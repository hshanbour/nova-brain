import test from "node:test";
import assert from "node:assert/strict";
import {createExecutionScopeFixture,executionProofSignature} from "./execution-scope-fixture.js";

test("both execution scope routes require valid worker bearer and a matching signed current workspace proof",async t=>{
  const f=await createExecutionScopeFixture(t),before=await f.current(),steps=await f.steps(),approvals=await f.storage.listApprovals(f.ownerId,{limit:100});
  for(const route of ["request-execution-scope-recovery","recover-execution-scope"]){
    for(const token of [null,"wrong-synthetic-worker-token"]){const out=await f.post(f.path(route),f.input,token);assert.equal(out.status,401);}
    for(const alter of [input=>{delete input.workspaceProofSignature;},input=>{input.workspaceProofSignature="0".repeat(64);},input=>{delete input.workspaceProof;},input=>{input.workspaceProof.workspace.changedFiles[0].hash="0".repeat(40);}]){
      const input=structuredClone(f.input);alter(input);const out=await f.post(f.path(route),input);assert.equal(out.status,403);assert.equal(out.body.code,"workspace_attestation_unauthorized");
    }
  }
  assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);assert.deepEqual(await f.storage.listApprovals(f.ownerId,{limit:100}),approvals);await f.verifyBytes(f.beforeContents);
});

test("execution request and normal owner decision authorize only exact existing plan and four tests without task or product mutation",async t=>{
  const f=await createExecutionScopeFixture(t),before=await f.current(),steps=await f.steps(),first=await f.post(f.path("request-execution-scope-recovery"));
  assert.equal(first.status,200);assert.equal(first.body.approval.status,"pending");assert.equal(first.body.approval.tool,"self_development_execution_scope_recovery");assert.equal(first.body.approval.arguments.planHash,f.plan.planHash);assert.equal(first.body.approval.arguments.expectedVersion,208);
  assert.equal(first.body.approval.arguments.maxProductMutations,1);assert.equal(first.body.approval.arguments.maxApplyAttempts,1);assert.equal(first.body.approval.arguments.maxFocusedTestRuns,1);assert.equal(first.body.approval.arguments.maxAdditionalAttempts,0);
  const id=first.body.approval.id,again=await f.post(f.path("request-execution-scope-recovery"));assert.equal(again.body.idempotent,true);assert.equal(again.body.approval.id,id);
  const pending=await f.post(f.path("recover-execution-scope"),{...f.input,approvalId:id});assert.equal(pending.status,409);assert.equal(pending.body.code,"execution_scope_recovery_precondition_failed");assert.equal(pending.body.diagnostics.predicate,"exact_owner_approval");
  const decision=await f.post(`/api/approvals/${id}/decision`,{decision:"approved"});assert.equal(decision.status,200);assert.deepEqual(decision.body.execution,{authorized:true,approvalId:id});assert.equal(decision.body.approval.status,"approved");
  assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);assert.equal(f.executions.length,1,"Only historical planning preflight executed during fixture setup");await f.verifyBytes(f.beforeContents);
});

test("approved exact HTTP recovery creates one execution successor; replay creates no renewal or second mutation path",async t=>{
  const f=await createExecutionScopeFixture(t),requested=await f.post(f.path("request-execution-scope-recovery")),id=requested.body.approval.id;
  await f.post(`/api/approvals/${id}/decision`,{decision:"approved"});const input={...f.input,approvalId:id};
  const result=await f.post(f.path("recover-execution-scope"),input);assert.equal(result.status,200);assert.equal(result.body.task.stateVersion,209);assert.equal(result.body.recovery.maxAdditionalAttempts,0);
  const before=await f.current(),replay=await f.post(f.path("recover-execution-scope"),input);assert.equal(replay.status,409);assert.equal(replay.body.code,"execution_scope_recovery_precondition_failed");assert.deepEqual(await f.current(),before);assert.equal(before.metadata.executionScopeRecoveryHistory.length,1);await f.verifyBytes(f.beforeContents);
});

test("correct signature cannot substitute a different validated plan hash or broaden the workspace in an execution request",async t=>{
  const f=await createExecutionScopeFixture(t),before=await f.current();
  const wrongPlan={...f.input,planHash:"0".repeat(64)},planResult=await f.post(f.path("request-execution-scope-recovery"),wrongPlan);assert.equal(planResult.status,409);assert.equal(planResult.body.diagnostics.predicate,"owner_requested_plan_hash");
  const broader=structuredClone(f.input);broader.workspaceProof.workspace.changedFiles.push({...broader.workspaceProof.workspace.changedFiles[0],path:"test/console-client.test.js"});broader.workspaceProofSignature=executionProofSignature(broader.workspaceProof);
  const scopeResult=await f.post(f.path("request-execution-scope-recovery"),broader);assert.equal(scopeResult.status,409);assert.equal(scopeResult.body.diagnostics.predicate,"current_workspace");assert.deepEqual(await f.current(),before);await f.verifyBytes(f.beforeContents);
});
