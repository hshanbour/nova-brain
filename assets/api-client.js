export class NovaApiError extends Error {
  constructor(message, status = 0) { super(message); this.name = "NovaApiError"; this.status = status; }
}

export function createNovaClient({ fetchImpl = globalThis.fetch, endpoint = "/api/agent" } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("Nova client requires a fetch implementation.");
  let conversationId;
  return Object.freeze({
    get conversationId() { return conversationId; },
    resume(id) { conversationId = typeof id === "string" && id ? id : undefined; },
    reset() { conversationId = undefined; },
    async send(message) {
      const payload = { message };
      if (conversationId) payload.conversationId = conversationId;
      let response;
      try {
        response = await fetchImpl(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } catch {
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
