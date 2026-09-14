import {createActiveContinuation} from "./self-development-plan-lifecycle.js";
import {recoveryHash,recoveryRoot} from "./failed-local-read-recovery.js";
import {EXECUTION_SCOPE_RECOVERY_CLASS,EXECUTION_SCOPE_RECOVERY_TOOL,validateExecutionScopeEvidence} from "./execution-scope-recovery.js";
import {parseTestFailure} from "../tools/test-failure-evidence.js";

export const FULL_TEST_SCOPE_RECOVERY_CLASS="owner_approved_focused_success_full_tests";
export const FULL_TEST_SCOPE_RECOVERY_TOOL="self_development_full_test_scope_recovery";
// The unchanged full-suite runner defaults to 120 seconds; five minutes is the
// existing continuation minimum and includes bounded result persistence.
export const FULL_TEST_SCOPE_RUNTIME_MINUTES=5;
const SHA=/^[a-f0-9]{40}$/,HASH=/^[a-f0-9]{64}$/;
const WORKER=/^persistent-local-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const same=(a,b)=>recoveryHash(a)===recoveryHash(b);
const ordinal=step=>Number.parseInt(step?.stepId,10);
const sorted=entries=>[...entries].sort((a,b)=>a.path.localeCompare(b.path));
const entryProof=entries=>sorted(entries).map(({path,hashAlgorithm,hash,contentHash})=>({path,hashAlgorithm,hash,contentHash}));
const fixedHistoryKeys=["selfDevelopment","maxRepairIterations","selfDevelopmentImplementationPlan","implementationPlanGenerations","activeImplementationPlanGeneration"];
function histories(task){
  const keys=[...new Set([...fixedHistoryKeys,...Object.keys(task.metadata||{}).filter(key=>/(?:History|Boundary)$/.test(key)&&!["continuationHistory","fullTestScopeRecoveryHistory","fullTestScopeBoundary"].includes(key))])].sort();
  return Object.fromEntries(keys.map(key=>[key,recoveryHash(task.metadata?.[key])]));
}
function requireProof(value,predicate){
  if(!value)throw Object.assign(new Error(`Full-test scope recovery rejected: ${predicate}.`),{code:"full_test_scope_recovery_precondition_failed",statusCode:409,safeDiagnostics:{predicate,mutationApplied:false}});
}
function entriesValid(entries,paths){
  return Array.isArray(paths)&&paths.length>0&&paths.length<=8&&new Set(paths).size===paths.length&&paths.every(path=>typeof path==="string"&&!path.startsWith("/")&&!path.includes("\\")&&!path.split("/").includes(".."))&&Array.isArray(entries)&&entries.length===paths.length&&new Set(entries.map(item=>item?.path)).size===paths.length&&entries.every(item=>item&&paths.includes(item.path)&&item.hashAlgorithm==="git_sha1"&&SHA.test(item.hash||"")&&item.rawHash===item.hash&&HASH.test(item.contentHash||""));
}
function preservedSteps(steps,proofs){
  requireProof(Array.isArray(proofs)&&proofs.every(item=>item&&typeof item.stepId==="string"&&HASH.test(item.stepHash||""))&&new Set(proofs.map(item=>item.stepId)).size===proofs.length,"source_step_proofs");
  for(const proof of proofs){const matches=steps.filter(step=>step.stepId===proof.stepId);requireProof(matches.length===1&&recoveryHash(matches[0])===proof.stepHash,"immutable_source_step");}
}
function signedRequest({taskId,input,actor,runtimeVersion}){
  requireProof(input&&Object.keys(input).every(key=>["expectedVersion","planHash","runtimeVersion","approvalId","workspaceProof","workspaceProofSignature"].includes(key))&&Number.isInteger(input.expectedVersion)&&HASH.test(input.planHash||""),"request_shape");
  const proof=input.workspaceProof;
  requireProof(actor?.actorType==="scoped_local_worker"&&actor.workspaceProof&&same(actor.workspaceProof,proof)&&proof.taskId===taskId&&proof.expectedVersion===input.expectedVersion&&proof.runtimeVersion===input.runtimeVersion&&Object.keys(proof).every(key=>["taskId","expectedVersion","runtimeVersion","workspace"].includes(key)),"authenticated_workspace_proof");
  requireProof(SHA.test(runtimeVersion||"")&&input.runtimeVersion===runtimeVersion,"active_runtime");
  return proof;
}

// Revalidate the consumed execution as historical evidence at its original
// timestamp, without reopening it, extending its deadline or rewriting storage.
// Byte-identical applications are valid: completed exact lineage, not a changed
// byte count, is the authority for the post-application workspace.
function completedFocusedBoundary(task,steps){
  const history=task.metadata?.executionScopeRecoveryHistory,predecessor=history?.[0],active=task.metadata?.activeContinuation,boundary=task.metadata?.executionScopeBoundary;
  requireProof(history?.length===1&&predecessor?.recoveryClass===EXECUTION_SCOPE_RECOVERY_CLASS&&active&&predecessor.consumed===true&&predecessor.authorizationConsumed===true&&predecessor.result==="focused_tests_completed"&&predecessor.applyCompleted===true&&predecessor.workerBindingState==="bound"&&WORKER.test(predecessor.workerId||"")&&same(predecessor.activeContinuation,active)&&task.currentStep===active.startStep+2&&Date.parse(predecessor.completedAt)>=Date.parse(active.runtimeStartedAt)&&Date.parse(predecessor.completedAt)<=Date.parse(active.runtimeDeadline)&&Date.parse(predecessor.applyCompletedAt)>=Date.parse(active.runtimeStartedAt)&&Date.parse(predecessor.applyCompletedAt)<=Date.parse(predecessor.completedAt),"consumed_execution_predecessor");
  const projected=structuredClone(task);projected.status="running";projected.currentStep=active.startStep+1;projected.metadata.executionScopeRecoveryHistory[0].consumed=false;
  let state;try{state=validateExecutionScopeEvidence(projected,steps,()=>new Date(active.runtimeStartedAt));}catch(error){requireProof(false,`execution_evidence:${error.safeDiagnostics?.predicate||error.code||"invalid"}`);}
  const {plan,apply,focused}=state;
  requireProof(steps.length===predecessor.predecessorStepProofs.length+2,"no_additional_historical_step");
  requireProof(apply?.taskId===task.id&&apply.status==="completed"&&apply.attempt===1&&focused?.taskId===task.id&&focused.status==="completed"&&focused.attempt===1&&focused.stepType==="run_focused_tests"&&predecessor.applyResultHash===recoveryHash(apply.result)&&same(predecessor.claimedStepIds,[predecessor.applyStepId,predecessor.testStepId])&&!steps.some(step=>ordinal(step)>ordinal(focused)),"completed_execution_steps");
  requireProof(focused.input?.tool==="test_run"&&same(focused.input.arguments,{files:predecessor.focusedTests})&&focused.result?.ok===true&&focused.result.exitCode===0&&same(focused.result.executionScopeEvidence,{generationId:active.generationId,planHash:predecessor.planHash,entries:predecessor.afterEntries}),"successful_exact_focused_tests");
  const summary=parseTestFailure({root:predecessor.workspaceRoot,exitCode:0,stdout:focused.result.output}),focusedCounts=summary.counts;
  requireProof(typeof focused.result.output==="string"&&focused.result.outputTruncated===false&&focusedCounts.tests>0&&focusedCounts.passed===focusedCounts.tests&&focusedCounts.failed===0&&focusedCounts.skipped===0&&summary.failedTitles.length===0,"successful_complete_focused_summary");
  requireProof(same(boundary,predecessor.boundary)&&same(boundary,{kind:"focused_tests_completed",executionAuthorized:false,planHash:predecessor.planHash,planGenerationId:predecessor.planGenerationId,stepId:predecessor.testStepId,focusedTests:predecessor.focusedTests,errorCode:null}),"focused_success_boundary");
  requireProof(entriesValid(predecessor.afterEntries,predecessor.requiredPaths),"complete_applied_workspace_entries");
  return{predecessor,plan,apply,focused,focusedCounts,entries:structuredClone(predecessor.afterEntries),requiredPaths:structuredClone(predecessor.requiredPaths)};
}

export async function describeFullTestScopeRecovery({taskId,input,actor,runtime,storage,ownerId,repository,approvedBranch,runtimeVersion,verifyRemote}){
  const proof=signedRequest({taskId,input,actor,runtimeVersion}),task=await runtime.get(taskId);
  requireProof(task?.id===taskId&&task.taskType==="self_development"&&task.stateVersion===input.expectedVersion&&task.status==="blocked"&&task.currentPhase==="run_focused_tests"&&!task.errorCode&&!task.leaseOwner&&!task.leaseToken&&!task.metadata?.localHandoff&&!task.approvalState,"blocked_focused_success_task_state");
  requireProof(task.branch===approvedBranch&&task.metadata?.selfDevelopment?.repository===repository&&SHA.test(task.currentCommit||"")&&task.currentCommit===task.startingCommit,"product_identity");
  requireProof(!task.metadata.fullTestScopeRecoveryHistory?.length,"single_use_successor");
  const steps=await runtime.steps(taskId),state=completedFocusedBoundary(task,steps),{predecessor,plan,apply,focused,focusedCounts,entries,requiredPaths}=state;
  requireProof(input.planHash===plan.planHash,"owner_requested_plan_hash");
  const priorApproval=await storage.getApproval(predecessor.approvalId,ownerId);
  requireProof(priorApproval?.ownerId===ownerId&&priorApproval.projectId===task.projectId&&priorApproval.runId===taskId&&priorApproval.status==="approved"&&priorApproval.tool===EXECUTION_SCOPE_RECOVERY_TOOL&&same(priorApproval.arguments,predecessor.approvalArguments),"historical_execution_approval");
  const workspace=proof.workspace;
  requireProof(workspace&&Object.keys(workspace).every(key=>["root","gitTopLevel","repository","branch","head","liveTip","clean","changedFiles"].includes(key))&&recoveryRoot(workspace.root)===predecessor.workspaceRoot&&recoveryRoot(workspace.gitTopLevel)===predecessor.workspaceRoot&&workspace.repository===repository&&workspace.branch===task.branch&&workspace.head===task.currentCommit&&workspace.liveTip===task.currentCommit&&workspace.clean===false&&Array.isArray(workspace.changedFiles)&&workspace.changedFiles.length===requiredPaths.length&&new Set(workspace.changedFiles.map(item=>item?.path)).size===requiredPaths.length&&workspace.changedFiles.every(item=>item&&typeof item.path==="string"&&SHA.test(item.hash||"")&&HASH.test(item.contentHash||""))&&same(entryProof(workspace.changedFiles),entryProof(entries)),"current_workspace");
  requireProof(typeof verifyRemote==="function","remote_verifier");
  const product=await verifyRemote({repository,branch:task.branch,requiredAncestors:[task.currentCommit]}),control=await verifyRemote({repository,branch:"stage13/control-plane-approved-delivery-runtime",requiredAncestors:[predecessor.runtimeVersion,runtimeVersion]});
  requireProof(product?.currentTip===task.currentCommit&&product.ancestors?.[task.currentCommit]===true,"live_product_tip");
  requireProof(control?.currentTip===runtimeVersion&&control.ancestors?.[runtimeVersion]===true&&control.ancestors?.[predecessor.runtimeVersion]===true,"runtime_transition");
  const approvalArguments={taskId,projectId:task.projectId,expectedVersion:task.stateVersion,repository,branch:task.branch,currentCommit:task.currentCommit,workspaceRoot:predecessor.workspaceRoot,runtimeVersion,planHash:plan.planHash,planGenerationId:predecessor.planGenerationId,fullPlanHash:recoveryHash(plan),filesHash:recoveryHash(plan.files),focusedTests:predecessor.focusedTests,sourcePlanStepId:predecessor.sourcePlanStepId,sourceApplyStepId:apply.stepId,sourceFocusedStepId:focused.stepId,sourceApplyHash:recoveryHash(apply),sourceFocusedHash:recoveryHash(focused),sourceLineageHash:recoveryHash(apply.result.taskOwnedDirtyLineage),predecessorGenerationId:activeGeneration(predecessor),executionAuthorityHash:recoveryHash(predecessor),workspaceProofHash:recoveryHash(proof),workspaceEvidenceHash:recoveryHash(entries),workspaceScopeHash:recoveryHash(requiredPaths),maxRecoveries:1,runtimeMinutes:FULL_TEST_SCOPE_RUNTIME_MINUTES,maxSteps:1,maxFullTestRuns:1,maxProductMutations:0,maxAdditionalAttempts:0};
  approvalArguments.focusedCounts=focusedCounts;
  return{task,steps,plan,predecessor,apply,focused,focusedCounts,entries,requiredPaths,approvalArguments,proof};
}
const activeGeneration=record=>record.activeContinuation.generationId;

export async function recoverFullTestScope(options){
  const {input,storage,ownerId,clock=()=>new Date()}=options,state=await describeFullTestScopeRecovery(options),{task,steps,plan,predecessor,apply,focused,entries,requiredPaths,approvalArguments}=state;
  const approval=typeof input.approvalId==="string"?await storage.getApproval(input.approvalId,ownerId):null;
  requireProof(approval&&approval.id===input.approvalId&&approval.ownerId===ownerId&&approval.projectId===task.projectId&&approval.status==="approved"&&approval.runId===task.id&&approval.tool===FULL_TEST_SCOPE_RECOVERY_TOOL&&same(approval.arguments,approvalArguments),"exact_owner_approval");
  const base=task.metadata.steps.length,now=clock().toISOString(),nextSteps=[{type:"run_full_tests",capability:"test_local",input:{tool:"test_run_full",arguments:{}},idempotencyIdentity:`full-test-scope:${task.id}:${task.stateVersion}:${plan.planHash}`}];
  const activeContinuation=createActiveContinuation({task,startStep:base,plannedSteps:1,repairLimit:0,recoveryClass:FULL_TEST_SCOPE_RECOVERY_CLASS,runtimeStartedAt:now,runtimeMinutes:FULL_TEST_SCOPE_RUNTIME_MINUTES});
  const record={recoveryClass:FULL_TEST_SCOPE_RECOVERY_CLASS,taskId:task.id,fromStateVersion:task.stateVersion,toStateVersion:task.stateVersion+1,approvalId:approval.id,approvalArguments,authorizationConsumed:true,consumed:false,maxRecoveries:1,maxFullTestRuns:1,maxProductMutations:0,maxAdditionalAttempts:0,repository:approvalArguments.repository,branch:task.branch,currentCommit:task.currentCommit,workspaceRoot:approvalArguments.workspaceRoot,runtimeVersion:options.runtimeVersion,planHash:plan.planHash,planGenerationId:predecessor.planGenerationId,fullPlanHash:recoveryHash(plan),filesHash:recoveryHash(plan.files),requiredPaths,focusedTests:structuredClone(predecessor.focusedTests),entries,sourcePlanStepId:predecessor.sourcePlanStepId,sourceApplyStepId:apply.stepId,sourceFocusedStepId:focused.stepId,fullTestStepId:`${base+1}:run_full_tests`,predecessorGenerationId:activeGeneration(predecessor),predecessorStepProofs:steps.map(step=>({stepId:step.stepId,stepHash:recoveryHash(step)})),immutableHistoryHashes:histories(task),historicalPlannedStepsHash:recoveryHash(task.metadata.steps),historicalPlannedStepsCount:task.metadata.steps.length,historicalContinuationsHash:recoveryHash(task.metadata.continuationHistory),historicalContinuationsCount:task.metadata.continuationHistory.length,successorStepsHash:recoveryHash(nextSteps),repairIteration:task.repairIteration,retryCount:task.retryCount,maxRetries:task.maxRetries,workerBindingState:"awaiting_worker_bind",workerId:null,rejectedPriorWorkerIds:[...new Set([predecessor.workerId,...predecessor.rejectedPriorWorkerIds])],activeContinuation,recoveredAt:now};
  record.focusedCounts=structuredClone(state.focusedCounts);
  const updated=await storage.updateAutonomyTask(task.id,ownerId,{status:"queued",currentStep:base,currentPhase:"run_full_tests",nextRunAt:now,startedAt:now,completedAt:null,errorCode:null,blockedReason:null,checkpoint:{...task.checkpoint,pendingStep:null},metadata:{...task.metadata,steps:[...task.metadata.steps,...nextSteps],activeContinuation,continuationHistory:[...task.metadata.continuationHistory,activeContinuation],fullTestScopeRecoveryHistory:[record],requiredCapability:"test_local",autoDispatch:true}},task.stateVersion);
  requireProof(updated,"recovery_compare_and_swap");
  await storage.appendActivity({ownerId,projectId:task.projectId,runId:task.id,action:"self_development_full_test_scope_recovered",status:"queued",summary:"One exact owner-approved full-suite run; no product mutation, additional repair attempt, review execution or delivery authority.",metadata:record});
  return{task:updated,recovery:record,idempotent:false};
}

export function validateFullTestScopeEvidence(task,steps,clock=()=>new Date()){
  const history=task.metadata?.fullTestScopeRecoveryHistory,record=history?.[0],active=task.metadata?.activeContinuation,plan=task.metadata?.selfDevelopmentImplementationPlan;
  requireProof(history?.length===1&&record?.recoveryClass===FULL_TEST_SCOPE_RECOVERY_CLASS&&active&&record.consumed===false&&record.authorizationConsumed===true&&record.taskId===task.id&&record.repository===task.metadata.selfDevelopment?.repository&&record.branch===task.branch&&record.currentCommit===task.currentCommit&&task.startingCommit===task.currentCommit&&same(record.activeContinuation,active)&&same(active,task.metadata.continuationHistory?.at(-1))&&active.maxSteps===1&&active.runtimeMinutes===FULL_TEST_SCOPE_RUNTIME_MINUTES&&record.maxRecoveries===1&&record.maxFullTestRuns===1&&record.maxProductMutations===0&&record.maxAdditionalAttempts===0&&["queued","waiting_for_worker","running"].includes(task.status)&&task.currentStep===active.startStep,"full_test_successor_generation");
  requireProof(Date.parse(active.runtimeDeadline)>clock().getTime(),"full_test_runtime_window");
  requireProof(same(histories(task),record.immutableHistoryHashes)&&task.repairIteration===record.repairIteration&&task.retryCount===record.retryCount&&task.maxRetries===record.maxRetries&&record.historicalContinuationsCount===task.metadata.continuationHistory.length-1&&recoveryHash(task.metadata.continuationHistory.slice(0,-1))===record.historicalContinuationsHash,"preserved_authority");
  preservedSteps(steps,record.predecessorStepProofs);
  requireProof(steps.filter(step=>ordinal(step)<=active.startStep).length===record.predecessorStepProofs.length,"no_additional_historical_step");
  requireProof(record.historicalPlannedStepsCount===active.startStep&&recoveryHash(task.metadata.steps.slice(0,active.startStep))===record.historicalPlannedStepsHash&&task.metadata.steps.length===active.startStep+1&&recoveryHash(task.metadata.steps.slice(active.startStep))===record.successorStepsHash&&task.metadata.steps[active.startStep]?.type==="run_full_tests"&&same(task.metadata.steps[active.startStep]?.input,{tool:"test_run_full",arguments:{}}),"bounded_full_test_step");
  const binding={taskId:task.id,projectId:task.projectId,expectedVersion:record.fromStateVersion,repository:record.repository,branch:record.branch,currentCommit:record.currentCommit,workspaceRoot:record.workspaceRoot,runtimeVersion:record.runtimeVersion,planHash:record.planHash,planGenerationId:record.planGenerationId,fullPlanHash:record.fullPlanHash,filesHash:record.filesHash,focusedTests:record.focusedTests,sourcePlanStepId:record.sourcePlanStepId,sourceApplyStepId:record.sourceApplyStepId,sourceFocusedStepId:record.sourceFocusedStepId,predecessorGenerationId:record.predecessorGenerationId,workspaceEvidenceHash:recoveryHash(record.entries),workspaceScopeHash:recoveryHash(record.requiredPaths),maxRecoveries:1,runtimeMinutes:FULL_TEST_SCOPE_RUNTIME_MINUTES,maxSteps:1,maxFullTestRuns:1,maxProductMutations:0,maxAdditionalAttempts:0};
  requireProof(record.approvalArguments&&Object.entries(binding).every(([key,value])=>same(record.approvalArguments[key],value))&&record.fullTestStepId===`${active.startStep+1}:run_full_tests`,"approved_full_test_binding");
  requireProof(record.focusedCounts?.tests>0&&record.focusedCounts.passed===record.focusedCounts.tests&&record.focusedCounts.failed===0&&record.focusedCounts.skipped===0&&same(record.focusedCounts,record.approvalArguments.focusedCounts),"approved_focused_result_counts");
  requireProof(entriesValid(record.entries,record.requiredPaths)&&plan&&recoveryHash(plan)===record.fullPlanHash&&recoveryHash(plan.files)===record.filesHash&&plan.planHash===record.planHash&&plan.provenance?.planningOnly===true&&plan.provenance.generationId===record.planGenerationId,"exact_full_test_plan_and_workspace");
  const claimed=record.claimedStepIds||[];
  requireProof(Array.isArray(claimed)&&claimed.length<=1&&same(claimed,[record.fullTestStepId].slice(0,claimed.length)),"single_use_claim_reservation");
  const executions=steps.filter(step=>ordinal(step)>active.startStep);
  requireProof(executions.length<=1&&executions.every(step=>step.taskId===task.id&&step.stepId===record.fullTestStepId&&step.stepType==="run_full_tests"&&step.attempt===1&&["running","completed"].includes(step.status)&&same(step.input,{tool:"test_run_full",arguments:{}})),"one_full_test_attempt");
  if(executions[0]?.status==="completed")requireProof(executions[0].result?.ok===true&&executions[0].result.exitCode===0&&same(executions[0].result.fullTestScopeEvidence,{generationId:active.generationId,planHash:record.planHash,entries:record.entries}),"full_test_result_evidence");
  return{record,history,plan,fullTest:executions[0]};
}

export function validateFullTestScopeContext(task,steps,context,clock=()=>new Date()){
  const state=validateFullTestScopeEvidence(task,steps,clock),{record}=state,firstBind=context.allowFirstBind===true&&record.workerBindingState==="awaiting_worker_bind"&&record.workerId===null&&task.currentStep===record.activeContinuation.startStep;
  requireProof(context.runtimeVersion===record.runtimeVersion&&context.generationId===activeGeneration(record)&&context.repository===record.repository&&context.branch===record.branch&&recoveryRoot(context.root)===record.workspaceRoot,"worker_context");
  requireProof(WORKER.test(context.workerId||"")&&!record.rejectedPriorWorkerIds.includes(context.workerId)&&(firstBind||record.workerBindingState==="bound"&&record.workerId===context.workerId),"worker_succession");
  return{...state,firstBind};
}

export function fullTestScopePayload(record){
  return{version:1,recoveryClass:record.recoveryClass,taskId:record.taskId,approvalId:record.approvalId,repository:record.repository,branch:record.branch,currentCommit:record.currentCommit,workspaceRoot:record.workspaceRoot,runtimeVersion:record.runtimeVersion,workerId:record.workerId,continuationGenerationId:activeGeneration(record),runtimeDeadline:record.activeContinuation.runtimeDeadline,runtimeMinutes:FULL_TEST_SCOPE_RUNTIME_MINUTES,planHash:record.planHash,planGenerationId:record.planGenerationId,fullPlanHash:record.fullPlanHash,filesHash:record.filesHash,focusedTests:structuredClone(record.focusedTests),requiredPaths:structuredClone(record.requiredPaths),entries:structuredClone(record.entries),sourcePlanStepId:record.sourcePlanStepId,sourceApplyStepId:record.sourceApplyStepId,sourceFocusedStepId:record.sourceFocusedStepId,fullTestStepId:record.fullTestStepId,maxFullTestRuns:1,maxProductMutations:0,maxAdditionalAttempts:0};
}
