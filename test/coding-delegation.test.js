import test from "node:test";
import assert from "node:assert/strict";
import { createCodingDelegationService, codingDelegationFingerprint, isChatCodingDelegationRequest } from "../src/autonomy/coding-delegation.js";
import { codingSpecificationHash } from "../src/autonomy/coding-executor.js";
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
  const f=await fixture(),context={delegationRequestFingerprint:codingDelegationFingerprint("Use Codex to fix the drawer")};
  const first=await f.service.prepare(request,context),second=await f.service.prepare({...request,objective:"Model wording must not replace the existing prepared authority."},context);
  assert.equal(first.duplicate,false);assert.equal(second.duplicate,true);assert.equal(first.task.id,second.task.id);
  assert.equal(first.task.taskType,"coding_orchestration");assert.equal(first.task.metadata.autoDispatch,false);
  assert.deepEqual(first.codingJob.repository,{slug:"hshanbour/nova-brain",branch:"feature",baseline:BASE});
  assert.deepEqual(first.codingJob.delivery,{boundary:"local_commit",allowPush:false,allowDeploy:false});
  assert.equal(first.codingJob.version,1);assert.equal(first.task.metadata.codingDelegation.codingJobHash,codingSpecificationHash(first.codingJob));
  assert.equal(first.codingJob.parentTaskId,first.task.id);assert.equal((await f.storage.listAutonomyTasks(OWNER)).length,1);
});

test("preparation fails closed for ambiguous or arbitrary project authority and never accepts Main",async()=>{
  const ambiguous=await fixture([BINDING,{projectId:"other",workspaceId:"other",repository:"safe/other",branch:"feature"}]),context={delegationRequestFingerprint:codingDelegationFingerprint("Use Codex to fix it")};
  await assert.rejects(ambiguous.service.prepare(request,context),error=>error.code==="coding_project_binding_ambiguous");
  const f=await fixture();await assert.rejects(f.service.prepare({...request,projectId:"attacker"},context),error=>error.code==="coding_repository_binding_rejected");
  await assert.rejects(f.service.prepare(request,{}),error=>error.code==="coding_delegation_unbound");
  assert.throws(()=>createCodingDelegationService({runtime:f.runtime,storage:f.storage,ownerId:OWNER,bindings:[{...BINDING,branch:"main"}],verifyRemote:async()=>({currentTip:BASE})}),error=>error.code==="coding_binding_invalid");
});
