import test from "node:test";
import assert from "node:assert/strict";
import {Readable} from "node:stream";
import {createEvidenceBoundReviewReplanFixture} from "./evidence-bound-review-replan-fixture.js";
import {executionProofSignature} from "./execution-scope-fixture.js";
import {createApi} from "../src/http/api.js";
import {describeImplementationContentReviewReplan,describeSourceLiteralReviewReplan,describeObservableLinkageReviewReplan,describeSemanticEvidenceReviewReplan,IMPLEMENTATION_CONTENT_REVIEW_REPLAN_CLASS,SOURCE_LITERAL_REVIEW_REPLAN_CLASS,OBSERVABLE_LINKAGE_REVIEW_REPLAN_CLASS,SEMANTIC_EVIDENCE_REVIEW_REPLAN_CLASS} from "../src/autonomy/review-remediation-scope.js";
import {recoveryHash} from "../src/autonomy/failed-local-read-recovery.js";

const freshWorker="persistent-local-abcdef01-2345-4abc-8def-0123456789ab";

async function fixture(t,{secondOutput}={}){
  let generation=0;
  const f=await createEvidenceBoundReviewReplanFixture(t,{output(value){
    generation++;
    if(generation===1)return{...value,files:value.files.slice(0,5).map(file=>({...file,content:""})),focusedTests:value.focusedTests.slice(0,2)};
    return secondOutput?secondOutput(value):value;
  }});
  await f.authorize();await f.recover();await f.runSteps(9);
  const blocked=await f.current(),failed=(await f.steps()).at(-1);
  assert.equal(blocked.stateVersion,335);assert.equal(blocked.status,"blocked");assert.equal(blocked.errorCode,"implementation_plan_invalid");assert.equal(blocked.currentStep,199);assert.equal(failed.stepId,"200:plan_repair");
  assert.deepEqual(failed.result.diagnostics.validationIssues,[0,1,2,3,4].map(index=>`file_${index}_content_invalid`));assert.equal(f.executions.some(item=>item.name==="repo_apply_patch"),false);
  const input=structuredClone(f.input);input.expectedVersion=335;input.workspaceProof.expectedVersion=335;input.workspaceProofSignature=executionProofSignature(input.workspaceProof);delete input.approvalId;
  const actor={...f.actor,workspaceProof:input.workspaceProof},options={...f.options,input,actor};
  return{...f,input,actor,options,blocked,failed,generation:()=>generation};
}

async function v363Fixture(t,{thirdOutput}={}){
  let afterEmpty=0;
  const f=await fixture(t,{secondOutput:value=>{
    afterEmpty++;
    if(afterEmpty===1){value.reviewCoverage[0].sourceExcerpt="STALE_OR_FABRICATED_EXCERPT_NOT_IN_PROPOSED_SOURCE";return value;}
    return thirdOutput?thirdOutput(value):value;
  }});
  const requested=await f.service.requestImplementationContentReviewReplanApproval(f.taskId,f.input,f.actor);
  await f.storage.decideApproval(requested.approval.id,f.ownerId,"approved");f.input.approvalId=requested.approval.id;
  await f.service.recoverImplementationContentReviewReplan(f.taskId,f.input,f.actor);
  const predecessorWorker=f.createWorker("persistent-local-abcdef02-2345-4abc-8def-0123456789ab");for(let index=0;index<9;index++)assert.equal((await predecessorWorker.runOnce()).worked,true);
  const blocked=await f.current(),failed=(await f.steps()).at(-1);assert.equal(blocked.stateVersion,363);assert.equal(blocked.status,"blocked");assert.equal(blocked.errorCode,"review_remediation_precondition_failed");assert.equal(failed.result.diagnostics.coverageDiagnostics.firstFailure.subclause,"source_contains_excerpt");assert.equal(failed.result.diagnostics.mutationApplied,false);
  const reference=failed.result.rejectedReviewEvidence,evidence=await f.storage.getRejectedReviewEvidence(reference.id,f.ownerId,f.taskId),item=evidence.envelope.coverage[0];
  assert.equal(item.sourceOrigin,"proposed_replacement");assert.equal(item.expectedSourceHash,item.suppliedSourceHash);assert.equal(item.sourceExcerpt,"STALE_OR_FABRICATED_EXCERPT_NOT_IN_PROPOSED_SOURCE");assert.equal(item.firstFailedSubclause,"source_contains_excerpt");
  const input=structuredClone(f.input);delete input.approvalId;input.expectedVersion=363;input.workspaceProof.expectedVersion=363;input.workspaceProofSignature=executionProofSignature(input.workspaceProof);
  const actor={...f.actor,workspaceProof:input.workspaceProof},options={...f.options,input,actor};
  return{...f,input,actor,options,blocked,failed,evidence,afterEmpty:()=>afterEmpty};
}

async function v391Fixture(t,{fourthOutput}={}){
  let afterSourceLiteral=0;
  const f=await v363Fixture(t,{thirdOutput:value=>{
    afterSourceLiteral++;
    if(afterSourceLiteral===1){value.reviewCoverage[0].observable="not a code reference";return value;}
    return fourthOutput?fourthOutput(value):value;
  }});
  const requested=await f.service.requestSourceLiteralReviewReplanApproval(f.taskId,f.input,f.actor);
  await f.storage.decideApproval(requested.approval.id,f.ownerId,"approved");f.input.approvalId=requested.approval.id;
  await f.service.recoverSourceLiteralReviewReplan(f.taskId,f.input,f.actor);
  const predecessorWorker=f.createWorker("persistent-local-abcdef05-2345-4abc-8def-0123456789ab");for(let index=0;index<9;index++)assert.equal((await predecessorWorker.runOnce()).worked,true);
  const blocked=await f.current(),failed=(await f.steps()).at(-1);assert.equal(blocked.stateVersion,391);assert.equal(blocked.status,"blocked");assert.equal(blocked.errorCode,"review_remediation_precondition_failed");assert.equal(failed.result.diagnostics.predicate,"observable_behavioral_test_linkage");assert.equal(failed.result.diagnostics.coverageDiagnostics.firstFailure.subclause,"observable_code_reference");assert.equal(failed.result.diagnostics.mutationApplied,false);
  const historical=blocked.metadata.sourceLiteralReviewReplanHistory[0],historicalSteps=blocked.metadata.steps.slice(historical.activeContinuation.startStep,historical.activeContinuation.startStep+13),historicalContract=historicalSteps[8].input.arguments.failureEvidence.requiredReviewCoverageContract;
  assert.deepEqual(historicalContract,{sourceExcerpt:"exact non-placeholder literal substring of the proposed replacement source for testPath",testName:"same named test declaration contained in sourceExcerpt",stimulus:"literal stimulus code contained in sourceExcerpt and preceding assertion",assertion:"literal behavioral assertion contained in sourceExcerpt",staleOrPlaceholderEvidenceForbidden:true});
  assert.equal(recoveryHash(historicalSteps),historical.successorStepsHash);
  const reference=failed.result.rejectedReviewEvidence,evidence=await f.storage.getRejectedReviewEvidence(reference.id,f.ownerId,f.taskId),item=evidence.envelope.coverage[0];
  assert.equal(item.observable,"not a code reference");assert.equal(item.sourceOrigin,"proposed_replacement");assert.equal(item.firstFailedSubclause,"observable_code_reference");
  const input=structuredClone(f.input);delete input.approvalId;input.expectedVersion=391;input.workspaceProof.expectedVersion=391;input.workspaceProofSignature=executionProofSignature(input.workspaceProof);
  const actor={...f.actor,workspaceProof:input.workspaceProof},options={...f.options,input,actor};
  return{...f,input,actor,options,blocked,failed,evidence,afterSourceLiteral:()=>afterSourceLiteral};
}

async function v419Fixture(t,{fifthOutput}={}){
  let afterObservable=0;
  const f=await v391Fixture(t,{fourthOutput:value=>{
    afterObservable++;
    if(afterObservable===1){
      const item=value.reviewCoverage[0],invented="Console activates all seven workspaces and voice input without fake Soon states";
      value.files=value.files.filter(file=>file.path!==item.testPath);
      value.acceptanceMapping=value.acceptanceMapping.map(mapping=>({...mapping,files:mapping.files.filter(path=>path!==item.testPath)}));
      item.testName=invented;item.sourceExcerpt=`test('${invented}', () => { const result = exercise(); assert.equal(result, true); });`;
      return value;
    }
    return fifthOutput?fifthOutput(value):value;
  }});
  const requested=await f.service.requestObservableLinkageReviewReplanApproval(f.taskId,f.input,f.actor);
  await f.storage.decideApproval(requested.approval.id,f.ownerId,"approved");f.input.approvalId=requested.approval.id;
  await f.service.recoverObservableLinkageReviewReplan(f.taskId,f.input,f.actor);
  const predecessorWorker=f.createWorker("persistent-local-abcdef09-2345-4abc-8def-0123456789ab");for(let index=0;index<9;index++)assert.equal((await predecessorWorker.runOnce()).worked,true);
  const blocked=await f.current(),failed=(await f.steps()).at(-1);assert.equal(blocked.stateVersion,419);assert.equal(blocked.status,"blocked");assert.equal(blocked.errorCode,"review_remediation_precondition_failed");assert.equal(failed.result.diagnostics.predicate,"source_bound_behavioral_coverage");assert.equal(failed.result.diagnostics.coverageDiagnostics.firstFailure.subclause,"source_contains_excerpt");assert.equal(failed.result.diagnostics.mutationApplied,false);
  const reference=failed.result.rejectedReviewEvidence,evidence=await f.storage.getRejectedReviewEvidence(reference.id,f.ownerId,f.taskId),item=evidence.envelope.coverage[0];
  assert.equal(item.sourceOrigin,"fresh_read");assert.equal(item.firstFailedSubclause,"source_contains_excerpt");
  const input=structuredClone(f.input);delete input.approvalId;input.expectedVersion=419;input.workspaceProof.expectedVersion=419;input.workspaceProofSignature=executionProofSignature(input.workspaceProof);
  const actor={...f.actor,workspaceProof:input.workspaceProof},options={...f.options,input,actor};
  return{...f,input,actor,options,blocked,failed,evidence,afterObservable:()=>afterObservable};
}

test("v335 empty replacement rejection permits one distinct owner-approved complete-content replan through fresh review_ready",async t=>{
  const f=await fixture(t),before=structuredClone(f.blocked),described=await describeImplementationContentReviewReplan(f.options);
  assert.equal(described.approvalArguments.expectedVersion,335);assert.equal(described.approvalArguments.maxSteps,13);assert.equal(described.approvalArguments.maxApplyAttempts,1);assert.equal(described.approvalArguments.maxAdditionalAttempts,0);
  assert.equal((await f.post(f.path("request-implementation-content-review-replan"),f.input,"wrong-worker-token")).status,401);
  const response=await f.post(f.path("request-implementation-content-review-replan"),f.input),requested=response.body;assert.equal(response.status,200);
  const decision=await f.post(`/api/approvals/${requested.approval.id}/decision`,{decision:"approved"});assert.equal(decision.status,200);assert.deepEqual(decision.body.execution,{authorized:true,approvalId:requested.approval.id});f.input.approvalId=requested.approval.id;
  const recovered=await f.service.recoverImplementationContentReviewReplan(f.taskId,f.input,f.actor),record=recovered.recovery;
  assert.equal(record.recoveryClass,IMPLEMENTATION_CONTENT_REVIEW_REPLAN_CLASS);assert.equal(record.fromStateVersion,335);assert.equal(record.repairIteration,3);assert.equal(record.implementationContentReplan,true);assert.equal(record.maxAdditionalAttempts,0);assert.equal(record.activeContinuation.maxSteps,13);assert.equal(record.activeContinuation.runtimeMinutes,15);
  const planStep=recovered.task.metadata.steps[record.activeContinuation.startStep+8];assert.equal(planStep.input.arguments.failureEvidence.code,"implementation_content_invalid");assert.deepEqual(planStep.input.arguments.failureEvidence.requiredImplementationContentContract,{operation:"replace",contentType:"string",completeReplacement:true,minLength:1,maxLength:250000,instructionsOrPlaceholdersForbidden:true});
  const worker=f.createWorker(freshWorker);for(let index=0;index<13;index++)assert.equal((await worker.runOnce()).worked,true);
  const final=await f.current(),history=final.metadata.implementationContentReviewReplanHistory[0],boundary=final.metadata.implementationContentReviewReplanBoundary;
  assert.equal(final.status,"blocked");assert.equal(final.repairIteration,3);assert.equal(history.consumed,true);assert.equal(history.result,"full_tests_completed");assert.equal(boundary.kind,"review_ready");assert.equal(boundary.executionAuthorized,false);assert.equal(f.generation(),2);
  assert.equal(f.executions.filter(item=>item.name==="repo_apply_patch").length,1);assert.equal(f.executions.filter(item=>item.name==="test_run").length,1);assert.equal(f.executions.filter(item=>item.name==="test_run_full").length,1);
  assert.equal(final.metadata.escalatedRepairHistory.length,before.metadata.escalatedRepairHistory.length);assert.deepEqual(final.metadata.escalatedRepairHistory,before.metadata.escalatedRepairHistory);assert.deepEqual(await worker.runOnce(),{worked:false});
});

test("v335 successor refuses malformed regenerated content before mutation and cannot replay",async t=>{
  const f=await fixture(t,{secondOutput:value=>({...value,files:value.files.map((file,index)=>index===0?{...file,content:null}:file)})});
  const requested=await f.service.requestImplementationContentReviewReplanApproval(f.taskId,f.input,f.actor);await f.storage.decideApproval(requested.approval.id,f.ownerId,"approved");f.input.approvalId=requested.approval.id;await f.service.recoverImplementationContentReviewReplan(f.taskId,f.input,f.actor);
  const worker=f.createWorker(freshWorker);for(let index=0;index<9;index++)assert.equal((await worker.runOnce()).worked,true);
  const final=await f.current();assert.equal(final.status,"blocked");assert.equal(final.errorCode,"implementation_plan_invalid");assert.equal(f.executions.filter(item=>item.name==="repo_apply_patch").length,0);assert.deepEqual(await worker.runOnce(),{worked:false});await assert.rejects(()=>f.service.recoverImplementationContentReviewReplan(f.taskId,f.input,f.actor));
});

test("v335 successor remains fail-closed for scope, workspace hash, predecessor, and approval drift",async t=>{
  const f=await fixture(t),task=await f.current(),steps=await f.steps();
  for(const alter of[
    options=>options.input.workspaceProof.workspace.changedFiles[0].hash="0".repeat(40),
    options=>options.input.workspaceProof.workspace.changedFiles.push({path:"test/ninth.test.js",hashAlgorithm:"git_sha1",hash:"0".repeat(40),rawHash:"0".repeat(40),contentHash:"0".repeat(64)}),
    options=>options.task.metadata.evidenceBoundReviewReplanHistory[0].consumed=false,
    options=>options.task.repairIteration=4,
    options=>options.steps.find(step=>step.stepId==="200:plan_repair").result.diagnostics.validationIssues[0]="file_0_reason_invalid",
  ]){const options={...f.options,task:structuredClone(task),steps:structuredClone(steps),input:structuredClone(f.input),actor:structuredClone(f.actor)};options.actor.workspaceProof=options.input.workspaceProof;alter(options);await assert.rejects(()=>describeImplementationContentReviewReplan(options));}
  assert.deepEqual(await f.current(),task);assert.deepEqual(await f.steps(),steps);
});

test("approval decision routing preserves the generic resume path for unrelated tools",async t=>{
  const f=await fixture(t),approval=await f.storage.createApproval({id:"synthetic-unrelated-routing-approval",ownerId:f.ownerId,projectId:"nova-brain",runId:f.taskId,tool:"unrelated_existing_tool",reason:"Synthetic routing compatibility",riskLevel:"SENSITIVE",arguments:{}});
  let resumeCalls=0;
  const api=createApi({agent:{tools:{list(){return[];},async execute(){assert.fail("Task-bound unrelated approvals must use the existing worker resume path");}}},config:{allowedOrigins:[],maxBodyBytes:256*1024},storage:f.storage,initialize:async()=>{},ownerId:f.ownerId,selfDevelopment:f.service,workerRuntime:{get:f.current,async resumeApproval(taskId,approved){resumeCalls++;return{route:"generic",taskId,approvalId:approved.id};},async control(){assert.fail("Approved unrelated tools must not use task control");}},logger:{info(){},error(){}}});
  const req=Readable.from([JSON.stringify({decision:"approved"})]);req.method="POST";req.url=`/api/approvals/${approval.id}/decision`;req.headers={"content-type":"application/json"};let text="";const res={setHeader(){},end(value=""){text+=value;}};
  await api.handle(req,res);const body=JSON.parse(text);
  assert.equal(res.statusCode,200);assert.equal(resumeCalls,1);assert.deepEqual(body.execution,{route:"generic",taskId:f.taskId,approvalId:approval.id});
});

test("v363 source-literal rejection permits one distinct owner-approved replan through fresh review_ready",async t=>{
  const f=await v363Fixture(t),before=structuredClone(f.blocked),described=await describeSourceLiteralReviewReplan(f.options);
  assert.equal(described.approvalArguments.expectedVersion,363);assert.equal(described.sourceProof.privateEvidenceId,f.failed.result.rejectedReviewEvidence.id);assert.equal(described.sourceProof.rejectedPlanFingerprint,f.evidence.envelope.planFingerprint);
  assert.equal((await f.post(f.path("request-source-literal-review-replan"),f.input,"wrong-worker-token")).status,401);
  const requestResponse=await f.post(f.path("request-source-literal-review-replan"),f.input),requested=requestResponse.body;assert.equal(requestResponse.status,200);assert.equal(requested.approval.tool,"self_development_source_literal_review_replan");
  const decision=await f.post(`/api/approvals/${requested.approval.id}/decision`,{decision:"approved"});assert.equal(decision.status,200);assert.deepEqual(decision.body.execution,{authorized:true,approvalId:requested.approval.id});f.input.approvalId=requested.approval.id;
  const recovered=await f.service.recoverSourceLiteralReviewReplan(f.taskId,f.input,f.actor),record=recovered.recovery;assert.equal(record.recoveryClass,SOURCE_LITERAL_REVIEW_REPLAN_CLASS);assert.equal(record.fromStateVersion,363);assert.equal(record.repairIteration,3);assert.equal(record.maxAdditionalAttempts,0);assert.equal(record.sourceLiteralReplan,true);
  const contract=recovered.task.metadata.steps[record.activeContinuation.startStep+8].input.arguments.failureEvidence;assert.equal(contract.code,"review_coverage_source_literal_invalid");assert.equal(contract.requiredImplementationContentContract.completeReplacement,true);assert.match(contract.requiredReviewCoverageContract.sourceExcerpt,/exact non-placeholder literal substring/);assert.equal(contract.requiredReviewCoverageContract.staleOrPlaceholderEvidenceForbidden,true);
  const worker=f.createWorker("persistent-local-abcdef03-2345-4abc-8def-0123456789ab");for(let index=0;index<13;index++)assert.equal((await worker.runOnce()).worked,true);
  const final=await f.current(),history=final.metadata.sourceLiteralReviewReplanHistory[0],boundary=final.metadata.sourceLiteralReviewReplanBoundary;assert.equal(final.status,"blocked");assert.equal(final.repairIteration,3);assert.equal(history.consumed,true);assert.equal(history.result,"full_tests_completed");assert.equal(boundary.kind,"review_ready");assert.equal(boundary.executionAuthorized,false);assert.equal(f.afterEmpty(),2);
  assert.equal(f.executions.filter(item=>item.name==="repo_apply_patch").length,1);assert.equal(f.executions.filter(item=>item.name==="test_run").length,1);assert.equal(f.executions.filter(item=>item.name==="test_run_full").length,1);assert.deepEqual(final.metadata.escalatedRepairHistory,before.metadata.escalatedRepairHistory);assert.deepEqual(await worker.runOnce(),{worked:false});await assert.rejects(()=>f.service.recoverSourceLiteralReviewReplan(f.taskId,f.input,f.actor));await assert.rejects(()=>f.service.recoverImplementationContentReviewReplan(f.taskId,f.input,f.actor));
});

for(const[name,change]of[
  ["non-substring",value=>{value.reviewCoverage[0].sourceExcerpt="NOT_PRESENT_IN_REPLACEMENT";}],
  ["stale excerpt",value=>{value.reviewCoverage[0].sourceExcerpt="legacy bytes absent after replacement";}],
  ["placeholder excerpt",value=>{value.reviewCoverage[0].sourceExcerpt="TODO: supply named behavioral test evidence";}],
])test(`v363 successor rejects ${name} evidence before mutation`,async t=>{
  const f=await v363Fixture(t,{thirdOutput:value=>{change(value);return value;}}),requested=await f.service.requestSourceLiteralReviewReplanApproval(f.taskId,f.input,f.actor);await f.storage.decideApproval(requested.approval.id,f.ownerId,"approved");f.input.approvalId=requested.approval.id;await f.service.recoverSourceLiteralReviewReplan(f.taskId,f.input,f.actor);
  const worker=f.createWorker("persistent-local-abcdef04-2345-4abc-8def-0123456789ab");for(let index=0;index<9;index++)assert.equal((await worker.runOnce()).worked,true);const final=await f.current();assert.equal(final.status,"blocked");assert.equal(final.errorCode,"review_remediation_precondition_failed");assert.equal(f.executions.filter(item=>item.name==="repo_apply_patch").length,0);assert.deepEqual(await worker.runOnce(),{worked:false});
});

test("v363 successor refuses ninth path, workspace hash drift, predecessor reuse, and repair counter drift",async t=>{
  const f=await v363Fixture(t),task=await f.current(),steps=await f.steps();
  for(const alter of[
    options=>options.input.workspaceProof.workspace.changedFiles[0].hash="0".repeat(40),
    options=>options.input.workspaceProof.workspace.changedFiles.push({path:"test/ninth.test.js",hashAlgorithm:"git_sha1",hash:"0".repeat(40),rawHash:"0".repeat(40),contentHash:"0".repeat(64)}),
    options=>options.task.metadata.implementationContentReviewReplanHistory[0].consumed=false,
    options=>options.task.repairIteration=4,
    options=>options.steps.find(step=>step.stepId===f.failed.stepId).result.diagnostics.coverageDiagnostics.constraints[0].expectedSourceHash="0".repeat(64),
  ]){const options={...f.options,task:structuredClone(task),steps:structuredClone(steps),input:structuredClone(f.input),actor:structuredClone(f.actor)};options.actor.workspaceProof=options.input.workspaceProof;alter(options);await assert.rejects(()=>describeSourceLiteralReviewReplan(options));}
  assert.deepEqual(await f.current(),task);assert.deepEqual(await f.steps(),steps);
});

test("v391 observable-linkage rejection permits one owner-approved replan through fresh review_ready",async t=>{
  const f=await v391Fixture(t),before=structuredClone(f.blocked),described=await describeObservableLinkageReviewReplan(f.options);
  assert.equal(described.approvalArguments.expectedVersion,391);assert.equal(described.sourceProof.privateEvidenceId,f.failed.result.rejectedReviewEvidence.id);assert.equal(described.sourceProof.rejectedPlanFingerprint,f.evidence.envelope.planFingerprint);
  assert.equal((await f.post(f.path("request-observable-linkage-review-replan"),f.input,"wrong-worker-token")).status,401);
  const requestResponse=await f.post(f.path("request-observable-linkage-review-replan"),f.input),requested=requestResponse.body;assert.equal(requestResponse.status,200);assert.equal(requested.approval.tool,"self_development_observable_linkage_review_replan");
  const decision=await f.post(`/api/approvals/${requested.approval.id}/decision`,{decision:"approved"});assert.equal(decision.status,200);assert.deepEqual(decision.body.execution,{authorized:true,approvalId:requested.approval.id});f.input.approvalId=requested.approval.id;
  const recovered=await f.service.recoverObservableLinkageReviewReplan(f.taskId,f.input,f.actor),record=recovered.recovery;assert.equal(record.recoveryClass,OBSERVABLE_LINKAGE_REVIEW_REPLAN_CLASS);assert.equal(record.fromStateVersion,391);assert.equal(record.repairIteration,3);assert.equal(record.maxAdditionalAttempts,0);assert.equal(record.observableLinkageReplan,true);
  const contract=recovered.task.metadata.steps[record.activeContinuation.startStep+8].input.arguments.failureEvidence;assert.equal(contract.code,"review_coverage_observable_linkage_invalid");assert.equal(contract.requiredImplementationContentContract.completeReplacement,true);assert.match(contract.requiredReviewCoverageContract.observableCodeReference,/real code reference/);assert.match(contract.requiredReviewCoverageContract.coherentBehavioralTest,/same test behavior/);assert.equal(contract.requiredReviewCoverageContract.staleOrPlaceholderEvidenceForbidden,true);
  const worker=f.createWorker("persistent-local-abcdef06-2345-4abc-8def-0123456789ab");for(let index=0;index<13;index++)assert.equal((await worker.runOnce()).worked,true);
  const final=await f.current(),history=final.metadata.observableLinkageReviewReplanHistory[0],boundary=final.metadata.observableLinkageReviewReplanBoundary;assert.equal(final.status,"blocked");assert.equal(final.repairIteration,3);assert.equal(history.consumed,true);assert.equal(history.result,"full_tests_completed");assert.equal(boundary.kind,"review_ready");assert.equal(boundary.executionAuthorized,false);assert.equal(f.afterSourceLiteral(),2);
  assert.equal(f.executions.filter(item=>item.name==="repo_apply_patch").length,1);assert.equal(f.executions.filter(item=>item.name==="test_run").length,1);assert.equal(f.executions.filter(item=>item.name==="test_run_full").length,1);assert.deepEqual(final.metadata.escalatedRepairHistory,before.metadata.escalatedRepairHistory);assert.deepEqual(await worker.runOnce(),{worked:false});await assert.rejects(()=>f.service.recoverObservableLinkageReviewReplan(f.taskId,f.input,f.actor));await assert.rejects(()=>f.service.recoverSourceLiteralReviewReplan(f.taskId,f.input,f.actor));
});

test("v391 successor rejects an invalid observable reference before mutation",async t=>{
  const f=await v391Fixture(t,{fourthOutput:value=>{value.reviewCoverage[0].observable="still not a code reference";return value;}}),requested=await f.service.requestObservableLinkageReviewReplanApproval(f.taskId,f.input,f.actor);await f.storage.decideApproval(requested.approval.id,f.ownerId,"approved");f.input.approvalId=requested.approval.id;await f.service.recoverObservableLinkageReviewReplan(f.taskId,f.input,f.actor);
  const worker=f.createWorker("persistent-local-abcdef07-2345-4abc-8def-0123456789ab");for(let index=0;index<9;index++)assert.equal((await worker.runOnce()).worked,true);const final=await f.current();assert.equal(final.status,"blocked");assert.equal(final.errorCode,"review_remediation_precondition_failed");assert.equal((await f.steps()).at(-1).result.diagnostics.coverageDiagnostics.firstFailure.subclause,"observable_code_reference");assert.equal(f.executions.filter(item=>item.name==="repo_apply_patch").length,0);assert.deepEqual(await worker.runOnce(),{worked:false});
});

test("v391 successor rejects plan scope expansion before mutation",async t=>{
  const f=await v391Fixture(t,{fourthOutput:value=>({...value,files:[...value.files,{path:"test/ninth.test.js",operation:"replace",content:"test('ninth',()=>{});"}]})}),requested=await f.service.requestObservableLinkageReviewReplanApproval(f.taskId,f.input,f.actor);await f.storage.decideApproval(requested.approval.id,f.ownerId,"approved");f.input.approvalId=requested.approval.id;await f.service.recoverObservableLinkageReviewReplan(f.taskId,f.input,f.actor);
  const worker=f.createWorker("persistent-local-abcdef08-2345-4abc-8def-0123456789ab");for(let index=0;index<9;index++)assert.equal((await worker.runOnce()).worked,true);const final=await f.current();assert.equal(final.status,"blocked");assert.equal(f.executions.filter(item=>item.name==="repo_apply_patch").length,0);assert.deepEqual(await worker.runOnce(),{worked:false});
});

test("v391 successor refuses workspace drift, predecessor reuse, and repair counter drift",async t=>{
  const f=await v391Fixture(t),task=await f.current(),steps=await f.steps();
  for(const alter of[
    options=>options.input.workspaceProof.workspace.changedFiles[0].hash="0".repeat(40),
    options=>options.input.workspaceProof.workspace.changedFiles.push({path:"test/ninth.test.js",hashAlgorithm:"git_sha1",hash:"0".repeat(40),rawHash:"0".repeat(40),contentHash:"0".repeat(64)}),
    options=>options.task.metadata.sourceLiteralReviewReplanHistory[0].consumed=false,
    options=>options.task.repairIteration=4,
    options=>options.steps.find(step=>step.stepId===f.failed.stepId).result.diagnostics.coverageDiagnostics.constraints[0].expectedSourceHash="0".repeat(64),
  ]){const options={...f.options,task:structuredClone(task),steps:structuredClone(steps),input:structuredClone(f.input),actor:structuredClone(f.actor)};options.actor.workspaceProof=options.input.workspaceProof;alter(options);await assert.rejects(()=>describeObservableLinkageReviewReplan(options));}
  assert.deepEqual(await f.current(),task);assert.deepEqual(await f.steps(),steps);
});

test("v419 semantic-evidence rejection permits one owner-approved replan through fresh review_ready",async t=>{
  const f=await v419Fixture(t),before=structuredClone(f.blocked),described=await describeSemanticEvidenceReviewReplan(f.options);
  assert.equal(described.approvalArguments.expectedVersion,419);assert.equal(described.sourceProof.privateEvidenceId,f.failed.result.rejectedReviewEvidence.id);assert.equal(described.sourceProof.rejectedPlanFingerprint,f.evidence.envelope.planFingerprint);
  assert.equal((await f.post(f.path("request-semantic-evidence-review-replan"),f.input,"wrong-worker-token")).status,401);
  const requestResponse=await f.post(f.path("request-semantic-evidence-review-replan"),f.input),requested=requestResponse.body;assert.equal(requestResponse.status,200);assert.equal(requested.approval.tool,"self_development_semantic_evidence_review_replan");
  const decision=await f.post(`/api/approvals/${requested.approval.id}/decision`,{decision:"approved"});assert.equal(decision.status,200);assert.deepEqual(decision.body.execution,{authorized:true,approvalId:requested.approval.id});f.input.approvalId=requested.approval.id;
  const recovered=await f.service.recoverSemanticEvidenceReviewReplan(f.taskId,f.input,f.actor),record=recovered.recovery;assert.equal(record.recoveryClass,SEMANTIC_EVIDENCE_REVIEW_REPLAN_CLASS);assert.equal(record.fromStateVersion,419);assert.equal(record.repairIteration,3);assert.equal(record.maxAdditionalAttempts,0);assert.equal(record.semanticEvidenceReplan,true);
  const contract=recovered.task.metadata.steps[record.activeContinuation.startStep+8].input.arguments.failureEvidence;assert.equal(contract.code,"review_coverage_semantic_identity_invalid");assert.equal(contract.requiredImplementationContentContract.completeReplacement,true);assert.match(contract.requiredSemanticTestIdentityContract.existingTest,/exact hash-bound current source/);assert.match(contract.requiredSemanticTestIdentityContract.newTest,/authorized replacement containing the exact named behavioral test/);assert.equal(contract.requiredSemanticTestIdentityContract.hypotheticalOrPlaceholderTestsForbidden,true);
  const worker=f.createWorker("persistent-local-abcdef10-2345-4abc-8def-0123456789ab");for(let index=0;index<13;index++)assert.equal((await worker.runOnce()).worked,true);
  const final=await f.current(),history=final.metadata.semanticEvidenceReviewReplanHistory[0],boundary=final.metadata.semanticEvidenceReviewReplanBoundary;assert.equal(final.status,"blocked");assert.equal(final.repairIteration,3);assert.equal(history.consumed,true);assert.equal(history.result,"full_tests_completed");assert.equal(boundary.kind,"review_ready");assert.equal(boundary.executionAuthorized,false);assert.equal(f.afterObservable(),2);
  assert.equal(f.executions.filter(item=>item.name==="repo_apply_patch").length,1);assert.equal(f.executions.filter(item=>item.name==="test_run").length,1);assert.equal(f.executions.filter(item=>item.name==="test_run_full").length,1);assert.deepEqual(final.metadata.escalatedRepairHistory,before.metadata.escalatedRepairHistory);assert.deepEqual(await worker.runOnce(),{worked:false});await assert.rejects(()=>f.service.recoverSemanticEvidenceReviewReplan(f.taskId,f.input,f.actor));await assert.rejects(()=>f.service.recoverObservableLinkageReviewReplan(f.taskId,f.input,f.actor));
});

test("v419 successor rejects semantic identity, scope, drift, replay, and repair counter changes",async t=>{
  const invalid=await v419Fixture(t,{fifthOutput:value=>{const item=value.reviewCoverage[0],invented="hypothetical future test";value.files=value.files.filter(file=>file.path!==item.testPath);item.testName=invented;item.sourceExcerpt=`test('${invented}', () => { const result = exercise(); assert.equal(result, true); });`;return value;}}),requested=await invalid.service.requestSemanticEvidenceReviewReplanApproval(invalid.taskId,invalid.input,invalid.actor);await invalid.storage.decideApproval(requested.approval.id,invalid.ownerId,"approved");invalid.input.approvalId=requested.approval.id;await invalid.service.recoverSemanticEvidenceReviewReplan(invalid.taskId,invalid.input,invalid.actor);
  const worker=invalid.createWorker("persistent-local-abcdef11-2345-4abc-8def-0123456789ab");for(let index=0;index<9;index++)assert.equal((await worker.runOnce()).worked,true);const rejected=await invalid.current(),last=(await invalid.steps()).at(-1);assert.equal(rejected.status,"blocked");assert.equal(last.result.diagnostics.coverageDiagnostics.firstFailure.predicate,"semantic_test_identity_binding");assert.equal(last.result.diagnostics.coverageDiagnostics.firstFailure.subclause,"test_name_not_placeholder");assert.equal(invalid.executions.filter(item=>item.name==="repo_apply_patch").length,0);assert.deepEqual(await worker.runOnce(),{worked:false});await assert.rejects(()=>invalid.service.recoverSemanticEvidenceReviewReplan(invalid.taskId,invalid.input,invalid.actor));

  const f=await v419Fixture(t),task=await f.current(),steps=await f.steps();
  for(const alter of[
    options=>options.input.workspaceProof.workspace.changedFiles[0].hash="0".repeat(40),
    options=>options.input.workspaceProof.workspace.changedFiles.push({path:"test/ninth.test.js",hashAlgorithm:"git_sha1",hash:"0".repeat(40),rawHash:"0".repeat(40),contentHash:"0".repeat(64)}),
    options=>options.task.metadata.observableLinkageReviewReplanHistory[0].consumed=false,
    options=>options.task.repairIteration=4,
  ]){const options={...f.options,task:structuredClone(task),steps:structuredClone(steps),input:structuredClone(f.input),actor:structuredClone(f.actor)};options.actor.workspaceProof=options.input.workspaceProof;alter(options);await assert.rejects(()=>describeSemanticEvidenceReviewReplan(options));}
  assert.deepEqual(await f.current(),task);assert.deepEqual(await f.steps(),steps);
});
