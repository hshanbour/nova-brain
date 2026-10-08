import test from "node:test";
import assert from "node:assert/strict";
import {createAgent} from "../src/agent/agent.js";
import {createExecutionTruthService} from "../src/autonomy/execution-truth.js";
import {createTerminalTaskReporter} from "../src/autonomy/terminal-task-reporter.js";
import {createMemoryLearningService} from "../src/memory/learning-service.js";
import {createTaskContextSnapshot} from "../src/memory/task-context-snapshot.js";
import {createActionPolicy} from "../src/policy/action-policy.js";
import {createProjectService} from "../src/projects/project-service.js";
import {createInMemoryStorage} from "../src/storage/in-memory-storage.js";
import {registerSystemTools} from "../src/tools/developer-tools.js";
import {createToolRegistry} from "../src/tools/tool-registry.js";
import {createDurableWebResearchService} from "../src/web/durable-web-research.js";
import {parseGroundedAnswer} from "../src/web/evidence-grounding.js";

const OWNER="owner";
const owner={id:OWNER,fullName:"Mohammad",preferences:{},facts:{}};
const evidence={version:1,researchId:"research",query:"retention",purpose:"general",performedAt:"2026-10-08T12:00:00Z",summary:"Public reminder evidence.",sources:[{sourceId:"source_1",title:"Reminder study",url:"https://example.com/reminders",domain:"example.com",retrievedAt:"2026-10-08T12:00:00Z",contentHash:"a".repeat(64)}],pages:[{status:"completed",url:"https://example.com/reminders",domain:"example.com",title:"Reminder study",text:"Reminder evidence is available.",contentHash:"a".repeat(64),retrievedAt:"2026-10-08T12:00:00Z",limitation:null}],actions:[{type:"search"}],limitations:[],usage:{searchCalls:1,costStatus:"settled",estimatedCostUsd:0.001}};

async function projectStorage(){const storage=createInMemoryStorage();await storage.initialize({owner,projects:[{id:"sharp-cuts",name:"Sharp Cuts"},{id:"sharp-cuts-web",name:"Sharp Cuts Web"}]});return storage;}
const assessment=input=>{const context=JSON.parse(input.message.slice(input.message.indexOf("\n")+1));return{type:"final",message:JSON.stringify({assessments:context.section.requirements.map(()=>({sourceIds:["source_1"]}))})};};

test("an exact request naming two independent projects fails closed before model or tools",async()=>{
  const storage=await projectStorage(),projectService=createProjectService({storage,ownerId:OWNER});let modelCalls=0;
  const agent=createAgent({storage,ownerId:OWNER,projectService,toolRegistry:createToolRegistry(),modelProvider:{name:"never",async generate(){modelCalls+=1;throw new Error("must not run");}}});
  const result=await agent.run({message:"Compare Sharp Cuts and Sharp Cuts Web",conversationId:"two-projects"});
  assert.equal(result.runStatus,"clarification_required");assert.equal(result.projectResolution.status,"multiple");assert.equal(modelCalls,0);assert.deepEqual(new Set(result.projectResolution.candidates.map(item=>item.id)),new Set(["sharp-cuts","sharp-cuts-web"]));
});
test("bounded task context retains a reviewed lesson beyond six newer memories without cross-project leakage",async()=>{
  const storage=await projectStorage();
  await storage.createMemory({id:"lesson",ownerId:OWNER,category:"reusable_instruction",content:"Completed-task lesson: verify retention claims before recommending them.",provenance:"memory-candidate:completed_task:accepted",privacy:"private",sensitivity:"normal",scope:"project",projectId:"sharp-cuts",status:"active"});
  for(let index=0;index<8;index+=1)await storage.createMemory({id:`fact-${index}`,ownerId:OWNER,category:"project_context",content:`Sharp Cuts research fact ${index} about retention.`,provenance:"owner-reviewed",privacy:"private",sensitivity:"normal",scope:"project",projectId:"sharp-cuts",status:"active"});
  await storage.createMemory({id:"irrelevant-global",ownerId:OWNER,category:"preference",content:"My private unrelated test phrase is ORANGE-4421.",provenance:"owner-explicit",privacy:"private",sensitivity:"normal",scope:"global",projectId:null,status:"active"});
  await storage.createMemory({id:"web-secret",ownerId:OWNER,category:"project_context",content:"Sharp Cuts Web private deployment context.",provenance:"owner-reviewed",privacy:"private",sensitivity:"normal",scope:"project",projectId:"sharp-cuts-web",status:"active"});
  const retrieved={projects:await storage.listProjects(OWNER),memories:await storage.retrieveMemories(OWNER,"Sharp Cuts retention",{projectId:"sharp-cuts",limit:12}),recentWork:[]},snapshot=createTaskContextSnapshot({retrieved,projectId:"sharp-cuts",request:"Research for Sharp Cuts using accepted project memory and retention evidence"});
  assert.equal(snapshot.acceptedMemories.length,6);assert.ok(snapshot.priorLessons.some(item=>item.memoryId==="lesson"));assert.match(JSON.stringify(snapshot),/verify retention claims/);assert.doesNotMatch(JSON.stringify(snapshot),/deployment context|ORANGE-4421/);
});

test("explicit memory correction preserves immutable history and activates only the replacement",async()=>{
  const storage=await projectStorage(),policy=createActionPolicy({storage,ownerId:OWNER,approvedBranch:"preview"}),registry=createToolRegistry({policy});registerSystemTools(registry,{storage,ownerId:OWNER,projectService:createProjectService({storage,ownerId:OWNER})});
  const first=await registry.execute("memory_remember",{content:"Sharp Cuts reviews retention every Friday.",category:"project_context",scope:"project",projectId:"sharp-cuts"},{runId:"memory-run",ownerMessage:"Remember that Sharp Cuts reviews retention every Friday."});
  const replacement=await registry.execute("memory_remember",{content:"Sharp Cuts reviews retention every Saturday.",category:"project_context",scope:"project",projectId:"sharp-cuts"},{runId:"memory-run-2",ownerMessage:"Remember this correction: Sharp Cuts reviews retention every Saturday."});
  const all=await storage.listMemories(OWNER,{projectId:"sharp-cuts"});assert.equal(replacement.operation,"superseded");assert.equal(replacement.supersededMemoryId,first.memory.id);assert.equal(all.find(item=>item.id===first.memory.id).status,"superseded");assert.equal(all.find(item=>item.id===replacement.memory.id).status,"active");assert.deepEqual((await storage.retrieveMemories(OWNER,"retention Saturday",{projectId:"sharp-cuts",limit:10})).map(item=>item.id),[replacement.memory.id]);
});

test("final claim validation binds public, reviewed-memory, and unknown claims and rejects unsupported quantitative assertions",()=>{
  const snapshot={acceptedMemories:[{id:"memory-1",evidenceType:"owner_claim"},{id:"hypothesis-1",evidenceType:"hypothesis"}]},result=evidence;
  const answer="The owner says reminders are a priority. Public evidence discusses reminders. Current booking figures are unknown.";
  const valid=parseGroundedAnswer({type:"final",message:JSON.stringify({answer,claims:[{text:"The owner says reminders are a priority.",classification:"owner_claim",sourceIds:[],memoryIds:["memory-1"]},{text:"Public evidence discusses reminders.",classification:"public_research",sourceIds:["source_1"],memoryIds:[]},{text:"Current booking figures are unknown.",classification:"unknown",sourceIds:[],memoryIds:[]}]})},{result,taskContextSnapshot:snapshot});
  assert.equal(valid.claims.length,3);
  const canonicalUnknown=parseGroundedAnswer({type:"final",message:JSON.stringify({answer:"Current revenue is unknown.",claims:[{text:"Current revenue is unknown.",classification:"unknown",sourceIds:["source_1"],memoryIds:["memory-1"]}]})},{result,taskContextSnapshot:snapshot});assert.deepEqual(canonicalUnknown.claims[0].sourceIds,[]);assert.deepEqual(canonicalUnknown.claims[0].memoryIds,[]);
  assert.equal(parseGroundedAnswer({type:"final",message:JSON.stringify({answer:"No accepted project memory confirms current website or integrations.",claims:[{text:"No accepted project memory confirms current website or integrations.",classification:"unknown",sourceIds:[],memoryIds:[]}]})},{result,taskContextSnapshot:snapshot}).claims[0].classification,"unknown");
  const formatted=parseGroundedAnswer({type:"final",message:JSON.stringify({answer:"Send one brief, manual SMS reminder about **two days before** each booked appointment.",claims:[{text:"Send one SMS reminder about two days before each booked appointment.",classification:"public_research",sourceIds:["source_1"],memoryIds:[]}]})},{result,taskContextSnapshot:snapshot});assert.equal(formatted.claims.length,1);
  assert.throws(()=>parseGroundedAnswer({type:"final",message:JSON.stringify({answer:"Current revenue is £50,000.",claims:[]})},{result,taskContextSnapshot:snapshot}),error=>error.code==="web_research_grounding_invalid"&&error.safeDiagnostics.reasonCode==="important_claim_unmapped");
  assert.throws(()=>parseGroundedAnswer({type:"final",message:JSON.stringify({answer:"This is verified.",claims:[{text:"This is verified.",classification:"verified_memory",sourceIds:[],memoryIds:["hypothesis-1"]}]})},{result,taskContextSnapshot:snapshot}),error=>error.safeDiagnostics.reasonCode==="unverified_memory_claim");
});

test("a context-bearing durable task resumes after a worker restart and reports exactly once",async()=>{
  const storage=await projectStorage();await storage.ensureConversation({id:"restart",ownerId:OWNER});await storage.createMemory({id:"sharp-context",ownerId:OWNER,category:"project_context",content:"Sharp Cuts prioritizes appointment reminders.",provenance:"owner-explicit",privacy:"private",sensitivity:"normal",scope:"project",projectId:"sharp-cuts",status:"active"});
  const snapshot=createTaskContextSnapshot({retrieved:{projects:await storage.listProjects(OWNER),memories:await storage.retrieveMemories(OWNER,"Sharp Cuts reminders",{projectId:"sharp-cuts",limit:12}),recentWork:[]},projectId:"sharp-cuts",request:"Research reminder practices"});let gatewayCalls=0,synthesisCalls=0,seenSnapshotHash=null;
  const gateway={async research(){gatewayCalls+=1;return structuredClone(evidence);}},provider={async generate(input){if(input.responseFormat?.name==="nova_research_evidence_relevance")return assessment(input);synthesisCalls+=1;seenSnapshotHash=JSON.parse(input.systemContext.match(/TRUSTED BOUNDED PROJECT CONTEXT JSON:\n(\{.*\})\nUse accepted/s)?.[1]||"null")?.snapshotHash||null;const answer="Sharp Cuts prioritizes appointment reminders. Public evidence discusses reminders. Current booking figures are unknown.";return{type:"final",message:JSON.stringify({answer,claims:[{text:"Sharp Cuts prioritizes appointment reminders.",classification:"owner_claim",sourceIds:[],memoryIds:["sharp-context"]},{text:"Public evidence discusses reminders.",classification:"public_research",sourceIds:["source_1"],memoryIds:[]},{text:"Current booking figures are unknown.",classification:"unknown",sourceIds:[],memoryIds:[]}]})};}};
  const first=createDurableWebResearchService({storage,ownerId:OWNER,webGateway:gateway,modelProvider:provider,executionTruth:createExecutionTruthService({storage,ownerId:OWNER})});let task=(await first.prepare({request:"Research reminder practices deeply and return sourced recommendations.",conversationId:"restart",runId:"origin",projectId:"sharp-cuts",taskContextSnapshot:snapshot,webAuthority:{ownerDomains:[]}})).task;task=(await first.executeTask(task.id,{coordinatorId:"worker-before",expectedVersion:task.stateVersion})).task;assert.equal(task.currentPhase,"research_completed");
  const restarted=createDurableWebResearchService({storage,ownerId:OWNER,webGateway:gateway,modelProvider:provider,executionTruth:createExecutionTruthService({storage,ownerId:OWNER})}),completed=await restarted.executeTask(task.id,{coordinatorId:"worker-after",expectedVersion:task.stateVersion});assert.equal(completed.task.status,"completed");assert.equal(completed.task.metadata.researchJob.taskContextSnapshot.snapshotHash,snapshot.snapshotHash);assert.equal(seenSnapshotHash,snapshot.snapshotHash);assert.deepEqual({gatewayCalls,synthesisCalls},{gatewayCalls:1,synthesisCalls:1});
  const reporter=createTerminalTaskReporter({storage,ownerId:OWNER,learningService:createMemoryLearningService({storage,ownerId:OWNER})});await reporter.reconcile();await reporter.reconcile();assert.equal((await storage.listMessages("restart",OWNER)).filter(item=>item.role==="assistant").length,1);assert.equal((await storage.listMemoryCandidates(OWNER,{sourceTaskId:task.id})).length,1);
});
