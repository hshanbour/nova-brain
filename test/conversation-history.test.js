import test from "node:test";
import assert from "node:assert/strict";
import { createNovaClient } from "../assets/api-client.js";
import { conversationTitle, createConversationHistory, newestConversations } from "../assets/conversation-history.js";

function localState(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}

test("recent conversations are newest-first with deterministic ties and readable titles", () => {
  const result = newestConversations([
    { id: "b", updatedAt: "2026-01-01T00:00:00Z" }, { id: "c", updatedAt: "2026-02-01T00:00:00Z" }, { id: "a", updatedAt: "2026-01-01T00:00:00Z" }
  ]);
  assert.deepEqual(result.map(({ id }) => id), ["c", "a", "b"]);
  assert.equal(conversationTitle("  A   useful title  "), "A useful title");
  assert.match(conversationTitle("x".repeat(80)), /…$/);
});

test("selecting a conversation loads chronological messages and resumes its exact id", async () => {
  const storage = localState(); const client = createNovaClient({ fetchImpl: async () => { throw new Error("not used"); } });
  const history = createConversationHistory({ client, storage, api: { conversations: async () => ({ conversations: [] }), messages: async () => ({ messages: [{ sequence: 2, content: "reply" }, { sequence: 1, content: "question" }] }) } });
  assert.deepEqual((await history.select("conversation-a")).map(({ content }) => content), ["question", "reply"]);
  assert.equal(client.conversationId, "conversation-a"); assert.equal(storage.getItem("nova.activeConversationId"), "conversation-a");
});

test("sending after reopening appends to the same conversation id", async () => {
  const requests = []; const storage = localState();
  const client = createNovaClient({ fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, status: 200, async json() { return { message: "continued", conversationId: "conversation-a" }; } }; } });
  const history = createConversationHistory({ client, storage, api: { messages: async () => ({ messages: [] }), conversations: async () => ({ conversations: [] }) } });
  await history.select("conversation-a"); await client.send("Continue this chat");
  assert.deepEqual(requests, [{ message: "Continue this chat", conversationId: "conversation-a" }]);
});

test("New Conversation preserves recents and creates no conversation until send", async () => {
  const storage = localState({ "nova.activeConversationId": "conversation-a" }); const client = createNovaClient({ fetchImpl: async () => { throw new Error("not used"); } }); client.resume("conversation-a");
  const history = createConversationHistory({ client, storage, api: { conversations: async () => ({ conversations: [{ id: "conversation-a" }] }) } });
  await history.refresh(); history.startNew();
  assert.equal(client.conversationId, undefined); assert.equal(storage.getItem("nova.activeConversationId"), null); assert.deepEqual(history.conversations.map(({ id }) => id), ["conversation-a"]);
});

test("refresh restoration resumes local active state and empty history is safe", async () => {
  const storage = localState({ "nova.activeConversationId": "conversation-a" }); const client = createNovaClient({ fetchImpl: async () => { throw new Error("not used"); } });
  const history = createConversationHistory({ client, storage, api: { conversations: async () => ({ conversations: [] }), messages: async () => ({ messages: [] }) } });
  assert.deepEqual(await history.refresh(), []); assert.deepEqual(await history.restore(), { id: "conversation-a", messages: [] }); assert.equal(client.conversationId, "conversation-a");
});

test("malformed or unavailable conversation history never changes the active conversation", async () => {
  const storage = localState(); const client = createNovaClient({ fetchImpl: async () => { throw new Error("not used"); } }); client.resume("safe-conversation");
  const history = createConversationHistory({ client, storage, api: { messages: async () => ({ messages: "not-an-array" }) } });
  await assert.rejects(() => history.select("other-conversation"), /unreadable/);
  assert.equal(client.conversationId, "safe-conversation"); assert.equal(storage.getItem("nova.activeConversationId"), null);
});
