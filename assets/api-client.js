export class NovaApiError extends Error {
  constructor(message, status = 0, details = {}) { super(message); this.name = "NovaApiError"; this.status = status; this.requestId=details?.requestId||null;this.runId=details?.runId||null;this.userMessageId=details?.userMessageId||null;this.conversationId=details?.conversationId||null; }
}

const durableTaskAcknowledgement = /^Durable (?:self-development|coding orchestration|artifact delivery|public web browser|public Web research) task ([a-z]+_[a-f0-9]{32}) is [a-z_]+\. Track it in Activity; Nova's Persistent Local Worker can continue it independently\.$/;
const terminalTaskStates = new Set(["completed", "failed", "blocked", "cancelled", "expired"]);

export function isDurableTaskId(value) {
  return typeof value === "string" && /^(?:selfdev|orchestration|coding|shipping|web)_[a-f0-9]{32}$/.test(value);
}

export function durableTaskIdFromAcknowledgement(value) {
  if (typeof value !== "string") return null;
  const taskId = value.match(durableTaskAcknowledgement)?.[1] || null;
  return isDurableTaskId(taskId) ? taskId : null;
}

export function durableTaskRecordsFromMessages(messages, conversationId) {
  const records = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const taskId = message?.role === "assistant" ? durableTaskIdFromAcknowledgement(message.content) : null;
    if (taskId && !records.has(taskId)) records.set(taskId, { taskId, conversationId: typeof conversationId === "string" ? conversationId : "", startedAt: message.createdAt || null, completedAt: null });
  }
  return [...records.values()];
}

export async function terminalTaskReportMessageId(task, cryptoImpl = globalThis.crypto) {
  if (!isDurableTaskId(task?.id) || !terminalTaskStates.has(task?.status) || !Number.isInteger(task?.stateVersion) || task.stateVersion < 0 || !cryptoImpl?.subtle) return null;
  const input = new TextEncoder().encode(`${task.id}:${task.stateVersion}:${task.status}`);
  const digest = await cryptoImpl.subtle.digest("SHA-256", input);
  const hex = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `task-report_${hex.slice(0, 48)}`;
}

export async function terminalTaskReportFromMessages(messages, task, cryptoImpl = globalThis.crypto) {
  const messageId = await terminalTaskReportMessageId(task, cryptoImpl);
  if (!messageId || !Array.isArray(messages)) return null;
  return messages.find((message) => message?.id === messageId && message?.role === "assistant" && typeof message?.content === "string") || null;
}

export function createNovaClient({ fetchImpl = globalThis.fetch, endpoint = "/api/agent" } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("Nova client requires a fetch implementation.");
  let conversationId;
  return Object.freeze({
    get conversationId() { return conversationId; },
    resume(id) { conversationId = typeof id === "string" && id ? id : undefined; },
    reset() { conversationId = undefined; },
    async send(message, { signal, context } = {}) {
      const payload = { message };
      if (conversationId) payload.conversationId = conversationId;
      if (context && typeof context === "object") payload.context = context;
      let response;
      try {
        response = await fetchImpl(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, signal, body: JSON.stringify(payload) });
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        throw new NovaApiError("Nova could not be reached. Check your connection and try again.");
      }
      let result;
      try { result = await response.json(); }
      catch { throw new NovaApiError("Nova returned an unreadable response.", response.status); }
      if (!response.ok) throw new NovaApiError(typeof result?.error === "string" ? result.error : "Nova could not complete that request.", response.status, result);
      if (!result || typeof result.message !== "string" || !result.conversationId) throw new NovaApiError("Nova returned an incomplete response.", response.status);
      conversationId = result.conversationId;
      return result;
    }
  });
}
