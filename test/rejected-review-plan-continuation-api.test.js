import test from "node:test";
import assert from "node:assert/strict";
import {createRejectedReviewPlanFixture,REJECTED_REVIEW_CLASS} from "./rejected-review-plan-fixture.js";
import {executionProofSignature} from "./execution-scope-fixture.js";

const requestRoute="request-rejected-review-plan-continuation";
const recoveryRoute="recover-rejected-review-plan-continuation";
const approvalTool="self_development_rejected_review_plan_continuation";

test("rejected-review-plan routes require worker authentication and an exact signed proof before service writes",async t=>{
  const f=await createRejectedReviewPlanFixture(t),before=await f.current(),steps=await f.steps(),approvals=await f.storage.listApprovals(f.ownerId,{limit:100});
  for(const suffix of[requestRoute,recoveryRoute]){
    for(const token of[null,"wrong-synthetic-token"])assert.equal((await f.post(f.path(suffix),f.input,token)).status,401);
    for(const alter of[
      input=>{delete input.workspaceProofSignature;},
      input=>{input.workspaceProofSignature="0".repeat(64);},
      input=>{delete input.workspaceProof;},
      input=>{input.workspaceProof.workspace.changedFiles[0].hash="0".repeat(40);},
    ]){const input=structuredClone(f.input);alter(input);const response=await f.post(f.path(suffix),input);assert.equal(response.status,403,JSON.stringify(response.body));assert.equal(response.body.code,"workspace_attestation_unauthorized");}
  }
  assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);assert.deepEqual(await f.storage.listApprovals(f.ownerId,{limit:100}),approvals);await f.verifySourceUnchanged();
});

test("exact pending approval and its normal owner decision do not execute or resume the v251 task",async t=>{
  const f=await createRejectedReviewPlanFixture(t),before=await f.current(),steps=await f.steps(),executions=f.executions.length,prompts=f.prompts.length;
  const requested=await f.post(f.path(requestRoute));assert.equal(requested.status,200,JSON.stringify(requested.body));
  const approval=requested.body.approval,binding=approval.arguments;
  assert.equal(approval.status,"pending");assert.equal(approval.tool,approvalTool);assert.equal(approval.runId,f.taskId);assert.equal(binding.expectedVersion,251);assert.equal(binding.runtimeVersion,f.runtimeVersion);assert.equal(binding.runtimeMinutes,15);assert.equal(binding.maxSteps,13);assert.equal(binding.maxAdditionalAttempts,0);assert.deepEqual(binding.review,f.review);
  const duplicate=await f.post(f.path(requestRoute));assert.equal(duplicate.status,200,JSON.stringify(duplicate.body));assert.equal(duplicate.body.idempotent,true);assert.equal(duplicate.body.approval.id,approval.id);
  const priorApprovalId=before.metadata.reviewRemediationHistory[0].approvalId;
  assert.equal((await f.post(f.path(recoveryRoute),{...f.input,approvalId:priorApprovalId})).status,409);
  const input={...f.input,approvalId:approval.id};assert.equal((await f.post(f.path(recoveryRoute),input)).status,409);
  assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);
  const approved=await f.post(`/api/approvals/${approval.id}/decision`,{decision:"approved"});assert.equal(approved.status,200,JSON.stringify(approved.body));assert.equal(approved.body.approval.status,"approved");
  assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);assert.equal(f.executions.length,executions);assert.equal(f.prompts.length,prompts);await f.verifySourceUnchanged();
  const approvedDuplicate=await f.post(f.path(requestRoute));assert.equal(approvedDuplicate.status,200);assert.equal(approvedDuplicate.body.approval.id,approval.id);assert.equal(approvedDuplicate.body.idempotent,true);
  const recovered=await f.post(f.path(recoveryRoute),input);assert.equal(recovered.status,200,JSON.stringify(recovered.body));
  const after=await f.current();assert.equal(after.stateVersion,252);assert.equal(after.metadata.activeContinuation.recoveryClass,REJECTED_REVIEW_CLASS);assert.equal(after.repairIteration,3);assert.deepEqual(after.metadata.reviewRemediationHistory,before.metadata.reviewRemediationHistory);assert.deepEqual(after.metadata.escalatedRepairHistory,before.metadata.escalatedRepairHistory);assert.equal(f.executions.length,executions);assert.equal(f.prompts.length,prompts);
  assert.equal((await f.post(f.path(recoveryRoute),input)).status,409);assert.equal((await f.post(f.path(requestRoute))).status,409);assert.deepEqual(await f.current(),after);assert.deepEqual(await f.steps(),steps);await f.verifySourceUnchanged();
});

test("signed successor requests reject changed source bindings and any alteration of the predecessor review",async t=>{
  const f=await createRejectedReviewPlanFixture(t),before=await f.current(),steps=await f.steps(),approvals=await f.storage.listApprovals(f.ownerId,{limit:100});
  for(const alter of[
    input=>{input.expectedVersion--;},
    input=>{input.planHash="0".repeat(64);},
    input=>{input.runtimeVersion="0".repeat(40);input.workspaceProof.runtimeVersion=input.runtimeVersion;},
    input=>{input.workspaceProof.taskId="another-task";},
    input=>{input.workspaceProof.workspace.repository="another/repository";},
    input=>{input.workspaceProof.workspace.branch="main";},
    input=>{input.workspaceProof.workspace.root+="/other";},
    input=>{input.workspaceProof.workspace.head="0".repeat(40);},
    input=>{input.workspaceProof.workspace.liveTip="0".repeat(40);},
    input=>{input.workspaceProof.workspace.changedFiles[0].hash="0".repeat(40);},
    input=>{input.workspaceProof.workspace.changedFiles.push({...input.workspaceProof.workspace.changedFiles[0],path:"package.json"});},
    input=>{input.review.findings[0].defect="A different review is not the approved predecessor review";},
    input=>{input.review.acceptanceConstraints[0].text="A changed acceptance requirement";},
    input=>{input.review.acceptanceConstraints.pop();},
    input=>{input.review.findings[0].sourceEvidence[0].contentHash="0".repeat(64);},
  ]){
    const input=structuredClone(f.input);alter(input);input.workspaceProofSignature=executionProofSignature(input.workspaceProof);
    const out=await f.post(f.path(requestRoute),input);assert.equal(out.status,409,JSON.stringify(out.body));assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);assert.deepEqual(await f.storage.listApprovals(f.ownerId,{limit:100}),approvals);
  }
  await f.verifySourceUnchanged();
});
