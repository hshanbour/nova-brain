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

export function createConversationBindingState() {
  let pending = true, queuedId = null, displayedId = null, revision = 0;
  return Object.freeze({
    get pending() { return pending; },
    get displayedId() { return displayedId; },
    get revision() { return revision; },
    begin() { pending = true; },
    display(id) { displayedId = typeof id === "string" && id ? id : null; revision += 1; },
    capture() { return Object.freeze({ displayedId, revision }); },
    adopt(snapshot, activeId, returnedId) {
      const normalizedActiveId = typeof activeId === "string" && activeId ? activeId : null;
      if (!snapshot || snapshot.revision !== revision || snapshot.displayedId !== displayedId || displayedId !== normalizedActiveId || typeof returnedId !== "string" || !returnedId) return false;
      if (normalizedActiveId && normalizedActiveId !== returnedId) return false;
      displayedId = returnedId; revision += 1; return true;
    },
    queue(id) { if (typeof id === "string" && id) queuedId = id; },
    finish(activeId) {
      pending = false;
      const next = queuedId; queuedId = null;
      return next && next !== activeId ? next : null;
    },
    canSend(activeId) { return !pending && (activeId || null) === displayedId; },
  });
}

export function createConversationHistory({ client, api, storage = localStorage, key = defaultKey } = {}) {
  let conversations = [];
  async function refresh() {
    const result = await api.conversations();
    conversations = newestConversations(Array.isArray(result?.conversations) ? result.conversations : []);
    return conversations;
  }
  async function load(id) {
    if (typeof id !== "string" || !id) throw new Error("Conversation is unavailable.");
    const pages = []; let offset = 0;
    do {
      const result = await api.messages(id, { offset, limit: 100 });
      if (!Array.isArray(result?.messages)) throw new Error("Nova returned unreadable conversation history.");
      pages.unshift(result.messages); offset = Number.isInteger(result.nextOffset) && result.nextOffset > offset && result.nextOffset <= 100_000 ? result.nextOffset : 0;
    } while (offset);
    return pages.flat().sort((left, right) => Number(left.sequence) - Number(right.sequence));
  }
  async function select(id) {
    if (typeof id !== "string" || !id) throw new Error("Conversation is unavailable.");
    const previousId = client.conversationId;
    client.resume(id);
    try {
      const savedMessages = await load(id);
      storage.setItem(key, id);
      return savedMessages;
    } catch (error) {
      client.resume(previousId);
      throw error;
    }
  }
  function startNew() { client.reset(); storage.removeItem(key); }
  async function restore() {
    const id = storage.getItem(key); if (!id) return null;
    try { return { id, messages: await select(id) }; }
    catch (error) { startNew(); throw error; }
  }
  return Object.freeze({ refresh, load, select, startNew, restore, get conversations() { return conversations; } });
}
