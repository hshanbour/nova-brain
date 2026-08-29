import test from "node:test";
import assert from "node:assert/strict";
import { createAgent } from "../src/agent/agent.js";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";
import { INITIAL_OWNER_PROFILE, OWNER_ID } from "../src/identity/initial-context.js";
import { createMockModelProvider } from "../src/providers/mock-model-provider.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import { ApprovalRequiredError } from "../src/policy/action-policy.js";

function scriptedProvider(outputs, onGenerate = () => {}) {
  let index = 0;

  return {
    name: "scripted",
    async generate(input) {
      onGenerate(input, index);
      return outputs[Math.min(index++, outputs.length - 1)];
    }
  };
}

function testStorage() {
  const storage = createInMemoryStorage();
  storage.initialize({ owner: INITIAL_OWNER_PROFILE });
  return storage;
}

function createTestAgent(options) {
  return createAgent({ storage: options.storage || testStorage(), ownerId: OWNER_ID, ...options });
}

test("agent returns a stable response and records a conversation turn", async () => {
  const storage = testStorage();
  const agent = createTestAgent({
    storage,
    modelProvider: createMockModelProvider(),
    toolRegistry: createToolRegistry()
  });

  const result = await agent.run({
    message: "Plan a Sharp Cuts campaign",
    conversationId: "conversation-1"
  });

  assert.equal(result.conversationId, "conversation-1");
  assert.equal(result.provider, "mock");
  assert.equal(result.steps, 1);
  assert.equal(result.message, "Nova is ready. I received: Plan a Sharp Cuts campaign");
  assert.deepEqual((await storage.listMessages("conversation-1", OWNER_ID)).map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "Plan a Sharp Cuts campaign" },
    {
      role: "assistant",
      content: "Nova is ready. I received: Plan a Sharp Cuts campaign"
    }
  ]);
});

test("agent executes one tool call and returns the next final response", async () => {
  const registry = createToolRegistry();
  registry.register({ name: "double", async execute({ value }) { return value * 2; } });
  const provider = scriptedProvider([
    {
      type: "tool_calls",
      toolCalls: [{ id: "call-1", name: "double", arguments: { value: 4 } }],
      continuationToken: "response-1"
    },
    { type: "final", message: "The result is 8." }
  ], (input, index) => {
    if (index === 1) {
      assert.equal(input.continuationToken, "response-1");
      assert.deepEqual(input.toolResults, [
        { id: "call-1", output: { ok: true, result: 8 } }
      ]);
    }
  });
  const agent = createTestAgent({
    modelProvider: provider,
    toolRegistry: registry
  });

  const result = await agent.run({ message: "Double four" });

  assert.equal(result.message, "The result is 8.");
  assert.equal(result.steps, 2);
  assert.deepEqual(result.toolCalls, [
    {
      id: "call-1",
      name: "double",
      arguments: { value: 4 },
      status: "completed",
      result: 8
    }
  ]);
});

test("agent supports multiple sequential tool calls", async () => {
  const registry = createToolRegistry();
  registry.register({ name: "identity", async execute(input) { return input; } });
  const provider = scriptedProvider([
    { type: "tool_calls", toolCalls: [{ id: "c1", name: "identity", arguments: { n: 1 } }] },
    { type: "tool_calls", toolCalls: [{ id: "c2", name: "identity", arguments: { n: 2 } }] },
    { type: "final", message: "Done" }
  ]);
  const agent = createTestAgent({
    modelProvider: provider,
    toolRegistry: registry
  });

  const result = await agent.run({ message: "Run twice" });

  assert.equal(result.steps, 3);
  assert.deepEqual(result.toolCalls.map(({ arguments: args }) => args), [{ n: 1 }, { n: 2 }]);
});

test("agent returns unknown tool requests to the provider as safe failures", async () => {
  const provider = scriptedProvider([
    { type: "tool_calls", toolCalls: [{ id: "c1", name: "missing", arguments: {} }] },
    { type: "final", message: "I could not use that tool." }
  ], (input, index) => {
    if (index === 1) {
      assert.deepEqual(input.toolResults, [
        { id: "c1", output: { ok: false, error: "Unknown tool: missing" } }
      ]);
    }
  });
  const agent = createTestAgent({
    modelProvider: provider,
    toolRegistry: createToolRegistry()
  });

  const result = await agent.run({ message: "Use missing" });

  assert.equal(result.toolCalls[0].status, "failed");
  assert.equal(result.toolCalls[0].error, "Unknown tool: missing");
});

test("agent contains tool execution errors and continues", async () => {
  const registry = createToolRegistry();
  registry.register({ name: "fail", async execute() { throw new Error("secret detail"); } });
  const provider = scriptedProvider([
    { type: "tool_calls", toolCalls: [{ id: "c1", name: "fail", arguments: {} }] },
    { type: "final", message: "The tool failed safely." }
  ]);
  const agent = createTestAgent({
    modelProvider: provider,
    toolRegistry: registry
  });

  const result = await agent.run({ message: "Fail" });

  assert.equal(result.message, "The tool failed safely.");
  assert.equal(result.toolCalls[0].error, "Tool execution failed: fail");
  assert.equal(JSON.stringify(result).includes("secret detail"), false);
});

test("agent enforces its maximum model-step limit", async () => {
  let executions = 0;
  const registry = createToolRegistry();
  registry.register({
    name: "again",
    async execute() {
      executions += 1;
      return "again";
    }
  });
  const agent = createTestAgent({
    modelProvider: scriptedProvider([
      { type: "tool_calls", toolCalls: [{ id: "c1", name: "again", arguments: {} }] }
    ]),
    toolRegistry: registry,
    maxSteps: 2
  });

  await assert.rejects(
    () => agent.run({ message: "Loop" }),
    /maximum of 2 model steps/
  );
  assert.equal(executions, 1);
});

test("tool arguments are validated and passed without transformation", async () => {
  const seen = [];
  const registry = createToolRegistry();
  registry.register({
    name: "validated",
    validate(input) {
      assert.equal(typeof input.count, "number");
    },
    async execute(input) {
      seen.push(input);
      return "ok";
    }
  });
  const agent = createTestAgent({
    modelProvider: scriptedProvider([
      { type: "tool_calls", toolCalls: [{ id: "c1", name: "validated", arguments: { count: 3 } }] },
      { type: "final", message: "Done" }
    ]),
    toolRegistry: registry
  });

  await agent.run({ message: "Validate" });
  assert.deepEqual(seen, [{ count: 3 }]);
});

test("conversation history is preserved across agent turns", async () => {
  const storage = testStorage();
  const histories = [];
  const provider = scriptedProvider(
    [{ type: "final", message: "First" }, { type: "final", message: "Second" }],
    (input) => histories.push(input.conversationHistory)
  );
  const agent = createTestAgent({
    storage,
    modelProvider: provider,
    toolRegistry: createToolRegistry()
  });

  await agent.run({ message: "One", conversationId: "shared" });
  await agent.run({ message: "Two", conversationId: "shared" });

  assert.deepEqual(histories[0], []);
  assert.deepEqual(histories[1].map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "One" }, { role: "assistant", content: "First" }
  ]);
});

test("agent stops a sensitive run in waiting-for-approval state",async()=>{const storage=testStorage();const approval={id:"approval-1",tool:"sensitive",status:"pending"};const registry={list(){return[{name:"sensitive"}];},async execute(){throw new ApprovalRequiredError(approval);}};const agent=createTestAgent({storage,toolRegistry:registry,modelProvider:scriptedProvider([{type:"tool_calls",toolCalls:[{id:"call-1",name:"sensitive",arguments:{target:"one"}}]}])});const result=await agent.run({message:"Sensitive action",conversationId:"approval-chat"});assert.equal(result.runStatus,"waiting_for_approval");assert.equal(result.approval.id,"approval-1");assert.equal(result.toolCalls[0].status,"waiting_for_approval");assert.equal((await storage.listRuns(OWNER_ID))[0].status,"waiting_for_approval");});
