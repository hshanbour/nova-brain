const REPORT_REFERENCE = /\b(?:report|research|study|analysis)\b|(?:التقرير|تقرير|البحث|بحث|الدراسة|دراسة|التحليل|تحليل)/iu;
const REPORT_CONTENT = /^(?:task report\s+[—-]|#{1,3}\s)|\b(?:report|research|findings|recommendations)\b|(?:تقرير|بحث|النتائج|التوصيات)/iu;

const byteLength = (value) => new TextEncoder().encode(String(value || "")).byteLength;

function limits(value = {}) {
  return Object.freeze({
    pageSize: Math.min(100, Math.max(1, value.pageSize || 50)),
    maxPages: Math.min(20, Math.max(1, value.maxPages || 8)),
    maxMessages: Math.min(1_000, Math.max(1, value.maxMessages || 400)),
    maxScannedBytes: Math.min(2_000_000, Math.max(1, value.maxScannedBytes || 512_000)),
    maxSourceBytes: Math.min(256_000, Math.max(1, value.maxSourceBytes || 64_000)),
    timeoutMs: Math.min(10_000, Math.max(50, value.timeoutMs || 1_500)),
  });
}

function boundedCall(operation, remainingMs) {
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("Conversation transform source retrieval timed out."), { code: "conversation_transform_source_timeout" })), remainingMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function candidate(message) {
  if (message?.role !== "assistant" || typeof message.content !== "string" || !message.content.trim()) return null;
  const size = byteLength(message.content);
  return { message, size, terminal: /^task-report_[a-f0-9]{16,}$/i.test(message.id || ""), reportLike: REPORT_CONTENT.test(message.content) };
}

export async function retrieveConversationTransformSource({ storage, ownerId, conversationId, request, bounds, signal } = {}) {
  if (!storage || typeof ownerId !== "string" || !ownerId || typeof conversationId !== "string" || !conversationId) {
    return Object.freeze({ source: null, reason: "invalid_binding", pages: 0, messages: 0, bytes: 0 });
  }
  const bound = limits(bounds), prefersReport = REPORT_REFERENCE.test(String(request || "")), startedAt = Date.now();
  let offset = 0, pages = 0, scannedMessages = 0, scannedBytes = 0, latestAssistant = null, latestReport = null;
  while (pages < bound.maxPages && scannedMessages < bound.maxMessages && scannedBytes < bound.maxScannedBytes) {
    signal?.throwIfAborted?.();
    const remainingMs = bound.timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) return Object.freeze({ source: null, reason: "timeout", pages, messages: scannedMessages, bytes: scannedBytes });
    let page;
    try {
      page = await boundedCall(storage.listMessages(conversationId, ownerId, { limit: Math.min(bound.pageSize, bound.maxMessages - scannedMessages), offset }), remainingMs);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      return Object.freeze({ source: null, reason: error?.code === "conversation_transform_source_timeout" ? "timeout" : "storage_unavailable", pages, messages: scannedMessages, bytes: scannedBytes });
    }
    if (!Array.isArray(page) || !page.length) break;
    pages += 1;
    for (let index = page.length - 1; index >= 0; index -= 1) {
      const item = page[index], itemBytes = byteLength(item?.content);
      scannedMessages += 1; scannedBytes += itemBytes;
      if (scannedMessages > bound.maxMessages || scannedBytes > bound.maxScannedBytes) break;
      const possible = candidate(item);
      if (!possible || possible.size > bound.maxSourceBytes) continue;
      latestAssistant ||= possible.message;
      if (possible.terminal) return Object.freeze({ source: possible.message, reason: "terminal_report", pages, messages: scannedMessages, bytes: scannedBytes });
      if (!latestReport && possible.reportLike) latestReport = possible.message;
      if (!prefersReport) return Object.freeze({ source: possible.message, reason: "latest_assistant", pages, messages: scannedMessages, bytes: scannedBytes });
    }
    offset += page.length;
    if (page.length < bound.pageSize) break;
  }
  const source = prefersReport ? latestReport : latestAssistant;
  return Object.freeze({ source, reason: source ? "assistant_report" : "not_found", pages, messages: scannedMessages, bytes: scannedBytes });
}

export function minimalTransformContext(history, source, { maxMessages = 6, maxBytes = 12_000 } = {}) {
  const selected = [], sourceId = source?.id, items = Array.isArray(history) ? history : [];
  let bytes = 0;
  for (let index = items.length - 1; index >= 0 && selected.length < maxMessages; index -= 1) {
    const item = items[index];
    if (!item || item.id === sourceId || !["user", "assistant"].includes(item.role) || typeof item.content !== "string") continue;
    const size = byteLength(item.content);
    if (bytes + size > maxBytes) continue;
    bytes += size; selected.unshift(item);
  }
  return selected;
}
