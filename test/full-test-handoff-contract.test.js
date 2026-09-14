import test from "node:test";
import assert from "node:assert/strict";
import {writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createLocalWorkerHandoff} from "../src/autonomy/local-worker-handoff.js";
import {createWorkerRuntime} from "../src/autonomy/worker-runtime.js";
import {createPersistentLocalWorker} from "../src/autonomy/persistent-local-worker.js";
import {createToolRegistry} from "../src/tools/tool-registry.js";
import {registerHandsTools} from "../src/tools/hands-runtime.js";
import {createFullTestScopeFixture,FULL_TEST_WORKER} from "./full-test-scope-fixture.js";

async function ready(t){
  const f=await createFullTestScopeFixture(t);await f.authorize();await f.recover();
  const task=await f.current(),input={taskId:f.taskId,workerId:FULL_TEST_WORKER,runtimeVersion:f.runtimeVersion,repository:f.repository,repositoryRoot:f.root,continuationGenerationId:task.metadata.activeContinuation.generationId,expectedBranch:f.branch,expectedCommit:f.head,capabilities:["test_local"],idempotencyKey:"synthetic-full-test-claim"};
  return{...f,input};
}

test("server tick routes only the new full-test successor without reopening consumed execution authority",async t=>{
  const f=await ready(t),before=await f.current(),runtime=createWorkerRuntime({storage:f.storage,ownerId:f.ownerId,clock:f.clock,capabilities:["test_local"],toolRegistry:{async execute(){assert.fail("Full tests must remain in authenticated local Hands");}}});
  const result=await runtime.tickTask(f.taskId,{idempotencyKey:"synthetic-full-routing"}),after=await f.current();
  assert.equal(result.status,"waiting_for_worker");assert.equal(after.status,"waiting_for_worker");assert.equal(after.leaseToken,null);
  assert.equal(after.repairIteration,before.repairIteration);assert.equal(after.retryCount,before.retryCount);assert.deepEqual(after.metadata.executionScopeRecoveryHistory,before.metadata.executionScopeRecoveryHistory);assert.deepEqual(after.metadata.fullTestScopeRecoveryHistory,before.metadata.fullTestScopeRecoveryHistory);
  assert.equal((await f.steps()).some(step=>step.stepId===before.metadata.fullTestScopeRecoveryHistory[0].fullTestStepId),false);await f.verifyBytes(f.afterContents);
});

test("full-test first claim binds exactly one fresh worker and duplicate claim is read-only idempotent",async t=>{
  const f=await ready(t),before=await f.current(),claim=await f.handoff.claim(f.input),bound=await f.current(),record=bound.metadata.fullTestScopeRecoveryHistory[0];
  assert.equal(claim.claimed,true);assert.equal(record.workerBindingState,"bound");assert.equal(record.workerId,FULL_TEST_WORKER);assert.deepEqual(record.claimedStepIds,[record.fullTestStepId]);assert.deepEqual(claim.handoff.arguments,{});assert.equal(claim.handoff.tool,"test_run_full");
  assert.equal(Date.parse(claim.handoff.deadline),Date.parse(record.activeContinuation.runtimeDeadline));assert.ok(Date.parse(bound.leaseExpiresAt)-f.clock().getTime()>=125000);
  const duplicate=await f.handoff.claim(f.input);assert.equal(duplicate.idempotent,true);assert.equal(duplicate.handoff.handoffId,claim.handoff.handoffId);assert.deepEqual(await f.current(),bound);
  await assert.rejects(()=>f.handoff.claim({...f.input,workerId:"persistent-local-98765432-1234-4234-8234-123456789abc",idempotencyKey:"competing"}),error=>error.safeDiagnostics?.predicate==="worker_succession");
  assert.deepEqual(await f.current(),bound);assert.deepEqual(bound.metadata.executionScopeRecoveryHistory,before.metadata.executionScopeRecoveryHistory);assert.equal(bound.repairIteration,before.repairIteration);await f.verifyBytes(f.afterContents);
});

test("full-test reservation cannot be replayed after its handoff is lost",async t=>{
  const f=await ready(t);await f.handoff.claim(f.input);const bound=await f.current();
  // Isolated in-memory storage fault, never a real task or product workspace.
  await f.storage.updateAutonomyTask(f.taskId,f.ownerId,{status:"waiting_for_worker",leaseOwner:null,leaseToken:null,leaseExpiresAt:null,metadata:{...bound.metadata,localHandoff:null}},bound.stateVersion);
  const before=await f.current(),steps=await f.steps();await assert.rejects(()=>f.handoff.claim({...f.input,idempotencyKey:"lost-handoff-replay"}),error=>error.code==="full_test_scope_replay_forbidden");assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);await f.verifyBytes(f.afterContents);
});

test("atomic full-test reservation survives storage interruption before the execution step is created",async t=>{
  const f=await ready(t),interrupted=createLocalWorkerHandoff({storage:{...f.storage,async recordAutonomyStep(){throw new Error("Synthetic full-test step interruption");}},ownerId:f.ownerId,approvedBranch:f.branch,clock:f.clock});
  await assert.rejects(()=>interrupted.claim(f.input),/Synthetic full-test step interruption/);const reserved=await f.current(),record=reserved.metadata.fullTestScopeRecoveryHistory[0];assert.deepEqual(record.claimedStepIds,[record.fullTestStepId]);assert.equal((await f.steps()).some(step=>step.stepId===record.fullTestStepId),false);
  await f.storage.updateAutonomyTask(f.taskId,f.ownerId,{status:"waiting_for_worker",leaseOwner:null,leaseToken:null,leaseExpiresAt:null},reserved.stateVersion);const before=await f.current();
  await assert.rejects(()=>f.handoff.claim({...f.input,idempotencyKey:"post-crash-full-replay"}),error=>error.code==="full_test_scope_replay_forbidden");assert.deepEqual(await f.current(),before);await f.verifyBytes(f.afterContents);
});

test("full-test infrastructure failure consumes the single use without repair or counter changes",async t=>{
  const f=await ready(t),before=await f.current(),claim=await f.handoff.claim(f.input);
  const result=await f.handoff.fail(claim.handoff.handoffId,{taskId:f.taskId,workerId:FULL_TEST_WORKER,idempotencyKey:f.input.idempotencyKey,error:{code:"test_runner_unavailable",message:"Synthetic npm runner unavailable"}}),after=await f.current();
  assert.equal(result.status,"failed");assert.equal(after.errorCode,"test_runner_unavailable");assert.equal(after.metadata.fullTestScopeRecoveryHistory[0].consumed,true);assert.equal(after.metadata.fullTestScopeBoundary.kind,"full_test_infrastructure_failure");assert.equal(after.metadata.fullTestScopeBoundary.mutationApplied,null,"An unobserved runner outcome cannot claim unchanged product bytes");assert.equal(after.nextRunAt,null);assert.equal(after.retryCount,before.retryCount);assert.equal(after.repairIteration,before.repairIteration);assert.equal(after.metadata.steps.length,before.metadata.steps.length);assert.deepEqual(after.metadata.escalatedRepairHistory,before.metadata.escalatedRepairHistory);assert.deepEqual(after.metadata.executionScopeRecoveryHistory,before.metadata.executionScopeRecoveryHistory);await f.verifyBytes(f.afterContents);
});

test("expired full-test handoff terminalizes without queuing another run",async t=>{
  const f=await ready(t),before=await f.current(),claim=await f.handoff.claim(f.input),expired=createLocalWorkerHandoff({storage:f.storage,ownerId:f.ownerId,approvedBranch:f.branch,clock:()=>new Date(f.clock().getTime()+300001)});
  await assert.rejects(()=>expired.fail(claim.handoff.handoffId,{taskId:f.taskId,workerId:FULL_TEST_WORKER,idempotencyKey:f.input.idempotencyKey,error:{code:"worker_crash",message:"Synthetic expired runner"}}),error=>error.code==="handoff_expired");const after=await f.current();assert.equal(after.status,"failed");assert.equal(after.errorCode,"full_test_scope_handoff_expired");assert.equal(after.metadata.fullTestScopeBoundary.mutationApplied,null);assert.equal(after.metadata.fullTestScopeBoundary.workspaceDriftObserved,null);assert.equal(after.metadata.fullTestScopeRecoveryHistory[0].consumed,true);assert.equal(after.metadata.localHandoff,null);assert.equal(after.nextRunAt,null);assert.equal(after.retryCount,before.retryCount);assert.equal(after.repairIteration,before.repairIteration);assert.deepEqual(after.metadata.executionScopeRecoveryHistory,before.metadata.executionScopeRecoveryHistory);assert.equal((await f.steps()).find(step=>step.stepId===claim.handoff.stepId).status,"failed");await f.verifyBytes(f.afterContents);
});

test("full-test completion rejects absent or drifted post-run evidence before changing durable state",async t=>{
  const f=await ready(t),claim=await f.handoff.claim(f.input),before=await f.current(),steps=await f.steps(),record=before.metadata.fullTestScopeRecoveryHistory[0];
  for(const evidence of [undefined,{generationId:record.activeContinuation.generationId,planHash:record.planHash,entries:record.entries.slice(1)}]){
    await assert.rejects(()=>f.handoff.complete(claim.handoff.handoffId,{taskId:f.taskId,workerId:FULL_TEST_WORKER,idempotencyKey:f.input.idempotencyKey,result:{ok:true,exitCode:0,fullTestScopeEvidence:evidence}}),error=>error.code==="full_test_scope_result_invalid");assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);
  }
  await f.verifyBytes(f.afterContents);
});

test("full-test runner will not spawn when default timeout plus persistence cannot fit the remaining window",async t=>{
  const f=await ready(t),claimed=await f.claimFullTest(),before=await f.current(),count=f.commands.length;
  t.mock.method(Date,"now",()=>f.clock().getTime()+176000);
  await assert.rejects(()=>f.hands.execute("test_run_full",{},claimed.context),error=>error.safeDiagnostics?.predicate==="full_test_runtime_insufficient");
  t.mock.restoreAll();assert.deepEqual(await f.current(),before);assert.equal(f.commands.slice(count).some(command=>command.args.some(arg=>arg.endsWith("npm-cli.js"))||command.file==="npm"),false);await f.verifyBytes(f.afterContents);
});

test("the same active full-test context cannot invoke npm twice before durable completion",async t=>{
  const f=await ready(t),claimed=await f.claimFullTest(),before=await f.current(),count=f.commands.length,result=await f.hands.execute("test_run_full",{},claimed.context);assert.equal(result.ok,true);assert.equal(result.exitCode,0);assert.deepEqual(await f.current(),before);
  await assert.rejects(()=>f.hands.execute("test_run_full",{},claimed.context),error=>error.safeDiagnostics?.predicate==="full_test_local_replay");assert.deepEqual(await f.current(),before);assert.equal(f.commands.slice(count).filter(command=>command.args.some(arg=>arg.endsWith("npm-cli.js"))||command.file==="npm").length,1);await f.verifyBytes(f.afterContents);
});

for(const unknown of [false,true])test(unknown?"unverifiable post-npm state is durably unknown, never falsely reported unchanged":"a synthetic npm-side write is detected and durably reported without retry or restoration",async t=>{
  const f=await ready(t),before=await f.current(),path="assets/console.css",expected=new Map(f.afterContents),registry=createToolRegistry();let npmCalls=0,finished=false;
  registerHandsTools(registry,{root:f.root,environment:{NOVA_BRAIN_DEVELOPMENT_BRANCH:f.branch},storage:f.storage,ownerId:f.ownerId,commandRunner:async(file,args,options)=>{
    if(unknown&&finished)throw Object.assign(new Error("Synthetic post-run Git unavailability"),{code:"ENOENT"});
    const result=await f.commandRunner(file,args,options);
    if(file==="npm"||args.some(arg=>arg.endsWith("npm-cli.js"))){npmCalls+=1;finished=true;if(!unknown){const drift=expected.get(path)+"/* synthetic npm-side write */\n";expected.set(path,drift);await writeFile(join(f.root,path),drift);}}
    return result;
  }});
  const worker=createPersistentLocalWorker({client:f.client,root:f.root,branch:f.branch,repository:f.repository,runtimeVersion:f.runtimeVersion,workerId:FULL_TEST_WORKER,registry});
  await assert.rejects(()=>worker.runOnce(),error=>error.code==="full_test_scope_recovery_precondition_failed"&&error.safeDiagnostics?.verificationPhase==="post_run"&&error.safeDiagnostics?.mutationApplied===(unknown?null:true));
  const after=await f.current(),step=(await f.steps()).find(item=>item.stepId===after.metadata.fullTestScopeRecoveryHistory[0].fullTestStepId);
  assert.equal(npmCalls,1);assert.equal(after.status,"failed");assert.equal(after.metadata.fullTestScopeBoundary.kind,"full_test_infrastructure_failure");assert.equal(after.metadata.fullTestScopeBoundary.mutationApplied,unknown?null:true);assert.equal(after.metadata.fullTestScopeBoundary.workspaceDriftObserved,unknown?null:true);assert.equal(step.result.diagnostics.mutationApplied,unknown?null:true);assert.equal(after.metadata.fullTestScopeRecoveryHistory[0].consumed,true);assert.deepEqual(after.metadata.executionScopeRecoveryHistory,before.metadata.executionScopeRecoveryHistory);assert.equal(after.repairIteration,before.repairIteration);assert.equal(after.retryCount,before.retryCount);assert.deepEqual(await worker.runOnce(),{worked:false});assert.equal(npmCalls,1);await f.verifyBytes(expected);
});
