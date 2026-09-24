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

test("explicit engineering intake creates a durable task before any model generation", async () => {
  let modelCalls = 0;
  const agent = createTestAgent({
    modelProvider: { name: "never", async generate() { modelCalls += 1; throw new Error("model must not run"); } },
    toolRegistry: createToolRegistry(),
    routeDurableRequest: async ({message}) => message.startsWith("Fix Nova") ? {
      task: { id: "selfdev_trusted", status: "queued", projectId: "nova-brain", branch: "feat/nova-brain-mvp-foundation", startingCommit: "f".repeat(40) },
      idempotent: false,
    } : null,
  });
  const result = await agent.run({ message: "Fix Nova Console routing" });
  assert.equal(modelCalls, 0);
  assert.equal(result.provider, "durable_runtime");
  assert.equal(result.runStatus, "durable_task_created");
  assert.equal(result.durableTask.id, "selfdev_trusted");
  assert.equal(result.durableTask.status, "queued");
});
test("unsafe durable intake asks one bounded clarification without creating a task or entering chat generation",async()=>{
  let modelCalls=0;const storage=testStorage(),usage={model:"gpt-6-luna",stage:"intake",inputTokens:20,outputTokens:8},agent=createTestAgent({storage,modelProvider:{name:"never",async generate(){modelCalls+=1;throw new Error("chat model must not run");}},toolRegistry:createToolRegistry(),routeDurableRequest:async()=>({clarificationRequired:true,message:"Which account is authorized?",providerUsage:usage})}),result=await agent.run({message:"Update the customer account",conversationId:"clarify"});
  assert.equal(modelCalls,0);assert.equal(result.runStatus,"clarification_required");assert.equal(result.provider,"durable_intake");assert.equal(result.message,"Which account is authorized?");assert.equal((await storage.listAutonomyTasks(OWNER_ID)).length,0);const [run]=await storage.listRuns(OWNER_ID);assert.deepEqual(run.result.providerUsage,[usage]);
});

test("ordinary chat bypasses durable intake and keeps the synchronous model path", async () => {
  let routes = 0, modelCalls = 0;
  const agent = createTestAgent({
    modelProvider: scriptedProvider([{ type: "final", message: "Normal chat" }], () => { modelCalls += 1; }),
    toolRegistry: createToolRegistry(),
    routeDurableRequest: async () => { routes += 1; return null; },
  });
  const result = await agent.run({ message: "How are you today?" });
  assert.equal(routes, 1);
  assert.equal(modelCalls, 1);
  assert.equal(result.provider, "scripted");
  assert.equal(result.message, "Normal chat");
});
test("existing-task continuation bypasses new-task intake and exposes only bounded task tools",async()=>{
  const storage=testStorage(),registry=createToolRegistry(),id="selfdev_c9fc28effbd72350c86c67abe4d69e36";let durableRoutes=0,recoveries=0,modelCalls=0;
  registry.register({name:"self_development_get",available:true,async execute(){return{id};}});
  registry.register({name:"self_development_scope_recover",available:true,async execute(input){recoveries+=1;assert.deepEqual(input,{taskId:id,expectedVersion:37});return{task:{id,status:"queued",stateVersion:38}};}});
  registry.register({name:"self_development_create",available:true,async execute(){throw new Error("must remain unavailable to task control");}});
  const agent=createTestAgent({storage,toolRegistry:registry,routeExistingTaskRequest:async()=>({route:"existing_task_control",action:"recovery",expectedVersion:37,task:{id,status:"expired",stateVersion:37,currentPhase:"scope_rediscovery",errorCode:"max_runtime_reached"}}),routeDurableRequest:async()=>{durableRoutes+=1;throw new Error("new-task intake must not run");},modelProvider:{name:"never",async generate(){modelCalls+=1;throw new Error("task recovery must dispatch before chat generation");}}});
  const result=await agent.run({message:`Resume task ${id} with expectedVersion 37.`});
  assert.equal(durableRoutes,0);assert.equal(recoveries,1);assert.equal(modelCalls,0);assert.equal(result.runStatus,"task_recovered");assert.match(result.message,/recovery was accepted/);
  assert.deepEqual(result.taskControl,{taskId:id,status:"queued",stateVersion:38});
  assert.equal((await storage.listAutonomyTasks(OWNER_ID)).length,0);
  assert.equal((await storage.listActivity(OWNER_ID,{runId:result.runId})).some(item=>item.action==="existing_task_control_routed"),true);
});
test("exact recovery dispatch cannot execute a broader tool and binds a missing version to the inspected task",async()=>{
  const registry=createToolRegistry(),id="selfdev_c9fc28effbd72350c86c67abe4d69e36";let creations=0,recoveries=0,modelCalls=0;
  registry.register({name:"self_development_get",available:true,async execute(){return{id};}});
  registry.register({name:"self_development_scope_recover",available:true,async execute(input){recoveries+=1;assert.deepEqual(input,{taskId:id,expectedVersion:37});return{task:{id,status:"queued",stateVersion:38}};}});
  registry.register({name:"self_development_create",available:true,async execute(){creations+=1;return{task:{id:"new"}};}});
  const agent=createTestAgent({toolRegistry:registry,routeExistingTaskRequest:async()=>({route:"existing_task_control",action:"recovery",expectedVersion:null,task:{id,status:"expired",stateVersion:37,currentPhase:"scope_rediscovery",errorCode:"max_runtime_reached"}}),routeDurableRequest:async()=>{throw new Error("must not run");},modelProvider:{name:"never",async generate(){modelCalls+=1;throw new Error("must not run");}}});
  const result=await agent.run({message:`Recover task ${id}.`});
  assert.equal(creations,0);assert.equal(recoveries,1);assert.equal(modelCalls,0);assert.equal(result.toolCalls[0].name,"self_development_scope_recover");
});
test("task-bound approval or clarification routing cannot inherit recovery authority",async()=>{
  const registry=createToolRegistry(),id="selfdev_c9fc28effbd72350c86c67abe4d69e36",observed=[];let durableRoutes=0;
  registry.register({name:"self_development_get",available:true,async execute(){return{id};}});
  registry.register({name:"self_development_scope_recover",available:true,async execute(){throw new Error("must not be exposed");}});
  const agent=createTestAgent({toolRegistry:registry,routeExistingTaskRequest:async()=>({route:"existing_task_control",action:"approval",expectedVersion:null,task:{id,status:"waiting_for_approval",stateVersion:40,currentPhase:"approval",errorCode:null}}),routeDurableRequest:async()=>{durableRoutes+=1;throw new Error("must not run");},modelProvider:scriptedProvider([{type:"final",message:"Use the existing approval boundary."}],input=>observed.push(input))});
  const result=await agent.run({message:`Approve task ${id}. Do not create a new Nova task.`});
  assert.equal(result.message,"Use the existing approval boundary.");assert.equal(durableRoutes,0);assert.deepEqual(observed[0].tools.map(tool=>tool.name),["self_development_get"]);
});

test("ordinary chat binds the chat stage and durably records provider token usage",async()=>{const storage=testStorage(),observed=[];const usage={model:"economical",stage:"chat",serviceTier:"default",inputTokens:100,cachedInputTokens:80,outputTokens:10,reasoningTokens:2,totalTokens:110},agent=createTestAgent({storage,modelProvider:scriptedProvider([{type:"final",message:"Measured",providerUsage:usage}],input=>observed.push(input)),toolRegistry:createToolRegistry()});await agent.run({message:"Hello",conversationId:"usage-chat"});assert.equal(observed[0].stage,"chat");const [run]=await storage.listRuns(OWNER_ID);assert.deepEqual(run.result.providerUsage,[usage]);});

test("default synchronous loop permits a final response on model step ten", async () => {
  let index = 0;
  const registry = createToolRegistry();
  registry.register({ name: "again", async execute() { return "again"; } });
  const provider = { name: "ten-step", async generate() { index += 1; return index === 10 ? { type: "final", message: "Done at ten" } : { type: "tool_calls", toolCalls: [{ id: `c${index}`, name: "again", arguments: {} }] }; } };
  const result = await createTestAgent({ modelProvider: provider, toolRegistry: registry }).run({ message: "Use ten bounded rounds" });
  assert.equal(result.steps, 10);
  assert.equal(result.message, "Done at ten");
});

test("synchronous deadline aborts the provider and records a bounded failure", async () => {
  let observedSignal;
  const storage = testStorage();
  const provider = { name: "waiting", generate({signal}) { observedSignal = signal; return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); } };
  const agent = createTestAgent({ storage, modelProvider: provider, toolRegistry: createToolRegistry(), deadlineMs: 10 });
  await assert.rejects(() => agent.run({ message: "Wait" }), /synchronous deadline of 10ms/);
  assert.equal(observedSignal.aborted, true);
  assert.equal((await storage.listRuns(OWNER_ID))[0].status, "failed");
});

test("caller AbortSignal stops only the active synchronous run", async () => {
  let observedSignal;
  const storage = testStorage(), controller = new AbortController();
  const provider = { name: "waiting", generate({signal}) { observedSignal = signal; return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); } };
  const agent = createTestAgent({ storage, modelProvider: provider, toolRegistry: createToolRegistry() });
  const pending = agent.run({ message: "Stop me", signal: controller.signal });
  while (!observedSignal) await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new DOMException("Stopped", "AbortError"));
  await assert.rejects(() => pending, (error) => error.name === "AbortError");
  assert.equal(observedSignal.aborted, true);
  assert.equal((await storage.listRuns(OWNER_ID))[0].status, "cancelled");
});

test("agent returns structured redacted tool errors for known validation failures",async()=>{const registry=createToolRegistry();registry.register({name:"self_development_create",async execute(){throw Object.assign(new Error("The requested project could not be resolved to Nova Brain."),{code:"project_not_found"});}});const agent=createTestAgent({toolRegistry:registry,modelProvider:scriptedProvider([{type:"tool_calls",toolCalls:[{id:"create-1",name:"self_development_create",arguments:{userGoal:"Improve dictation"}}]},{type:"final",message:"I need corrected project context."}])}),result=await agent.run({message:"Improve dictation",conversationId:"structured-self-development-error"});assert.deepEqual(result.toolCalls[0].error,{code:"project_not_found",message:"The requested project could not be resolved to Nova Brain."});assert.doesNotMatch(JSON.stringify(result),/password|token|stack/i);});

test("unverified and non-owner voice turns cannot retrieve owner memories or prior conversation history",async()=>{
  const storage=testStorage();await storage.createMemory({id:"private-memory",ownerId:OWNER_ID,category:"identity",content:"OWNER SECRET VALUE",privacy:"private",sensitivity:"sensitive",scope:"global",provenance:"owner-explicit",status:"active"});await storage.ensureConversation({id:"shared-voice",ownerId:OWNER_ID});await storage.appendMessage({conversationId:"shared-voice",ownerId:OWNER_ID,role:"assistant",content:"PRIVATE PRIOR TURN"});
  const observed=[];const agent=createTestAgent({storage,modelProvider:scriptedProvider([{type:"final",message:"safe"}],(input)=>observed.push(input)),toolRegistry:createToolRegistry(),verifySpeakerAssertion:(token)=>token==="wife-signed"?{speaker_profile_id:"wife",speaker_label:"enrolled_member",match_status:"confirmed"}:null,validateSpeakerProfile:async()=>true});
  await agent.run({message:"What do you know?",conversationId:"shared-voice",context:{voice:true,speaker:{speaker_label:"owner",assertion:"wife-signed"}}});
  assert.deepEqual(observed[0].conversationHistory,[]);assert.doesNotMatch(observed[0].systemContext,/OWNER SECRET VALUE|PRIVATE PRIOR TURN/);assert.match(observed[0].systemContext,/do not use or reveal the owner's private memories/i);
});

test("a signed owner assertion is rejected after its profile is deleted",async()=>{const storage=testStorage();await storage.createMemory({id:"private-memory",ownerId:OWNER_ID,category:"identity",content:"OWNER SECRET VALUE",privacy:"private",sensitivity:"sensitive",scope:"global",provenance:"owner-explicit",status:"active"});const observed=[];const agent=createTestAgent({storage,modelProvider:scriptedProvider([{type:"final",message:"safe"}],(input)=>observed.push(input)),toolRegistry:createToolRegistry(),verifySpeakerAssertion:()=>({speaker_profile_id:"deleted-owner",speaker_label:"owner",match_status:"confirmed"}),validateSpeakerProfile:async()=>false});await agent.run({message:"private data",context:{voice:true,speaker:{assertion:"still-signed"}}});assert.deepEqual(observed[0].conversationHistory,[]);assert.doesNotMatch(observed[0].systemContext,/OWNER SECRET VALUE/);});

test("verified active owner assertion enables private context and replaces browser speaker claims",async()=>{const storage=testStorage();await storage.createMemory({id:"private-memory",ownerId:OWNER_ID,category:"identity",content:"OWNER VERIFIED CONTEXT",privacy:"private",sensitivity:"sensitive",scope:"global",provenance:"owner-explicit",status:"active"});const observed=[];const logs=[];const agent=createTestAgent({storage,modelProvider:scriptedProvider([{type:"final",message:"safe"}],(input)=>observed.push(input)),toolRegistry:createToolRegistry(),verifySpeakerAssertion:(token)=>token==="server-signed"?{speaker_profile_id:"owner-profile",speaker_label:"owner",match_status:"confirmed"}:null,validateSpeakerProfile:async(id)=>id==="owner-profile",logger:{info(...args){logs.push(args);},error(){}}});await agent.run({message:"owner context",requestId:"request-1",context:{voice:true,speaker:{speaker_label:"unknown",assertion:"server-signed",untrusted:"discard"}}});assert.match(observed[0].systemContext,/OWNER VERIFIED CONTEXT/);assert.deepEqual(observed[0].context.speaker,{speaker_profile_id:"owner-profile",speaker_label:"owner",match_status:"confirmed",authenticated_identity:"owner",speaker_familiarity:"none",anonymous_speaker_id:null});assert.equal(JSON.stringify(observed[0].context).includes("server-signed"),false);assert.equal(logs[0][0],"Nova speaker context verified");assert.equal(logs[0][1].ownerPrivateContext,true);});

test("anonymous familiarity stays unprivileged and a browser cannot spoof it",async()=>{const storage=testStorage();await storage.createMemory({id:"private-memory",ownerId:OWNER_ID,category:"identity",content:"NEVER DISCLOSE THIS",privacy:"private",sensitivity:"sensitive",scope:"global",provenance:"owner-explicit",status:"active"});const observed=[];const agent=createTestAgent({storage,modelProvider:scriptedProvider([{type:"final",message:"safe"}],(input)=>observed.push(input)),toolRegistry:createToolRegistry(),verifySpeakerAssertion:(token)=>token==="signed-anonymous"?{speaker_profile_id:null,speaker_label:"unknown",match_status:"unknown",authenticated_identity:"none",speaker_familiarity:"known_anonymous",anonymous_speaker_id:"anonymous-1"}:null,validateAnonymousSpeaker:async(id)=>id==="anonymous-1"});await agent.run({message:"hello",context:{voice:true,speaker:{assertion:"signed-anonymous",authenticated_identity:"owner",speaker_familiarity:"known_anonymous"}}});assert.doesNotMatch(observed[0].systemContext,/NEVER DISCLOSE THIS/);assert.equal(observed[0].context.speaker.authenticated_identity,"none");assert.equal(observed[0].context.speaker.speaker_familiarity,"known_anonymous");assert.equal(observed[0].context.speaker.anonymous_speaker_id,"anonymous-1");const spoofed=[];const second=createTestAgent({storage,modelProvider:scriptedProvider([{type:"final",message:"safe"}],(input)=>spoofed.push(input)),toolRegistry:createToolRegistry()});await second.run({message:"hello",context:{voice:true,speaker:{authenticated_identity:"owner",speaker_familiarity:"known_anonymous",anonymous_speaker_id:"fake"}}});assert.equal(spoofed[0].context.speaker.authenticated_identity,"none");assert.equal(spoofed[0].context.speaker.speaker_familiarity,"none");});

test("verified owner identity questions are natural while recognition-method questions stay concise and accurate",async()=>{const storage=testStorage();const create=()=>createTestAgent({storage,modelProvider:scriptedProvider([]),toolRegistry:createToolRegistry(),verifySpeakerAssertion:()=>({speaker_profile_id:"owner-profile",speaker_label:"owner",match_status:"confirmed"}),validateSpeakerProfile:async()=>true});for(const message of ["مين أنا؟","عرفتيني؟"]){const result=await create().run({message,context:{voice:true,speaker:{assertion:"signed"}}});assert.match(result.message,/محمد شنبور/);assert.doesNotMatch(result.message,/نظام التحقق|ملف صوت|موافقتك|assertion/iu);}const method=await create().run({message:"كيف عرفتي؟",context:{voice:true,speaker:{assertion:"signed"}}});assert.equal(method.message,"من نظام التحقق الصوتي اللي طابق صوتك مع ملفك الصوتي المسجّل.");});

test("owner security metadata never hijacks resume project tool or conversational intent",async()=>{const messages=["أنا حكيت لك كملي، ما قلت لك مين أنا","احكيلي عن مشروع Nova Voice","شغلي أداة فحص المشروع","شو كنتي تحكي؟"];let calls=0;const agent=createTestAgent({modelProvider:scriptedProvider(messages.map((message)=>({type:"final",message:`normal:${message}`})),()=>{calls+=1;}),toolRegistry:createToolRegistry(),verifySpeakerAssertion:()=>({speaker_profile_id:"owner-profile",speaker_label:"owner",match_status:"confirmed"}),validateSpeakerProfile:async()=>true});for(const message of messages){const result=await agent.run({message,conversationId:"intent-routing",context:{voice:true,speaker:{assertion:"signed"}}});assert.equal(result.message,`normal:${message}`);assert.doesNotMatch(result.message,/نظام التحقق|ملف صوت|موافقتك/iu);}assert.equal(calls,4);const identity=await createTestAgent({modelProvider:scriptedProvider([]),toolRegistry:createToolRegistry(),verifySpeakerAssertion:()=>({speaker_profile_id:"owner-profile",speaker_label:"owner",match_status:"confirmed"}),validateSpeakerProfile:async()=>true}).run({message:"مين أنا؟",context:{voice:true,speaker:{assertion:"signed"}}});assert.match(identity.message,/محمد شنبور/);});

test("conversation fallback uses stored recent assistant context before clarifying",async()=>{const observed=[];const agent=createTestAgent({modelProvider:scriptedProvider([{type:"final",message:"The last answer was explaining checkpoint preservation."},{type:"final",message:"continued from recent context"}],(input)=>observed.push(input)),toolRegistry:createToolRegistry(),verifySpeakerAssertion:()=>({speaker_profile_id:"owner-profile",speaker_label:"owner",match_status:"confirmed"}),validateSpeakerProfile:async()=>true});await agent.run({message:"Explain the interruption fix",conversationId:"continuation-fallback",context:{voice:true,speaker:{assertion:"signed"}}});const result=await agent.run({message:"شو كنتي تحكي؟",conversationId:"continuation-fallback",context:{voice:true,speaker:{assertion:"signed"}}});assert.equal(result.message,"continued from recent context");assert.match(observed[1].systemContext,/latest clear incomplete or interrupted assistant response/);assert.match(JSON.stringify(observed[1].conversationHistory),/checkpoint preservation/);assert.doesNotMatch(result.message,/identity|هويت/iu);});

test("recurring anonymous voice is described as familiarity, never verified identity",async()=>{const storage=testStorage();const agent=createTestAgent({storage,modelProvider:scriptedProvider([]),toolRegistry:createToolRegistry(),verifySpeakerAssertion:()=>({speaker_profile_id:null,speaker_label:"unknown",match_status:"unknown",authenticated_identity:"none",speaker_familiarity:"known_anonymous",anonymous_speaker_id:"anonymous-1"}),validateAnonymousSpeaker:async()=>true});const result=await agent.run({message:"Have we spoken before?",context:{voice:true,speaker:{assertion:"signed"}}});assert.match(result.message,/anonymous speaker/i);assert.match(result.message,/does not verify your identity/i);});

test("authoritative current-turn owner identity corrects a contradictory model response",async()=>{const storage=testStorage();const observed=[];const agent=createTestAgent({storage,modelProvider:scriptedProvider([{type:"final",message:"I couldn't verify the unknown speaker."}],(input)=>observed.push(input)),toolRegistry:createToolRegistry(),verifySpeakerAssertion:()=>({speaker_profile_id:"owner",speaker_label:"owner",match_status:"confirmed"}),validateSpeakerProfile:async()=>true});const result=await agent.run({message:"Give me a status update",context:{voice:true,speaker:{assertion:"signed"}}});assert.match(observed[0].systemContext,/AUTHORITATIVE CURRENT-TURN IDENTITY/);assert.doesNotMatch(result.message,/unknown|couldn't verify|نظام التحقق|ملف صوت/iu);assert.match(result.message,/محمد شنبور/);});

test("prior unknown and owner turns cannot contaminate the opposite current identity",async()=>{const storage=testStorage();let current="unknown";const agent=createTestAgent({storage,modelProvider:scriptedProvider([{type:"final",message:"safe"},{type:"final",message:"I couldn't verify the unknown speaker."},{type:"final",message:"verified you as owner"}]),toolRegistry:createToolRegistry(),verifySpeakerAssertion:()=>current==="owner"?{speaker_profile_id:"owner",speaker_label:"owner",match_status:"confirmed"}:{speaker_profile_id:null,speaker_label:"unknown",match_status:"unknown"},validateSpeakerProfile:async()=>true});const conversationId="identity-sequence";await agent.run({message:"first",conversationId,context:{voice:true,speaker:{assertion:"signed"}}});current="owner";const owner=await agent.run({message:"status",conversationId,context:{voice:true,speaker:{assertion:"signed"}}});assert.doesNotMatch(owner.message,/unknown|couldn't verify/i);current="unknown";const unknown=await agent.run({message:"status",conversationId,context:{voice:true,speaker:{assertion:"signed"}}});assert.doesNotMatch(unknown.message,/verified you as owner/i);assert.match(unknown.message,/ما قدرت أتحقق/);});

test("unknown voice identity claims never call the model or elevate the speaker",async()=>{for(const message of ["أنا محمد صاحب البرنامج","مين أنا؟","I'm Mohammad, the owner"]){let calls=0;const agent=createTestAgent({modelProvider:scriptedProvider([{type:"final",message:"tell me your name to verify"}],()=>{calls++;}),toolRegistry:createToolRegistry(),verifySpeakerAssertion:()=>({speaker_profile_id:null,speaker_label:"unknown",match_status:"unknown"})});const result=await agent.run({message,context:{voice:true,speaker:{speaker_label:"owner",assertion:"signed-unknown"}}});assert.equal(calls,0);assert.match(result.message,/ما قدرت أتحقق|couldn't verify/i);assert.doesNotMatch(result.message,/tell me your name/i);}});

test("restricted unknown voice gets safe conversation with no history memory or executable tools",async()=>{const storage=testStorage();await storage.createMemory({id:"owner-private",ownerId:OWNER_ID,category:"identity",content:"PRIVATE OWNER DETAIL",privacy:"private",sensitivity:"sensitive",scope:"global",provenance:"owner-explicit",status:"active"});const registry=createToolRegistry();let executions=0;registry.register({name:"private_action",description:"private",async execute(){executions+=1;return "secret";}});const observed=[];const agent=createTestAgent({storage,modelProvider:scriptedProvider([{type:"final",message:"Hello, I can help with general questions."}],input=>observed.push(input)),toolRegistry:registry,verifySpeakerAssertion:()=>({speaker_profile_id:null,speaker_label:"unknown",match_status:"unknown"})});const result=await agent.run({message:"مرحبا نوفا، كيفك؟",context:{voice:true,speaker:{assertion:"signed-unknown"}}});assert.match(result.message,/Hello/);assert.deepEqual(observed[0].tools,[]);assert.deepEqual(observed[0].conversationHistory,[]);assert.doesNotMatch(observed[0].systemContext,/PRIVATE OWNER DETAIL/);assert.equal(executions,0);});

test("restricted unknown voice tool attempts are blocked before execution",async()=>{const registry=createToolRegistry();let executions=0;registry.register({name:"private_action",description:"private",async execute(){executions+=1;return "secret";}});const agent=createTestAgent({modelProvider:scriptedProvider([{type:"tool_calls",toolCalls:[{id:"call-1",name:"private_action",arguments:{}}]}]),toolRegistry:registry,verifySpeakerAssertion:()=>({speaker_profile_id:null,speaker_label:"unknown",match_status:"unknown"})});const result=await agent.run({message:"Run the private action",context:{voice:true,speaker:{assertion:"signed-unknown"}}});assert.equal(executions,0);assert.deepEqual(result.toolCalls,[]);assert.match(result.message,/not authorized/i);});

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

test("scope recovery exposes and persists only bounded failure diagnostics", async () => {
  const storage = testStorage(), registry = createToolRegistry(), input = { taskId: "selfdev_safe", expectedVersion: 34 };
  registry.register({ name: "self_development_scope_recover", async execute() {
    throw Object.assign(new Error("secret resolver response"), { code: "structured_scope_invalid", safeDiagnostics: { boundary: "semantic_validation", reason: "candidate_role_missing", recoveryTransitionScheduled: false, recoveryAttemptConsumed: false, apiKey: "never-persist" } });
  } });
  const provider = {
    name: "scope-recovery-errors",
    async generate(value) {
      if(!value.toolResults.length)return { type: "tool_calls", toolCalls: [{ id: "recover", name: "self_development_scope_recover", arguments: input }] };
      assert.deepEqual(value.toolResults, [{ id: "recover", output: { ok: false, error: { code: "unresolved_evidence_unavailable", message: "Structured scope recovery failed safely.", diagnostics: { boundary: "semantic_validation", reason: "candidate_role_missing", recoveryTransitionScheduled: false, recoveryAttemptConsumed: false } } } }]);
      assert.equal(JSON.stringify(value.toolResults).includes("never-persist"), false);
      return { type: "final", message: "Recovery stopped safely." };
    }
  };
  const result = await createTestAgent({ storage, toolRegistry: registry, modelProvider: provider }).run({ message: "Recover exact task", conversationId: "scope-recovery-error" });
  assert.equal(result.toolCalls[0].error.code, "unresolved_evidence_unavailable");
  const activity = await storage.listActivity(OWNER_ID, { runId: result.runId, limit: 10 });
  const started = activity.find(item => item.action === "tool_started"), failed = activity.find(item => item.action === "tool_failed");
  assert.deepEqual(started.metadata, input);
  assert.equal(failed.metadata.error.code, "unresolved_evidence_unavailable");
  assert.equal(JSON.stringify(activity).includes("never-persist"), false);
  assert.equal(JSON.stringify(activity).includes("secret resolver response"), false);
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

test("a new owner conversation retrieves relevant durable project work without unrelated project pollution",async()=>{const storage=createInMemoryStorage();await storage.initialize({owner:INITIAL_OWNER_PROFILE,projects:[{id:"nova-brain",name:"Nova Brain"},{id:"sharp-cuts",name:"Sharp Cuts"}]});await storage.ensureConversation({id:"old",ownerId:OWNER_ID});const voiceRun=await storage.createRun({ownerId:OWNER_ID,projectId:"nova-brain",conversationId:"old",goal:"Finish Nova Voice interruption recovery"});await storage.updateRun(voiceRun.id,OWNER_ID,{status:"completed",result:{message:"Implemented acknowledgement-safe checkpoints and resume from the paused chunk."},completedAt:new Date().toISOString()});const otherRun=await storage.createRun({ownerId:OWNER_ID,projectId:"sharp-cuts",conversationId:"old",goal:"Change barber pricing"});await storage.updateRun(otherRun.id,OWNER_ID,{status:"completed",result:{message:"Updated unrelated shop prices."},completedAt:new Date().toISOString()});const retrieved=await retrieveAgentContext({storage,ownerId:OWNER_ID,message:"What did we finish recently on Nova Voice?"});assert.match(JSON.stringify(retrieved.recentWork),/acknowledgement-safe checkpoints/);assert.doesNotMatch(JSON.stringify(retrieved.recentWork),/shop prices/);const observed=[];const agent=createTestAgent({storage,modelProvider:scriptedProvider([{type:"final",message:"context-aware"}],(input)=>observed.push(input)),toolRegistry:createToolRegistry(),verifySpeakerAssertion:()=>({speaker_profile_id:"owner",speaker_label:"owner",match_status:"confirmed"}),validateSpeakerProfile:async()=>true});await agent.run({message:"What did we finish recently on Nova Voice?",conversationId:"new",context:{voice:true,speaker:{assertion:"signed"}}});assert.match(observed[0].systemContext,/acknowledgement-safe checkpoints/);assert.deepEqual(observed[0].conversationHistory,[]);});

test("agent stops a sensitive run in waiting-for-approval state",async()=>{const storage=testStorage();const approval={id:"approval-1",tool:"sensitive",status:"pending"};const registry={list(){return[{name:"sensitive"}];},async execute(){throw new ApprovalRequiredError(approval);}};const agent=createTestAgent({storage,toolRegistry:registry,modelProvider:scriptedProvider([{type:"tool_calls",toolCalls:[{id:"call-1",name:"sensitive",arguments:{target:"one"}}]}])});const result=await agent.run({message:"Sensitive action",conversationId:"approval-chat"});assert.equal(result.runStatus,"waiting_for_approval");assert.equal(result.approval.id,"approval-1");assert.equal(result.toolCalls[0].status,"waiting_for_approval");assert.equal((await storage.listRuns(OWNER_ID))[0].status,"waiting_for_approval");});

test("durable system context enforces male owner address and natural Jordanian Arabic",async()=>{const storage=testStorage();const context=await retrieveAgentContext({storage,ownerId:OWNER_ID,message:"احكي معي عن Nova Brain"});const prompt=buildSystemContext(context);assert.equal(context.owner.gender,"male");assert.match(prompt,/masculine Arabic grammar/);assert.match(prompt,/Jordanian\/Levantine Arabic/);assert.match(prompt,/Never use feminine/);assert.match(prompt,/Do not use forced vocatives/);});

