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
export function createRecentsDrawer({ drawer, opener, closeButton, fallback, conversationView, background, documentRef = document }) {
  let returnTarget;
  let backgroundWasInert = false;
  const available = (element) => element?.isConnected && !element.disabled &&
    !element.closest('[hidden], [inert]') && element.getClientRects().length > 0;
  const focus = (element) => { if (available(element)) element.focus(); };
  function open() {
    if (!drawer.hidden) return;
    returnTarget = opener;
    backgroundWasInert = background.inert;
    background.inert = true;
    drawer.hidden = false;
    opener.setAttribute('aria-expanded', 'true');
    closeButton.focus();
  }
  function close({ selected = false } = {}) {
    if (drawer.hidden) return;
    drawer.hidden = true;
    background.inert = backgroundWasInert;
    opener.setAttribute('aria-expanded', 'false');
    const target = selected ? fallback : returnTarget;
    focus([target, fallback, conversationView].find(available));
  }
  // Keep focus on a stable control before asynchronous list updates remove entries.
  function beforeListUpdate() {
    if (!drawer.hidden && drawer.contains(documentRef.activeElement) && documentRef.activeElement !== closeButton) closeButton.focus();
  }
  opener.addEventListener('click', open);
  closeButton.addEventListener('click', () => close());
  drawer.addEventListener('click', (event) => { if (event.target === drawer) close(); });
  documentRef.addEventListener('focusin', (event) => {
    if (!drawer.hidden && !drawer.contains(event.target)) closeButton.focus();
  });
  documentRef.addEventListener('keydown', (event) => {
    if (drawer.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...drawer.querySelectorAll('button')].filter(available);
    const first = controls[0] || closeButton;
    const last = controls.at(-1) || closeButton;
    if (!controls.includes(documentRef.activeElement) ||
        (event.shiftKey && documentRef.activeElement === first) ||
        (!event.shiftKey && documentRef.activeElement === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  });
  return { open, close, beforeListUpdate };
}
