import test from "node:test";
import assert from "node:assert/strict";
import {createEvidenceBoundReviewReplanFixture} from "./evidence-bound-review-replan-fixture.js";
import {executionProofSignature} from "./execution-scope-fixture.js";
import {describeImplementationContentReviewReplan,IMPLEMENTATION_CONTENT_REVIEW_REPLAN_CLASS} from "../src/autonomy/review-remediation-scope.js";

const freshWorker="persistent-local-abcdef01-2345-4abc-8def-0123456789ab";

async function fixture(t,{secondOutput}={}){
  let generation=0;
  const f=await createEvidenceBoundReviewReplanFixture(t,{output(value){
    generation++;
    if(generation===1)return{...value,files:value.files.slice(0,5).map(file=>({...file,content:""})),focusedTests:value.focusedTests.slice(0,2)};
    return secondOutput?secondOutput(value):value;
  }});
  await f.authorize();await f.recover();await f.runSteps(9);
  const blocked=await f.current(),failed=(await f.steps()).at(-1);
  assert.equal(blocked.stateVersion,335);assert.equal(blocked.status,"blocked");assert.equal(blocked.errorCode,"implementation_plan_invalid");assert.equal(blocked.currentStep,199);assert.equal(failed.stepId,"200:plan_repair");
  assert.deepEqual(failed.result.diagnostics.validationIssues,[0,1,2,3,4].map(index=>`file_${index}_content_invalid`));assert.equal(f.executions.some(item=>item.name==="repo_apply_patch"),false);
  const input=structuredClone(f.input);input.expectedVersion=335;input.workspaceProof.expectedVersion=335;input.workspaceProofSignature=executionProofSignature(input.workspaceProof);delete input.approvalId;
  const actor={...f.actor,workspaceProof:input.workspaceProof},options={...f.options,input,actor};
  return{...f,input,actor,options,blocked,failed,generation:()=>generation};
}

test("v335 empty replacement rejection permits one distinct owner-approved complete-content replan through fresh review_ready",async t=>{
  const f=await fixture(t),before=structuredClone(f.blocked),described=await describeImplementationContentReviewReplan(f.options);
  assert.equal(described.approvalArguments.expectedVersion,335);assert.equal(described.approvalArguments.maxSteps,13);assert.equal(described.approvalArguments.maxApplyAttempts,1);assert.equal(described.approvalArguments.maxAdditionalAttempts,0);
  assert.equal((await f.post(f.path("request-implementation-content-review-replan"),f.input,"wrong-worker-token")).status,401);
  const response=await f.post(f.path("request-implementation-content-review-replan"),f.input),requested=response.body;assert.equal(response.status,200);await f.storage.decideApproval(requested.approval.id,f.ownerId,"approved");f.input.approvalId=requested.approval.id;
  const recovered=await f.service.recoverImplementationContentReviewReplan(f.taskId,f.input,f.actor),record=recovered.recovery;
  assert.equal(record.recoveryClass,IMPLEMENTATION_CONTENT_REVIEW_REPLAN_CLASS);assert.equal(record.fromStateVersion,335);assert.equal(record.repairIteration,3);assert.equal(record.implementationContentReplan,true);assert.equal(record.maxAdditionalAttempts,0);assert.equal(record.activeContinuation.maxSteps,13);assert.equal(record.activeContinuation.runtimeMinutes,15);
  const planStep=recovered.task.metadata.steps[record.activeContinuation.startStep+8];assert.equal(planStep.input.arguments.failureEvidence.code,"implementation_content_invalid");assert.deepEqual(planStep.input.arguments.failureEvidence.requiredImplementationContentContract,{operation:"replace",contentType:"string",completeReplacement:true,minLength:1,maxLength:250000,instructionsOrPlaceholdersForbidden:true});
  const worker=f.createWorker(freshWorker);for(let index=0;index<13;index++)assert.equal((await worker.runOnce()).worked,true);
  const final=await f.current(),history=final.metadata.implementationContentReviewReplanHistory[0],boundary=final.metadata.implementationContentReviewReplanBoundary;
  assert.equal(final.status,"blocked");assert.equal(final.repairIteration,3);assert.equal(history.consumed,true);assert.equal(history.result,"full_tests_completed");assert.equal(boundary.kind,"review_ready");assert.equal(boundary.executionAuthorized,false);assert.equal(f.generation(),2);
  assert.equal(f.executions.filter(item=>item.name==="repo_apply_patch").length,1);assert.equal(f.executions.filter(item=>item.name==="test_run").length,1);assert.equal(f.executions.filter(item=>item.name==="test_run_full").length,1);
  assert.equal(final.metadata.escalatedRepairHistory.length,before.metadata.escalatedRepairHistory.length);assert.deepEqual(final.metadata.escalatedRepairHistory,before.metadata.escalatedRepairHistory);assert.deepEqual(await worker.runOnce(),{worked:false});
});

test("v335 successor refuses malformed regenerated content before mutation and cannot replay",async t=>{
  const f=await fixture(t,{secondOutput:value=>({...value,files:value.files.map((file,index)=>index===0?{...file,content:null}:file)})});
  const requested=await f.service.requestImplementationContentReviewReplanApproval(f.taskId,f.input,f.actor);await f.storage.decideApproval(requested.approval.id,f.ownerId,"approved");f.input.approvalId=requested.approval.id;await f.service.recoverImplementationContentReviewReplan(f.taskId,f.input,f.actor);
  const worker=f.createWorker(freshWorker);for(let index=0;index<9;index++)assert.equal((await worker.runOnce()).worked,true);
  const final=await f.current();assert.equal(final.status,"blocked");assert.equal(final.errorCode,"implementation_plan_invalid");assert.equal(f.executions.filter(item=>item.name==="repo_apply_patch").length,0);assert.deepEqual(await worker.runOnce(),{worked:false});await assert.rejects(()=>f.service.recoverImplementationContentReviewReplan(f.taskId,f.input,f.actor));
});

test("v335 successor remains fail-closed for scope, workspace hash, predecessor, and approval drift",async t=>{
  const f=await fixture(t),task=await f.current(),steps=await f.steps();
  for(const alter of[
    options=>options.input.workspaceProof.workspace.changedFiles[0].hash="0".repeat(40),
    options=>options.input.workspaceProof.workspace.changedFiles.push({path:"test/ninth.test.js",hashAlgorithm:"git_sha1",hash:"0".repeat(40),rawHash:"0".repeat(40),contentHash:"0".repeat(64)}),
    options=>options.task.metadata.evidenceBoundReviewReplanHistory[0].consumed=false,
    options=>options.task.repairIteration=4,
    options=>options.steps.find(step=>step.stepId==="200:plan_repair").result.diagnostics.validationIssues[0]="file_0_reason_invalid",
  ]){const options={...f.options,task:structuredClone(task),steps:structuredClone(steps),input:structuredClone(f.input),actor:structuredClone(f.actor)};options.actor.workspaceProof=options.input.workspaceProof;alter(options);await assert.rejects(()=>describeImplementationContentReviewReplan(options));}
  assert.deepEqual(await f.current(),task);assert.deepEqual(await f.steps(),steps);
});
