import test from "node:test";
import assert from "node:assert/strict";
import {createRejectedReviewPlanFixture,REJECTED_REVIEW_CLASS,REJECTED_REVIEW_HISTORY,assertRejectedReviewHistoriesPreserved} from "./rejected-review-plan-fixture.js";
import {describeRejectedReviewPlanContinuation,validateReviewRemediationEvidence,reviewRemediationDescriptor} from "../src/autonomy/review-remediation-scope.js";
import {recoveryHash} from "../src/autonomy/failed-local-read-recovery.js";

test("real rejected v251 plan yields separate bounded authority without changing its eight reads or rejection",async t=>{
  const f=await createRejectedReviewPlanFixture(t),before=await f.current(),steps=await f.steps(),description=await describeRejectedReviewPlanContinuation(f.options);
  assert.equal(before.stateVersion,251);assert.equal(before.currentStep,160);assert.equal(before.currentPhase,"read_files");assert.equal(before.repairIteration,3);assert.equal(f.sourceReads.length,8);assert.equal(f.sourceRejectedStep.stepId,"161:plan_repair");assert.equal(f.sourceRejectedStep.attempt,1);
  assert.equal(f.sourceRejectedPlan.files.length,2);assert.equal(f.sourceRejectedPlan.reviewCoverage.length,5);assert.equal(new Set(f.sourceRejectedPlan.reviewCoverage.map(item=>item.constraintId)).size,4);assert.equal(f.sourceRejectedStep.result.diagnostics.predicate,"complete_behavioral_coverage");assert.equal(f.sourceRejectedStep.result.diagnostics.mutationApplied,false);
  assert.equal(description.requiredPaths.length,8);assert.equal(description.approvalArguments.maxSteps,13);assert.equal(description.approvalArguments.runtimeMinutes,15);assert.equal(description.approvalArguments.maxAdditionalAttempts,0);assert.equal(description.approvalArguments.maxApplyAttempts,1);assert.deepEqual(description.fullCounts,{tests:761,passed:761,failed:0,skipped:0});
  assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);await f.verifySourceUnchanged();
});

test("rejected source identity, prior consumption, exact rejection and complete historical read evidence remain fail closed",async t=>{
  const f=await createRejectedReviewPlanFixture(t),before=await f.current(),originalSteps=await f.steps();
  for(const[label,alter]of[
    ["wrong task",task=>task.id="different-task"],
    ["wrong version",task=>task.stateVersion--],
    ["wrong status",task=>task.status="queued"],
    ["wrong phase",task=>task.currentPhase="plan_repair"],
    ["wrong current step",task=>task.currentStep--],
    ["wrong branch",task=>task.branch="different-branch"],
    ["wrong repository",task=>task.metadata.selfDevelopment.repository="different/repo"],
    ["wrong HEAD",task=>task.currentCommit="0".repeat(40)],
    ["active lease",task=>task.leaseToken="lease"],
    ["pending approval",task=>task.approvalState={approved:false}],
    ["unconsumed predecessor",task=>task.metadata.reviewRemediationHistory[0].consumed=false],
    ["unauthorized predecessor",task=>task.metadata.reviewRemediationHistory[0].authorizationConsumed=false],
    ["wrong predecessor result",task=>task.metadata.reviewRemediationHistory[0].result="completed"],
    ["missing historical worker",task=>task.metadata.reviewRemediationHistory[0].workerId=null],
    ["invalid historical worker",task=>task.metadata.reviewRemediationHistory[0].workerId="invalid-worker"],
    ["unbound historical worker",task=>task.metadata.reviewRemediationHistory[0].workerBindingState="awaiting_worker_bind"],
    ["stale historical worker",task=>{const record=task.metadata.reviewRemediationHistory[0];record.workerId=record.rejectedPriorWorkerIds[0];}],
    ["extra reserved historical phase",task=>{const record=task.metadata.reviewRemediationHistory[0];record.claimedStepIds.push(record.applyStepId);}],
    ["wrong boundary",task=>task.metadata.reviewRemediationBoundary.kind="review_ready"],
    ["changed repair counter",task=>task.repairIteration++],
    ["changed retry counter",task=>task.retryCount++],
    ["changed consumed extension",task=>task.metadata.escalatedRepairHistory[0].maxAdditionalAttempts=2],
    ["existing new continuation",task=>task.metadata[REJECTED_REVIEW_HISTORY]=[{}]],
  ]){const task=structuredClone(before);alter(task);await assert.rejects(()=>describeRejectedReviewPlanContinuation({...f.options,task,steps:originalSteps}),undefined,label);}
  for(const[label,alter]of[
    ["later durable step",steps=>steps.push({...steps.at(-1),stepId:"162:validate_patch"})],
    ["missing historical read",steps=>steps.splice(steps.findIndex(step=>step.stepId==="153:read_files"),1)],
    ["incomplete historical read",steps=>steps.find(step=>step.stepId==="153:read_files").result.truncated=true],
    ["changed historical bytes",steps=>steps.find(step=>step.stepId==="153:read_files").result.content+="\n"],
    ["changed historical read binding",steps=>steps.find(step=>step.stepId==="153:read_files").input.arguments.binding.runtimeVersion="0".repeat(40)],
    ["different rejection",steps=>steps.find(step=>step.stepId==="161:plan_repair").result.diagnostics.predicate="other"],
    ["mutation already applied",steps=>steps.find(step=>step.stepId==="161:plan_repair").result.diagnostics.mutationApplied=true],
    ["retry already attempted",steps=>steps.find(step=>step.stepId==="161:plan_repair").attempt=2],
    ["different failed fingerprint",steps=>steps.find(step=>step.stepId==="161:plan_repair").operationFingerprint="0".repeat(64)],
    ["missing rejection proof",steps=>delete steps.find(step=>step.stepId==="161:plan_repair").result.diagnostics.rejectedPlanEvidence],
    ["wrong proof version",steps=>steps.find(step=>step.stepId==="161:plan_repair").result.diagnostics.rejectedPlanEvidence.taskStateVersion--],
    ["wrong failed generation",steps=>steps.find(step=>step.stepId==="161:plan_repair").result.diagnostics.rejectedPlanEvidence.continuationGenerationId="different"],
    ["wrong rejected read fingerprint",steps=>steps.find(step=>step.stepId==="161:plan_repair").result.diagnostics.rejectedPlanEvidence.evidenceFingerprint="0".repeat(64)],
  ]){const steps=structuredClone(originalSteps);alter(steps);await assert.rejects(()=>describeRejectedReviewPlanContinuation({...f.options,task:before,steps}),undefined,label);}
  for(const alter of[
    input=>input.runtimeVersion="0".repeat(40),
    input=>input.planHash="0".repeat(64),
    input=>input.workspaceProof.workspace.changedFiles.pop(),
    input=>input.workspaceProof.workspace.changedFiles[0].hash="0".repeat(40),
    input=>input.workspaceProof.workspace.root+="/other",
    input=>input.review.findings[0].defect="Changed finding",
    input=>input.review.acceptanceConstraints.pop(),
  ]){const input=structuredClone(f.input);alter(input);await assert.rejects(()=>describeRejectedReviewPlanContinuation({...f.options,input,actor:{...f.actor,workspaceProof:input.workspaceProof}}));}
  await assert.rejects(()=>describeRejectedReviewPlanContinuation({...f.options,actor:{actorType:"owner"}}));
  f.remoteOverrides[f.branch]="0".repeat(40);await assert.rejects(()=>describeRejectedReviewPlanContinuation(f.options));delete f.remoteOverrides[f.branch];
  f.remoteOverrides["stage13/control-plane-approved-delivery-runtime"]="0".repeat(40);await assert.rejects(()=>describeRejectedReviewPlanContinuation(f.options));
  assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),originalSteps);await f.verifySourceUnchanged();
});

test("new generation preserves rejected authority and rejects tampered scope, source bindings, phases, runtime and replay",async t=>{
  const f=await createRejectedReviewPlanFixture(t),source=await f.current();await f.authorize();await f.recover();const before=await f.current(),steps=await f.steps(),record=before.metadata[REJECTED_REVIEW_HISTORY][0];
  assertRejectedReviewHistoriesPreserved(source,before);assert.equal(record.fromStateVersion,251);assert.equal(record.readStepIds.length,8);assert.equal(record.planHash,null);assert.equal(record.activeContinuation.maxSteps,13);assert.equal(record.activeContinuation.runtimeMinutes,15);assert.equal(reviewRemediationDescriptor(before).recoveryClass,REJECTED_REVIEW_CLASS);assert.equal(reviewRemediationDescriptor(before).historyKey,REJECTED_REVIEW_HISTORY);assert.equal(validateReviewRemediationEvidence(before,steps,f.clock).record.recoveryClass,REJECTED_REVIEW_CLASS);
  const mutations=[
    task=>task.metadata[REJECTED_REVIEW_HISTORY][0].consumed=true,
    task=>task.metadata[REJECTED_REVIEW_HISTORY][0].maxApplyAttempts=2,
    task=>task.metadata[REJECTED_REVIEW_HISTORY][0].maxAdditionalAttempts=1,
    task=>task.metadata[REJECTED_REVIEW_HISTORY][0].sourceApplyStepId="27:apply_patch",
    task=>task.metadata[REJECTED_REVIEW_HISTORY][0].beforeEntries[0].hash="0".repeat(40),
    task=>task.metadata[REJECTED_REVIEW_HISTORY][0].requiredPaths[0]="test/ninth.test.js",
    task=>task.metadata[REJECTED_REVIEW_HISTORY][0].review.findings[0].defect="Changed owner finding",
    task=>task.metadata[REJECTED_REVIEW_HISTORY][0].unresolvedFindingIds=[],
    task=>task.metadata[REJECTED_REVIEW_HISTORY][0].rejectedPlanSource.sourceVersion--,
    task=>task.metadata.reviewRemediationHistory[0].consumed=false,
    task=>task.metadata.reviewRemediationBoundary.executionAuthorized=true,
    task=>task.metadata.selfDevelopment.userGoal="Different mission",
    task=>task.metadata.maxRepairIterations=4,
    task=>task.repairIteration=0,
    task=>task.metadata.steps.push({type:"push",input:{tool:"git_push",arguments:{}}}),
    task=>task.metadata.continuationHistory[0].runtimeMinutes=999,
    task=>task.metadata[REJECTED_REVIEW_HISTORY][0].claimedStepIds=[record.applyStepId],
    task=>{const record=task.metadata[REJECTED_REVIEW_HISTORY][0];task.metadata.steps[record.activeContinuation.startStep].input.tool="repo_apply_patch";record.successorStepsHash=recoveryHash(task.metadata.steps.slice(record.activeContinuation.startStep));},
    task=>{const record=task.metadata[REJECTED_REVIEW_HISTORY][0];task.metadata.steps.at(-1).input.arguments={namePattern:"skip failures"};record.successorStepsHash=recoveryHash(task.metadata.steps.slice(record.activeContinuation.startStep));},
  ];
  for(const alter of mutations){const task=structuredClone(before);alter(task);assert.throws(()=>validateReviewRemediationEvidence(task,steps,f.clock));assert.equal(reviewRemediationDescriptor(task).historyKey,REJECTED_REVIEW_HISTORY);}
  for(const alter of[
    steps=>steps.find(step=>step.stepId==="161:plan_repair").operationFingerprint="0".repeat(64),
    steps=>steps.find(step=>step.stepId==="161:plan_repair").result.diagnostics.rejectedPlanEvidence.planFingerprint="0".repeat(64),
    steps=>steps.find(step=>step.stepId==="153:read_files").result.content+="\n",
  ]){const altered=structuredClone(steps);alter(altered);assert.throws(()=>validateReviewRemediationEvidence(before,altered,f.clock));}
  assert.throws(()=>validateReviewRemediationEvidence(before,steps,()=>new Date(f.clock().getTime()+15*60000)));
  await assert.rejects(()=>f.recover());await assert.rejects(()=>f.oldReviewRecover());assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);await f.verifySourceUnchanged();
});
