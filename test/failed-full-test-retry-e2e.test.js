import test from "node:test";
import assert from "node:assert/strict";
import {createFailedFullTestRetryFixture,RETRY_WORKER,FAILED_FULL_TEST_PATHS} from "./failed-full-test-retry-fixture.js";

const histories=["failedLocalReadRecoveryHistory","continuationRuntimeResumeHistory","implementationPlanRecoveryHistory","partialRepairPlanRecoveryHistory","escalatedRepairHistory","planningScopeRecoveryHistory","planningScopeBoundary","executionScopeRecoveryHistory","executionScopeBoundary","fullTestScopeRecoveryHistory","fullTestScopeBoundary","implementationPlanGenerations","activeImplementationPlanGeneration","selfDevelopmentImplementationPlan"];
function preserved(before,after){for(const key of["repairIteration","retryCount","maxRetries","branch","startingCommit","currentCommit"])assert.equal(after[key],before[key],key);for(const key of histories)assert.deepEqual(after.metadata[key],before.metadata[key],key);}
const npmCommand=command=>command.args.some(arg=>arg.endsWith("npm-cli.js"))&&command.args.includes("test");
const dependencyCommand=command=>command.args.includes("--eval")&&command.args.some(arg=>arg.includes("@neondatabase/serverless"));

test("real v219-shaped missing-package failure authorizes one retry, verifies cwd dependency, and persists passing review boundary",async t=>{
  const f=await createFailedFullTestRetryFixture(t),before=await f.current(),steps=await f.steps();
  assert.equal(before.stateVersion,219);assert.equal(before.status,"blocked");assert.equal(before.currentStep,151);assert.equal(before.repairIteration,3);assert.equal(before.metadata.fullTestScopeRecoveryHistory[0].consumed,true);assert.deepEqual(f.sourceFailed.result.diagnostics.counts,{tests:681,passed:678,failed:3,skipped:0});assert.deepEqual(f.sourceFailed.result.diagnostics.failedFiles,FAILED_FULL_TEST_PATHS);assert.match(f.focused.result.output,/pass 7/);assert.notEqual(f.runtimeVersion,f.head);
  const request=await f.authorize();assert.equal(request.approval.arguments.maxAdditionalAttempts,0);assert.equal(request.approval.arguments.maxProductMutations,0);assert.equal(request.approval.arguments.planHash,f.plan.planHash);assert.equal(request.approval.arguments.expectedVersion,219);
  const recovered=await f.recover(),record=recovered.recovery;assert.equal(recovered.task.stateVersion,220);assert.equal(record.activeContinuation.maxSteps,1);assert.equal(record.activeContinuation.runtimeMinutes,5);assert.equal(record.workerId,null);preserved(before,recovered.task);await f.verifyUnchanged();
  const commandCount=f.commands.length;assert.equal((await f.worker.runOnce()).worked,true);const commands=f.commands.slice(commandCount),dependency=commands.findIndex(dependencyCommand),npm=commands.findIndex(npmCommand);
  assert.ok(dependency>=0);assert.ok(npm>dependency);assert.equal(commands.filter(dependencyCommand).length,1);assert.equal(commands.filter(npmCommand).length,1);assert.equal(f.retryExecutions.length,1);assert.deepEqual(f.retryExecutions[0].args,{});
  const final=await f.current(),full=(await f.steps()).find(step=>Number.parseInt(step.stepId,10)>151);assert.equal(full.stepType,"run_full_tests");assert.equal(full.status,"completed");assert.equal(full.attempt,1);assert.match(full.result.output,/tests 8/);assert.match(full.result.output,/pass 8/);assert.match(full.result.output,/fail 0/);
  assert.equal(final.status,"blocked");assert.equal(final.currentPhase,"run_full_tests");assert.equal(final.metadata.failedFullTestRetryBoundary.kind,"review_ready");assert.equal(final.metadata.failedFullTestRetryBoundary.executionAuthorized,false);assert.equal(final.metadata.failedFullTestRetryHistory[0].consumed,true);assert.equal(final.metadata.failedFullTestRetryHistory[0].workerId,RETRY_WORKER);preserved(before,final);
  for(const original of steps)assert.deepEqual((await f.steps()).find(step=>step.stepId===original.stepId),original);assert.equal((await f.steps()).filter(step=>Number.parseInt(step.stepId,10)>151).length,1);assert.deepEqual(await f.worker.runOnce(),{worked:false});await assert.rejects(()=>f.recover());assert.deepEqual(await f.current(),final);await f.verifyUnchanged();assert.equal(f.commands.some(command=>command.args.some(arg=>["push","fetch","pull","clone"].includes(arg))),false);
});

test("retry product failure stops at Nova repair decision with exact evidence and no new attempt authority",async t=>{
  const f=await createFailedFullTestRetryFixture(t,{failingRetry:true}),before=await f.current();await f.authorize();await f.recover();const priorCommands=f.commands.length;
  await assert.rejects(()=>f.worker.runOnce(),error=>error.code==="test_failed");const final=await f.current(),full=(await f.steps()).find(step=>Number.parseInt(step.stepId,10)>151),result=f.retryExecutions[0].result;
  assert.equal(full.status,"failed");assert.equal(full.errorCode,"test_failed");assert.match(result.output,/tests 8/);assert.match(result.output,/pass 7/);assert.match(result.output,/fail 1/);assert.deepEqual(full.result.diagnostics.failedFiles,["test/full-suite-only.test.js"]);assert.match(full.result.diagnostics.stdoutExcerpt,/synthetic full-suite-only acceptance/);
  assert.equal(final.status,"blocked");assert.equal(final.metadata.failedFullTestRetryBoundary.kind,"product_repair_decision");assert.equal(final.metadata.failedFullTestRetryHistory[0].consumed,true);preserved(before,final);assert.equal(f.commands.slice(priorCommands).filter(npmCommand).length,1);assert.deepEqual(await f.worker.runOnce(),{worked:false});await assert.rejects(()=>f.recover());assert.deepEqual(await f.current(),final);await f.verifyUnchanged();
});

test("missing dependency stops before npm and consumes only the security claim reservation without touching manifests or product bytes",async t=>{
  const f=await createFailedFullTestRetryFixture(t,{dependencyAvailable:false}),before=await f.current();await f.authorize();await f.recover();const count=f.commands.length;
  await assert.rejects(()=>f.worker.runOnce(),error=>error.code==="dependency_provisioning_required");const final=await f.current(),full=(await f.steps()).find(step=>Number.parseInt(step.stepId,10)>151);
  assert.equal(f.commands.slice(count).filter(dependencyCommand).length,1);assert.equal(f.commands.slice(count).filter(npmCommand).length,0);assert.equal(full.status,"failed");assert.equal(full.errorCode,"dependency_provisioning_required");assert.equal(full.result.diagnostics.npmInvoked,false);assert.equal(full.result.diagnostics.mutationApplied,false);assert.equal(final.status,"failed");assert.equal(final.metadata.failedFullTestRetryHistory[0].consumed,true);preserved(before,final);assert.deepEqual(await f.worker.runOnce(),{worked:false});await f.verifyUnchanged();
});

test("consumed previous full-test successor and generic resume cannot substitute for a newly approved retry",async t=>{
  const f=await createFailedFullTestRetryFixture(t),before=await f.current();await assert.rejects(()=>f.previousFullTestRecover());await assert.rejects(()=>f.taskWorker.control(f.taskId,"resume"));await assert.rejects(()=>f.recover());assert.deepEqual(await f.worker.runOnce(),{worked:false});assert.deepEqual(await f.current(),before);assert.equal(f.retryExecutions.length,0);await f.verifyUnchanged();
});

test("retry eligibility rejects task version plan workspace product runtime and raw evidence drift before mutation",async t=>{
  const f=await createFailedFullTestRetryFixture(t),before=await f.current();
  for(const alter of [input=>{input.expectedVersion--;},input=>{input.planHash="0".repeat(64);},input=>{input.workspaceProof.taskId="other-task";},input=>{input.workspaceProof.workspace.repository="other/repository";},input=>{input.workspaceProof.workspace.branch="other-branch";},input=>{input.workspaceProof.workspace.root+="/wrong";},input=>{input.workspaceProof.workspace.head="0".repeat(40);},input=>{input.workspaceProof.runtimeVersion="0".repeat(40);},input=>{input.workspaceProof.workspace.changedFiles[0].hash="0".repeat(40);},input=>{input.workspaceProof.workspace.changedFiles.push({...input.workspaceProof.workspace.changedFiles[0],path:"test/unrelated.test.js"});}]){
    const input=structuredClone(f.input);alter(input);await assert.rejects(()=>f.service.requestFailedFullTestRetry(f.taskId,input,{actorType:"scoped_local_worker",workspaceProof:input.workspaceProof}));assert.deepEqual(await f.current(),before);await f.verifyUnchanged();
  }
});

test("retry Hands refuses mutation focused reruns filters and direct post-boundary replay",async t=>{
  const f=await createFailedFullTestRetryFixture(t);await f.authorize();await f.recover();const claim=await f.claimRetry(),before=await f.current();
  for(const[name,args]of[["repo_apply_patch",f.executions.find(item=>item.name==="repo_apply_patch").args],["test_run",{files:f.plan.focusedTests.map(test=>test.path)}],["test_run_full",{files:[f.plan.focusedTests[0].path]}],["test_run_full",{namePattern:"synthetic"}],["test_run_full",{timeoutMs:180000}]]){
    await assert.rejects(()=>f.hands.execute(name,args,claim.context));assert.deepEqual(await f.current(),before);await f.verifyUnchanged();
  }
  const result=await f.hands.execute("test_run_full",{},claim.context);await claim.complete(result);const final=await f.current();await assert.rejects(()=>f.hands.execute("test_run_full",{},claim.context));await assert.rejects(()=>f.previousFullTestRecover());await assert.rejects(()=>f.taskWorker.control(f.taskId,"resume"));assert.deepEqual(await f.current(),final);await f.verifyUnchanged();
});
