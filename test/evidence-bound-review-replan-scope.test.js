import test from "node:test";
import assert from "node:assert/strict";
import {createEvidenceBoundReviewReplanFixture,EVIDENCE_BOUND_CLASS,EVIDENCE_BOUND_HISTORY,assertEvidenceBoundHistoriesPreserved} from "./evidence-bound-review-replan-fixture.js";
import {describeEvidenceBoundReviewReplan,validateReviewRemediationEvidence,reviewRemediationDescriptor} from "../src/autonomy/review-remediation-scope.js";
import {recoveryHash} from "../src/autonomy/failed-local-read-recovery.js";

test("real-shaped v307 evidence-bound rejection supports only a separate thirteen-step owner approval and requires exact historical clause diagnostics",async t=>{
  const f=await createEvidenceBoundReviewReplanFixture(t),before=await f.current(),steps=await f.steps(),described=await describeEvidenceBoundReviewReplan(f.options);
  assert.equal(before.stateVersion,307);assert.equal(before.currentStep,186);assert.equal(before.currentPhase,"read_files");assert.equal(before.repairIteration,3);assert.equal(f.sourceRejectedStep.stepId,"187:plan_repair");assert.equal(f.sourceRejectedStep.attempt,1);assert.equal(f.sourceRejectedStep.result.diagnostics.predicate,"source_bound_behavioral_coverage");assert.equal(f.sourceRejectedStep.result.diagnostics.mutationApplied,false);
  assert.equal(f.sourceReads.length,8);assert.deepEqual(f.sourceRejectedPlan.files.map(file=>file.path),["assets/voice-input.js","test/composer-dictation.test.js"]);assert.equal(f.sourceRejectedPlan.focusedTests.length,1);assert.equal(new Set(f.sourceRejectedPlan.reviewCoverage.map(item=>item.constraintId)).size,5);
  assert.equal(described.requiredPaths.length,8);assert.equal(described.approvalArguments.maxSteps,13);assert.equal(described.approvalArguments.runtimeMinutes,15);assert.equal(described.approvalArguments.maxAdditionalAttempts,0);assert.equal(described.approvalArguments.maxApplyAttempts,1);assert.deepEqual(described.review,f.review);
  const historical=structuredClone(steps),failed=historical.find(step=>step.stepId==="187:plan_repair");delete failed.result.diagnostics.coverageDiagnostics;delete failed.result.diagnostics.rejectedPlanEvidence.coverageDiagnostics;
  await assert.rejects(()=>describeEvidenceBoundReviewReplan({...f.options,task:before,steps:historical}),error=>error.safeDiagnostics?.predicate==="exact_evidence_bound_named_test_rejection");
  assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);await f.verifySourceUnchanged();
});

test("v307 identity, exact source rejection, historical worker/read proof and reviewed bytes reject drift without changing source state",async t=>{
  const f=await createEvidenceBoundReviewReplanFixture(t),before=await f.current(),originalSteps=await f.steps();
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
    ["unconsumed predecessor",task=>task.metadata.sourceBoundReviewReplanHistory[0].consumed=false],
    ["unapproved predecessor",task=>task.metadata.sourceBoundReviewReplanHistory[0].authorizationConsumed=false],
    ["wrong predecessor result",task=>task.metadata.sourceBoundReviewReplanHistory[0].result="completed"],
    ["missing worker",task=>task.metadata.sourceBoundReviewReplanHistory[0].workerId=null],
    ["invalid worker",task=>task.metadata.sourceBoundReviewReplanHistory[0].workerId="invalid"],
    ["unbound worker",task=>task.metadata.sourceBoundReviewReplanHistory[0].workerBindingState="awaiting_worker_bind"],
    ["stale worker",task=>{const record=task.metadata.sourceBoundReviewReplanHistory[0];record.workerId=record.rejectedPriorWorkerIds[0];}],
    ["extra reservation",task=>{const record=task.metadata.sourceBoundReviewReplanHistory[0];record.claimedStepIds.push(record.applyStepId);}],
    ["wrong boundary",task=>task.metadata.sourceBoundReviewReplanBoundary.kind="review_ready"],
    ["changed repair counter",task=>task.repairIteration++],
    ["changed retry counter",task=>task.retryCount++],
    ["changed consumed extension",task=>task.metadata.escalatedRepairHistory[0].maxAdditionalAttempts=2],
    ["changed older history",task=>task.metadata.reviewRemediationHistory[0].consumed=false],
    ["existing successor",task=>task.metadata[EVIDENCE_BOUND_HISTORY]=[{}]],
  ]){const task=structuredClone(before);alter(task);await assert.rejects(()=>describeEvidenceBoundReviewReplan({...f.options,task,steps:originalSteps}),undefined,label);}
  for(const[label,alter]of[
    ["later execution",steps=>steps.push({...steps.at(-1),stepId:"188:validate_patch"})],
    ["missing read",steps=>steps.splice(steps.findIndex(step=>step.stepId==="179:read_files"),1)],
    ["truncated read",steps=>steps.find(step=>step.stepId==="179:read_files").result.truncated=true],
    ["changed read bytes",steps=>steps.find(step=>step.stepId==="179:read_files").result.content+="\n"],
    ["changed read runtime",steps=>steps.find(step=>step.stepId==="179:read_files").input.arguments.binding.runtimeVersion="0".repeat(40)],
    ["wrong rejection",steps=>steps.find(step=>step.stepId==="187:plan_repair").result.diagnostics.predicate="complete_behavioral_coverage"],
    ["mutation already applied",steps=>steps.find(step=>step.stepId==="187:plan_repair").result.diagnostics.mutationApplied=true],
    ["another attempt",steps=>steps.find(step=>step.stepId==="187:plan_repair").attempt=2],
    ["wrong execution fingerprint",steps=>steps.find(step=>step.stepId==="187:plan_repair").operationFingerprint="0".repeat(64)],
    ["missing rejection proof",steps=>delete steps.find(step=>step.stepId==="187:plan_repair").result.diagnostics.rejectedPlanEvidence],
    ["wrong rejected version",steps=>steps.find(step=>step.stepId==="187:plan_repair").result.diagnostics.rejectedPlanEvidence.taskStateVersion--],
    ["wrong rejected generation",steps=>steps.find(step=>step.stepId==="187:plan_repair").result.diagnostics.rejectedPlanEvidence.continuationGenerationId="other"],
    ["wrong evidence fingerprint",steps=>steps.find(step=>step.stepId==="187:plan_repair").result.diagnostics.rejectedPlanEvidence.evidenceFingerprint="0".repeat(64)],
    ...[
      diagnostics=>diagnostics.firstFailure.subclause="source_contains_excerpt",
      diagnostics=>diagnostics.firstFailure.constraintId="unapproved",
      diagnostics=>diagnostics.stateVersion--,
      diagnostics=>diagnostics.continuationGenerationId="0".repeat(64),
      diagnostics=>diagnostics.planFingerprint="0".repeat(64),
      diagnostics=>diagnostics.constraints[0].clauses[0].passed=false,
      diagnostics=>diagnostics.constraints[0].clauses.pop(),
      diagnostics=>diagnostics.constraints[0].firstFailedSubclause="source_contains_excerpt",
      diagnostics=>diagnostics.constraints[0].findingIds=[],
      diagnostics=>diagnostics.constraints[0].suppliedFindingIds=[],
      diagnostics=>diagnostics.constraints[0].suppliedSourceHash="0".repeat(64),
      diagnostics=>diagnostics.constraints[0].expectedSourceHash=null,
      diagnostics=>diagnostics.constraints[0].testPath="test/unrelated.test.js",
      diagnostics=>diagnostics.constraints[1].evaluated=true,
      diagnostics=>diagnostics.constraints[1].clauses=[{predicate:"made_up",passed:true}],
    ].map((alter,index)=>[`changed source coverage proof ${index}`,steps=>alter(steps.find(step=>step.stepId==="187:plan_repair").result.diagnostics.coverageDiagnostics)]),
  ]){const steps=structuredClone(originalSteps);alter(steps);await assert.rejects(()=>describeEvidenceBoundReviewReplan({...f.options,task:before,steps}),undefined,label);}
  for(const alter of[
    input=>input.runtimeVersion="0".repeat(40),
    input=>input.planHash="0".repeat(64),
    input=>input.workspaceProof.workspace.changedFiles.pop(),
    input=>input.workspaceProof.workspace.changedFiles[0].hash="0".repeat(40),
    input=>input.workspaceProof.workspace.root+="/other",
    input=>input.review.findings[0].defect="Changed finding",
    input=>input.review.acceptanceConstraints.pop(),
  ]){const input=structuredClone(f.input);alter(input);await assert.rejects(()=>describeEvidenceBoundReviewReplan({...f.options,input,actor:{...f.actor,workspaceProof:input.workspaceProof}}));}
  await assert.rejects(()=>describeEvidenceBoundReviewReplan({...f.options,actor:{actorType:"owner"}}));f.remoteOverrides[f.branch]="0".repeat(40);await assert.rejects(()=>describeEvidenceBoundReviewReplan(f.options));delete f.remoteOverrides[f.branch];f.remoteOverrides["stage13/control-plane-approved-delivery-runtime"]="0".repeat(40);await assert.rejects(()=>describeEvidenceBoundReviewReplan(f.options));
  assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),originalSteps);await f.verifySourceUnchanged();
});

test("evidence-bound successor preserves every consumed predecessor and rejects changed budgets, lineage, phases, expiry and replay",async t=>{
  const f=await createEvidenceBoundReviewReplanFixture(t),source=await f.current();await f.authorize();await f.recover();const before=await f.current(),steps=await f.steps(),record=before.metadata[EVIDENCE_BOUND_HISTORY][0];
  assertEvidenceBoundHistoriesPreserved(source,before);assert.equal(record.fromStateVersion,307);assert.equal(record.readStepIds.length,8);assert.equal(record.planHash,null);assert.equal(record.activeContinuation.maxSteps,13);assert.equal(record.activeContinuation.runtimeMinutes,15);assert.equal(reviewRemediationDescriptor(before).recoveryClass,EVIDENCE_BOUND_CLASS);assert.equal(reviewRemediationDescriptor(before).historyKey,EVIDENCE_BOUND_HISTORY);assert.equal(validateReviewRemediationEvidence(before,steps,f.clock).record.recoveryClass,EVIDENCE_BOUND_CLASS);
  for(const alter of[
    task=>task.metadata[EVIDENCE_BOUND_HISTORY][0].consumed=true,
    task=>task.metadata[EVIDENCE_BOUND_HISTORY][0].maxApplyAttempts=2,
    task=>task.metadata[EVIDENCE_BOUND_HISTORY][0].maxAdditionalAttempts=1,
    task=>task.metadata[EVIDENCE_BOUND_HISTORY][0].sourceApplyStepId="27:apply_patch",
    task=>task.metadata[EVIDENCE_BOUND_HISTORY][0].beforeEntries[0].hash="0".repeat(40),
    task=>task.metadata[EVIDENCE_BOUND_HISTORY][0].requiredPaths[0]="test/ninth.test.js",
    task=>task.metadata[EVIDENCE_BOUND_HISTORY][0].review.findings[0].defect="Changed owner finding",
    task=>task.metadata[EVIDENCE_BOUND_HISTORY][0].unresolvedFindingIds=[],
    task=>task.metadata.sourceBoundReviewReplanHistory[0].consumed=false,
    task=>task.metadata.sourceBoundReviewReplanBoundary.executionAuthorized=true,
    task=>task.metadata.reviewRemediationHistory[0].consumed=false,
    task=>task.metadata.selfDevelopment.userGoal="Different mission",
    task=>task.metadata.maxRepairIterations=4,
    task=>task.repairIteration=0,
    task=>task.metadata.steps.push({type:"push",input:{tool:"git_push",arguments:{}}}),
    task=>task.metadata.continuationHistory[0].runtimeMinutes=999,
    task=>task.metadata[EVIDENCE_BOUND_HISTORY][0].claimedStepIds=[record.applyStepId],
    task=>{const record=task.metadata[EVIDENCE_BOUND_HISTORY][0];task.metadata.steps[record.activeContinuation.startStep].input.tool="repo_apply_patch";record.successorStepsHash=recoveryHash(task.metadata.steps.slice(record.activeContinuation.startStep));},
    task=>{const record=task.metadata[EVIDENCE_BOUND_HISTORY][0];task.metadata.steps.at(-1).input.arguments={namePattern:"skip failures"};record.successorStepsHash=recoveryHash(task.metadata.steps.slice(record.activeContinuation.startStep));},
  ]){const task=structuredClone(before);alter(task);assert.throws(()=>validateReviewRemediationEvidence(task,steps,f.clock));assert.equal(reviewRemediationDescriptor(task).historyKey,EVIDENCE_BOUND_HISTORY);}
  for(const alter of[
    steps=>steps.find(step=>step.stepId==="187:plan_repair").operationFingerprint="0".repeat(64),
    steps=>steps.find(step=>step.stepId==="187:plan_repair").result.diagnostics.rejectedPlanEvidence.planFingerprint="0".repeat(64),
    steps=>steps.find(step=>step.stepId==="179:read_files").result.content+="\n",
  ]){const altered=structuredClone(steps);alter(altered);assert.throws(()=>validateReviewRemediationEvidence(before,altered,f.clock));}
  assert.throws(()=>validateReviewRemediationEvidence(before,steps,()=>new Date(f.clock().getTime()+15*60000)));await assert.rejects(()=>f.recover());await assert.rejects(()=>f.previousSourceBoundRecover());await assert.rejects(()=>f.previousRejectedRecover());await assert.rejects(()=>f.oldReviewRecover());assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);await f.verifySourceUnchanged();
});
