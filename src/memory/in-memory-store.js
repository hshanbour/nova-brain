export function createInMemoryMemoryStore() {
  const conversations = new Map();

  return Object.freeze({
    async list(conversationId) {
      return conversations.get(conversationId) || [];
    },
    async append(conversationId, entry) {
      const history = conversations.get(conversationId) || [];
      conversations.set(conversationId, [...history, Object.freeze({ ...entry })]);
    }
  });
}
