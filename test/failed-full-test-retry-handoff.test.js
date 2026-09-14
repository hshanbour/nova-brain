import test from "node:test";
import assert from "node:assert/strict";
import {writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createLocalWorkerHandoff} from "../src/autonomy/local-worker-handoff.js";
import {createWorkerRuntime} from "../src/autonomy/worker-runtime.js";
import {createFailedFullTestRetryFixture,RETRY_WORKER} from "./failed-full-test-retry-fixture.js";

async function ready(t,options){const f=await createFailedFullTestRetryFixture(t,options);await f.authorize();await f.recover();return f;}
const isNpm=command=>command.file==="npm"||command.args.some(arg=>arg.endsWith("npm-cli.js"));
const isPreflight=command=>command.args.includes("--eval")&&command.args.some(arg=>arg.includes("import.meta.resolve('@neondatabase/serverless')"));

test("failed-full-test retry first bind and duplicate claim preserve the consumed predecessor",async t=>{
  const f=await ready(t),before=await f.current(),claim=await f.claimRetry(),bound=await f.current(),record=bound.metadata.failedFullTestRetryHistory[0];
  assert.equal(claim.claim.claimed,true);assert.equal(record.workerId,RETRY_WORKER);assert.equal(record.workerBindingState,"bound");assert.deepEqual(record.claimedStepIds,[record.fullTestStepId]);assert.deepEqual(claim.job.arguments,{});assert.equal(claim.job.fullTestScope.recoveryClass,"owner_approved_failed_full_test_retry");
  const duplicate=await f.handoff.claim(claim.claimInput);assert.equal(duplicate.idempotent,true);assert.equal(duplicate.handoff.handoffId,claim.job.handoffId);assert.deepEqual(await f.current(),bound);
  await assert.rejects(()=>f.handoff.claim({...claim.claimInput,workerId:"persistent-local-98765432-1234-4234-8234-123456789abc",idempotencyKey:"competing"}),error=>error.safeDiagnostics?.predicate==="worker_succession");assert.deepEqual(await f.current(),bound);assert.deepEqual(bound.metadata.fullTestScopeRecoveryHistory,before.metadata.fullTestScopeRecoveryHistory);assert.deepEqual(bound.metadata.fullTestScopeBoundary,before.metadata.fullTestScopeBoundary);await f.verifyUnchanged();
});

test("server retry routing cannot execute tools or reopen the previous full-test history",async t=>{
  const f=await ready(t),before=await f.current(),runtime=createWorkerRuntime({storage:f.storage,ownerId:f.ownerId,clock:f.clock,capabilities:["test_local"],toolRegistry:{async execute(){assert.fail("Server tick cannot execute npm or product tools");}}});
  assert.equal((await runtime.tickTask(f.taskId,{idempotencyKey:"retry-route"})).status,"waiting_for_worker");const after=await f.current();assert.equal(after.repairIteration,before.repairIteration);assert.deepEqual(after.metadata.failedFullTestRetryHistory,before.metadata.failedFullTestRetryHistory);assert.deepEqual(after.metadata.fullTestScopeRecoveryHistory,before.metadata.fullTestScopeRecoveryHistory);await f.verifyUnchanged();
});

test("dependency resolution is cwd-local, non-evaluating and separate from the single 120-second npm command",async t=>{
  const f=await ready(t),count=f.commands.length,observed=[];
  // The synthetic dependency throws if evaluated: resolution must not run it.
  await writeFile(join(f.root,"node_modules/@neondatabase/serverless/index.js"),"throw new Error('Dependency top-level code must not run during preflight');\n");
  f.commandHooks.before=async(file,args,options)=>{if(args.includes("--eval")||isNpm({file,args}))observed.push({file,args,cwd:options.cwd,timeout:options.timeout});};
  await f.worker.runOnce();const after=await f.current(),commands=f.commands.slice(count);assert.equal(commands.filter(isPreflight).length,1);assert.equal(commands.filter(isNpm).length,1);assert.equal(observed.length,2);assert.equal(observed[0].cwd,f.root);assert.equal(observed[0].timeout,10000);assert.equal(observed[1].cwd,f.root);assert.equal(observed[1].timeout,120000);assert.equal(after.metadata.failedFullTestRetryBoundary.kind,"review_ready");
  const step=(await f.steps()).find(step=>step.stepId===after.metadata.failedFullTestRetryHistory[0].fullTestStepId);assert.deepEqual(step.result.dependencyPreflight,{package:"@neondatabase/serverless",cwd:after.metadata.failedFullTestRetryHistory[0].workspaceRoot,resolved:true});await f.verifyUnchanged();
});

test("missing cwd dependency consumes the reserved retry without any npm invocation or product mutation",async t=>{
  const f=await ready(t,{dependencyAvailable:false}),before=await f.current(),count=f.commands.length;
  await assert.rejects(()=>f.worker.runOnce(),error=>error.code==="dependency_provisioning_required"&&error.safeDiagnostics?.npmInvoked===false&&error.safeDiagnostics?.mutationApplied===false);
  const after=await f.current(),record=after.metadata.failedFullTestRetryHistory[0],step=(await f.steps()).find(step=>step.stepId===record.fullTestStepId);assert.equal(record.consumed,true);assert.equal(after.status,"failed");assert.equal(after.errorCode,"dependency_provisioning_required");assert.equal(after.metadata.failedFullTestRetryBoundary.kind,"full_test_infrastructure_failure");assert.equal(after.metadata.failedFullTestRetryBoundary.mutationApplied,false);assert.equal(step.result.diagnostics.consumesOnFailure,true);assert.equal(f.commands.slice(count).filter(isPreflight).length,1);assert.equal(f.commands.slice(count).filter(isNpm).length,0);assert.equal(after.repairIteration,before.repairIteration);assert.equal(after.retryCount,before.retryCount);assert.deepEqual(after.metadata.fullTestScopeRecoveryHistory,before.metadata.fullTestScopeRecoveryHistory);assert.deepEqual(after.metadata.escalatedRepairHistory,before.metadata.escalatedRepairHistory);assert.deepEqual(await f.worker.runOnce(),{worked:false});await assert.rejects(()=>f.recover());await f.verifyUnchanged();
});

test("a caller cannot drop or weaken the mandatory dependency binding before Hands execution",async t=>{
  const f=await ready(t),claim=await f.claimRetry(),before=await f.current(),count=f.commands.length;
  for(const change of [scope=>delete scope.dependencyPreflight,scope=>{scope.dependencyPreflight.required=false;},scope=>{scope.dependencyPreflight.cwd+="/wrong";},scope=>{scope.dependencyPreflight.package="other-package";},scope=>{scope.maxFullTestRetries=2;},scope=>{scope.recoveryClass="owner_approved_focused_success_full_tests";}]){
    const context=structuredClone(claim.context);change(context.fullTestScope);await assert.rejects(()=>f.hands.execute("test_run_full",{},context),error=>error.code==="full_test_scope_recovery_precondition_failed");assert.deepEqual(await f.current(),before);
  }
  assert.equal(f.commands.slice(count).filter(command=>isNpm(command)||isPreflight(command)).length,0);await f.verifyUnchanged();
});

test("retry completion requires exact successful dependency evidence",async t=>{
  const f=await ready(t),claim=await f.claimRetry(),before=await f.current(),record=before.metadata.failedFullTestRetryHistory[0],result={ok:true,exitCode:0,fullTestScopeEvidence:{generationId:record.activeContinuation.generationId,planHash:record.planHash,entries:record.entries}};
  for(const dependencyPreflight of [undefined,{package:"@neondatabase/serverless",cwd:record.workspaceRoot+"/wrong",resolved:true},{package:"@neondatabase/serverless",cwd:record.workspaceRoot,resolved:false}]){await assert.rejects(()=>claim.complete({...result,dependencyPreflight}),error=>error.code==="full_test_scope_result_invalid");assert.deepEqual(await f.current(),before);}
  await f.verifyUnchanged();
});

test("expired retry handoff consumes only the new retry history and never rotates workers",async t=>{
  const f=await ready(t),claim=await f.claimRetry(),before=await f.current(),expired=createLocalWorkerHandoff({storage:f.storage,ownerId:f.ownerId,approvedBranch:f.branch,clock:()=>new Date(f.clock().getTime()+300001)});
  await assert.rejects(()=>expired.fail(claim.job.handoffId,{taskId:f.taskId,workerId:RETRY_WORKER,idempotencyKey:claim.claimInput.idempotencyKey,error:{code:"worker_crash",message:"Synthetic expired retry"}}),error=>error.code==="handoff_expired");const after=await f.current();assert.equal(after.status,"failed");assert.equal(after.metadata.failedFullTestRetryHistory[0].consumed,true);assert.equal(after.metadata.failedFullTestRetryBoundary.mutationApplied,null);assert.deepEqual(after.metadata.fullTestScopeRecoveryHistory,before.metadata.fullTestScopeRecoveryHistory);assert.deepEqual(after.metadata.fullTestScopeBoundary,before.metadata.fullTestScopeBoundary);assert.equal(after.repairIteration,before.repairIteration);assert.equal(after.retryCount,before.retryCount);await f.verifyUnchanged();
});
