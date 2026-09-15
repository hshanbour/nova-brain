import test from "node:test";
import assert from "node:assert/strict";
import {createSourceBoundReviewReplanFixture,SOURCE_BOUND_CLASS,assertSourceBoundHistoriesPreserved} from "./source-bound-review-replan-fixture.js";
import {executionProofSignature} from "./execution-scope-fixture.js";

const requestRoute="request-source-bound-review-replan",recoveryRoute="recover-source-bound-review-replan",approvalTool="self_development_source_bound_review_replan";

test("source-bound replan routes authenticate the worker and signed workspace before any service write",async t=>{
  const f=await createSourceBoundReviewReplanFixture(t),before=await f.current(),steps=await f.steps(),approvals=await f.storage.listApprovals(f.ownerId,{limit:100});
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

test("v279 successor needs its own owner decision and creates one idempotent approval without execution",async t=>{
  const f=await createSourceBoundReviewReplanFixture(t),before=await f.current(),steps=await f.steps(),executions=f.executions.length,prompts=f.prompts.length;
  const requested=await f.post(f.path(requestRoute));assert.equal(requested.status,200,JSON.stringify(requested.body));
  const approval=requested.body.approval,binding=approval.arguments;
  assert.equal(approval.status,"pending");assert.equal(approval.tool,approvalTool);assert.equal(approval.runId,f.taskId);assert.equal(binding.expectedVersion,279);assert.equal(binding.runtimeVersion,f.runtimeVersion);assert.equal(binding.runtimeMinutes,15);assert.equal(binding.maxSteps,13);assert.equal(binding.maxAdditionalAttempts,0);assert.deepEqual(binding.review,f.review);
  const duplicate=await f.post(f.path(requestRoute));assert.equal(duplicate.status,200,JSON.stringify(duplicate.body));assert.equal(duplicate.body.idempotent,true);assert.equal(duplicate.body.approval.id,approval.id);
  for(const prior of[before.metadata.reviewRemediationHistory[0],before.metadata.rejectedReviewPlanContinuationHistory[0]])assert.equal((await f.post(f.path(recoveryRoute),{...f.input,approvalId:prior.approvalId})).status,409);
  const input={...f.input,approvalId:approval.id};assert.equal((await f.post(f.path(recoveryRoute),input)).status,409);assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);
  const approved=await f.post(`/api/approvals/${approval.id}/decision`,{decision:"approved"});assert.equal(approved.status,200,JSON.stringify(approved.body));assert.equal(approved.body.approval.status,"approved");assert.equal(approved.body.execution.authorized,true);
  assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);assert.equal(f.executions.length,executions);assert.equal(f.prompts.length,prompts);await f.verifySourceUnchanged();
  const approvedDuplicate=await f.post(f.path(requestRoute));assert.equal(approvedDuplicate.status,200);assert.equal(approvedDuplicate.body.approval.id,approval.id);assert.equal(approvedDuplicate.body.idempotent,true);
  const recovered=await f.post(f.path(recoveryRoute),input);assert.equal(recovered.status,200,JSON.stringify(recovered.body));
  const after=await f.current();assert.equal(after.stateVersion,280);assert.equal(after.metadata.activeContinuation.recoveryClass,SOURCE_BOUND_CLASS);assert.equal(after.repairIteration,3);assertSourceBoundHistoriesPreserved(before,after);assert.equal(f.executions.length,executions);assert.equal(f.prompts.length,prompts);
  assert.equal((await f.post(f.path(recoveryRoute),input)).status,409);assert.equal((await f.post(f.path(requestRoute))).status,409);assert.deepEqual(await f.current(),after);assert.deepEqual(await f.steps(),steps);await f.verifySourceUnchanged();
});

test("signed v279 successor requests reject task, runtime, workspace, lineage and review binding drift",async t=>{
  const f=await createSourceBoundReviewReplanFixture(t),before=await f.current(),steps=await f.steps(),approvals=await f.storage.listApprovals(f.ownerId,{limit:100});
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
    input=>{input.review.findings[0].defect="Unapproved changed review";},
    input=>{input.review.acceptanceConstraints[0].text="Changed behavioral constraint";},
    input=>{input.review.acceptanceConstraints.pop();},
    input=>{input.review.findings[0].sourceEvidence[0].contentHash="0".repeat(64);},
  ]){
    const input=structuredClone(f.input);alter(input);input.workspaceProofSignature=executionProofSignature(input.workspaceProof);
    const out=await f.post(f.path(requestRoute),input);assert.equal(out.status,409,JSON.stringify(out.body));assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);assert.deepEqual(await f.storage.listApprovals(f.ownerId,{limit:100}),approvals);
  }
  await f.verifySourceUnchanged();
});
