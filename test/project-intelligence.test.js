import test from "node:test";
import assert from "node:assert/strict";
import {createProjectService} from "../src/projects/project-service.js";
import {createTaskContextSnapshot} from "../src/memory/task-context-snapshot.js";
import {createInMemoryStorage} from "../src/storage/in-memory-storage.js";
import {createAgent} from "../src/agent/agent.js";
import {createToolRegistry} from "../src/tools/tool-registry.js";
import {registerSystemTools} from "../src/tools/developer-tools.js";
import {createActionPolicy} from "../src/policy/action-policy.js";
import {createDurableWebResearchService} from "../src/web/durable-web-research.js";
import {createExecutionTruthService} from "../src/autonomy/execution-truth.js";
import {createMemoryLearningService} from "../src/memory/learning-service.js";

const OWNER="owner";
const owner={id:OWNER,fullName:"Mohammad",preferences:{},facts:{}};

async function storageFixture(){
  const storage=createInMemoryStorage();
  await storage.initialize({owner,projects:[
    {id:"sharp-cuts",name:"Sharp Cuts",description:"Luton barber business."},
    {id:"sharp-cuts-web",name:"Sharp Cuts Web",description:"Website delivery project."},
    {id:"north-star-a",name:"North Star Alpha"},
    {id:"north-star-b",name:"North Star Beta"}
  ],memories:[
    {id:"sharp-fact",ownerId:OWNER,category:"project_context",content:"Sharp Cuts uses appointment reminders as an owner-verified retention constraint.",provenance:"owner-reviewed",privacy:"private",sensitivity:"business",scope:"project",projectId:"sharp-cuts",status:"active"},
    {id:"web-fact",ownerId:OWNER,category:"project_context",content:"Sharp Cuts Web uses an unrelated deployment framework.",provenance:"owner-reviewed",privacy:"private",sensitivity:"business",scope:"project",projectId:"sharp-cuts-web",status:"active"},
    {id:"global-preference",ownerId:OWNER,category:"preference",content:"Keep recommendations practical and concise.",provenance:"owner-reviewed",privacy:"private",sensitivity:"normal",scope:"global",status:"active"}
  ]});
  return storage;
}

test("project identity resolves the longest exact project name and fails closed on genuine ambiguity",async()=>{
  const storage=await storageFixture(),service=createProjectService({storage,ownerId:OWNER});
  assert.equal((await service.resolve({message:"Review Sharp Cuts Web deployment"})).project.id,"sharp-cuts-web");
  assert.equal((await service.resolve({message:"Review Sharp Cuts retention"})).project.id,"sharp-cuts");
  const multiple=await service.resolve({message:"Compare Sharp Cuts with Sharp Cuts Web"});assert.equal(multiple.status,"multiple");assert.deepEqual(new Set(multiple.projects.map(item=>item.id)),new Set(["sharp-cuts","sharp-cuts-web"]));
  const ambiguous=await service.resolve({message:"Continue the North Star project"});
  assert.equal(ambiguous.status,"ambiguous");
  assert.deepEqual(new Set(ambiguous.projects.map(item=>item.id)),new Set(["north-star-a","north-star-b"]));
});

test("new owner projects are durable, collision-safe, auditable, and immediately resolvable",async()=>{
  const storage=await storageFixture(),service=createProjectService({storage,ownerId:OWNER});
  const created=await service.create({name:"Luton Growth Lab",description:"New owner business experiment."});
  assert.equal(created.created,true);assert.equal(created.project.id,"luton-growth-lab");
  assert.equal((await service.resolve({message:"Continue Luton Growth Lab"})).project.id,"luton-growth-lab");
  assert.equal((await service.create({name:"Luton Growth Lab"})).created,false);
  assert.equal((await storage.listActivity(OWNER,{limit:20})).filter(item=>item.action==="project_created").length,1);
});

test("bounded task context includes relevant accepted project knowledge and excludes similarly named projects and secrets",async()=>{
  const storage=await storageFixture();
  await storage.createMemory({id:"secret",ownerId:OWNER,category:"project_context",content:"api_key=do-not-copy-this-value",provenance:"owner-reviewed",privacy:"private",sensitivity:"high",scope:"project",projectId:"sharp-cuts",status:"active"});
  const projects=await storage.listProjects(OWNER),memories=await storage.retrieveMemories(OWNER,"Sharp Cuts appointment reminders",{projectId:"sharp-cuts",limit:20});
  const snapshot=createTaskContextSnapshot({retrieved:{projects,memories,recentWork:[]},projectId:"sharp-cuts",request:"Research retention"});
  const encoded=JSON.stringify(snapshot);
  assert.match(encoded,/appointment reminders/);assert.doesNotMatch(encoded,/deployment framework/);assert.doesNotMatch(encoded,/do-not-copy/);assert.equal(snapshot.privacy.crossProjectFallback,false);assert.ok(Buffer.byteLength(encoded)<=16_384);
});

test("ambiguous project identity returns deterministic clarification before model, Web, workflow, or tools",async()=>{
  const storage=await storageFixture(),projectService=createProjectService({storage,ownerId:OWNER});let modelCalls=0,workflowCalls=0;
  const agent=createAgent({storage,ownerId:OWNER,projectService,toolRegistry:createToolRegistry(),modelProvider:{name:"never",async generate(){modelCalls+=1;throw new Error("must not run");}},routeDurableRequest:async()=>{workflowCalls+=1;throw new Error("must not run");}});
  const result=await agent.run({message:"Continue the North Star project",conversationId:"ambiguous-project"});
  assert.equal(result.runStatus,"clarification_required");assert.equal(result.provider,"project_registry");assert.match(result.message,/North Star Alpha/);assert.match(result.message,/North Star Beta/);assert.deepEqual({modelCalls,workflowCalls,tools:result.toolCalls.length},{modelCalls:0,workflowCalls:0,tools:0});
});

test("project creation reuses the generic registry as a bounded low-risk owner action",async()=>{
  const storage=await storageFixture(),projectService=createProjectService({storage,ownerId:OWNER}),policy=createActionPolicy({storage,ownerId:OWNER,approvedBranch:"preview"}),registry=createToolRegistry({policy});
  registerSystemTools(registry,{storage,ownerId:OWNER,projectService});
  const tool=registry.list().find(item=>item.name==="project_create");assert.equal(tool.riskLevel,"LOW_RISK_WRITE");
  await assert.rejects(()=>registry.execute("project_create",{name:"Accidental Project"},{runId:"run-create",ownerMessage:"Tell me what you know about this project."}),error=>error.code==="project_creation_intent_required");
  const result=await registry.execute("project_create",{name:"Customer Recovery Pilot",description:"Bounded pilot."},{runId:"run-create",ownerMessage:"Create a new project named Customer Recovery Pilot."});
  assert.equal(result.project.id,"customer-recovery-pilot");assert.equal(result.created,true);
});

test("durable worker synthesis receives the exact bounded snapshot while Web collection does not",async()=>{
  const storage=await storageFixture();await storage.ensureConversation({id:"grounded-worker",ownerId:OWNER});
  const snapshot=createTaskContextSnapshot({retrieved:{projects:await storage.listProjects(OWNER),memories:await storage.retrieveMemories(OWNER,"appointment reminders",{projectId:"sharp-cuts",limit:10}),recentWork:[]},projectId:"sharp-cuts",request:"Research current retention evidence"});
  let gatewayInput,systemContext="";
  const evidence={version:1,researchId:"evidence",query:"retention",purpose:"general_research",performedAt:"2026-10-08T12:00:00Z",summary:"Evidence retained.",sources:[{sourceId:"source_1",title:"Public evidence",url:"https://example.com/evidence",domain:"example.com",retrievedAt:"2026-10-08T12:00:00Z",contentHash:"a".repeat(64)}],pages:[{status:"completed",url:"https://example.com/evidence",domain:"example.com",title:"Evidence",text:"Appointment reminders may improve attendance.",contentHash:"a".repeat(64),retrievedAt:"2026-10-08T12:00:00Z",limitation:null}],actions:[{type:"search"}],limitations:[],usage:{searchCalls:1}};
  const service=createDurableWebResearchService({storage,ownerId:OWNER,webGateway:{async research(input){gatewayInput=structuredClone(input);return structuredClone(evidence);}},modelProvider:{async generate(input){if(input.responseFormat?.name==="nova_research_evidence_relevance"){const context=JSON.parse(input.message.slice(input.message.indexOf("\n")+1));return{type:"final",message:JSON.stringify({assessments:context.section.requirements.map(()=>({sourceIds:["source_1"]}))})};}systemContext=input.systemContext;const answer="Tailored Sharp Cuts report [Evidence](https://example.com/evidence)";return{type:"final",message:JSON.stringify({answer,claims:[{text:answer,classification:"public_research",sourceIds:["source_1"],memoryIds:[]}]})};}},executionTruth:createExecutionTruthService({storage,ownerId:OWNER})});
  let task=(await service.prepare({request:"Research current retention evidence in depth and produce a practical report with sources.",conversationId:"grounded-worker",runId:"origin",projectId:"sharp-cuts",taskContextSnapshot:snapshot,webAuthority:{ownerDomains:[]}})).task;
  assert.equal(task.metadata.researchJob.version,5);assert.equal(task.metadata.researchJob.taskContextSnapshot.snapshotHash,snapshot.snapshotHash);
  task=(await service.executeTask(task.id,{coordinatorId:"worker",expectedVersion:task.stateVersion})).task;
  const completed=await service.executeTask(task.id,{coordinatorId:"worker",expectedVersion:task.stateVersion});
  assert.equal(completed.task.status,"completed");assert.doesNotMatch(JSON.stringify(gatewayInput),/owner-verified retention constraint/);assert.match(systemContext,/owner-verified retention constraint/);assert.match(systemContext,/Never present a hypothesis/);assert.equal(completed.task.metadata.researchJob.taskContextSnapshot.snapshotHash,snapshot.snapshotHash);
});

test("corrections require and preserve one same-scope superseded memory",async()=>{
  const storage=await storageFixture(),learning=createMemoryLearningService({storage,ownerId:OWNER});
  const candidate=await learning.observeConversationTurn({message:"Correction: Sharp Cuts now prefers Saturday retention reviews.",conversationId:"correction",userMessageId:"user-correction",projectId:"sharp-cuts"});
  await assert.rejects(()=>learning.reviewCandidate(candidate.candidate.id,{decision:"accepted"}),error=>error.code==="memory_correction_target_required");
  await assert.rejects(()=>learning.reviewCandidate(candidate.candidate.id,{decision:"accepted",supersedesMemoryId:"web-fact"}),error=>error.code==="memory_correction_target_invalid");
  const accepted=await learning.reviewCandidate(candidate.candidate.id,{decision:"accepted",supersedesMemoryId:"sharp-fact"});
  assert.equal(accepted.memory.category,"project_context");assert.equal(accepted.memory.projectId,"sharp-cuts");assert.equal((await storage.listMemories(OWNER)).find(item=>item.id==="sharp-fact").status,"superseded");
});

test("failed-task lessons stay pending guardrails and never auto-promote",async()=>{
  const storage=await storageFixture(),learning=createMemoryLearningService({storage,ownerId:OWNER});
  const task={id:"failed-task",projectId:"sharp-cuts",taskType:"public_web_research",status:"failed",stateVersion:4,errorCode:"source_unavailable",blockedReason:"Authoritative booking data was unavailable.",metadata:{terminalReporting:{conversationId:"failed-conversation"}}};
  const result=await learning.observeTaskOutcome(task);
  assert.equal(result.candidate.candidateType,"failed_task_lesson");assert.equal(result.candidate.status,"pending");assert.equal((await storage.listMemories(OWNER)).some(item=>/Authoritative booking data/.test(item.content)),false);
});
