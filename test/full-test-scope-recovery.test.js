import test from "node:test";
import assert from "node:assert/strict";
import {createFullTestScopeFixture,FULL_TEST_WORKER} from "./full-test-scope-fixture.js";
import {recoveryHash} from "../src/autonomy/failed-local-read-recovery.js";
import {FULL_TEST_SCOPE_RECOVERY_CLASS,FULL_TEST_SCOPE_RECOVERY_TOOL,FULL_TEST_SCOPE_RUNTIME_MINUTES,describeFullTestScopeRecovery,recoverFullTestScope,validateFullTestScopeContext,validateFullTestScopeEvidence,fullTestScopePayload} from "../src/autonomy/full-test-scope-recovery.js";

test("full-suite eligibility preserves a real v215 byte-identical application and focused-success boundary",async t=>{
  const f=await createFullTestScopeFixture(t),original=await f.current(),originalSteps=await f.steps(),originalBytes=new Map(f.afterContents);
  const described=await describeFullTestScopeRecovery(f.options);
  assert.equal(original.stateVersion,215);assert.equal(original.status,"blocked");assert.equal(original.currentStep,150);
  assert.equal(described.entries.length,8);assert.deepEqual(described.entries,original.metadata.executionScopeRecoveryHistory[0].afterEntries);
  assert.equal(described.focused.result.ok,true);assert.equal(described.focused.result.exitCode,0);assert.match(described.focused.result.output,/pass 7/);assert.match(described.focused.result.output,/fail 0/);
  assert.deepEqual(f.beforeContents,f.afterContents,"Byte-identical application is not missing application evidence");
  assert.equal(described.approvalArguments.maxSteps,1);assert.equal(described.approvalArguments.runtimeMinutes,5);assert.equal(described.approvalArguments.maxFullTestRuns,1);assert.equal(described.approvalArguments.maxProductMutations,0);assert.equal(described.approvalArguments.maxAdditionalAttempts,0);
  assert.deepEqual(described.approvalArguments.focusedCounts,{tests:7,passed:7,failed:0,skipped:0});
  assert.notEqual(f.runtimeVersion,f.head);assert.notEqual(f.runtimeVersion,described.predecessor.runtimeVersion);

  function isolated(){
    const task=structuredClone(original),steps=structuredClone(originalSteps),input=structuredClone(f.input),actor={actorType:"scoped_local_worker",workspaceProof:input.workspaceProof};let writes=0;
    const options={...f.options,input,actor,runtime:{get:async()=>structuredClone(task),steps:async()=>structuredClone(steps)},storage:{...f.storage,updateAutonomyTask(){writes++;assert.fail("Rejected eligibility cannot mutate any task or product");},appendActivity(){writes++;assert.fail("Eligibility cannot append activity");}}};
    return{task,steps,input,actor,options,writes:()=>writes};
  }
  async function rejected(state,predicate){
    const before=recoveryHash([state.task,state.steps]);
    await assert.rejects(()=>describeFullTestScopeRecovery(state.options),error=>error.code==="full_test_scope_recovery_precondition_failed"&&error.safeDiagnostics.mutationApplied===false&&(!predicate||error.safeDiagnostics.predicate===predicate));
    assert.equal(recoveryHash([state.task,state.steps]),before);assert.equal(state.writes(),0);
  }

  await t.test("historical consumed execution stays evidence under a different current runtime, without renewal",async()=>{
    const state=isolated();state.options.clock=()=>new Date("2099-01-01T00:00:00Z");
    await describeFullTestScopeRecovery(state.options);assert.deepEqual(state.task,original);assert.deepEqual(state.steps,originalSteps);
  });
  for(const [name,alter] of [
    ["wrong task",s=>{s.task.id="another-task";}],
    ["wrong version",s=>{s.task.stateVersion--;}],
    ["not blocked",s=>{s.task.status="queued";}],
    ["wrong phase",s=>{s.task.currentPhase="apply_patch";}],
    ["active lease",s=>{s.task.leaseOwner="another-worker";}],
    ["active handoff",s=>{s.task.metadata.localHandoff={id:"another-handoff"};}],
    ["pending task approval",s=>{s.task.approvalState={approvalId:"other"};}],
    ["wrong repository",s=>{s.task.metadata.selfDevelopment.repository="other/repo";}],
    ["wrong feature branch",s=>{s.task.branch="main";}],
    ["wrong product HEAD",s=>{s.task.currentCommit="f".repeat(40);} ],
    ["wrong product starting commit",s=>{s.task.startingCommit="f".repeat(40);} ],
    ["unconsumed execution predecessor",s=>{s.task.metadata.executionScopeRecoveryHistory[0].consumed=false;}],
    ["unsuccessful execution predecessor",s=>{s.task.metadata.executionScopeRecoveryHistory[0].result="failed";}],
    ["application not completed",s=>{s.task.metadata.executionScopeRecoveryHistory[0].applyCompleted=false;}],
    ["prior worker binding drift",s=>{s.task.metadata.executionScopeRecoveryHistory[0].workerBindingState="awaiting_worker_bind";}],
    ["rewritten execution boundary",s=>{s.task.metadata.executionScopeBoundary.executionAuthorized=true;}],
    ["repairIteration drift",s=>{s.task.repairIteration++;}],
    ["retry counter drift",s=>{s.task.retryCount++;}],
    ["repair extension reset",s=>{s.task.metadata.escalatedRepairHistory=[];}],
    ["plan replacement bytes drift",s=>{s.task.metadata.selfDevelopmentImplementationPlan.files[0].content+=" ";}],
    ["prior full-test successor",s=>{s.task.metadata.fullTestScopeRecoveryHistory=[{consumed:true}];}],
    ["requested plan mismatch",s=>{s.input.planHash="0".repeat(64);}]
  ])await t.test(`${name} fails closed before mutation`,async()=>{const state=isolated();alter(state);await rejected(state);});

  for(const [name,alter] of [
    ["wrong task",p=>{p.taskId="other";}],["wrong version",p=>{p.expectedVersion--;}],
    ["wrong runtime",p=>{p.runtimeVersion="f".repeat(40);}],["wrong repository",p=>{p.workspace.repository="other/repo";}],
    ["wrong branch",p=>{p.workspace.branch="main";}],["wrong root",p=>{p.workspace.root+="/other";}],
    ["wrong git root",p=>{p.workspace.gitTopLevel+="/other";}],["runtime used as product HEAD",p=>{p.workspace.head=f.runtimeVersion;}],
    ["wrong live tip",p=>{p.workspace.liveTip="f".repeat(40);}],["raw byte drift",p=>{p.workspace.changedFiles[0].hash="0".repeat(40);}],
    ["canonical content drift",p=>{p.workspace.changedFiles[0].contentHash="0".repeat(64);}],["missing dirty file",p=>{p.workspace.changedFiles.pop();}],
    ["unrelated dirty file",p=>{p.workspace.changedFiles.push({...p.workspace.changedFiles[0],path:"unrelated.js"});}],
    ["duplicate dirty path",p=>{p.workspace.changedFiles[1]=p.workspace.changedFiles[0];}]
  ])await t.test(`signed workspace ${name} is rejected`,async()=>{const state=isolated();alter(state.input.workspaceProof);await rejected(state);});

  for(const [name,alter] of [
    ["apply missing",s=>{s.steps=s.steps.filter(step=>step.stepId!=="149:apply_patch");}],
    ["apply lineage drift",s=>{s.steps.find(step=>step.stepId==="149:apply_patch").result.taskOwnedDirtyLineage.entries[0].contentHash="0".repeat(64);}],
    ["focused test failed",s=>{s.steps.find(step=>step.stepId==="150:run_focused_tests").status="failed";}],
    ["focused exit failure",s=>{s.steps.find(step=>step.stepId==="150:run_focused_tests").result.exitCode=1;}],
    ["focused evidence drift",s=>{s.steps.find(step=>step.stepId==="150:run_focused_tests").result.executionScopeEvidence.entries[0].rawHash="0".repeat(40);}],
    ["focused filters changed",s=>{s.steps.find(step=>step.stepId==="150:run_focused_tests").input.arguments.testNamePattern="only-one";}],
    ["zero focused tests despite success exit",s=>{s.steps.find(step=>step.stepId==="150:run_focused_tests").result.output="ℹ tests 0\nℹ pass 0\nℹ fail 0\nℹ skipped 0\n";}],
    ["focused failure summary despite success exit",s=>{s.steps.find(step=>step.stepId==="150:run_focused_tests").result.output="ℹ tests 7\nℹ pass 6\nℹ fail 1\nℹ skipped 0\n";}],
    ["skipped focused test",s=>{s.steps.find(step=>step.stepId==="150:run_focused_tests").result.output="ℹ tests 7\nℹ pass 6\nℹ fail 0\nℹ skipped 1\n";}],
    ["truncated focused evidence",s=>{s.steps.find(step=>step.stepId==="150:run_focused_tests").result.outputTruncated=true;}],
    ["failed title in focused evidence",s=>{s.steps.find(step=>step.stepId==="150:run_focused_tests").result.output+="\n✖ failed test\n";}],
    ["second focused attempt",s=>{s.steps.find(step=>step.stepId==="150:run_focused_tests").attempt=2;}],
    ["later durable step",s=>{s.steps.push({taskId:f.taskId,stepId:"151:run_full_tests",stepType:"run_full_tests",status:"completed",attempt:1});}]
    ,["extra historical step",s=>{s.steps.push({taskId:f.taskId,stepId:"1:extra",stepType:"read_files",status:"completed",attempt:1});}]
  ])await t.test(`${name} cannot authorize a full-suite successor`,async()=>{const state=isolated();alter(state);state.options.runtime.steps=async()=>structuredClone(state.steps);await rejected(state);});

  for(const branch of [f.branch,"stage13/control-plane-approved-delivery-runtime"])await t.test(`independent remote ${branch} must match`,async()=>{const state=isolated();state.options.verifyRemote=async request=>({currentTip:request.branch===branch?"0".repeat(40):request.branch===f.branch?f.head:f.runtimeVersion,ancestors:Object.fromEntries(request.requiredAncestors.map(sha=>[sha,true]))});await rejected(state,branch===f.branch?"live_product_tip":"runtime_transition");});
  await t.test("runtime transition must preserve independent prior-runtime ancestry",async()=>{const state=isolated();state.options.verifyRemote=async request=>({currentTip:request.branch===f.branch?f.head:f.runtimeVersion,ancestors:Object.fromEntries(request.requiredAncestors.map(sha=>[sha,sha!==described.predecessor.runtimeVersion]))});await rejected(state,"runtime_transition");});
  await t.test("JSONB key ordering and dirty-path ordering do not alter exact evidence",async()=>{const state=isolated();state.input.workspaceProof.workspace.changedFiles.reverse();state.task.metadata.executionScopeRecoveryHistory[0].afterEntries=state.task.metadata.executionScopeRecoveryHistory[0].afterEntries.map(item=>Object.fromEntries(Object.entries(item).reverse()));await describeFullTestScopeRecovery(state.options);});

  await t.test("new exact owner approval is required; the consumed execution approval is insufficient",async()=>{
    for(const approvalId of [undefined,described.predecessor.approvalId]){const state=isolated();state.input.approvalId=approvalId;await assert.rejects(()=>recoverFullTestScope(state.options),error=>error.safeDiagnostics?.predicate==="exact_owner_approval");assert.equal(state.writes(),0);}
  });
  await f.authorize();
  for(const [name,alter] of [
    ["pending",approval=>{approval.status="pending";}],["wrong owner",approval=>{approval.ownerId="other";}],["wrong project",approval=>{approval.projectId="other";}],["wrong task",approval=>{approval.runId="other";}],
    ["wrong tool",approval=>{approval.tool="self_development_execution_scope_recovery";}],["two full tests",approval=>{approval.arguments.maxFullTestRuns=2;}],["product mutation",approval=>{approval.arguments.maxProductMutations=1;}],["repair attempt",approval=>{approval.arguments.maxAdditionalAttempts=1;}],["longer runtime",approval=>{approval.arguments.runtimeMinutes=30;}]
  ])await t.test(`owner authorization ${name} cannot expand the contract`,async()=>{const state=isolated();state.input.approvalId=f.input.approvalId;state.options.storage.getApproval=async(id,owner)=>{const approval=await f.storage.getApproval(id,owner);if(id===f.input.approvalId)alter(approval);return approval;};await assert.rejects(()=>recoverFullTestScope(state.options),error=>error.safeDiagnostics?.predicate==="exact_owner_approval");assert.equal(state.writes(),0);});

  await t.test("exact owner decision creates one new five-minute, one-full-run generation only",async()=>{
    const {task,recovery:record}=await recoverFullTestScope(f.options),steps=await f.steps();
    assert.equal(task.stateVersion,216);assert.equal(task.currentStep,150);assert.equal(task.currentPhase,"run_full_tests");assert.equal(task.status,"queued");
    assert.equal(record.recoveryClass,FULL_TEST_SCOPE_RECOVERY_CLASS);assert.equal(record.approvalArguments.runtimeMinutes,FULL_TEST_SCOPE_RUNTIME_MINUTES);assert.equal(record.activeContinuation.maxSteps,1);assert.equal(Date.parse(record.activeContinuation.runtimeDeadline)-Date.parse(record.activeContinuation.runtimeStartedAt),300000);
    assert.notEqual(record.activeContinuation.generationId,record.predecessorGenerationId);assert.equal(record.workerId,null);assert.equal(record.maxFullTestRuns,1);assert.equal(record.maxProductMutations,0);assert.equal(record.maxAdditionalAttempts,0);
    assert.deepEqual(task.metadata.steps.slice(150).map(step=>[step.type,step.input]),[["run_full_tests",{tool:"test_run_full",arguments:{}}]]);
    assert.deepEqual(task.metadata.executionScopeRecoveryHistory,original.metadata.executionScopeRecoveryHistory);assert.deepEqual(task.metadata.executionScopeBoundary,original.metadata.executionScopeBoundary);assert.deepEqual(steps,originalSteps);
    for(const [key,value] of Object.entries(original.metadata).filter(([key])=>/(?:History|Boundary)$/.test(key)&&key!=="continuationHistory"))assert.deepEqual(task.metadata[key],value,key);
    for(const key of ["repairIteration","retryCount","maxRetries","currentCommit","startingCommit","branch"])assert.equal(task[key],original[key]);
    const ctx={runtimeVersion:f.runtimeVersion,generationId:record.activeContinuation.generationId,repository:f.repository,branch:f.branch,root:f.root,workerId:FULL_TEST_WORKER,allowFirstBind:true};
    assert.equal(validateFullTestScopeContext(task,steps,ctx,f.clock).firstBind,true);
    const payload=fullTestScopePayload(record);assert.equal(payload.entries.length,8);assert.equal(payload.fullTestStepId,"151:run_full_tests");assert.equal(payload.maxProductMutations,0);assert.equal(payload.maxFullTestRuns,1);
    for(const change of [{workerId:described.predecessor.workerId},{runtimeVersion:"0".repeat(40)},{root:f.root+"/other"},{branch:"main"},{repository:"other/repo"},{generationId:"0".repeat(64)}])assert.throws(()=>validateFullTestScopeContext(task,steps,{...ctx,...change},f.clock));
    assert.throws(()=>validateFullTestScopeContext(task,steps,ctx,()=>new Date(record.activeContinuation.runtimeDeadline)),error=>error.safeDiagnostics?.predicate==="full_test_runtime_window");
    task.metadata.fullTestScopeRecoveryHistory[0].workerBindingState="bound";task.metadata.fullTestScopeRecoveryHistory[0].workerId=FULL_TEST_WORKER;
    assert.equal(validateFullTestScopeContext(task,steps,ctx,f.clock).firstBind,false);
    assert.throws(()=>validateFullTestScopeContext(task,steps,{...ctx,workerId:"persistent-local-01234567-89ab-4def-8abc-0123456789ab"},f.clock));
    const exact={taskId:f.taskId,stepId:record.fullTestStepId,stepType:"run_full_tests",status:"running",attempt:1,input:{tool:"test_run_full",arguments:{}}};
    assert.equal(validateFullTestScopeEvidence(task,[...steps,exact],f.clock).fullTest.stepId,record.fullTestStepId);
    for(const changed of [{...exact,attempt:2},{...exact,stepId:"152:run_full_tests"},{...exact,stepType:"apply_patch"},{...exact,input:{tool:"test_run_full",arguments:{files:record.focusedTests}}}])assert.throws(()=>validateFullTestScopeEvidence(task,[...steps,changed],f.clock));
    assert.throws(()=>validateFullTestScopeEvidence(task,[...steps,exact,exact],f.clock));
    await assert.rejects(()=>recoverFullTestScope(f.options),error=>error.code==="full_test_scope_recovery_precondition_failed");
  });
  await f.verifyBytes(originalBytes);assert.deepEqual(f.beforeContents,originalBytes);
});
