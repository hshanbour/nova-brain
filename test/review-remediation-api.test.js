import test from "node:test";
import assert from "node:assert/strict";
import {createReviewRemediationFixture,REVIEW_CLASS,assertReviewHistoriesPreserved} from "./review-remediation-fixture.js";
import {executionProofSignature} from "./execution-scope-fixture.js";
import {recoveryHash} from "../src/autonomy/failed-local-read-recovery.js";

test("review remediation routes require authenticated worker and a signed exact workspace proof before durable evidence writes",async t=>{
  const f=await createReviewRemediationFixture(t),before=await f.current(),steps=await f.steps(),approvals=await f.storage.listApprovals(f.ownerId,{limit:100});
  for(const suffix of ["request-review-remediation","recover-review-remediation"]){
    for(const token of [null,"wrong-synthetic-token"])assert.equal((await f.post(f.path(suffix),f.input,token)).status,401);
    for(const alter of [input=>{delete input.workspaceProofSignature;},input=>{input.workspaceProofSignature="0".repeat(64);},input=>{delete input.workspaceProof;},input=>{input.workspaceProof.workspace.changedFiles[0].hash="0".repeat(40);}]){
      const input=structuredClone(f.input);alter(input);const response=await f.post(f.path(suffix),input);
      assert.equal(response.status,403);assert.equal(response.body.code,"workspace_attestation_unauthorized");
    }
  }
  assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);assert.deepEqual(await f.storage.listApprovals(f.ownerId,{limit:100}),approvals);await f.verifySourceUnchanged();
});

test("owner approval is exact, idempotent and authorizes no implicit review remediation execution",async t=>{
  const f=await createReviewRemediationFixture(t),before=await f.current(),steps=await f.steps();
  const requested=await f.post(f.path("request-review-remediation"));assert.equal(requested.status,200,JSON.stringify(requested.body));
  const approval=requested.body.approval;assert.equal(approval.status,"pending");assert.equal(approval.tool,"self_development_review_remediation");
  const binding=approval.arguments;assert.equal(binding.expectedVersion,223);assert.equal(binding.runtimeMinutes,15);assert.equal(binding.maxSteps,13);assert.equal(binding.maxAdditionalAttempts,0);assert.equal(binding.sourcePlanHash,f.plan.planHash);
  assert.equal(binding.sourcePlanSnapshotHash,recoveryHash(before.metadata.selfDevelopmentImplementationPlan));assert.deepEqual(binding.sourceFocusedCounts,{tests:7,passed:7,failed:0,skipped:0});assert.deepEqual(binding.sourceFullCounts,{tests:761,passed:761,failed:0,skipped:0});assert.deepEqual(binding.review,f.review);
  const duplicate=await f.post(f.path("request-review-remediation"));assert.equal(duplicate.status,200);assert.equal(duplicate.body.idempotent,true);assert.equal(duplicate.body.approval.id,approval.id);
  const input={...f.input,approvalId:approval.id};assert.equal((await f.post(f.path("recover-review-remediation"),input)).status,409);
  const approved=await f.post(`/api/approvals/${approval.id}/decision`,{decision:"approved"});assert.equal(approved.status,200,JSON.stringify(approved.body));assert.equal(approved.body.approval.status,"approved");
  assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);assert.equal(f.executions.length,0);assert.equal(f.prompts.length,0);await f.verifySourceUnchanged();
  const recovered=await f.post(f.path("recover-review-remediation"),input);assert.equal(recovered.status,200,JSON.stringify(recovered.body));assert.equal(recovered.body.task.metadata.activeContinuation.recoveryClass,REVIEW_CLASS);assert.equal(recovered.body.task.stateVersion,224);assertReviewHistoriesPreserved(before,recovered.body.task);
  const after=await f.current();assert.equal((await f.post(f.path("recover-review-remediation"),input)).status,409);assert.deepEqual(await f.current(),after);assert.equal(f.executions.length,0);await f.verifySourceUnchanged();
});

test("correctly signed review requests fail closed for wrong task repository branch workspace HEAD hash scope and stale source version",async t=>{
  const f=await createReviewRemediationFixture(t),before=await f.current(),approvals=await f.storage.listApprovals(f.ownerId,{limit:100});
  for(const alter of [
    input=>{input.expectedVersion--;},input=>{input.planHash="0".repeat(64);},input=>{input.workspaceProof.taskId="another-task";},
    input=>{input.workspaceProof.workspace.repository="other/repository";},input=>{input.workspaceProof.workspace.branch="main";},input=>{input.workspaceProof.workspace.root+="/wrong";},
    input=>{input.workspaceProof.workspace.head="0".repeat(40);},input=>{input.workspaceProof.workspace.changedFiles[0].hash="0".repeat(40);},
    input=>{input.workspaceProof.workspace.changedFiles.push({...input.workspaceProof.workspace.changedFiles[0],path:"test/ninth.test.js"});},
    input=>{input.review.findings[0].sourceEvidence[0].contentHash="0".repeat(64);},
  ]){
    const input=structuredClone(f.input);alter(input);input.workspaceProofSignature=executionProofSignature(input.workspaceProof);
    const out=await f.post(f.path("request-review-remediation"),input);assert.equal(out.status,409,JSON.stringify(out.body));
    assert.deepEqual(await f.current(),before);assert.deepEqual(await f.storage.listApprovals(f.ownerId,{limit:100}),approvals);
  }
  await f.verifySourceUnchanged();
});

test("structured review evidence rejects missing blocking findings, invented properties and incomplete acceptance constraints",async t=>{
  const f=await createReviewRemediationFixture(t),before=await f.current();
  for(const alter of [
    review=>{review.findings.shift();},review=>{review.findings[0].severity="note";},review=>{review.acceptanceConstraints.pop();},
    review=>{review.findings[0].chainOfThought="Unrestricted reasoning must not be persisted";},
    review=>{review.findings[0].paths.push("src/unapproved.js");},review=>{review.acceptanceConstraints[0].findingIds=["missing-finding"];},
  ]){
    const input=structuredClone(f.input);alter(input.review);const out=await f.post(f.path("request-review-remediation"),input);assert.equal(out.status,409,JSON.stringify(out.body));assert.deepEqual(await f.current(),before);
  }
  await f.verifySourceUnchanged();
});

test("review remediation rejects altered durable dirty lineage even with an unchanged signed workspace proof",async t=>{
  const f=await createReviewRemediationFixture(t),source=f.sourceSteps.find(step=>step.stepId==="149:apply_patch"),result=structuredClone(source.result);
  result.taskOwnedDirtyLineage.sourceApplyStepId="80:apply_patch";
  await f.storage.updateAutonomyStep(f.taskId,source.stepId,{result});
  const before=await f.current(),steps=await f.steps(),approvals=await f.storage.listApprovals(f.ownerId,{limit:100});
  const out=await f.post(f.path("request-review-remediation"));assert.equal(out.status,409,JSON.stringify(out.body));
  assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);assert.deepEqual(await f.storage.listApprovals(f.ownerId,{limit:100}),approvals);await f.verifySourceUnchanged();
});
