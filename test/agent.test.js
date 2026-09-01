import test from "node:test";
import assert from "node:assert/strict";
import { createAgent } from "../src/agent/agent.js";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";
import { INITIAL_OWNER_PROFILE, OWNER_ID } from "../src/identity/initial-context.js";
import { createMockModelProvider } from "../src/providers/mock-model-provider.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import { ApprovalRequiredError } from "../src/policy/action-policy.js";
import { buildSystemContext, retrieveAgentContext } from "../src/memory/context-retriever.js";

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

test("unverified and non-owner voice turns cannot retrieve owner memories or prior conversation history",async()=>{
  const storage=testStorage();await storage.createMemory({id:"private-memory",ownerId:OWNER_ID,category:"identity",content:"OWNER SECRET VALUE",privacy:"private",sensitivity:"sensitive",scope:"global",provenance:"owner-explicit",status:"active"});await storage.ensureConversation({id:"shared-voice",ownerId:OWNER_ID});await storage.appendMessage({conversationId:"shared-voice",ownerId:OWNER_ID,role:"assistant",content:"PRIVATE PRIOR TURN"});
  const observed=[];const agent=createTestAgent({storage,modelProvider:scriptedProvider([{type:"final",message:"safe"}],(input)=>observed.push(input)),toolRegistry:createToolRegistry(),verifySpeakerAssertion:(token)=>token==="wife-signed"?{speaker_profile_id:"wife",speaker_label:"enrolled_member",match_status:"confirmed"}:null,validateSpeakerProfile:async()=>true});
  await agent.run({message:"What do you know?",conversationId:"shared-voice",context:{voice:true,speaker:{speaker_label:"owner",assertion:"wife-signed"}}});
  assert.deepEqual(observed[0].conversationHistory,[]);assert.doesNotMatch(observed[0].systemContext,/OWNER SECRET VALUE|PRIVATE PRIOR TURN/);assert.match(observed[0].systemContext,/do not use or reveal the owner's private memories/i);
});

test("a signed owner assertion is rejected after its profile is deleted",async()=>{const storage=testStorage();await storage.createMemory({id:"private-memory",ownerId:OWNER_ID,category:"identity",content:"OWNER SECRET VALUE",privacy:"private",sensitivity:"sensitive",scope:"global",provenance:"owner-explicit",status:"active"});const observed=[];const agent=createTestAgent({storage,modelProvider:scriptedProvider([{type:"final",message:"safe"}],(input)=>observed.push(input)),toolRegistry:createToolRegistry(),verifySpeakerAssertion:()=>({speaker_profile_id:"deleted-owner",speaker_label:"owner",match_status:"confirmed"}),validateSpeakerProfile:async()=>false});await agent.run({message:"private data",context:{voice:true,speaker:{assertion:"still-signed"}}});assert.deepEqual(observed[0].conversationHistory,[]);assert.doesNotMatch(observed[0].systemContext,/OWNER SECRET VALUE/);});

test("verified active owner assertion enables private context and replaces browser speaker claims",async()=>{const storage=testStorage();await storage.createMemory({id:"private-memory",ownerId:OWNER_ID,category:"identity",content:"OWNER VERIFIED CONTEXT",privacy:"private",sensitivity:"sensitive",scope:"global",provenance:"owner-explicit",status:"active"});const observed=[];const logs=[];const agent=createTestAgent({storage,modelProvider:scriptedProvider([{type:"final",message:"safe"}],(input)=>observed.push(input)),toolRegistry:createToolRegistry(),verifySpeakerAssertion:(token)=>token==="server-signed"?{speaker_profile_id:"owner-profile",speaker_label:"owner",match_status:"confirmed"}:null,validateSpeakerProfile:async(id)=>id==="owner-profile",logger:{info(...args){logs.push(args);},error(){}}});await agent.run({message:"owner context",requestId:"request-1",context:{voice:true,speaker:{speaker_label:"unknown",assertion:"server-signed",untrusted:"discard"}}});assert.match(observed[0].systemContext,/OWNER VERIFIED CONTEXT/);assert.deepEqual(observed[0].context.speaker,{speaker_profile_id:"owner-profile",speaker_label:"owner",match_status:"confirmed"});assert.equal(JSON.stringify(observed[0].context).includes("server-signed"),false);assert.equal(logs[0][0],"Nova speaker context verified");assert.equal(logs[0][1].ownerPrivateContext,true);});

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

test("durable system context enforces male owner address and natural Jordanian Arabic",async()=>{const storage=testStorage();const context=await retrieveAgentContext({storage,ownerId:OWNER_ID,message:"احكي معي عن Nova Brain"});const prompt=buildSystemContext(context);assert.equal(context.owner.gender,"male");assert.match(prompt,/masculine Arabic grammar/);assert.match(prompt,/Jordanian\/Levantine Arabic/);assert.match(prompt,/Never use feminine/);assert.match(prompt,/Do not use forced vocatives/);});

