import test from "node:test";
import assert from "node:assert/strict";
import {createFailedFullTestRetryFixture,RETRY_WORKER} from "./failed-full-test-retry-fixture.js";
import {recoveryHash} from "../src/autonomy/failed-local-read-recovery.js";
import {FAILED_FULL_TEST_RETRY_CLASS,FAILED_FULL_TEST_RETRY_TOOL,describeFailedFullTestRetry,recoverFailedFullTestRetry,describeFullTestScopeRecovery,validateFullTestScopeContext,validateFullTestScopeEvidence,fullTestScopeDescriptor,fullTestScopePayload} from "../src/autonomy/full-test-scope-recovery.js";

test("v219 missing-package full-test failure has one separately approved retry without changing prior authority",async t=>{
  const f=await createFailedFullTestRetryFixture(t),before=await f.current(),beforeSteps=await f.steps(),described=await describeFailedFullTestRetry(f.options);
  assert.equal(before.stateVersion,219);assert.equal(before.status,"blocked");assert.equal(before.currentStep,151);assert.equal(before.currentPhase,"run_full_tests");
  assert.equal(described.failed.stepId,"151:run_full_tests");assert.deepEqual(described.diagnostics.counts,{tests:681,passed:678,failed:3,skipped:0});
  assert.equal(described.approvalArguments.maxFullTestRetries,1);assert.equal(described.approvalArguments.maxFullTestRuns,1);assert.equal(described.approvalArguments.maxSteps,1);assert.equal(described.approvalArguments.runtimeMinutes,5);assert.equal(described.approvalArguments.maxProductMutations,0);assert.equal(described.approvalArguments.maxAdditionalAttempts,0);
  assert.deepEqual(described.approvalArguments.dependencyPreflight,{package:"@neondatabase/serverless",cwd:described.predecessor.workspaceRoot,required:true,consumesOnFailure:true});
  assert.equal(fullTestScopeDescriptor(null),null);assert.equal(fullTestScopeDescriptor({metadata:{}}),null);
  assert.equal(fullTestScopeDescriptor(before).isRetry,false);assert.notEqual(f.head,f.runtimeVersion);assert.notEqual(described.predecessor.runtimeVersion,f.runtimeVersion);

  function isolated(){
    const task=structuredClone(before),steps=structuredClone(beforeSteps),input=structuredClone(f.input),actor={actorType:"scoped_local_worker",workspaceProof:input.workspaceProof};let writes=0;
    const options={...f.options,input,actor,runtime:{get:async()=>structuredClone(task),steps:async()=>structuredClone(steps)},storage:{...f.storage,updateAutonomyTask(){writes++;assert.fail("Eligibility may not mutate any task or product");},appendActivity(){writes++;assert.fail("Eligibility may not append history");}}};
    return{task,steps,input,actor,options,writes:()=>writes};
  }
  async function rejected(state,predicate){
    const snapshot=recoveryHash([state.task,state.steps]);
    await assert.rejects(()=>describeFailedFullTestRetry(state.options),error=>error.code==="full_test_scope_recovery_precondition_failed"&&error.safeDiagnostics.mutationApplied===false&&(!predicate||error.safeDiagnostics.predicate===predicate));
    assert.equal(recoveryHash([state.task,state.steps]),snapshot);assert.equal(state.writes(),0);
  }
  await t.test("historical expiry does not reopen or rewrite the prior consumed full-test authority",async()=>{const state=isolated();state.options.clock=()=>new Date("2099-01-01T00:00:00Z");await describeFailedFullTestRetry(state.options);assert.deepEqual(state.task,before);assert.deepEqual(state.steps,beforeSteps);});
  for(const [name,change] of [
    ["task mismatch",s=>{s.task.id="other";}],["version mismatch",s=>{s.task.stateVersion--;}],
    ["not blocked",s=>{s.task.status="failed";}],["phase mismatch",s=>{s.task.currentPhase="run_focused_tests";}],
    ["step mismatch",s=>{s.task.currentStep--;}],["wrong terminal reason",s=>{s.task.errorCode="handoff_failed";}],
    ["active lease",s=>{s.task.leaseOwner="other";}],["active handoff",s=>{s.task.metadata.localHandoff={id:"other"};}],
    ["task approval pending",s=>{s.task.approvalState={approvalId:"other"};}],
    ["repository mismatch",s=>{s.task.metadata.selfDevelopment.repository="other/repo";}],["branch mismatch",s=>{s.task.branch="main";}],
    ["HEAD mismatch",s=>{s.task.currentCommit="0".repeat(40);}],["starting commit mismatch",s=>{s.task.startingCommit="0".repeat(40);}],
    ["prior full test not consumed",s=>{s.task.metadata.fullTestScopeRecoveryHistory[0].consumed=false;}],
    ["prior full test was successful",s=>{s.task.metadata.fullTestScopeRecoveryHistory[0].result="full_tests_completed";}],
    ["prior full-test result hash drift",s=>{s.task.metadata.fullTestScopeRecoveryHistory[0].resultHash="0".repeat(64);}],
    ["prior full-test worker drift",s=>{s.task.metadata.fullTestScopeRecoveryHistory[0].workerBindingState="awaiting_worker_bind";}],
    ["prior boundary drift",s=>{s.task.metadata.fullTestScopeBoundary.mutationApplied=true;}],
    ["prior execution history drift",s=>{s.task.metadata.executionScopeRecoveryHistory[0].consumed=false;}],
    ["consumed repair extension reset",s=>{s.task.metadata.escalatedRepairHistory=[];}],
    ["repair counter reset",s=>{s.task.repairIteration=0;}],["retry counter reset",s=>{s.task.retryCount=0;}],
    ["plan byte drift",s=>{s.task.metadata.selfDevelopmentImplementationPlan.files[0].content+=" ";}],
    ["already used retry",s=>{s.task.metadata.failedFullTestRetryHistory=[{consumed:true}];}],
    ["different requested plan",s=>{s.input.planHash="0".repeat(64);}]
  ])await t.test(`${name} rejects without mutation`,async()=>{const state=isolated();change(state);await rejected(state);});
  for(const [name,change] of [
    ["task",p=>{p.taskId="other";}],["version",p=>{p.expectedVersion--;}],["runtime",p=>{p.runtimeVersion="f".repeat(40);}],
    ["root",p=>{p.workspace.root+="/other";}],["Git root",p=>{p.workspace.gitTopLevel+="/other";}],
    ["repository",p=>{p.workspace.repository="other/repo";}],["branch",p=>{p.workspace.branch="main";}],
    ["product/runtime identity",p=>{p.workspace.head=f.runtimeVersion;}],["live tip",p=>{p.workspace.liveTip="0".repeat(40);}],
    ["raw bytes",p=>{p.workspace.changedFiles[0].hash="0".repeat(40);}],["canonical content",p=>{p.workspace.changedFiles[0].contentHash="0".repeat(64);}],
    ["missing path",p=>{p.workspace.changedFiles.pop();}],["unrelated path",p=>{p.workspace.changedFiles.push({...p.workspace.changedFiles[0],path:"unrelated.js"});}]
  ])await t.test(`workspace ${name} drift rejects`,async()=>{const state=isolated();change(state.input.workspaceProof);await rejected(state);});
  for(const [name,change] of [
    ["source step absent",s=>{s.steps=s.steps.filter(step=>step.stepId!=="151:run_full_tests");}],
    ["source step successful",s=>{s.steps.find(step=>step.stepId==="151:run_full_tests").status="completed";}],
    ["second failed attempt",s=>{s.steps.find(step=>step.stepId==="151:run_full_tests").attempt=2;}],
    ["failed result drift",s=>{s.steps.find(step=>step.stepId==="151:run_full_tests").result.diagnostics.counts.failed=4;}],
    ["source output hash drift",s=>{s.steps.find(step=>step.stepId==="151:run_full_tests").result.diagnostics.fullTestScopeEvidence.entries[0].hash="0".repeat(40);}],
    ["earlier focused drift",s=>{s.steps.find(step=>step.stepId==="150:run_focused_tests").result.exitCode=1;}],
    ["applied lineage drift",s=>{s.steps.find(step=>step.stepId==="149:apply_patch").result.taskOwnedDirtyLineage.entries[0].contentHash="0".repeat(64);}],
    ["later mutation",s=>{s.steps.push({taskId:f.taskId,stepId:"152:apply_patch",stepType:"apply_patch",status:"completed",attempt:1});}],
    ["inserted historical step",s=>{s.steps.push({taskId:f.taskId,stepId:"1:extra",stepType:"read_files",status:"completed",attempt:1});}]
  ])await t.test(`${name} rejects`,async()=>{const state=isolated();change(state);state.options.runtime.steps=async()=>structuredClone(state.steps);await rejected(state);});

  // Keep the surrounding completion hash internally coherent here to exercise
  // the independent failure classifier rather than only its integrity check.
  for(const [name,change] of [
    ["unrelated failure",d=>{d.stdoutExcerpt="TypeError: unrelated";d.stderrExcerpt="";}],
    ["another missing package",d=>{d.stdoutExcerpt=d.stdoutExcerpt.replaceAll("@neondatabase/serverless","other-package");d.stderrExcerpt=d.stderrExcerpt.replaceAll("@neondatabase/serverless","other-package");}],
    ["missing error class",d=>{d.stdoutExcerpt=d.stdoutExcerpt.replaceAll("ERR_MODULE_NOT_FOUND","");d.stderrExcerpt=d.stderrExcerpt.replaceAll("ERR_MODULE_NOT_FOUND","");}],
    ["missing fingerprint",d=>{d.fingerprint="";}],["focused command",d=>{d.identity.command="node:test:focused";}],
    ["zero failed tests",d=>{d.counts={tests:681,passed:681,failed:0,skipped:0};}],
    ["killed test process",d=>{d.signal="SIGTERM";}],["unrelated failure path",d=>{d.failedFiles=["../outside.test.js"];}]
  ])await t.test(`${name} is not eligible for dependency retry`,async()=>{const state=isolated(),failed=state.steps.find(step=>step.stepId==="151:run_full_tests");change(failed.result.diagnostics);state.task.metadata.fullTestScopeRecoveryHistory[0].resultHash=recoveryHash(failed.result);await rejected(state,"exact_missing_dependency_failure");});

  await t.test("JSONB key order does not change failed-source evidence",async()=>{const state=isolated(),failed=state.steps.find(step=>step.stepId==="151:run_full_tests");failed.result=Object.fromEntries(Object.entries(failed.result).reverse());state.task.metadata.fullTestScopeBoundary=Object.fromEntries(Object.entries(state.task.metadata.fullTestScopeBoundary).reverse());await describeFailedFullTestRetry(state.options);});
  await t.test("old full-test successor remains rejected and cannot be recycled",async()=>{await assert.rejects(()=>describeFullTestScopeRecovery(f.options),error=>error.safeDiagnostics?.predicate==="blocked_focused_success_task_state");});
  for(const [name,change] of [["revoked",a=>{a.status="revoked";}],["wrong owner",a=>{a.ownerId="other";}],["wrong task",a=>{a.runId="other";}],["wrong historical tool",a=>{a.tool=FAILED_FULL_TEST_RETRY_TOOL;}]])await t.test(`historical full-test approval ${name} rejects`,async()=>{const state=isolated();state.options.storage.getApproval=async(id,owner)=>{const approval=await f.storage.getApproval(id,owner);if(id===described.predecessor.approvalId)change(approval);return approval;};await rejected(state,"historical_full_test_approval");});
  for(const branch of [f.branch,"stage13/control-plane-approved-delivery-runtime"])await t.test(`independent ${branch} tip must match`,async()=>{const state=isolated();state.options.verifyRemote=async request=>({currentTip:request.branch===branch?"0".repeat(40):request.branch===f.branch?f.head:f.runtimeVersion,ancestors:Object.fromEntries(request.requiredAncestors.map(sha=>[sha,true]))});await rejected(state,branch===f.branch?"live_product_tip":"runtime_transition");});
  await t.test("source runtime must be an ancestor of independently approved active runtime",async()=>{const state=isolated();state.options.verifyRemote=async request=>({currentTip:request.branch===f.branch?f.head:f.runtimeVersion,ancestors:Object.fromEntries(request.requiredAncestors.map(sha=>[sha,sha!==described.predecessor.runtimeVersion]))});await rejected(state,"runtime_transition");});

  await t.test("retry requires its own owner approval, never the consumed previous full-test approval",async()=>{for(const approvalId of [undefined,described.predecessor.approvalId]){const state=isolated();state.input.approvalId=approvalId;await assert.rejects(()=>recoverFailedFullTestRetry(state.options),error=>error.safeDiagnostics?.predicate==="exact_owner_approval");assert.equal(state.writes(),0);}});
  await f.authorize();
  for(const [name,change] of [["pending",a=>{a.status="pending";}],["wrong owner",a=>{a.ownerId="other";}],["wrong project",a=>{a.projectId="other";}],["old full-suite tool",a=>{a.tool="self_development_full_test_scope_recovery";}],["two retries",a=>{a.arguments.maxFullTestRetries=2;}],["extra repair",a=>{a.arguments.maxAdditionalAttempts=1;}],["mutation",a=>{a.arguments.maxProductMutations=1;}],["longer runtime",a=>{a.arguments.runtimeMinutes=6;}],["dependency bypass",a=>{a.arguments.dependencyPreflight.required=false;}]])await t.test(`owner contract ${name} rejects`,async()=>{const state=isolated();state.input.approvalId=f.input.approvalId;state.options.storage.getApproval=async(id,owner)=>{const approval=await f.storage.getApproval(id,owner);if(id===f.input.approvalId)change(approval);return approval;};await assert.rejects(()=>recoverFailedFullTestRetry(state.options),error=>error.safeDiagnostics?.predicate==="exact_owner_approval");assert.equal(state.writes(),0);});

  await t.test("one new retry generation preserves every previous consumed history and counter",async()=>{
    const {task,recovery:record}=await recoverFailedFullTestRetry(f.options),steps=await f.steps(),descriptor=fullTestScopeDescriptor(task);
    assert.equal(task.stateVersion,220);assert.equal(task.currentStep,151);assert.equal(task.status,"queued");assert.equal(record.recoveryClass,FAILED_FULL_TEST_RETRY_CLASS);
    assert.deepEqual(descriptor,{historyKey:"failedFullTestRetryHistory",boundaryKey:"failedFullTestRetryBoundary",recoveryClass:FAILED_FULL_TEST_RETRY_CLASS,tool:FAILED_FULL_TEST_RETRY_TOOL,isRetry:true});
    assert.equal(record.fullTestStepId,"152:run_full_tests");assert.equal(record.maxFullTestRetries,1);assert.equal(record.maxAdditionalAttempts,0);assert.equal(record.maxProductMutations,0);assert.equal(record.activeContinuation.maxSteps,1);assert.equal(record.activeContinuation.runtimeMinutes,5);assert.notEqual(record.activeContinuation.generationId,record.predecessorGenerationId);
    assert.deepEqual(task.metadata.steps.slice(151).map(step=>[step.type,step.input]),[["run_full_tests",{tool:"test_run_full",arguments:{}}]]);
    for(const[key,value]of Object.entries(before.metadata).filter(([key])=>/(?:History|Boundary)$/.test(key)&&key!=="continuationHistory"))assert.deepEqual(task.metadata[key],value,key);
    for(const key of ["repairIteration","retryCount","maxRetries","branch","currentCommit","startingCommit"])assert.equal(task[key],before[key]);
    assert.deepEqual(steps,beforeSteps);assert.deepEqual(record.entries,before.metadata.fullTestScopeRecoveryHistory[0].entries);
    const ctx={runtimeVersion:f.runtimeVersion,generationId:record.activeContinuation.generationId,repository:f.repository,branch:f.branch,root:f.root,workerId:RETRY_WORKER,allowFirstBind:true};
    assert.equal(validateFullTestScopeContext(task,steps,ctx,f.clock).firstBind,true);assert.equal(fullTestScopePayload(record).dependencyPreflight.consumesOnFailure,true);
    assert.throws(()=>validateFullTestScopeContext(task,steps,{...ctx,workerId:described.predecessor.workerId},f.clock));
    assert.throws(()=>validateFullTestScopeContext(task,steps,ctx,()=>new Date(record.activeContinuation.runtimeDeadline)));
    const oldHistory=structuredClone(task.metadata.fullTestScopeRecoveryHistory);task.metadata.fullTestScopeRecoveryHistory[0].consumed=false;assert.throws(()=>validateFullTestScopeEvidence(task,steps,f.clock),error=>error.safeDiagnostics?.predicate==="preserved_authority");task.metadata.fullTestScopeRecoveryHistory=oldHistory;
    for(const extra of [{taskId:f.taskId,stepId:record.fullTestStepId,stepType:"run_full_tests",attempt:2,status:"running",input:{tool:"test_run_full",arguments:{}}},{taskId:f.taskId,stepId:"153:run_full_tests",stepType:"run_full_tests",attempt:1,status:"running",input:{tool:"test_run_full",arguments:{}}}])assert.throws(()=>validateFullTestScopeEvidence(task,[...steps,extra],f.clock));
    await assert.rejects(()=>recoverFailedFullTestRetry(f.options),error=>error.code==="full_test_scope_recovery_precondition_failed");
    task.status="blocked";task.currentStep=152;task.errorCode="test_failed";task.metadata.failedFullTestRetryHistory[0].consumed=true;
    const replay={...f.options,input:{...f.input,expectedVersion:task.stateVersion,workspaceProof:{...f.input.workspaceProof,expectedVersion:task.stateVersion}},runtime:{get:async()=>task,steps:async()=>steps}};replay.actor={actorType:"scoped_local_worker",workspaceProof:replay.input.workspaceProof};
    await assert.rejects(()=>describeFailedFullTestRetry(replay),error=>error.safeDiagnostics?.predicate==="single_use_failed_full_test_retry");
  });
  await f.verifyUnchanged();
});
