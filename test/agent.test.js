import test from "node:test";
import assert from "node:assert/strict";
import { createAgent } from "../src/agent/agent.js";
import { createInMemoryMemoryStore } from "../src/memory/in-memory-store.js";
import { createMockModelProvider } from "../src/providers/mock-model-provider.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";

test("agent returns a stable response and records a conversation turn", async () => {
  const memoryStore = createInMemoryMemoryStore();
  const agent = createAgent({
    memoryStore,
    modelProvider: createMockModelProvider(),
    toolRegistry: createToolRegistry()
  });

  const result = await agent.run({
    message: "Plan a Sharp Cuts campaign",
    conversationId: "conversation-1"
  });

  assert.equal(result.conversationId, "conversation-1");
  assert.equal(result.provider, "mock");
  assert.equal(result.message, "Brian is ready. I received: Plan a Sharp Cuts campaign");
  assert.deepEqual(await memoryStore.list("conversation-1"), [
    { role: "user", content: "Plan a Sharp Cuts campaign" },
    {
      role: "assistant",
      content: "Brian is ready. I received: Plan a Sharp Cuts campaign"
    }
  ]);
});
