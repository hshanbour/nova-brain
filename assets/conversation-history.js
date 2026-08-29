const defaultKey = "nova.activeConversationId";

export function conversationTitle(value, maximum = 52) {
  const title = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!title) return "Untitled conversation";
  return title.length <= maximum ? title : `${title.slice(0, maximum - 1).trimEnd()}…`;
}

export function newestConversations(conversations = []) {
  return [...conversations].sort((left, right) => {
    const updated = String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
    return updated || String(left.id).localeCompare(String(right.id));
  });
}

export function createConversationHistory({ client, api, storage = localStorage, key = defaultKey } = {}) {
  let conversations = [];
  async function refresh() {
    const result = await api.conversations();
    conversations = newestConversations(Array.isArray(result?.conversations) ? result.conversations : []);
    return conversations;
  }
  async function select(id) {
    if (typeof id !== "string" || !id) throw new Error("Conversation is unavailable.");
    const pages = []; let offset = 0;
    do {
      const result = await api.messages(id, { offset, limit: 100 });
      if (!Array.isArray(result?.messages)) throw new Error("Nova returned unreadable conversation history.");
      pages.unshift(result.messages); offset = Number.isInteger(result.nextOffset) && result.nextOffset > offset && result.nextOffset <= 100_000 ? result.nextOffset : 0;
    } while (offset);
    const savedMessages = pages.flat();
    client.resume(id); storage.setItem(key, id);
    return savedMessages.sort((left, right) => Number(left.sequence) - Number(right.sequence));
  }
  function startNew() { client.reset(); storage.removeItem(key); }
  async function restore() {
    const id = storage.getItem(key); if (!id) return null;
    try { return { id, messages: await select(id) }; }
    catch (error) { startNew(); throw error; }
  }
  return Object.freeze({ refresh, select, startNew, restore, get conversations() { return conversations; } });
}
