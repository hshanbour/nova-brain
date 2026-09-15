import test from "node:test";
import assert from "node:assert/strict";
import {Readable} from "node:stream";
import {createApi} from "../src/http/api.js";
import {createEvidenceBoundReviewReplanFixture,EVIDENCE_BOUND_CLASS,EVIDENCE_BOUND_HISTORY,EVIDENCE_BOUND_ADMIN_TOKEN,assertEvidenceBoundHistoriesPreserved} from "./evidence-bound-review-replan-fixture.js";
import {executionProofSignature} from "./execution-scope-fixture.js";
import {PLANNING_TOKEN} from "./planning-scope-fixture.js";

const requestRoute="request-evidence-bound-review-replan",recoveryRoute="recover-evidence-bound-review-replan",approvalTool="self_development_evidence_bound_review_replan";

test("evidence-bound replan routes authenticate the worker and signed workspace before any service write",async t=>{
  const f=await createEvidenceBoundReviewReplanFixture(t),before=await f.current(),steps=await f.steps(),approvals=await f.storage.listApprovals(f.ownerId,{limit:100});
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

test("v307 successor needs its own owner decision and creates one idempotent approval without execution",async t=>{
  const f=await createEvidenceBoundReviewReplanFixture(t),before=await f.current(),steps=await f.steps(),executions=f.executions.length,prompts=f.prompts.length;
  const requested=await f.post(f.path(requestRoute));assert.equal(requested.status,200,JSON.stringify(requested.body));
  const approval=requested.body.approval,binding=approval.arguments;
  assert.equal(approval.status,"pending");assert.equal(approval.tool,approvalTool);assert.equal(approval.runId,f.taskId);assert.equal(binding.expectedVersion,307);assert.equal(binding.runtimeVersion,f.runtimeVersion);assert.equal(binding.runtimeMinutes,15);assert.equal(binding.maxSteps,13);assert.equal(binding.maxAdditionalAttempts,0);assert.deepEqual(binding.review,f.review);
  const duplicate=await f.post(f.path(requestRoute));assert.equal(duplicate.status,200,JSON.stringify(duplicate.body));assert.equal(duplicate.body.idempotent,true);assert.equal(duplicate.body.approval.id,approval.id);
  for(const prior of[before.metadata.reviewRemediationHistory[0],before.metadata.rejectedReviewPlanContinuationHistory[0],before.metadata.sourceBoundReviewReplanHistory[0]])assert.equal((await f.post(f.path(recoveryRoute),{...f.input,approvalId:prior.approvalId})).status,409);
  const input={...f.input,approvalId:approval.id};assert.equal((await f.post(f.path(recoveryRoute),input)).status,409);assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);
  const approved=await f.post(`/api/approvals/${approval.id}/decision`,{decision:"approved"});assert.equal(approved.status,200,JSON.stringify(approved.body));assert.equal(approved.body.approval.status,"approved");assert.equal(approved.body.execution.authorized,true);
  assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);assert.equal(f.executions.length,executions);assert.equal(f.prompts.length,prompts);await f.verifySourceUnchanged();
  const approvedDuplicate=await f.post(f.path(requestRoute));assert.equal(approvedDuplicate.status,200);assert.equal(approvedDuplicate.body.approval.id,approval.id);assert.equal(approvedDuplicate.body.idempotent,true);
  const recovered=await f.post(f.path(recoveryRoute),input);assert.equal(recovered.status,200,JSON.stringify(recovered.body));
  const after=await f.current();assert.equal(after.stateVersion,308);assert.equal(after.metadata.activeContinuation.recoveryClass,EVIDENCE_BOUND_CLASS);assert.equal(after.repairIteration,3);assertEvidenceBoundHistoriesPreserved(before,after);assert.equal(f.executions.length,executions);assert.equal(f.prompts.length,prompts);
  assert.equal((await f.post(f.path(recoveryRoute),input)).status,409);assert.equal((await f.post(f.path(requestRoute))).status,409);assert.deepEqual(await f.current(),after);assert.deepEqual(await f.steps(),steps);await f.verifySourceUnchanged();
});

test("signed v307 successor requests reject task, runtime, workspace, lineage and review binding drift",async t=>{
  const f=await createEvidenceBoundReviewReplanFixture(t),before=await f.current(),steps=await f.steps(),approvals=await f.storage.listApprovals(f.ownerId,{limit:100});
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

test("private rejected-plan evidence is owner/task scoped, unavailable to worker auth, escaped and read-only",async t=>{
  const privateName="Private audit <script>not executable</script> & selected declaration";
  const f=await createEvidenceBoundReviewReplanFixture(t,{output:value=>{value.reviewCoverage[0].testName=privateName;return value;}});
  await f.authorize();await f.recover();await f.runSteps(9);
  const before=await f.current(),steps=await f.steps(),record=before.metadata[EVIDENCE_BOUND_HISTORY][0],failed=steps.find(item=>item.stepId===record.planStepId),id=failed.result.rejectedReviewEvidence.id,path=f.path("rejected-plan-evidence/"+id);
  for(const token of[null,"wrong-owner-token",PLANNING_TOKEN]){const response=await f.get(path,token);assert.equal(response.status,401);assert.doesNotMatch(JSON.stringify(response.body),/Private audit|sourceExcerpt/);}
  const response=await f.get(path),envelope=response.body.evidence.envelope;
  assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(response.body.evidence.ownerId,f.ownerId);assert.equal(response.body.evidence.taskId,f.taskId);assert.equal(envelope.executionId,failed.stepId);assert.equal(envelope.coverage[0].testName,privateName);assert.equal(envelope.executionAuthorized,false);assert.equal(envelope.diagnosticOnly,true);
  assert.equal(response.headers["content-type"],"application/json; charset=utf-8");assert.equal(response.headers["cache-control"],"no-store");assert.equal(response.headers["x-content-type-options"],"nosniff");assert.equal(response.headers["referrer-policy"],"no-referrer");assert.doesNotMatch(response.rawText,/[<>&\u2028\u2029]/);assert.match(response.rawText,/\\u003cscript\\u003e/);
  const wrongTask=await f.get(path.replace(f.taskId,"another-task"));assert.equal(wrongTask.status,404);assert.equal(wrongTask.body.code,"rejected_review_evidence_not_found");
  assert.equal((await f.get(f.path("rejected-plan-evidence/00000000-0000-0000-0000-000000000000"))).status,404);
  assert.equal((await f.get(f.path("rejected-plan-evidence"))).status,404,"There is no broad/list diagnostic route");
  const readWithConfig=async(ownerId,workerAdminToken)=>{
    const api=createApi({agent:{tools:{list(){return[];}}},config:{allowedOrigins:[],maxBodyBytes:256*1024,localWorkerToken:PLANNING_TOKEN,workerAdminToken},storage:f.storage,initialize:async()=>{},ownerId,logger:{info(){},error(){}}});
    const request=Readable.from([]);request.method="GET";request.url=path;request.headers={authorization:"Bearer "+EVIDENCE_BOUND_ADMIN_TOKEN};let text="";const result={setHeader(){},end(value=""){text+=value;}};
    await api.handle(request,result);return{status:result.statusCode,body:JSON.parse(text)};
  };
  assert.equal((await readWithConfig(f.ownerId,null)).status,503,"A missing administrator credential must fail closed");
  assert.equal((await readWithConfig("another-owner",EVIDENCE_BOUND_ADMIN_TOKEN)).status,404,"A different configured owner must not read the record");
  assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);assert.equal(f.prompts.length,1);assert.equal(f.executions.length,8);await f.verifySourceUnchanged();
});
