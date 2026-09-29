import test from "node:test";
import assert from "node:assert/strict";
import {createInMemoryStorage} from "../src/storage/in-memory-storage.js";
import {INITIAL_OWNER_PROFILE,OWNER_ID} from "../src/identity/initial-context.js";
import {createExecutionTruthService} from "../src/autonomy/execution-truth.js";
import {createDurableWebResearchService,shouldUseDurableWebResearch} from "../src/web/durable-web-research.js";
import {createTerminalTaskReporter} from "../src/autonomy/terminal-task-reporter.js";

const LONG=`Research the UK market for barber booking systems.

1. Compare five systems used by UK barbers and salons.
2. Inspect current pricing, commission, booking, payments, reminders, staff management, marketing, and limitations.
3. Navigate one provider's real pricing page and research UK missed-call-recovery competitors and market gaps.
4. Produce one final business report with clickable evidence from current public sources. Choose whatever Web research depth you need and do not ask for approval merely because the research is deep.`;
const authority={autonomousDeep:true,explicitDeep:false,explicitBrowser:false,explicitResearch:true,ownerDomains:[],ownerUrls:[],navigation:null,presentation:{version:1,requestedFields:[]}};
const result={version:1,researchId:"web-evidence",query:"UK market",purpose:"competitor_research",performedAt:"2026-09-29T12:00:00Z",summary:"Five systems were compared.",sources:[{sourceId:"source_1",title:"Official pricing",url:"https://example.com/pricing",domain:"example.com",retrievedAt:"2026-09-29T12:00:00Z",contentHash:"a".repeat(64)}],pages:[{status:"completed",url:"https://example.com/pricing",domain:"example.com",title:"Pricing",text:"Verified pricing evidence.",contentHash:"a".repeat(64),retrievedAt:"2026-09-29T12:00:00Z",limitation:null}],actions:[{type:"search"}],limitations:[],usage:{searchCalls:4,costStatus:"settled",estimatedCostUsd:0.041}};

function fixture({gatewayResult=result}={}){
  const storage=createInMemoryStorage();storage.initialize({owner:INITIAL_OWNER_PROFILE});let gatewayCalls=0,modelCalls=0;
  const webGateway={async research(){gatewayCalls+=1;return structuredClone(gatewayResult);}},modelProvider={async generate(input){modelCalls+=1;assert.equal(input.costContext.taskId,input.costContext.runId);return{type:"final",message:"Verified report [Official pricing](https://example.com/pricing) [Invented](https://evil.example/)",providerUsage:{model:"gpt-6-luna",stage:"chat",inputTokens:100,outputTokens:20,totalTokens:120,costStatus:"settled",estimatedCostUsd:0.00002}};}},executionTruth=createExecutionTruthService({storage,ownerId:OWNER_ID}),service=createDurableWebResearchService({storage,ownerId:OWNER_ID,webGateway,modelProvider,executionTruth});
  return{storage,service,counts:()=>({gatewayCalls,modelCalls})};
}

test("quick public lookup remains synchronous while structured multi-part research is durable",()=>{
  assert.equal(shouldUseDurableWebResearch("Use web research to find today's official price.",{...authority,explicitResearch:true}),false);
  assert.equal(shouldUseDurableWebResearch(LONG,authority),true);
  assert.equal(shouldUseDurableWebResearch("Research sources then implement and commit a repository fix.",{...authority,explicitResearch:false}),false);
});

test("durable research establishes one canonical owner before provider work and resumes checkpoints exactly once",async()=>{
  const f=fixture();await f.storage.ensureConversation({id:"conversation-long",ownerId:OWNER_ID,title:"Long research"});const first=await f.service.prepare({request:LONG,conversationId:"conversation-long",runId:"chat-run-one",webAuthority:authority}),replay=await f.service.prepare({request:LONG,conversationId:"conversation-long",runId:"chat-run-retry",webAuthority:authority});
  assert.match(first.task.id,/^web_[a-f0-9]{32}$/);assert.equal(replay.task.id,first.task.id);assert.equal(replay.idempotent,true);assert.deepEqual(f.counts(),{gatewayCalls:0,modelCalls:0});assert.equal((await f.storage.getRun(first.task.id,OWNER_ID)).conversationId,"conversation-long");
  const research=await f.service.executeTask(first.task.id,{coordinatorId:"worker",expectedVersion:first.task.stateVersion});assert.equal(research.task.currentPhase,"research_completed");assert.deepEqual(f.counts(),{gatewayCalls:1,modelCalls:0});
  const completed=await f.service.executeTask(first.task.id,{coordinatorId:"worker",expectedVersion:research.task.stateVersion});assert.equal(completed.task.status,"completed");assert.deepEqual(f.counts(),{gatewayCalls:1,modelCalls:1});assert.match(completed.task.metadata.researchFinalAnswer,/Official pricing/);assert.doesNotMatch(completed.task.metadata.researchFinalAnswer,/\]\(https:\/\/evil\.example/);
  const latest=await f.storage.getLatestExecutionAttempt(first.task.id,OWNER_ID);assert.equal(latest.generation,2);assert.equal(latest.status,"completed");
});

test("an uncertain persisted provider boundary fails closed without replay or duplicate cost",async()=>{
  const f=fixture(),prepared=await f.service.prepare({request:LONG,conversationId:"conversation-uncertain",runId:"chat-run",webAuthority:authority});let task=prepared.task;task=await f.storage.updateAutonomyTask(task.id,OWNER_ID,{metadata:{...task.metadata,researchState:{version:1,phase:"research_in_flight",providerBoundary:{phase:"public_web_research",status:"in_flight"}}}},task.stateVersion);const failed=await f.service.executeTask(task.id,{coordinatorId:"worker",expectedVersion:task.stateVersion});assert.equal(failed.task.status,"failed");assert.equal(failed.task.errorCode,"web_provider_boundary_uncertain");assert.deepEqual(f.counts(),{gatewayCalls:0,modelCalls:0});
});

test("stale worker versions are fenced before provider execution",async()=>{
  const f=fixture(),prepared=await f.service.prepare({request:LONG,conversationId:"conversation-fence",runId:"chat-run",webAuthority:authority});await assert.rejects(()=>f.service.executeTask(prepared.task.id,{coordinatorId:"stale",expectedVersion:prepared.task.stateVersion+1}),error=>error.code==="web_research_task_fenced");assert.deepEqual(f.counts(),{gatewayCalls:0,modelCalls:0});
});

test("durable research reuses one existing browser child and resumes without repeating hosted research",async()=>{
  const storage=createInMemoryStorage();storage.initialize({owner:INITIAL_OWNER_PROFILE});await storage.ensureConversation({id:"conversation-browser-child",ownerId:OWNER_ID,title:"Research"});const childId=`web_${"b".repeat(32)}`;let gatewayCalls=0,modelCalls=0;
  const gateway={async research(){gatewayCalls+=1;await storage.createRun({id:childId,ownerId:OWNER_ID,conversationId:"conversation-browser-child",goal:"Read pricing",status:"queued"});await storage.createAutonomyTask({id:childId,ownerId:OWNER_ID,title:"Browser child",objective:"Read pricing",taskType:"public_web_browser",maxRuntimeMinutes:5,metadata:{requiredCapability:"remote_public_browser",browserJob:{version:2}}});return{...structuredClone(result),durableTask:{id:childId,status:"queued"}};}},modelProvider={async generate(){modelCalls+=1;return{type:"final",message:"Final report."};}},service=createDurableWebResearchService({storage,ownerId:OWNER_ID,webGateway:gateway,modelProvider,executionTruth:createExecutionTruthService({storage,ownerId:OWNER_ID})});
  const prepared=await service.prepare({request:LONG,conversationId:"conversation-browser-child",runId:"chat-run",webAuthority:authority}),waiting=await service.executeTask(prepared.task.id,{coordinatorId:"worker",expectedVersion:prepared.task.stateVersion});assert.equal(waiting.task.currentPhase,"waiting_for_browser");let child=await storage.getAutonomyTask(childId,OWNER_ID);child=await storage.updateAutonomyTask(childId,OWNER_ID,{status:"completed",currentPhase:"completed",completedAt:new Date().toISOString(),metadata:{...child.metadata,browserResult:{status:"completed",finalUrl:"https://example.com/pricing/details",domain:"example.com",title:"Pricing details",text:"Rendered pricing evidence",contentHash:"c".repeat(64),retrievedAt:new Date().toISOString()}}},child.stateVersion);assert.equal(child.status,"completed");
  const resumed=await service.executeTask(prepared.task.id,{coordinatorId:"worker",expectedVersion:waiting.task.stateVersion});assert.equal(resumed.task.currentPhase,"research_completed");assert.equal(resumed.task.metadata.researchResult.pages.some(page=>page.rendered===true),true);const completed=await service.executeTask(prepared.task.id,{coordinatorId:"worker",expectedVersion:resumed.task.stateVersion});assert.equal(completed.task.status,"completed");assert.equal(gatewayCalls,1);assert.equal(modelCalls,1);
});

test("terminal research delivery is exactly once in the originating conversation",async()=>{
  const f=fixture();await f.storage.ensureConversation({id:"conversation-report",ownerId:OWNER_ID,title:"Long research"});const prepared=await f.service.prepare({request:LONG,conversationId:"conversation-report",runId:"origin-run",webAuthority:authority}),research=await f.service.executeTask(prepared.task.id,{coordinatorId:"worker",expectedVersion:prepared.task.stateVersion});await f.service.executeTask(prepared.task.id,{coordinatorId:"worker",expectedVersion:research.task.stateVersion});const reporter=createTerminalTaskReporter({storage:f.storage,ownerId:OWNER_ID});await reporter.reconcile();await reporter.reconcile();const messages=await f.storage.listMessages("conversation-report",OWNER_ID);assert.equal(messages.filter(message=>message.role==="assistant").length,1);assert.match(messages.at(-1).content,/Official pricing/);assert.equal((await f.storage.listMessages("other-conversation",OWNER_ID)).length,0);
});
