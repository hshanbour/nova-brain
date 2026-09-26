import test from "node:test";
import assert from "node:assert/strict";
import { createCodingDelegationService, codingDelegationFingerprint, isChatCodingDelegationRequest } from "../src/autonomy/coding-delegation.js";
import { codingSpecificationHash, createCodingExecutorService } from "../src/autonomy/coding-executor.js";
import { registerWorkerTools } from "../src/autonomy/worker-tools.js";
import { ApprovalRequiredError, createActionPolicy } from "../src/policy/action-policy.js";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";
import { createWorkerRuntime } from "../src/autonomy/worker-runtime.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";

const OWNER="owner",BASE="a".repeat(40),BINDING={projectId:"nova-brain",workspaceId:"nova-brain",repository:"hshanbour/nova-brain",branch:"feature"};

async function fixture(bindings=[BINDING]){
  const storage=createInMemoryStorage();await storage.initialize({owner:{id:OWNER},projects:[{id:"nova-brain",name:"Nova Brain"}]});
  const runtime=createWorkerRuntime({storage,ownerId:OWNER,toolRegistry:createToolRegistry(),approvedBranch:"feature"});
  let remoteCalls=0;const service=createCodingDelegationService({runtime,storage,ownerId:OWNER,bindings,verifyRemote:async input=>{remoteCalls++;assert.equal(input.repository,"hshanbour/nova-brain");assert.equal(input.branch,"feature");return{currentTip:BASE};}});
  return{storage,runtime,service,remoteCalls:()=>remoteCalls};
}

const request={objective:"Improve keyboard accessibility in the Recent Conversations drawer.",acceptanceCriteria:["Keyboard navigation and focus management work.","Existing Console behavior remains intact."],constraints:["Do not push or deploy."],verification:["Run focused Console tests."]};

test("natural explicit Codex requests use a first-class delegation route while ordinary and self-development chat do not",()=>{
  assert.equal(isChatCodingDelegationRequest("Build this in the current project. Use Codex for the coding."),true);
  assert.equal(isChatCodingDelegationRequest("Nova, improve your own Console implementation."),false);
  assert.equal(isChatCodingDelegationRequest("How should I improve keyboard accessibility?"),false);
});

test("preparation selects only the trusted project, resolves a fresh baseline, and is deterministic",async()=>{
  const f=await fixture(),context={delegationRequestFingerprint:codingDelegationFingerprint("Use Codex to fix the drawer"),conversationId:"conversation-1",runId:"run-1"};
  const first=await f.service.prepare(request,context),second=await f.service.prepare({...request,objective:"Model wording must not replace the existing prepared authority."},context);
  assert.equal(first.duplicate,false);assert.equal(second.duplicate,true);assert.equal(first.task.id,second.task.id);
  assert.equal(first.task.taskType,"coding_orchestration");assert.equal("metadata" in first.task,false);
  const persisted=await f.storage.getAutonomyTask(first.task.id,OWNER),stored=persisted.metadata.codingDelegation.codingJob;
  assert.equal("codingJob" in first,false);assert.equal("codingJob" in second,false);
  assert.deepEqual(stored.repository,{slug:"hshanbour/nova-brain",branch:"feature",baseline:BASE});
  assert.deepEqual(stored.delivery,{boundary:"local_commit",allowPush:false,allowDeploy:false});
  assert.equal(stored.version,1);assert.equal(persisted.metadata.codingDelegation.codingJobHash,codingSpecificationHash(stored));
  assert.deepEqual(first.creationRequest,{parentTaskId:first.task.id,specificationHash:codingSpecificationHash(stored)});
  assert.deepEqual(second.creationRequest,first.creationRequest);
  assert.equal(stored.parentTaskId,first.task.id);assert.equal((await f.storage.listAutonomyTasks(OWNER)).length,1);
  assert.deepEqual(persisted.metadata.terminalReporting,{version:1,conversationId:"conversation-1",runId:"run-1"});
});

test("the compact immutable creation handle reaches approval and the server creates from its stored canonical specification",async()=>{
  const f=await fixture(),runId="chat-run",prepared=await f.service.prepare(request,{delegationRequestFingerprint:codingDelegationFingerprint("Use Codex to fix the drawer"),conversationId:"conversation-1",runId});
  const codingExecutor=createCodingExecutorService({runtime:f.runtime,storage:f.storage,ownerId:OWNER,bindings:[BINDING]});
  const registry=createToolRegistry({policy:createActionPolicy({storage:f.storage,ownerId:OWNER,approvedBranch:"feature"})});
  registerWorkerTools(registry,{runtime:f.runtime,taskMigration:{migrate(){throw new Error("unused");}},codingExecutor,codingDelegation:f.service});
  const createTool=registry.list().find(tool=>tool.name==="coding_job_create");
  assert.deepEqual(Object.keys(createTool.inputSchema.properties).sort(),["parentTaskId","specificationHash"]);
  await assert.rejects(
    registry.execute("coding_job_create",{...prepared.creationRequest,objective:"must not be accepted"},{runId,projectId:BINDING.projectId}),
    error=>error.code==="schema_mismatch"&&error.safeDiagnostics?.fieldPath==="coding_job_create.objective"&&error.safeDiagnostics?.argumentKeys.includes("objective")&&!JSON.stringify(error.safeDiagnostics).includes("must not be accepted"),
  );
  await assert.rejects(
    registry.execute("coding_job_create",prepared.creationRequest,{runId,projectId:BINDING.projectId}),
    error=>error instanceof ApprovalRequiredError&&error.approval.tool==="coding_job_create"&&error.approval.runId===runId,
  );
  const approvals=await f.storage.listApprovals(OWNER);
  assert.equal(approvals.length,1);
  assert.equal(approvals[0].status,"pending");
  assert.deepEqual(approvals[0].arguments,prepared.creationRequest);
  await f.storage.decideApproval(approvals[0].id,OWNER,"approved");
  const created=await registry.execute("coding_job_create",prepared.creationRequest,{runId,projectId:BINDING.projectId,approvalId:approvals[0].id});
  assert.equal(created.task.metadata.codingJob.objective,request.objective);
  assert.equal(created.task.metadata.codingJob.approval.approvalId,approvals[0].id);
  assert.deepEqual(created.task.metadata.terminalReporting,{version:1,conversationId:"conversation-1",runId});
  assert.equal(created.task.metadata.steps[0].input.arguments.objective,request.objective);
  const duplicate=await registry.execute("coding_job_create",prepared.creationRequest,{runId,projectId:BINDING.projectId,approvalId:approvals[0].id});
  assert.equal(duplicate.duplicate,true);assert.equal((await f.storage.listAutonomyTasks(OWNER)).length,2);
});

test("already-approved historical full specifications retain a bounded dual-read replay path",async()=>{
  const f=await fixture(),prepared=await f.service.prepare(request,{delegationRequestFingerprint:codingDelegationFingerprint("Use Codex to fix the drawer")});
  const codingExecutor=createCodingExecutorService({runtime:f.runtime,storage:f.storage,ownerId:OWNER,bindings:[BINDING]});
  const registry=createToolRegistry({policy:{async authorize(){}}});
  registerWorkerTools(registry,{runtime:f.runtime,taskMigration:{migrate(){throw new Error("unused");}},codingExecutor,codingDelegation:f.service});
  const historical=(await f.storage.getAutonomyTask(prepared.task.id,OWNER)).metadata.codingDelegation.codingJob;
  await assert.rejects(registry.execute("coding_job_create",historical,{}),error=>error.code==="schema_mismatch");
  const created=await registry.execute("coding_job_create",historical,{approvalId:"historical-approval"});
  assert.equal(created.task.metadata.codingJob.approval.approvalId,"historical-approval");
});

test("preparation fails closed for ambiguous or arbitrary project authority and never accepts Main",async()=>{
  const ambiguous=await fixture([BINDING,{projectId:"other",workspaceId:"other",repository:"safe/other",branch:"feature"}]),context={delegationRequestFingerprint:codingDelegationFingerprint("Use Codex to fix it")};
  await assert.rejects(ambiguous.service.prepare(request,context),error=>error.code==="coding_project_binding_ambiguous");
  const f=await fixture();await assert.rejects(f.service.prepare({...request,projectId:"attacker"},context),error=>error.code==="coding_repository_binding_rejected");
  await assert.rejects(f.service.prepare(request,{}),error=>error.code==="coding_delegation_unbound");
  assert.throws(()=>createCodingDelegationService({runtime:f.runtime,storage:f.storage,ownerId:OWNER,bindings:[{...BINDING,branch:"main"}],verifyRemote:async()=>({currentTip:BASE})}),error=>error.code==="coding_binding_invalid");
});
