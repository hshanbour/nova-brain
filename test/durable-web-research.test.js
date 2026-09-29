import test from "node:test";
import assert from "node:assert/strict";
import {createInMemoryStorage} from "../src/storage/in-memory-storage.js";
import {INITIAL_OWNER_PROFILE,OWNER_ID} from "../src/identity/initial-context.js";
import {createExecutionTruthService} from "../src/autonomy/execution-truth.js";
import {createDurableWebResearchService,researchQuery,researchSections,shouldUseDurableWebResearch} from "../src/web/durable-web-research.js";
import {createTerminalTaskReporter} from "../src/autonomy/terminal-task-reporter.js";

const LONG=`Research the UK market for barber booking systems.

1. Compare five systems used by UK barbers and salons.
2. Inspect current pricing, commission, booking, payments, reminders, staff management, marketing, and limitations.
3. Navigate one provider's real pricing page and research UK missed-call-recovery competitors and market gaps.
4. Produce one final business report with clickable evidence from current public sources. Choose whatever Web research depth you need and do not ask for approval merely because the research is deep.`;
const ORIGINAL_LONG=`I want to test your real web-research and browsing ability on practical business tasks.

Use whatever web capabilities you think are appropriate. Do not wait for me to tell you whether to use Search, Page Read, or Browser — choose the right method yourself.

Complete all three parts:

PART 1 — BARBER BOOKING SYSTEMS

I currently know Fresha.

Find 3 strong booking systems used by barbers or salons in the UK that could realistically compete with Fresha.

For each one, find and compare:
- Current pricing
- Any booking/customer commission
- Main features
- Online booking
- Payments
- Customer reminders
- Staff/team management
- Marketing features
- Any important limitations

Use current information from their real websites where possible.

PART 2 — REAL WEBSITE NAVIGATION

Choose one of the booking systems you found.

Actually navigate its official website and find its pricing/plans page.

Tell me:
- Cheapest paid plan
- Current price
- What is included
- Any important limits
- Whether there are extra fees

Do not rely only on a search-result summary if the information is available inside the website itself.

PART 3 — MISSED-CALL RECOVERY BUSINESS RESEARCH

Research the UK market for a business service that helps small businesses recover missed phone calls automatically using AI, SMS, WhatsApp, callbacks, or similar automation.

Find 5 real competitors or closely related services.

For each one, tell me:
- Company/product name
- What they offer
- Who they target
- Pricing if publicly available
- How their missed-call/recovery workflow works
- Their main selling point

Then compare them and tell me:
- What patterns you see in the market
- What customers appear to be paying for
- What common gaps or underserved needs you found
- 3 possible ways a new service could differentiate itself

Do not invent missing prices or features. Clearly say when something is not publicly available.

FINAL OUTPUT

Give me one clear business report with:
1. Barber booking-system comparison
2. Website pricing-page findings
3. Missed-call recovery competitor research
4. Key opportunities you found
5. Clickable evidence/sources for the important claims

Keep it practical and easy to understand.

I want the research itself, not an explanation of which tools you used.`;
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

test("section-aware query reduction preserves every subject in the exact long live request",()=>{
  const query=researchQuery(ORIGINAL_LONG);
  assert.ok(query.length<=500);assert.match(query,/PART 1/i);assert.match(query,/barber booking systems/i);assert.match(query,/\bUK\b/i);assert.match(query,/Fresha/i);assert.match(query,/PART 2/i);assert.match(query,/official pricing page/i);assert.match(query,/PART 3/i);assert.match(query,/missed-call recovery/i);assert.match(query,/\bUK\b/i);assert.match(query,/FINAL OUTPUT/i);
});

test("query reduction keeps short prompts unchanged and bounds long unstructured research",()=>{
  const short="Research current UK salon pricing from https://example.co.uk/plans.";assert.equal(researchQuery(short),short);
  const long=`${"General introductory boilerplate without a decision. ".repeat(30)} Research the United Kingdom market for Fresha competitors at https://example.co.uk/plans and compare current pricing, commission, and limitations.`;
  const query=researchQuery(long);assert.ok(query.length<=500);assert.match(query,/United Kingdom/);assert.match(query,/Fresha/);assert.match(query,/https:\/\/example\.co\.uk\/plans/);
});

test("structured reduction trims repeated boilerplate before substantive section content",()=>{
  const request=`${"I want to test your real web-research ability.\n".repeat(20)}PART 1 — UK SYSTEMS\nResearch AcmeBooking and Fresha pricing for UK salons.\nPART 2 — OFFICIAL SITE\nInspect https://acme.example.com/pricing and compare current plans.\nPART 3 — RECOVERY\nResearch UK missed-call recovery competitors.\nFINAL OUTPUT\nCompare verified limitations with clickable evidence.`;
  const query=researchQuery(request);assert.ok(query.length<=500);assert.doesNotMatch(query,/I want to test/);for(const heading of["PART 1","PART 2","PART 3","FINAL OUTPUT"])assert.match(query,new RegExp(heading));assert.match(query,/AcmeBooking/);assert.match(query,/Fresha/);assert.match(query,/https:\/\/acme\.example\.com\/pricing/);
});

test("the exact multi-part request becomes three bounded evidence phases with explicit completeness requirements",()=>{
  const sections=researchSections(ORIGINAL_LONG);assert.equal(sections.length,3);assert.deepEqual(sections.map(section=>section.requiredSources),[3,1,5]);assert.deepEqual(sections.map(section=>section.input.maxSources),[3,1,5]);assert.deepEqual(sections.map(section=>section.input.purpose),["competitor_research","pricing","competitor_research"]);
  assert.match(sections[0].query,/UK/i);assert.match(sections[0].query,/Fresha/);assert.match(sections[1].query,/official pricing page/i);assert.match(sections[2].query,/missed-call recovery/i);assert.match(sections[2].query,/5 distinct/i);for(const section of sections)assert.ok(section.query.length<=500);
});

test("durable multi-part research persists and resumes each section exactly once before synthesis",async()=>{
  const storage=createInMemoryStorage();storage.initialize({owner:INITIAL_OWNER_PROFILE});await storage.ensureConversation({id:"conversation-sections",ownerId:OWNER_ID,title:"Sections"});const calls=[];let modelCalls=0,systemContext="";
  const gateway={async research(input){const section=calls.length+1;calls.push(input.query);const sources=Array.from({length:input.maxSources},(_,index)=>({sourceId:`source_${index+1}`,title:`Section ${section} source ${index+1}`,url:`https://section${section}-${index+1}.example/evidence`,domain:`section${section}-${index+1}.example`,retrievedAt:"2026-09-29T12:00:00Z",contentHash:String(section).repeat(64)}));return{version:1,researchId:`research-${section}`,query:input.query,purpose:input.purpose,performedAt:"2026-09-29T12:00:00Z",summary:`Verified section ${section}.`,sources,pages:sources.map(source=>({status:"completed",url:source.url,domain:source.domain,title:source.title,text:`Evidence ${section}`,contentHash:source.contentHash,retrievedAt:source.retrievedAt,limitation:null})),actions:[{type:"search"}],limitations:[],usage:{searchCalls:1,costStatus:"settled",estimatedCostUsd:0.01}};}},modelProvider={async generate(input){modelCalls+=1;systemContext=input.systemContext;return{type:"final",message:"Complete report [evidence](https://section1-1.example/evidence)",providerUsage:{model:"gpt-6-luna",stage:"chat",inputTokens:10,outputTokens:10,totalTokens:20,costStatus:"settled",estimatedCostUsd:0.00001}};}},make=()=>createDurableWebResearchService({storage,ownerId:OWNER_ID,webGateway:gateway,modelProvider,executionTruth:createExecutionTruthService({storage,ownerId:OWNER_ID})});
  let service=make(),prepared=await service.prepare({request:ORIGINAL_LONG,conversationId:"conversation-sections",runId:"origin-run",webAuthority:authority});assert.equal(prepared.task.maxSteps,4);assert.equal(prepared.task.metadata.researchJob.version,2);assert.deepEqual(prepared.task.metadata.researchJob.sections.map(section=>section.requiredSources),[3,1,5]);
  let current=prepared.task;for(let index=0;index<3;index+=1){const value=await service.executeTask(current.id,{coordinatorId:"worker",expectedVersion:current.stateVersion});current=value.task;service=make();assert.equal(calls.length,index+1);assert.equal(modelCalls,0);}
  const completed=await service.executeTask(current.id,{coordinatorId:"worker",expectedVersion:current.stateVersion});assert.equal(completed.task.status,"completed");assert.equal(modelCalls,1);assert.equal(calls.length,3);assert.deepEqual(completed.result.coverage.map(item=>item.complete),[true,true,true]);assert.match(systemContext,/PART 3 — MISSED-CALL RECOVERY/);assert.equal(completed.result.sources.length,9);const steps=await storage.listAutonomySteps(current.id);assert.deepEqual(steps.map(step=>step.stepId),["1:public_web_research","2:public_web_research","3:public_web_research","4:research_synthesis"]);assert.deepEqual(steps.map(step=>step.attempt),[1,1,1,1]);
});

test("multi-part synthesis runs only after every bounded section pass and receives exact unsupported coverage",async()=>{
  const storage=createInMemoryStorage();storage.initialize({owner:INITIAL_OWNER_PROFILE});let gatewayCalls=0,synthesisContext="";const sparse={...structuredClone(result),sources:result.sources.slice(0,1)},service=createDurableWebResearchService({storage,ownerId:OWNER_ID,webGateway:{async research(){gatewayCalls+=1;return structuredClone(sparse);}},modelProvider:{async generate(input){synthesisContext=input.systemContext;return{type:"final",message:"Part 1 and Part 3 remain unsupported [source](https://example.com/pricing)"};}},executionTruth:createExecutionTruthService({storage,ownerId:OWNER_ID})});
  let current=(await service.prepare({request:ORIGINAL_LONG,conversationId:"conversation-incomplete",runId:"origin-run",webAuthority:authority})).task;for(let index=0;index<3;index+=1){const value=await service.executeTask(current.id,{coordinatorId:"worker",expectedVersion:current.stateVersion});current=value.task;assert.equal(current.status,"queued");assert.equal(gatewayCalls,index+1);assert.equal(synthesisContext,"");}const completed=await service.executeTask(current.id,{coordinatorId:"worker",expectedVersion:current.stateVersion});assert.equal(completed.task.status,"completed");assert.deepEqual(completed.result.coverage.map(item=>item.complete),[false,true,false]);assert.match(synthesisContext,/"heading":"PART 1 — BARBER BOOKING SYSTEMS"/);assert.match(synthesisContext,/"complete":false/);
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
