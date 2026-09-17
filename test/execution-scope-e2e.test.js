import test from "node:test";
import assert from "node:assert/strict";
import {writeFile,readFile} from "node:fs/promises";
import {join} from "node:path";
import {canonicalContentHash} from "../src/autonomy/self-development-plan-lifecycle.js";
import {createExecutionScopeFixture,EXECUTION_TEST_PATHS,EXECUTION_TEST_RUNTIME,EXECUTION_TEST_WORKER} from "./execution-scope-fixture.js";
import {PLANNING_PATHS} from "./planning-scope-fixture.js";

const executionRecords=f=>f.executions.filter(item=>item.name!=="repo_validate_patch");
function preserved(before,after){
  for(const key of ["repairIteration","retryCount","maxRetries","branch","startingCommit","currentCommit"])assert.equal(after[key],before[key],key);
  for(const key of ["failedLocalReadRecoveryHistory","continuationRuntimeResumeHistory","implementationPlanRecoveryHistory","partialRepairPlanRecoveryHistory","escalatedRepairHistory","planningScopeRecoveryHistory","planningScopeBoundary","implementationPlanGenerations","activeImplementationPlanGeneration","selfDevelopmentImplementationPlan"])assert.deepEqual(after.metadata[key],before.metadata[key],key);
}

test("real v208-shaped successor performs one exact eight-file apply and four focused tests then stops with every consumed predecessor unchanged",async t=>{
  const f=await createExecutionScopeFixture(t),before=await f.current(),history=await f.steps();
  assert.equal(before.stateVersion,208);assert.equal(before.currentStep,148);assert.equal(before.metadata.selfDevelopmentImplementationPlan.provenance.planningOnly,true);
  assert.notEqual(f.head,f.runtimeVersion);assert.notEqual(f.runtimeVersion,before.metadata.planningScopeRecoveryHistory[0].runtimeVersion);
  const approved=await f.authorize();assert.equal(approved.approval.arguments.planHash,f.plan.planHash);assert.deepEqual(approved.approval.arguments.focusedTests,EXECUTION_TEST_PATHS);
  const recovered=await f.recover(),fresh=await f.current(),record=recovered.recovery;
  assert.equal(fresh.stateVersion,209);assert.equal(record.maxApplyAttempts,1);assert.equal(record.maxFocusedTestRuns,1);assert.equal(record.maxAdditionalAttempts,0);
  assert.equal(record.activeContinuation.maxSteps,2);assert.equal(record.activeContinuation.runtimeMinutes,15);assert.equal(record.workerId,null);
  assert.deepEqual(fresh.metadata.steps.slice(fresh.currentStep).map(item=>item.type),["apply_patch","run_focused_tests"]);preserved(before,fresh);await f.verifyBytes(f.beforeContents);
  assert.equal((await f.worker.runOnce()).worked,true);
  const applied=await f.current(),apply=(await f.steps()).find(step=>Number.parseInt(step.stepId,10)>148&&step.stepType==="apply_patch");
  assert.equal(apply.status,"completed");assert.equal(apply.attempt,1);assert.deepEqual(apply.result.files,PLANNING_PATHS);assert.equal(executionRecords(f).filter(item=>item.name==="repo_apply_patch").length,1);
  assert.equal(apply.result.taskOwnedDirtyLineage.taskId,f.taskId);assert.equal(apply.result.taskOwnedDirtyLineage.sourceApplyStepId,apply.stepId);assert.equal(apply.result.taskOwnedDirtyLineage.sourcePlanStepId,"147:plan_repair");
  assert.deepEqual([...apply.result.taskOwnedDirtyLineage.entries].sort((a,b)=>a.path.localeCompare(b.path)),PLANNING_PATHS.map(path=>({path,contentHash:canonicalContentHash(f.afterContents.get(path))})).sort((a,b)=>a.path.localeCompare(b.path)));
  assert.equal(applied.metadata.executionScopeRecoveryHistory[0].workerId,EXECUTION_TEST_WORKER);preserved(before,applied);await f.verifyBytes(f.afterContents);
  assert.equal((await f.worker.runOnce()).worked,true);
  const final=await f.current(),focused=(await f.steps()).find(step=>Number.parseInt(step.stepId,10)>148&&step.stepType==="run_focused_tests");
  assert.equal(focused.status,"completed");assert.equal(focused.attempt,1);assert.equal(focused.result.exitCode,0);assert.match(focused.result.output,/tests 4/);assert.match(focused.result.output,/pass 4/);
  const tests=executionRecords(f).filter(item=>item.name==="test_run");assert.equal(tests.length,1);assert.deepEqual(tests[0].args.files,EXECUTION_TEST_PATHS);assert.equal(tests[0].args.namePattern,undefined);
  assert.equal(final.status,"blocked");assert.equal(final.currentPhase,"run_focused_tests");assert.equal(final.metadata.executionScopeRecoveryHistory[0].consumed,true);assert.equal(final.metadata.executionScopeBoundary.kind,"focused_tests_completed");
  assert.deepEqual(await f.worker.runOnce(),{worked:false});preserved(before,final);assert.equal(f.prompts.length,1,"No new planning or repair attempt is synthesized by execution");
  for(const old of history)assert.deepEqual((await f.steps()).find(step=>step.stepId===old.stepId),old);
  assert.equal((await f.steps()).filter(step=>Number.parseInt(step.stepId,10)>148).length,2);await f.verifyBytes(f.afterContents);
  await assert.rejects(()=>f.recover(),error=>error.code==="execution_scope_recovery_precondition_failed");assert.deepEqual(await f.current(),final);
});

test("generic resume cannot replace owner-controlled execution authorization at v208",async t=>{
  const f=await createExecutionScopeFixture(t),before=await f.current();
  await assert.rejects(()=>f.taskWorker.control(f.taskId,"resume"));assert.deepEqual(await f.current(),before);await f.verifyBytes(f.beforeContents);
  const args=structuredClone(f.executions[0].args);delete args.planProvenance.planningOnly;delete args.planProvenance.planningScope;
  await assert.rejects(()=>f.hands.execute("repo_apply_patch",args,{runId:f.taskId,stepId:"149:apply_patch"}),error=>error.code==="planning_scope_mutation_forbidden");
  assert.equal(executionRecords(f).length,0);await f.verifyBytes(f.beforeContents);
});

for(const [name,alter] of [
  ["wrong runtime",args=>{args.runtimeVersion="0".repeat(40);}],
  ["wrong workspace",args=>{args.repositoryRoot+="/other";}],
  ["wrong repository",args=>{args.repository="another/repository";}],
  ["wrong generation",args=>{args.continuationGenerationId="0".repeat(64);}],
  ["old bound planning worker",args=>{args.workerId="persistent-local-abcdef12-3456-4789-8abc-def012345678";}],
])test(`execution handoff rejects ${name} before first apply or worker binding`,async t=>{
  const f=await createExecutionScopeFixture(t);await f.authorize();await f.recover();const before=await f.current(),steps=await f.steps();f.hooks.claim=alter;
  await assert.rejects(()=>f.worker.runOnce());assert.equal(executionRecords(f).length,0);assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);await f.verifyBytes(f.beforeContents);
});

test("raw byte drift after approval is rejected before any of the eight source replacements",async t=>{
  const f=await createExecutionScopeFixture(t);await f.authorize();await f.recover();const path=PLANNING_PATHS[0],drift=f.beforeContents.get(path).replaceAll("\n","\r\n");
  assert.equal(canonicalContentHash(drift),canonicalContentHash(f.beforeContents.get(path)));await writeFile(join(f.root,path),drift);
  const expected=new Map(f.beforeContents);expected.set(path,drift);
  await assert.rejects(()=>f.worker.runOnce(),error=>error.code==="execution_scope_recovery_precondition_failed");const failed=await f.current(),apply=(await f.steps()).find(step=>Number.parseInt(step.stepId,10)>148&&step.stepType==="apply_patch");
  assert.equal(apply.status,"failed");assert.match(apply.errorCode,/execution_scope|working_tree_dirty/);assert.equal(failed.status,"failed");assert.equal(executionRecords(f).filter(item=>item.name==="test_run").length,0);
  await f.verifyBytes(expected);assert.deepEqual(await f.worker.runOnce(),{worked:false});
});

test("a genuine focused-test failure consumes only this execution, never increments product repair authority or schedules another attempt",async t=>{
  const f=await createExecutionScopeFixture(t,{failingFocusedTest:true}),before=await f.current();await f.authorize();await f.recover();await f.worker.runOnce();await assert.rejects(()=>f.worker.runOnce(),error=>error.code==="test_failed");
  const final=await f.current(),focused=(await f.steps()).find(step=>Number.parseInt(step.stepId,10)>148&&step.stepType==="run_focused_tests");
  const testResult=executionRecords(f).find(item=>item.name==="test_run").result;
  assert.equal(focused.status,"failed");assert.equal(focused.errorCode,"test_failed");assert.equal(testResult.exitCode,1);assert.match(testResult.output,/tests 4/);assert.match(testResult.output,/pass 3/);assert.match(testResult.output,/fail 1/);
  assert.equal(final.status,"failed");assert.equal(final.metadata.executionScopeRecoveryHistory[0].consumed,true);assert.equal(final.repairIteration,before.repairIteration);assert.equal(final.retryCount,before.retryCount);
  assert.deepEqual(final.metadata.escalatedRepairHistory,before.metadata.escalatedRepairHistory);assert.equal(f.prompts.length,1);assert.equal(executionRecords(f).length,2);assert.deepEqual(await f.worker.runOnce(),{worked:false});await f.verifyBytes(f.afterContents);
});

test("post-apply dirty drift prevents focused execution without reapplying or broadening the test selection",async t=>{
  const f=await createExecutionScopeFixture(t);await f.authorize();await f.recover();await f.worker.runOnce();
  const path=PLANNING_PATHS[0],changed=(await readFile(join(f.root,path),"utf8"))+"/* synthetic external drift */\n";await writeFile(join(f.root,path),changed);const expected=new Map(f.afterContents);expected.set(path,changed);
  await assert.rejects(()=>f.worker.runOnce(),error=>error.code==="execution_scope_recovery_precondition_failed");const final=await f.current(),focused=(await f.steps()).find(step=>Number.parseInt(step.stepId,10)>148&&step.stepType==="run_focused_tests");
  assert.equal(final.status,"failed");assert.equal(focused.status,"failed");assert.match(focused.errorCode,/execution_scope/);assert.equal(executionRecords(f).filter(item=>item.name==="repo_apply_patch").length,1);await f.verifyBytes(expected);
  assert.equal(focused.result.diagnostics.mutationApplied,true,"Failure evidence retains the known completed prior apply");
});

test("an exact replacement restoring one tracked file to HEAD preserves eight-file lineage and still runs the four approved tests",async t=>{
  const f=await createExecutionScopeFixture(t,{restoreFirstTrackedToBaseline:true});await f.authorize();await f.recover();await f.worker.runOnce();
  const apply=(await f.steps()).find(step=>Number.parseInt(step.stepId,10)>148&&step.stepType==="apply_patch");
  assert.equal(apply.status,"completed");assert.equal(apply.result.files.length,8);assert.equal(apply.result.taskOwnedDirtyLineage.entries.length,8);
  const dirty=(await f.git("status","--porcelain=v1","--untracked-files=all")).split(/\r?\n/).filter(Boolean);
  assert.equal(dirty.length,7);assert.equal(dirty.some(line=>line.endsWith(` ${PLANNING_PATHS[0]}`)),false);await f.verifyBytes(f.afterContents);
  await f.worker.runOnce();const focused=(await f.steps()).find(step=>Number.parseInt(step.stepId,10)>148&&step.stepType==="run_focused_tests");
  assert.equal(focused.status,"completed");assert.match(focused.result.output,/tests 4/);assert.match(focused.result.output,/pass 4/);assert.equal((await f.current()).status,"blocked");await f.verifyBytes(f.afterContents);
});

test("Hands rejects altered replacement payloads, filtered or expanded tests, and post-boundary direct replay",async t=>{
  const f=await createExecutionScopeFixture(t);await f.authorize();await f.recover();const apply=await f.claimExecution(),before=await f.current();
  for(const alter of [
    (args,context)=>{context.executionScope.filesHash="0".repeat(64);},
    args=>{args.files[0].content+="/* unauthorised synthetic replacement */\n";},
    args=>{args.files.push({path:"test/console-client.test.js",operation:"create",content:"export const unrelated = true;\n"});},
    args=>{args.planProvenance.generationId="0".repeat(64);},
    (args,context)=>{delete context.executionScope;},
  ]){
    const args=structuredClone(apply.job.arguments),context=structuredClone(apply.context);alter(args,context);
    await assert.rejects(()=>f.hands.execute("repo_apply_patch",args,context),error=>["execution_scope_recovery_precondition_failed","planning_scope_mutation_forbidden"].includes(error.code));
    assert.deepEqual(await f.current(),before);await f.verifyBytes(f.beforeContents);
  }
  const applied=await f.hands.execute("repo_apply_patch",apply.job.arguments,apply.context);assert.equal(applied.ok,true);await apply.complete(applied);await f.verifyBytes(f.afterContents);
  const focused=await f.claimExecution(),preTests=await f.current();
  for(const alter of [
    args=>{args.namePattern="synthetic applied focused 4";},
    args=>{args.files.pop();},
    args=>{args.files.push("test/console-client.test.js");},
    args=>{args.files.push(args.files[0]);},
    (args,context)=>{context.executionScope.focusedTests=[args.files[0]];},
  ]){
    const args=structuredClone(focused.job.arguments),context=structuredClone(focused.context);alter(args,context);
    await assert.rejects(()=>f.hands.execute("test_run",args,context),error=>error.code==="execution_scope_recovery_precondition_failed");
    assert.deepEqual(await f.current(),preTests);await f.verifyBytes(f.afterContents);
  }
  await assert.rejects(()=>f.hands.execute("test_run_full",{},focused.context),error=>error.code==="execution_scope_recovery_precondition_failed");
  const result=await f.hands.execute("test_run",focused.job.arguments,focused.context);assert.equal(result.exitCode,0);assert.match(result.output,/tests 4/);await focused.complete(result);
  const final=await f.current();assert.equal(final.status,"blocked");
  await assert.rejects(()=>f.hands.execute("repo_apply_patch",apply.job.arguments,apply.context),error=>error.code==="execution_scope_recovery_precondition_failed");
  await assert.rejects(()=>f.hands.execute("test_run",focused.job.arguments,focused.context),error=>error.code==="execution_scope_recovery_precondition_failed");
  await assert.rejects(()=>f.taskWorker.control(f.taskId,"resume"));assert.deepEqual(await f.current(),final);await f.verifyBytes(f.afterContents);
});
