import test from "node:test";
import assert from "node:assert/strict";
import {writeFile} from "node:fs/promises";
import {join} from "node:path";
import {canonicalContentHash} from "../src/autonomy/self-development-plan-lifecycle.js";
import {createFullTestScopeFixture,FULL_TEST_RUNTIME,FULL_TEST_WORKER} from "./full-test-scope-fixture.js";
import {PLANNING_PATHS} from "./planning-scope-fixture.js";

const historyKeys=["failedLocalReadRecoveryHistory","continuationRuntimeResumeHistory","implementationPlanRecoveryHistory","partialRepairPlanRecoveryHistory","escalatedRepairHistory","planningScopeRecoveryHistory","planningScopeBoundary","executionScopeRecoveryHistory","executionScopeBoundary","implementationPlanGenerations","activeImplementationPlanGeneration","selfDevelopmentImplementationPlan"];
function preserved(before,after){for(const key of ["repairIteration","retryCount","maxRetries","branch","startingCommit","currentCommit"])assert.equal(after[key],before[key],key);for(const key of historyKeys)assert.deepEqual(after.metadata[key],before.metadata[key],key);}

test("real v215-shaped byte-identical application and 7/7 focused evidence authorize one full suite and then a review-only boundary",async t=>{
  const f=await createFullTestScopeFixture(t),before=await f.current(),steps=await f.steps();
  assert.equal(before.stateVersion,215);assert.equal(before.currentStep,150);assert.equal(before.metadata.executionScopeRecoveryHistory[0].consumed,true);assert.deepEqual(f.beforeContents,f.afterContents);assert.equal(f.apply.status,"completed");
  assert.match(f.focused.result.output,/tests 7/);assert.match(f.focused.result.output,/pass 7/);assert.notEqual(f.runtimeVersion,f.head);assert.notEqual(f.runtimeVersion,before.metadata.executionScopeRecoveryHistory[0].runtimeVersion);
  const request=await f.authorize();assert.equal(request.approval.arguments.maxProductMutations,0);assert.equal(request.approval.arguments.maxAdditionalAttempts,0);assert.equal(request.approval.arguments.planHash,f.plan.planHash);
  const recovered=await f.recover(),current=await f.current(),record=recovered.recovery;
  assert.equal(current.stateVersion,216);assert.equal(record.activeContinuation.maxSteps,1);assert.equal(record.activeContinuation.runtimeMinutes,5);assert.equal(record.workerId,null);assert.deepEqual(current.metadata.steps.slice(current.currentStep).map(step=>[step.type,step.input.tool,step.input.arguments]),[["run_full_tests","test_run_full",{}]]);
  preserved(before,current);await f.verifyBytes(f.afterContents);
  assert.equal((await f.worker.runOnce()).worked,true);
  const final=await f.current(),full=(await f.steps()).find(step=>Number.parseInt(step.stepId,10)>150&&step.stepType==="run_full_tests");
  assert.equal(full.status,"completed");assert.equal(full.attempt,1);assert.equal(full.result.exitCode,0);assert.match(full.result.output,/tests 8/);assert.match(full.result.output,/pass 8/);assert.match(full.result.output,/fail 0/);
  assert.equal(f.fullExecutions.length,1);assert.deepEqual(f.fullExecutions[0].args,{});assert.equal(f.fullExecutions[0].name,"test_run_full");assert.equal(final.status,"blocked");assert.equal(final.currentPhase,"run_full_tests");assert.equal(final.metadata.fullTestScopeBoundary.kind,"review_ready");assert.equal(final.metadata.fullTestScopeBoundary.executionAuthorized,false);assert.equal(final.metadata.fullTestScopeRecoveryHistory[0].consumed,true);assert.equal(final.metadata.fullTestScopeRecoveryHistory[0].workerId,FULL_TEST_WORKER);
  preserved(before,final);for(const original of steps)assert.deepEqual((await f.steps()).find(step=>step.stepId===original.stepId),original);assert.equal((await f.steps()).filter(step=>Number.parseInt(step.stepId,10)>150).length,1);assert.equal(f.prompts.length,1);
  assert.deepEqual(await f.worker.runOnce(),{worked:false});await assert.rejects(()=>f.recover(),error=>error.code==="full_test_scope_recovery_precondition_failed");assert.deepEqual(await f.current(),final);await f.verifyBytes(f.afterContents);
  assert.equal(f.commands.some(command=>command.args.some(arg=>["push","fetch","pull","clone"].includes(arg))),false);
});

test("a full-suite product failure is durable and stops at product repair decision without a new repair attempt",async t=>{
  const f=await createFullTestScopeFixture(t,{failingFullSuite:true}),before=await f.current();await f.authorize();await f.recover();
  await assert.rejects(()=>f.worker.runOnce(),error=>error.code==="test_failed");
  const final=await f.current(),full=(await f.steps()).find(step=>Number.parseInt(step.stepId,10)>150&&step.stepType==="run_full_tests"),result=f.fullExecutions[0].result;
  assert.equal(full.status,"failed");assert.equal(full.errorCode,"test_failed");assert.equal(result.exitCode,1);assert.match(result.output,/tests 8/);assert.match(result.output,/pass 7/);assert.match(result.output,/fail 1/);assert.match(result.output,/synthetic full-suite-only acceptance/);
  assert.equal(full.result.diagnostics.version,1);assert.equal(full.result.diagnostics.identity.command,"npm:test");assert.ok(full.result.diagnostics.failedFiles.includes("test/full-suite-only.test.js"));
  assert.equal(final.status,"blocked");assert.equal(final.metadata.fullTestScopeBoundary.kind,"product_repair_decision");assert.equal(final.metadata.fullTestScopeRecoveryHistory[0].consumed,true);preserved(before,final);assert.equal(f.prompts.length,1);assert.equal(f.fullExecutions.length,1);assert.deepEqual(await f.worker.runOnce(),{worked:false});await f.verifyBytes(f.afterContents);
});

test("generic resume and consumed execution successor do not supply full-suite authority",async t=>{
  const f=await createFullTestScopeFixture(t),before=await f.current();
  await assert.rejects(()=>f.taskWorker.control(f.taskId,"resume"));await assert.rejects(()=>f.previousExecutionRecover(),error=>error.code==="execution_scope_recovery_precondition_failed");
  assert.deepEqual(await f.worker.runOnce(),{worked:false});assert.deepEqual(await f.current(),before);assert.equal(f.fullExecutions.length,0);await f.verifyBytes(f.afterContents);
});

test("a complete signed proof with changed runtime, product, workspace or hashes cannot request full-test authority",async t=>{
  const f=await createFullTestScopeFixture(t),before=await f.current(),originalInput=structuredClone(f.input);
  for(const alter of [
    input=>{input.workspaceProof.taskId="another-task";},
    input=>{input.workspaceProof.workspace.repository="another/repository";},
    input=>{input.workspaceProof.workspace.branch="another-branch";},
    input=>{input.workspaceProof.workspace.root+="/other";},
    input=>{input.workspaceProof.workspace.head="0".repeat(40);},
    input=>{input.workspaceProof.runtimeVersion="0".repeat(40);},
    input=>{input.workspaceProof.workspace.changedFiles[0].hash="0".repeat(40);},
    input=>{input.workspaceProof.workspace.changedFiles[0].contentHash="0".repeat(64);},
    input=>{input.workspaceProof.workspace.changedFiles.push({...input.workspaceProof.workspace.changedFiles[0],path:"test/console-client.test.js"});},
  ]){
    const input=structuredClone(originalInput);alter(input);await assert.rejects(()=>f.service.requestFullTestScopeRecovery(f.taskId,input,{actorType:"scoped_local_worker",workspaceProof:input.workspaceProof}),error=>error.code==="full_test_scope_recovery_precondition_failed");assert.deepEqual(await f.current(),before);await f.verifyBytes(f.afterContents);
  }
});

test("raw-byte drift after full-test approval fails closed before npm test without changing any file",async t=>{
  const f=await createFullTestScopeFixture(t);await f.authorize();await f.recover();const path=PLANNING_PATHS[0],drift=f.afterContents.get(path).replaceAll("\n","\r\n");assert.equal(canonicalContentHash(drift),canonicalContentHash(f.afterContents.get(path)));await writeFile(join(f.root,path),drift);const expected=new Map(f.afterContents);expected.set(path,drift);
  const priorCommandCount=f.commands.length;await assert.rejects(()=>f.worker.runOnce(),error=>error.code==="full_test_scope_recovery_precondition_failed");
  const full=(await f.steps()).find(step=>Number.parseInt(step.stepId,10)>150&&step.stepType==="run_full_tests");assert.equal(full.status,"failed");assert.equal((await f.current()).status,"failed");assert.equal(f.commands.slice(priorCommandCount).some(command=>command.args.some(arg=>arg.endsWith("npm-cli.js"))),false);assert.deepEqual(await f.worker.runOnce(),{worked:false});await f.verifyBytes(expected);
});

test("full-test Hands capability rejects filters, mutation, focused rerun and post-boundary replay",async t=>{
  const f=await createFullTestScopeFixture(t);await f.authorize();await f.recover();const claim=await f.claimFullTest(),before=await f.current();
  for(const args of [{files:[PLANNING_PATHS[4]]},{namePattern:"synthetic"},{timeoutMs:180000},{command:"node --test test/voice-input.test.js"}]){
    await assert.rejects(()=>f.hands.execute("test_run_full",args,claim.context),error=>error.code==="full_test_scope_recovery_precondition_failed"||error.name==="ToolInputError");assert.deepEqual(await f.current(),before);await f.verifyBytes(f.afterContents);
  }
  await assert.rejects(()=>f.hands.execute("test_run",{files:PLANNING_PATHS.slice(4)},claim.context),error=>/full_test_scope/.test(error.code));
  const oldApply=f.executions.find(item=>item.name==="repo_apply_patch");await assert.rejects(()=>f.hands.execute("repo_apply_patch",oldApply.args,claim.context),error=>/full_test_scope/.test(error.code));
  const result=await f.hands.execute("test_run_full",{},claim.context);assert.equal(result.exitCode,0);await claim.complete(result);const final=await f.current();
  await assert.rejects(()=>f.hands.execute("test_run_full",{},claim.context),error=>/full_test_scope/.test(error.code));await assert.rejects(()=>f.hands.execute("repo_apply_patch",oldApply.args,oldApply.context),error=>/full_test_scope/.test(error.code));await assert.rejects(()=>f.taskWorker.control(f.taskId,"resume"));assert.deepEqual(await f.current(),final);await f.verifyBytes(f.afterContents);
});
