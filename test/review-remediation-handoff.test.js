import test from "node:test";
import assert from "node:assert/strict";
import {createLocalWorkerHandoff} from "../src/autonomy/local-worker-handoff.js";
import {createToolRegistry} from "../src/tools/tool-registry.js";
import {registerHandsTools} from "../src/tools/hands-runtime.js";
import {createReviewRemediationFixture,REVIEW_WORKER,assertReviewHistoriesPreserved} from "./review-remediation-fixture.js";

async function ready(t){
  const f=await createReviewRemediationFixture(t);await f.authorize();await f.recover();
  const task=await f.current(),input={taskId:f.taskId,workerId:REVIEW_WORKER,runtimeVersion:f.runtimeVersion,repository:f.repository,repositoryRoot:f.root,continuationGenerationId:task.metadata.activeContinuation.generationId,expectedBranch:f.branch,expectedCommit:f.head,capabilities:["repo_read_remote","repo_mutate_local","test_local"],idempotencyKey:"synthetic-review-claim"};
  return{...f,claimInput:input};
}

test("review-remediation first claim binds one worker and reserves one exact phase atomically",async t=>{
  const f=await ready(t),before=await f.current(),claimed=await f.handoff.claim(f.claimInput),bound=await f.current(),record=bound.metadata.reviewRemediationHistory[0];
  assert.equal(claimed.claimed,true);assert.equal(record.workerId,REVIEW_WORKER);assert.equal(record.workerBindingState,"bound");assert.deepEqual(record.claimedStepIds,[record.readStepIds[0]]);
  const duplicate=await f.handoff.claim(f.claimInput);assert.equal(duplicate.idempotent,true);assert.equal(duplicate.handoff.handoffId,claimed.handoff.handoffId);assert.deepEqual(await f.current(),bound);
  await assert.rejects(()=>f.handoff.claim({...f.claimInput,workerId:"persistent-local-98765432-1234-4234-8234-123456789abc",idempotencyKey:"competing"}),error=>error.code==="review_remediation_precondition_failed");assert.deepEqual(await f.current(),bound);
  const standalone=createToolRegistry();registerHandsTools(standalone,{root:f.root,environment:{NOVA_BRAIN_DEVELOPMENT_BRANCH:f.branch},commandRunner:f.commandRunner});
  const job=claimed.handoff,context={runId:f.taskId,stepId:job.stepId,workerId:REVIEW_WORKER,runtimeVersion:f.runtimeVersion,continuationGenerationId:record.activeContinuation.generationId,reviewRemediationScope:job.reviewRemediationScope,repositoryContext:{version:1,repository:f.repository,root:f.root,branch:f.branch,expectedHead:f.head,source:"persistent_worker_handoff"}};
  const read=await standalone.execute(job.tool,job.arguments,context);assert.equal(read.path,job.arguments.path);assert.equal(read.reviewRemediationEvidence.entries.length,8);assert.equal(read.baselineCommit,f.head);
  await assert.rejects(()=>standalone.execute(job.tool,job.arguments,context),error=>error.safeDiagnostics?.predicate==="remediation_local_replay");assert.deepEqual(await f.current(),bound);
  assertReviewHistoriesPreserved(before,bound);await f.verifySourceUnchanged();
});

test("review-remediation reservation survives a crash before the step record and cannot replay",async t=>{
  const f=await ready(t),interrupted=createLocalWorkerHandoff({storage:{...f.storage,async recordAutonomyStep(){throw new Error("Synthetic step-record interruption");}},ownerId:f.ownerId,approvedBranch:f.branch,clock:f.clock});
  await assert.rejects(()=>interrupted.claim(f.claimInput),/Synthetic step-record interruption/);
  const reserved=await f.current(),record=reserved.metadata.reviewRemediationHistory[0];assert.deepEqual(record.claimedStepIds,[record.readStepIds[0]]);assert.equal((await f.steps()).some(step=>step.stepId===record.readStepIds[0]),false);
  await f.storage.updateAutonomyTask(f.taskId,f.ownerId,{status:"waiting_for_worker",leaseOwner:null,leaseToken:null,leaseExpiresAt:null});
  const before=await f.current();await assert.rejects(()=>f.handoff.claim({...f.claimInput,idempotencyKey:"never-replay"}),error=>error.code==="review_remediation_replay_forbidden");assert.deepEqual(await f.current(),before);await f.verifySourceUnchanged();
});

test("review-remediation expiry before a claim consumes only the valid bound generation",async t=>{
  const f=await ready(t),before=await f.current(),expired=createLocalWorkerHandoff({storage:f.storage,ownerId:f.ownerId,approvedBranch:f.branch,clock:()=>new Date(f.clock().getTime()+900001)});
  await assert.rejects(()=>expired.claim({...f.claimInput,repositoryRoot:"C:/unrelated"}),error=>error.code==="review_remediation_precondition_failed");assert.deepEqual(await f.current(),before);
  const result=await expired.claim(f.claimInput),after=await f.current();assert.equal(result.claimed,false);assert.equal(result.code,"review_remediation_runtime_expired");assert.equal(after.status,"blocked");assert.equal(after.nextRunAt,null);assert.equal(after.metadata.reviewRemediationHistory[0].consumed,true);assert.equal(after.metadata.reviewRemediationBoundary.executionAuthorized,false);assertReviewHistoriesPreserved(before,after);await f.verifySourceUnchanged();
});

test("review-remediation post-read drift stops before another local phase and preserves consumed histories",async t=>{
  const f=await ready(t);await f.runSteps(1);const before=await f.current(),path=before.metadata.reviewRemediationHistory[0].requiredPaths[0],content=await f.read(path);
  await f.drift(path,content.replaceAll("\n","\r\n"));
  await assert.rejects(()=>f.worker.runOnce(),error=>error.code==="review_remediation_precondition_failed"&&error.safeDiagnostics?.predicate==="remediation_current_bytes");
  const after=await f.current();assert.equal(after.status,"blocked");assert.equal(after.metadata.reviewRemediationHistory[0].consumed,true);assert.equal(after.nextRunAt,null);assertReviewHistoriesPreserved(before,after);assert.equal(after.repairIteration,3);
});
