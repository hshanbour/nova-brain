export class NovaApiError extends Error {
  constructor(message, status = 0) { super(message); this.name = "NovaApiError"; this.status = status; }
}

const durableTaskAcknowledgement = /^Durable self-development task (selfdev_[a-f0-9]{32}) is [a-z_]+\. Track it in Activity; Nova's Persistent Local Worker can continue it independently\.$/;

export function durableTaskIdFromAcknowledgement(value) {
  if (typeof value !== "string") return null;
  return value.match(durableTaskAcknowledgement)?.[1] || null;
}

export function durableTaskRecordsFromMessages(messages, conversationId) {
  const records = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const taskId = message?.role === "assistant" ? durableTaskIdFromAcknowledgement(message.content) : null;
    if (taskId && !records.has(taskId)) records.set(taskId, { taskId, conversationId: typeof conversationId === "string" ? conversationId : "", startedAt: message.createdAt || null, completedAt: null });
  }
  return [...records.values()];
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
      if (!response.ok) throw new NovaApiError(typeof result?.error === "string" ? result.error : "Nova could not complete that request.", response.status);
      if (!result || typeof result.message !== "string" || !result.conversationId) throw new NovaApiError("Nova returned an incomplete response.", response.status);
      conversationId = result.conversationId;
      return result;
    }
  });
}
