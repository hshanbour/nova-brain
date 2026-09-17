import test from "node:test";
import assert from "node:assert/strict";
import {createFullTestScopeFixture} from "./full-test-scope-fixture.js";
import {executionProofSignature} from "./execution-scope-fixture.js";

test("both full-test successor routes require worker authentication and an exact signed current workspace proof",async t=>{
  const f=await createFullTestScopeFixture(t),before=await f.current(),steps=await f.steps(),approvals=await f.storage.listApprovals(f.ownerId,{limit:100});
  for(const route of ["request-full-test-scope-recovery","recover-full-test-scope"]){
    for(const token of [null,"wrong-synthetic-worker-token"]){const out=await f.post(f.path(route),f.input,token);assert.equal(out.status,401);}
    for(const alter of [input=>{delete input.workspaceProofSignature;},input=>{input.workspaceProofSignature="0".repeat(64);},input=>{delete input.workspaceProof;},input=>{input.workspaceProof.workspace.changedFiles[0].hash="0".repeat(40);}]){
      const input=structuredClone(f.input);alter(input);const out=await f.post(f.path(route),input);assert.equal(out.status,403);assert.equal(out.body.code,"workspace_attestation_unauthorized");
    }
  }
  assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);assert.deepEqual(await f.storage.listApprovals(f.ownerId,{limit:100}),approvals);await f.verifyBytes(f.afterContents);
});

test("full-test request and owner decision authorize one unfiltered full suite only without task mutation or implicit execution",async t=>{
  const f=await createFullTestScopeFixture(t),before=await f.current(),steps=await f.steps(),first=await f.post(f.path("request-full-test-scope-recovery"));
  assert.equal(first.status,200);assert.equal(first.body.approval.status,"pending");assert.equal(first.body.approval.tool,"self_development_full_test_scope_recovery");
  const binding=first.body.approval.arguments;
  assert.equal(binding.planHash,f.plan.planHash);assert.equal(binding.expectedVersion,215);assert.equal(binding.maxFullTestRuns,1);assert.equal(binding.maxSteps,1);assert.equal(binding.runtimeMinutes,5);assert.equal(binding.maxProductMutations,0);assert.equal(binding.maxAdditionalAttempts,0);assert.equal(binding.sourceApplyStepId,"149:apply_patch");assert.equal(binding.sourceFocusedStepId,"150:run_focused_tests");
  const id=first.body.approval.id,again=await f.post(f.path("request-full-test-scope-recovery"));assert.equal(again.body.idempotent,true);assert.equal(again.body.approval.id,id);
  const pending=await f.post(f.path("recover-full-test-scope"),{...f.input,approvalId:id});assert.equal(pending.status,409);assert.equal(pending.body.code,"full_test_scope_recovery_precondition_failed");assert.equal(pending.body.diagnostics.predicate,"exact_owner_approval");
  const decision=await f.post(`/api/approvals/${id}/decision`,{decision:"approved"});assert.equal(decision.status,200);assert.deepEqual(decision.body.execution,{authorized:true,approvalId:id});assert.equal(decision.body.approval.status,"approved");
  assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);assert.equal(f.fullExecutions.length,0);await f.verifyBytes(f.afterContents);
});

test("exact approved HTTP full-test recovery creates one successor and replay creates neither a second generation nor new repair authority",async t=>{
  const f=await createFullTestScopeFixture(t),requested=await f.post(f.path("request-full-test-scope-recovery")),id=requested.body.approval.id;
  await f.post(`/api/approvals/${id}/decision`,{decision:"approved"});const input={...f.input,approvalId:id};
  const result=await f.post(f.path("recover-full-test-scope"),input);assert.equal(result.status,200);assert.equal(result.body.task.stateVersion,216);assert.equal(result.body.recovery.maxFullTestRuns,1);assert.equal(result.body.recovery.maxAdditionalAttempts,0);assert.equal(result.body.recovery.maxProductMutations,0);
  const before=await f.current(),replay=await f.post(f.path("recover-full-test-scope"),input);assert.equal(replay.status,409);assert.equal(replay.body.code,"full_test_scope_recovery_precondition_failed");assert.deepEqual(await f.current(),before);assert.equal(before.metadata.fullTestScopeRecoveryHistory.length,1);assert.deepEqual(before.metadata.escalatedRepairHistory,f.executionBoundary.metadata.escalatedRepairHistory);assert.equal(f.fullExecutions.length,0);await f.verifyBytes(f.afterContents);
});

test("signed full-test requests cannot replace the validated plan, raw bytes or eight-file scope",async t=>{
  const f=await createFullTestScopeFixture(t),before=await f.current(),approvals=await f.storage.listApprovals(f.ownerId,{limit:100});
  const wrongPlan={...f.input,planHash:"0".repeat(64)},planResult=await f.post(f.path("request-full-test-scope-recovery"),wrongPlan);assert.equal(planResult.status,409);assert.equal(planResult.body.diagnostics.predicate,"owner_requested_plan_hash");
  for(const alter of [proof=>{proof.workspace.changedFiles.push({...proof.workspace.changedFiles[0],path:"test/unrelated.test.js"});},proof=>{proof.workspace.changedFiles[0].hash="0".repeat(40);},proof=>{proof.workspace.root+="/wrong";proof.workspace.gitTopLevel=proof.workspace.root;}]){
    const input=structuredClone(f.input);alter(input.workspaceProof);input.workspaceProofSignature=executionProofSignature(input.workspaceProof);const result=await f.post(f.path("request-full-test-scope-recovery"),input);assert.equal(result.status,409);assert.equal(result.body.code,"full_test_scope_recovery_precondition_failed");assert.equal(result.body.diagnostics.predicate,"current_workspace");
  }
  assert.deepEqual(await f.current(),before);assert.deepEqual(await f.storage.listApprovals(f.ownerId,{limit:100}),approvals);await f.verifyBytes(f.afterContents);
});
