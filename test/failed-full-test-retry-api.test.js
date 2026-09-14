import test from "node:test";
import assert from "node:assert/strict";
import {createFailedFullTestRetryFixture} from "./failed-full-test-retry-fixture.js";
import {executionProofSignature} from "./execution-scope-fixture.js";

test("both failed-full-test retry routes require valid worker bearer and signed current workspace proof",async t=>{
  const f=await createFailedFullTestRetryFixture(t),before=await f.current(),steps=await f.steps(),approvals=await f.storage.listApprovals(f.ownerId,{limit:100});
  for(const route of["request-failed-full-test-retry","recover-failed-full-test-retry"]){
    for(const token of[null,"wrong-synthetic-token"]){const out=await f.post(f.path(route),f.input,token);assert.equal(out.status,401);}
    for(const alter of[input=>{delete input.workspaceProofSignature;},input=>{input.workspaceProofSignature="0".repeat(64);},input=>{delete input.workspaceProof;},input=>{input.workspaceProof.workspace.changedFiles[0].hash="0".repeat(40);}]){
      const input=structuredClone(f.input);alter(input);const out=await f.post(f.path(route),input);assert.equal(out.status,403);assert.equal(out.body.code,"workspace_attestation_unauthorized");
    }
  }
  assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);assert.deepEqual(await f.storage.listApprovals(f.ownerId,{limit:100}),approvals);await f.verifyUnchanged();
});

test("failed-full-test owner decision authorizes exactly one dependency-gated retry without execution or task mutation",async t=>{
  const f=await createFailedFullTestRetryFixture(t),before=await f.current(),steps=await f.steps(),requested=await f.post(f.path("request-failed-full-test-retry"));
  assert.equal(requested.status,200);assert.equal(requested.body.approval.status,"pending");assert.equal(requested.body.approval.tool,"self_development_failed_full_test_retry");
  const binding=requested.body.approval.arguments;assert.equal(binding.expectedVersion,219);assert.equal(binding.planHash,f.plan.planHash);assert.equal(binding.runtimeMinutes,5);assert.equal(binding.maxSteps,1);assert.equal(binding.maxFullTestRetries,1);assert.equal(binding.maxProductMutations,0);assert.equal(binding.maxAdditionalAttempts,0);
  const id=requested.body.approval.id,duplicate=await f.post(f.path("request-failed-full-test-retry"));assert.equal(duplicate.body.idempotent,true);assert.equal(duplicate.body.approval.id,id);
  const pending=await f.post(f.path("recover-failed-full-test-retry"),{...f.input,approvalId:id});assert.equal(pending.status,409);assert.match(pending.body.code,/full_test/);assert.equal(pending.body.diagnostics.predicate,"exact_owner_approval");
  const approved=await f.post(`/api/approvals/${id}/decision`,{decision:"approved"});assert.equal(approved.status,200);assert.deepEqual(approved.body.execution,{authorized:true,approvalId:id});assert.equal(approved.body.approval.status,"approved");assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);assert.equal(f.retryExecutions.length,0);await f.verifyUnchanged();
});

test("approved HTTP retry recovery creates one new generation while preserving consumed full-test predecessor; replay is rejected",async t=>{
  const f=await createFailedFullTestRetryFixture(t),requested=await f.post(f.path("request-failed-full-test-retry")),id=requested.body.approval.id;
  await f.post(`/api/approvals/${id}/decision`,{decision:"approved"});const input={...f.input,approvalId:id},result=await f.post(f.path("recover-failed-full-test-retry"),input);
  assert.equal(result.status,200);assert.equal(result.body.task.stateVersion,220);assert.equal(result.body.recovery.maxFullTestRetries,1);assert.equal(result.body.recovery.maxProductMutations,0);assert.equal(result.body.recovery.maxAdditionalAttempts,0);
  const before=await f.current(),replay=await f.post(f.path("recover-failed-full-test-retry"),input);assert.equal(replay.status,409);assert.deepEqual(await f.current(),before);assert.equal(before.metadata.failedFullTestRetryHistory.length,1);assert.deepEqual(before.metadata.fullTestScopeRecoveryHistory,f.sourceTask.metadata.fullTestScopeRecoveryHistory);assert.deepEqual(before.metadata.escalatedRepairHistory,f.sourceTask.metadata.escalatedRepairHistory);assert.equal(f.retryExecutions.length,0);await f.verifyUnchanged();
});

test("correctly signed retry request cannot substitute another plan or broaden current dirty workspace evidence",async t=>{
  const f=await createFailedFullTestRetryFixture(t),before=await f.current(),approvals=await f.storage.listApprovals(f.ownerId,{limit:100});
  for(const alter of[input=>{input.planHash="0".repeat(64);},input=>{input.workspaceProof.workspace.changedFiles[0].hash="0".repeat(40);},input=>{input.workspaceProof.workspace.changedFiles.push({...input.workspaceProof.workspace.changedFiles[0],path:"test/unrelated.test.js"});},input=>{input.workspaceProof.workspace.root+="/wrong";}]){
    const input=structuredClone(f.input);alter(input);input.workspaceProofSignature=executionProofSignature(input.workspaceProof);const result=await f.post(f.path("request-failed-full-test-retry"),input);assert.equal(result.status,409);assert.match(result.body.code,/full_test/);assert.deepEqual(await f.current(),before);
  }
  assert.deepEqual(await f.storage.listApprovals(f.ownerId,{limit:100}),approvals);await f.verifyUnchanged();
});
