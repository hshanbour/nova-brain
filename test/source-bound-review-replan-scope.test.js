import test from "node:test";
import assert from "node:assert/strict";
import {createSourceBoundReviewReplanFixture,SOURCE_BOUND_CLASS,SOURCE_BOUND_HISTORY,assertSourceBoundHistoriesPreserved} from "./source-bound-review-replan-fixture.js";
import {describeSourceBoundReviewReplan,validateReviewRemediationEvidence,reviewRemediationDescriptor} from "../src/autonomy/review-remediation-scope.js";
import {recoveryHash} from "../src/autonomy/failed-local-read-recovery.js";

test("real-shaped v279 source-bound rejection supports only a separate thirteen-step owner approval and tolerates genuinely absent historical diagnostics",async t=>{
  const f=await createSourceBoundReviewReplanFixture(t),before=await f.current(),steps=await f.steps(),described=await describeSourceBoundReviewReplan(f.options);
  assert.equal(before.stateVersion,279);assert.equal(before.currentStep,173);assert.equal(before.currentPhase,"read_files");assert.equal(before.repairIteration,3);assert.equal(f.sourceRejectedStep.stepId,"174:plan_repair");assert.equal(f.sourceRejectedStep.attempt,1);assert.equal(f.sourceRejectedStep.result.diagnostics.predicate,"source_bound_behavioral_coverage");assert.equal(f.sourceRejectedStep.result.diagnostics.mutationApplied,false);
  assert.equal(f.sourceReads.length,8);assert.deepEqual(f.sourceRejectedPlan.files.map(file=>file.path),["assets/voice-input.js"]);assert.equal(f.sourceRejectedPlan.focusedTests.length,4);assert.equal(new Set(f.sourceRejectedPlan.reviewCoverage.map(item=>item.constraintId)).size,5);
  assert.equal(described.requiredPaths.length,8);assert.equal(described.approvalArguments.maxSteps,13);assert.equal(described.approvalArguments.runtimeMinutes,15);assert.equal(described.approvalArguments.maxAdditionalAttempts,0);assert.equal(described.approvalArguments.maxApplyAttempts,1);assert.deepEqual(described.review,f.review);
  const historical=structuredClone(steps),failed=historical.find(step=>step.stepId==="174:plan_repair");delete failed.result.diagnostics.coverageDiagnostics;delete failed.result.diagnostics.rejectedPlanEvidence.coverageDiagnostics;
  await describeSourceBoundReviewReplan({...f.options,task:before,steps:historical});
  assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);await f.verifySourceUnchanged();
});

test("v279 identity, exact source rejection, historical worker/read proof and reviewed bytes reject drift without changing source state",async t=>{
  const f=await createSourceBoundReviewReplanFixture(t),before=await f.current(),originalSteps=await f.steps();
  for(const[label,alter]of[
    ["wrong task",task=>task.id="different-task"],
    ["wrong version",task=>task.stateVersion--],
    ["wrong status",task=>task.status="queued"],
    ["wrong phase",task=>task.currentPhase="plan_repair"],
    ["wrong step",task=>task.currentStep--],
    ["wrong branch",task=>task.branch="different-branch"],
    ["wrong repository",task=>task.metadata.selfDevelopment.repository="different/repo"],
    ["wrong HEAD",task=>task.currentCommit="0".repeat(40)],
    ["active lease",task=>task.leaseToken="lease"],
    ["pending approval",task=>task.approvalState={approved:false}],
    ["unconsumed predecessor",task=>task.metadata.rejectedReviewPlanContinuationHistory[0].consumed=false],
    ["unapproved predecessor",task=>task.metadata.rejectedReviewPlanContinuationHistory[0].authorizationConsumed=false],
    ["wrong predecessor result",task=>task.metadata.rejectedReviewPlanContinuationHistory[0].result="completed"],
    ["missing worker",task=>task.metadata.rejectedReviewPlanContinuationHistory[0].workerId=null],
    ["invalid worker",task=>task.metadata.rejectedReviewPlanContinuationHistory[0].workerId="invalid"],
    ["unbound worker",task=>task.metadata.rejectedReviewPlanContinuationHistory[0].workerBindingState="awaiting_worker_bind"],
    ["stale worker",task=>{const record=task.metadata.rejectedReviewPlanContinuationHistory[0];record.workerId=record.rejectedPriorWorkerIds[0];}],
    ["extra reservation",task=>{const record=task.metadata.rejectedReviewPlanContinuationHistory[0];record.claimedStepIds.push(record.applyStepId);}],
    ["wrong boundary",task=>task.metadata.rejectedReviewPlanContinuationBoundary.kind="review_ready"],
    ["changed repair counter",task=>task.repairIteration++],
    ["changed retry counter",task=>task.retryCount++],
    ["changed consumed extension",task=>task.metadata.escalatedRepairHistory[0].maxAdditionalAttempts=2],
    ["changed older history",task=>task.metadata.reviewRemediationHistory[0].consumed=false],
    ["existing successor",task=>task.metadata[SOURCE_BOUND_HISTORY]=[{}]],
  ]){const task=structuredClone(before);alter(task);await assert.rejects(()=>describeSourceBoundReviewReplan({...f.options,task,steps:originalSteps}),undefined,label);}
  for(const[label,alter]of[
    ["later execution",steps=>steps.push({...steps.at(-1),stepId:"175:validate_patch"})],
    ["missing read",steps=>steps.splice(steps.findIndex(step=>step.stepId==="166:read_files"),1)],
    ["truncated read",steps=>steps.find(step=>step.stepId==="166:read_files").result.truncated=true],
    ["changed read bytes",steps=>steps.find(step=>step.stepId==="166:read_files").result.content+="\n"],
    ["changed read runtime",steps=>steps.find(step=>step.stepId==="166:read_files").input.arguments.binding.runtimeVersion="0".repeat(40)],
    ["wrong rejection",steps=>steps.find(step=>step.stepId==="174:plan_repair").result.diagnostics.predicate="complete_behavioral_coverage"],
    ["mutation already applied",steps=>steps.find(step=>step.stepId==="174:plan_repair").result.diagnostics.mutationApplied=true],
    ["another attempt",steps=>steps.find(step=>step.stepId==="174:plan_repair").attempt=2],
    ["wrong execution fingerprint",steps=>steps.find(step=>step.stepId==="174:plan_repair").operationFingerprint="0".repeat(64)],
    ["missing rejection proof",steps=>delete steps.find(step=>step.stepId==="174:plan_repair").result.diagnostics.rejectedPlanEvidence],
    ["wrong rejected version",steps=>steps.find(step=>step.stepId==="174:plan_repair").result.diagnostics.rejectedPlanEvidence.taskStateVersion--],
    ["wrong rejected generation",steps=>steps.find(step=>step.stepId==="174:plan_repair").result.diagnostics.rejectedPlanEvidence.continuationGenerationId="other"],
    ["wrong evidence fingerprint",steps=>steps.find(step=>step.stepId==="174:plan_repair").result.diagnostics.rejectedPlanEvidence.evidenceFingerprint="0".repeat(64)],
  ]){const steps=structuredClone(originalSteps);alter(steps);await assert.rejects(()=>describeSourceBoundReviewReplan({...f.options,task:before,steps}),undefined,label);}
  for(const alter of[
    input=>input.runtimeVersion="0".repeat(40),
    input=>input.planHash="0".repeat(64),
    input=>input.workspaceProof.workspace.changedFiles.pop(),
    input=>input.workspaceProof.workspace.changedFiles[0].hash="0".repeat(40),
    input=>input.workspaceProof.workspace.root+="/other",
    input=>input.review.findings[0].defect="Changed finding",
    input=>input.review.acceptanceConstraints.pop(),
  ]){const input=structuredClone(f.input);alter(input);await assert.rejects(()=>describeSourceBoundReviewReplan({...f.options,input,actor:{...f.actor,workspaceProof:input.workspaceProof}}));}
  await assert.rejects(()=>describeSourceBoundReviewReplan({...f.options,actor:{actorType:"owner"}}));f.remoteOverrides[f.branch]="0".repeat(40);await assert.rejects(()=>describeSourceBoundReviewReplan(f.options));delete f.remoteOverrides[f.branch];f.remoteOverrides["stage13/control-plane-approved-delivery-runtime"]="0".repeat(40);await assert.rejects(()=>describeSourceBoundReviewReplan(f.options));
  assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),originalSteps);await f.verifySourceUnchanged();
});

test("source-bound successor preserves every consumed predecessor and rejects changed budgets, lineage, phases, expiry and replay",async t=>{
  const f=await createSourceBoundReviewReplanFixture(t),source=await f.current();await f.authorize();await f.recover();const before=await f.current(),steps=await f.steps(),record=before.metadata[SOURCE_BOUND_HISTORY][0];
  assertSourceBoundHistoriesPreserved(source,before);assert.equal(record.fromStateVersion,279);assert.equal(record.readStepIds.length,8);assert.equal(record.planHash,null);assert.equal(record.activeContinuation.maxSteps,13);assert.equal(record.activeContinuation.runtimeMinutes,15);assert.equal(reviewRemediationDescriptor(before).recoveryClass,SOURCE_BOUND_CLASS);assert.equal(reviewRemediationDescriptor(before).historyKey,SOURCE_BOUND_HISTORY);assert.equal(validateReviewRemediationEvidence(before,steps,f.clock).record.recoveryClass,SOURCE_BOUND_CLASS);
  for(const alter of[
    task=>task.metadata[SOURCE_BOUND_HISTORY][0].consumed=true,
    task=>task.metadata[SOURCE_BOUND_HISTORY][0].maxApplyAttempts=2,
    task=>task.metadata[SOURCE_BOUND_HISTORY][0].maxAdditionalAttempts=1,
    task=>task.metadata[SOURCE_BOUND_HISTORY][0].sourceApplyStepId="27:apply_patch",
    task=>task.metadata[SOURCE_BOUND_HISTORY][0].beforeEntries[0].hash="0".repeat(40),
    task=>task.metadata[SOURCE_BOUND_HISTORY][0].requiredPaths[0]="test/ninth.test.js",
    task=>task.metadata[SOURCE_BOUND_HISTORY][0].review.findings[0].defect="Changed owner finding",
    task=>task.metadata[SOURCE_BOUND_HISTORY][0].unresolvedFindingIds=[],
    task=>task.metadata.rejectedReviewPlanContinuationHistory[0].consumed=false,
    task=>task.metadata.rejectedReviewPlanContinuationBoundary.executionAuthorized=true,
    task=>task.metadata.reviewRemediationHistory[0].consumed=false,
    task=>task.metadata.selfDevelopment.userGoal="Different mission",
    task=>task.metadata.maxRepairIterations=4,
    task=>task.repairIteration=0,
    task=>task.metadata.steps.push({type:"push",input:{tool:"git_push",arguments:{}}}),
    task=>task.metadata.continuationHistory[0].runtimeMinutes=999,
    task=>task.metadata[SOURCE_BOUND_HISTORY][0].claimedStepIds=[record.applyStepId],
    task=>{const record=task.metadata[SOURCE_BOUND_HISTORY][0];task.metadata.steps[record.activeContinuation.startStep].input.tool="repo_apply_patch";record.successorStepsHash=recoveryHash(task.metadata.steps.slice(record.activeContinuation.startStep));},
    task=>{const record=task.metadata[SOURCE_BOUND_HISTORY][0];task.metadata.steps.at(-1).input.arguments={namePattern:"skip failures"};record.successorStepsHash=recoveryHash(task.metadata.steps.slice(record.activeContinuation.startStep));},
  ]){const task=structuredClone(before);alter(task);assert.throws(()=>validateReviewRemediationEvidence(task,steps,f.clock));assert.equal(reviewRemediationDescriptor(task).historyKey,SOURCE_BOUND_HISTORY);}
  for(const alter of[
    steps=>steps.find(step=>step.stepId==="174:plan_repair").operationFingerprint="0".repeat(64),
    steps=>steps.find(step=>step.stepId==="174:plan_repair").result.diagnostics.rejectedPlanEvidence.planFingerprint="0".repeat(64),
    steps=>steps.find(step=>step.stepId==="166:read_files").result.content+="\n",
  ]){const altered=structuredClone(steps);alter(altered);assert.throws(()=>validateReviewRemediationEvidence(before,altered,f.clock));}
  assert.throws(()=>validateReviewRemediationEvidence(before,steps,()=>new Date(f.clock().getTime()+15*60000)));await assert.rejects(()=>f.recover());await assert.rejects(()=>f.previousRejectedRecover());await assert.rejects(()=>f.oldReviewRecover());assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);await f.verifySourceUnchanged();
});
