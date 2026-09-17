import test from "node:test";
import assert from "node:assert/strict";
import {createLocalWorkerHandoff} from "../src/autonomy/local-worker-handoff.js";
import {createWorkerRuntime} from "../src/autonomy/worker-runtime.js";
import {createExecutionScopeFixture,EXECUTION_TEST_WORKER} from "./execution-scope-fixture.js";

async function ready(t){
  const f=await createExecutionScopeFixture(t);await f.authorize();await f.recover();
  const task=await f.current();
  const input={taskId:f.taskId,workerId:EXECUTION_TEST_WORKER,runtimeVersion:f.runtimeVersion,repository:f.repository,repositoryRoot:f.root,continuationGenerationId:task.metadata.activeContinuation.generationId,expectedBranch:f.branch,expectedCommit:f.head,capabilities:["repo_mutate_local","test_local"],idempotencyKey:"synthetic-execution-claim"};
  return{...f,input};
}

test("server tick routes an execution successor to authenticated local Hands without running a product tool",async t=>{
  const f=await ready(t),before=await f.current();assert.ok(before.startedAt,"Successor creation sets its own bounded start timestamp");
  const runtime=createWorkerRuntime({storage:f.storage,ownerId:f.ownerId,clock:f.clock,capabilities:["repo_mutate_local","test_local"],toolRegistry:{async execute(){assert.fail("Server tick may not execute the product tools");}}});
  const result=await runtime.tickTask(f.taskId,{idempotencyKey:"synthetic-server-routing"}),after=await f.current();
  assert.equal(result.status,"waiting_for_worker");assert.equal(after.status,"waiting_for_worker");assert.equal(after.repairIteration,before.repairIteration);assert.equal(after.retryCount,before.retryCount);
  assert.deepEqual(after.metadata.executionScopeRecoveryHistory,before.metadata.executionScopeRecoveryHistory);assert.equal(after.leaseToken,null);
  assert.equal((await f.steps()).some(step=>step.stepId===before.metadata.executionScopeRecoveryHistory[0].applyStepId),false);await f.verifyBytes(f.beforeContents);
});

test("execution first claim atomically binds one fresh worker and duplicate is read-only idempotent",async t=>{
  const f=await ready(t),before=await f.current(),claimed=await f.handoff.claim(f.input),bound=await f.current(),record=bound.metadata.executionScopeRecoveryHistory[0];
  assert.equal(claimed.claimed,true);assert.equal(record.workerBindingState,"bound");assert.equal(record.workerId,EXECUTION_TEST_WORKER);assert.deepEqual(record.claimedStepIds,[record.applyStepId]);
  const duplicate=await f.handoff.claim(f.input);assert.equal(duplicate.idempotent,true);assert.equal(duplicate.handoff.handoffId,claimed.handoff.handoffId);assert.deepEqual(await f.current(),bound);
  const other={...f.input,workerId:"persistent-local-98765432-1234-4234-8234-123456789abc",idempotencyKey:"competing-claim"};
  await assert.rejects(()=>f.handoff.claim(other),error=>error.safeDiagnostics?.predicate==="worker_succession");
  assert.deepEqual(await f.current(),bound);assert.equal(bound.repairIteration,before.repairIteration);assert.equal(bound.retryCount,before.retryCount);await f.verifyBytes(f.beforeContents);
});

test("execution cannot reclaim a reserved apply after its handoff is lost",async t=>{
  const f=await ready(t);await f.handoff.claim(f.input);const bound=await f.current();
  // Synthetic storage fault fixture only: no live task or product state exists.
  await f.storage.updateAutonomyTask(f.taskId,f.ownerId,{status:"waiting_for_worker",leaseOwner:null,leaseToken:null,leaseExpiresAt:null,metadata:{...bound.metadata,localHandoff:null}},bound.stateVersion);
  const before=await f.current(),steps=await f.steps();
  await assert.rejects(()=>f.handoff.claim({...f.input,idempotencyKey:"never-replay"}),error=>error.code==="execution_scope_replay_forbidden");
  assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);await f.verifyBytes(f.beforeContents);
});

test("atomic execution reservation survives a crash before the durable apply step is created",async t=>{
  const f=await ready(t),interrupted=createLocalWorkerHandoff({storage:{...f.storage,async recordAutonomyStep(){throw new Error("Synthetic step storage interruption");}},ownerId:f.ownerId,approvedBranch:f.branch,clock:f.clock});
  await assert.rejects(()=>interrupted.claim(f.input),/Synthetic step storage interruption/);
  const reserved=await f.current(),record=reserved.metadata.executionScopeRecoveryHistory[0];
  assert.deepEqual(record.claimedStepIds,[record.applyStepId]);assert.equal((await f.steps()).some(step=>step.stepId===record.applyStepId),false);
  await f.storage.updateAutonomyTask(f.taskId,f.ownerId,{status:"waiting_for_worker",leaseOwner:null,leaseToken:null,leaseExpiresAt:null},reserved.stateVersion);
  const before=await f.current();await assert.rejects(()=>f.handoff.claim({...f.input,idempotencyKey:"post-crash-replay"}),error=>error.code==="execution_scope_replay_forbidden");
  assert.deepEqual(await f.current(),before);await f.verifyBytes(f.beforeContents);
});

test("execution apply failure consumes the one use without retry or repair counter changes",async t=>{
  const f=await ready(t),before=await f.current(),claimed=await f.handoff.claim(f.input);
  const failed=await f.handoff.fail(claimed.handoff.handoffId,{taskId:f.taskId,workerId:EXECUTION_TEST_WORKER,idempotencyKey:f.input.idempotencyKey,error:{code:"worker_crash",message:"Synthetic pre-apply interruption"}}),after=await f.current();
  assert.equal(failed.status,"failed");assert.equal(after.errorCode,"worker_crash");assert.equal(after.retryCount,before.retryCount);assert.equal(after.repairIteration,before.repairIteration);
  assert.equal(after.metadata.executionScopeRecoveryHistory[0].consumed,true);assert.equal(after.metadata.steps.length,before.metadata.steps.length);assert.equal(after.nextRunAt,null);
  assert.equal((await f.steps()).find(step=>step.stepId===claimed.handoff.stepId).attempt,1);
  assert.deepEqual(after.metadata.escalatedRepairHistory,before.metadata.escalatedRepairHistory);await f.verifyBytes(f.beforeContents);
});

test("expired execution handoff fails terminally rather than requeuing a second apply",async t=>{
  const f=await ready(t),before=await f.current(),claimed=await f.handoff.claim(f.input),expired=createLocalWorkerHandoff({storage:f.storage,ownerId:f.ownerId,approvedBranch:f.branch,clock:()=>new Date(f.clock().getTime()+300001)});
  await assert.rejects(()=>expired.fail(claimed.handoff.handoffId,{taskId:f.taskId,workerId:EXECUTION_TEST_WORKER,idempotencyKey:f.input.idempotencyKey,error:{code:"worker_crash",message:"Synthetic expired worker"}}),error=>error.code==="handoff_expired");
  const after=await f.current();assert.equal(after.status,"failed");assert.equal(after.errorCode,"execution_scope_handoff_expired");assert.equal(after.nextRunAt,null);assert.equal(after.metadata.localHandoff,null);assert.equal(after.metadata.executionScopeRecoveryHistory[0].consumed,true);
  assert.equal(after.retryCount,before.retryCount);assert.equal(after.repairIteration,before.repairIteration);await f.verifyBytes(f.beforeContents);
});
