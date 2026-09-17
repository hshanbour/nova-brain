import {createHash} from "node:crypto";
import {assertActiveImplementationPlan,canonicalContentHash,createActiveContinuation} from "./self-development-plan-lifecycle.js";
import {recoveryHash,recoveryRoot} from "./failed-local-read-recovery.js";
import {PLANNING_SCOPE_RECOVERY_CLASS,PLANNING_SCOPE_RECOVERY_TOOL,validatePlanningScopeReadEvidence} from "./planning-scope-recovery.js";

export const EXECUTION_SCOPE_RECOVERY_CLASS="owner_approved_validated_plan_execution";
export const EXECUTION_SCOPE_RECOVERY_TOOL="self_development_execution_scope_recovery";
const SHA=/^[a-f0-9]{40}$/,HASH=/^[a-f0-9]{64}$/;
const WORKER=/^persistent-local-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ordinal=step=>Number.parseInt(step?.stepId,10);
const same=(a,b)=>recoveryHash(a)===recoveryHash(b);
const blobHash=content=>createHash("sha1").update(`blob ${Buffer.byteLength(content,"utf8")}\0`).update(content).digest("hex");
const historyKeys=["failedLocalReadRecoveryHistory","continuationRuntimeResumeHistory","implementationPlanRecoveryHistory","partialRepairPlanRecoveryHistory","escalatedRepairHistory","planningScopeRecoveryHistory","planningScopeBoundary","implementationPlanGenerations","activeImplementationPlanGeneration","selfDevelopmentImplementationPlan","selfDevelopment","maxRepairIterations"];
const histories=task=>Object.fromEntries(historyKeys.map(key=>[key,recoveryHash(task.metadata?.[key])]));
function requireProof(value,predicate){
  if(!value)throw Object.assign(new Error(`Execution scope recovery rejected: ${predicate}.`),{code:"execution_scope_recovery_precondition_failed",statusCode:409,safeDiagnostics:{predicate,mutationApplied:false}});
}
const entry=(path,content)=>({path,hashAlgorithm:"git_sha1",hash:blobHash(content),rawHash:blobHash(content),contentHash:canonicalContentHash(content)});
const sorted=entries=>[...entries].sort((a,b)=>a.path.localeCompare(b.path));
const entryProof=entries=>sorted(entries).map(({path,hashAlgorithm,hash,contentHash})=>({path,hashAlgorithm,hash,contentHash}));
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

// Historical planning authority is evidence, not execution authority. The
// projection revalidates its immutable read proof at its original timestamp;
// it never reopens, rewrites or renews the consumed predecessor on storage.
function validatedPlanningBoundary(task,steps){
  const records=task.metadata?.planningScopeRecoveryHistory,predecessor=records?.[0],active=task.metadata?.activeContinuation,boundary=task.metadata?.planningScopeBoundary;
  requireProof(records?.length===1&&predecessor?.recoveryClass===PLANNING_SCOPE_RECOVERY_CLASS&&active&&predecessor.consumed===true&&predecessor.authorizationConsumed===true&&predecessor.workerBindingState==="bound"&&WORKER.test(predecessor.workerId||"")&&same(active,predecessor.activeContinuation)&&task.currentStep===active.startStep+2&&Date.parse(predecessor.completedAt)>=Date.parse(active.runtimeStartedAt)&&Date.parse(predecessor.completedAt)<=Date.parse(active.runtimeDeadline),"consumed_planning_predecessor");
  const projected=structuredClone(task);projected.currentStep=active.startStep+1;projected.metadata.planningScopeRecoveryHistory[0].consumed=false;
  let evidence;try{evidence=validatePlanningScopeReadEvidence(projected,steps,()=>new Date(active.runtimeStartedAt));}catch(error){requireProof(false,`planning_evidence:${error.safeDiagnostics?.predicate||error.code||"invalid"}`);}
  const plan=task.metadata.selfDevelopmentImplementationPlan,sourcePlan=steps.find(step=>step.stepId===`${active.startStep+1}:plan_repair`),validation=steps.find(step=>step.stepId===`${active.startStep+2}:validate_patch`);
  requireProof(sourcePlan?.taskId===task.id&&sourcePlan.status==="completed"&&sourcePlan.stepType==="plan_repair"&&sourcePlan.attempt===1&&same(sourcePlan.result?.implementationPlan,plan)&&validation?.taskId===task.id&&validation.status==="completed"&&validation.stepType==="validate_patch"&&validation.attempt===1&&!steps.some(step=>ordinal(step)>ordinal(validation)),"validated_planning_steps");
  requireProof(HASH.test(plan?.planHash||"")&&Array.isArray(plan.files)&&plan.files.length>0&&plan.files.length<=8&&plan.files.length===predecessor.requiredPaths.length&&plan.files.every(file=>file&&typeof file.path==="string"&&file.operation==="replace"&&typeof file.content==="string"&&typeof file.expectedContent==="string"&&evidence.reads.has(file.path)&&file.expectedContent===evidence.reads.get(file.path))&&new Set(plan.files.map(file=>file.path)).size===plan.files.length&&plan.provenance?.planningOnly===true,"exact_validated_plan");
  requireProof(plan.planHash===recoveryHash({files:plan.files.map(({expectedContent,...file})=>file),focusedTests:plan.focusedTests,acceptanceMapping:plan.acceptanceMapping,riskLevel:plan.riskLevel}),"validated_plan_hash");
  try{assertActiveImplementationPlan(task,plan.files,{allowPlanningOnly:true});}catch{requireProof(false,"active_planning_generation");}
  requireProof(Array.isArray(plan.focusedTests)&&plan.focusedTests.every(item=>item&&typeof item.path==="string"),"validated_focused_scope");
  const focusedTests=plan.focusedTests.map(item=>item.path);
  requireProof(Array.isArray(focusedTests)&&focusedTests.length>0&&new Set(focusedTests).size===focusedTests.length&&plan.focusedTests.every(item=>item.kind==="existing"&&evidence.reads.has(item.path)&&/^test\/[a-z0-9._/-]+\.test\.js$/i.test(item.path)&&!item.path.split("/").includes(".."))&&same(boundary,predecessor.boundary)&&boundary?.kind==="focused_test_scheduling_ready"&&boundary.tool==="test_run"&&boundary.executionAuthorized===false&&boundary.mutationApplied===false&&boundary.validatedStepId===validation.stepId&&boundary.planGenerationId===plan.provenance.generationId&&same(boundary.arguments,{files:focusedTests}),"validated_focused_scope");
  const validationFiles=validation.input?.arguments?.files;
  requireProof(validation.input?.tool==="repo_validate_patch"&&validation.result?.ok===true&&validation.result.preMutationValidated===true&&validation.result.mutationApplied===false&&validation.result.currentCommit===task.currentCommit&&validation.result.planGenerationId===plan.provenance.generationId&&same(validation.result.files,plan.files.map(file=>file.path))&&(validationFiles==="$IMPLEMENTATION_FILES"||same(validationFiles,plan.files)),"completed_pre_mutation_validation");
  return{predecessor,plan,sourcePlan,validation,focusedTests,...evidence};
}

export async function describeExecutionScopeRecovery({taskId,input,actor,runtime,storage,ownerId,repository,approvedBranch,runtimeVersion,verifyRemote}){
  const proof=signedRequest({taskId,input,actor,runtimeVersion}),task=await runtime.get(taskId);
  requireProof(task?.id===taskId&&task.taskType==="self_development"&&task.stateVersion===input.expectedVersion&&task.status==="blocked"&&task.currentPhase==="validate_patch"&&!task.errorCode&&!task.leaseOwner&&!task.leaseToken&&!task.metadata?.localHandoff&&!task.approvalState,"blocked_validated_task_state");
  requireProof(task.branch===approvedBranch&&task.metadata?.selfDevelopment?.repository===repository&&SHA.test(task.currentCommit||"")&&task.currentCommit===task.startingCommit,"product_identity");
  requireProof(!task.metadata.executionScopeRecoveryHistory?.length,"single_use_successor");
  const steps=await runtime.steps(taskId),state=validatedPlanningBoundary(task,steps),{predecessor,plan,sourcePlan,validation,focusedTests,reads}=state;
  requireProof(input.planHash===plan.planHash,"owner_requested_plan_hash");
  const priorApproval=await storage.getApproval(predecessor.approvalId,ownerId);
  requireProof(priorApproval?.ownerId===ownerId&&priorApproval.runId===taskId&&priorApproval.status==="approved"&&priorApproval.tool===PLANNING_SCOPE_RECOVERY_TOOL&&same(priorApproval.arguments,predecessor.approvalArguments),"historical_planning_approval");
  const requiredPaths=[...predecessor.requiredPaths],readProofs=structuredClone(predecessor.readProofs),beforeEntries=requiredPaths.map(path=>entry(path,reads.get(path))),replacements=new Map(plan.files.map(file=>[file.path,file.content])),afterEntries=requiredPaths.map(path=>entry(path,replacements.has(path)?replacements.get(path):reads.get(path)));
  const workspace=proof.workspace;
  requireProof(workspace&&Object.keys(workspace).every(key=>["root","gitTopLevel","repository","branch","head","liveTip","clean","changedFiles"].includes(key))&&recoveryRoot(workspace.root)===predecessor.workspaceRoot&&recoveryRoot(workspace.gitTopLevel)===predecessor.workspaceRoot&&workspace.repository===repository&&workspace.branch===task.branch&&workspace.head===task.currentCommit&&workspace.liveTip===task.currentCommit&&workspace.clean===false&&Array.isArray(workspace.changedFiles)&&workspace.changedFiles.every(item=>item&&typeof item.path==="string"&&SHA.test(item.hash||"")&&HASH.test(item.contentHash||""))&&new Set(workspace.changedFiles.map(item=>item.path)).size===requiredPaths.length&&workspace.changedFiles.length===requiredPaths.length&&same(entryProof(workspace.changedFiles),entryProof(beforeEntries)),"current_workspace");
  requireProof(typeof verifyRemote==="function","remote_verifier");
  const product=await verifyRemote({repository,branch:task.branch,requiredAncestors:[task.currentCommit]}),control=await verifyRemote({repository,branch:"stage13/control-plane-approved-delivery-runtime",requiredAncestors:[predecessor.runtimeVersion,runtimeVersion]});
  requireProof(product?.currentTip===task.currentCommit&&product.ancestors?.[task.currentCommit]===true,"live_product_tip");
  requireProof(control?.currentTip===runtimeVersion&&control.ancestors?.[runtimeVersion]===true&&control.ancestors?.[predecessor.runtimeVersion]===true,"runtime_transition");
  const approvalArguments={taskId,projectId:task.projectId,expectedVersion:task.stateVersion,repository,branch:task.branch,currentCommit:task.currentCommit,workspaceRoot:predecessor.workspaceRoot,runtimeVersion,planHash:plan.planHash,planGenerationId:plan.provenance.generationId,fullPlanHash:recoveryHash(plan),filesHash:recoveryHash(plan.files),focusedTests,sourcePlanStepId:sourcePlan.stepId,validatedStepId:validation.stepId,validatedStepHash:recoveryHash(validation),predecessorGenerationId:predecessor.activeContinuation.generationId,planningAuthorityHash:recoveryHash(predecessor),workspaceProofHash:recoveryHash(proof),readEvidenceHash:recoveryHash(readProofs),mutationScopeHash:recoveryHash(requiredPaths),beforeEvidenceHash:recoveryHash(beforeEntries),afterEvidenceHash:recoveryHash(afterEntries),maxRecoveries:1,runtimeMinutes:15,maxSteps:2,maxProductMutations:1,maxApplyAttempts:1,maxFocusedTestRuns:1,maxAdditionalAttempts:0};
  return{task,steps,plan,predecessor,readProofs,requiredPaths,focusedTests,beforeEntries,afterEntries,sourcePlan,validation,approvalArguments,proof};
}

export async function recoverExecutionScope(options){
  const {input,storage,ownerId,clock=()=>new Date()}=options,state=await describeExecutionScopeRecovery(options),{task,steps,plan,predecessor,readProofs,requiredPaths,focusedTests,beforeEntries,afterEntries,sourcePlan,validation,approvalArguments}=state;
  const approval=typeof input.approvalId==="string"?await storage.getApproval(input.approvalId,ownerId):null;
  requireProof(approval&&approval.id===input.approvalId&&approval.ownerId===ownerId&&approval.projectId===task.projectId&&approval.status==="approved"&&approval.runId===task.id&&approval.tool===EXECUTION_SCOPE_RECOVERY_TOOL&&same(approval.arguments,approvalArguments),"exact_owner_approval");
  const base=task.metadata.steps.length,now=clock().toISOString(),nextSteps=[
    {type:"apply_patch",capability:"repo_mutate_local",input:{tool:"repo_apply_patch",arguments:{branch:"$TASK_BRANCH",currentCommit:"$CURRENT_COMMIT",files:"$IMPLEMENTATION_FILES",planProvenance:"$IMPLEMENTATION_PLAN_PROVENANCE"}},idempotencyIdentity:`execution-scope:${task.id}:${task.stateVersion}:${plan.planHash}:apply`},
    {type:"run_focused_tests",capability:"test_local",input:{tool:"test_run",arguments:{files:[...focusedTests]}},idempotencyIdentity:`execution-scope:${task.id}:${task.stateVersion}:${plan.planHash}:focused`}
  ];
  const activeContinuation=createActiveContinuation({task,startStep:base,plannedSteps:2,repairLimit:0,recoveryClass:EXECUTION_SCOPE_RECOVERY_CLASS,runtimeStartedAt:now,runtimeMinutes:15});
  const record={recoveryClass:EXECUTION_SCOPE_RECOVERY_CLASS,taskId:task.id,fromStateVersion:task.stateVersion,toStateVersion:task.stateVersion+1,approvalId:approval.id,approvalArguments,authorizationConsumed:true,consumed:false,maxRecoveries:1,maxProductMutations:1,maxApplyAttempts:1,maxFocusedTestRuns:1,maxAdditionalAttempts:0,repository:approvalArguments.repository,branch:task.branch,currentCommit:task.currentCommit,workspaceRoot:approvalArguments.workspaceRoot,runtimeVersion:options.runtimeVersion,planHash:plan.planHash,planGenerationId:plan.provenance.generationId,fullPlanHash:recoveryHash(plan),filesHash:recoveryHash(plan.files),requiredPaths,focusedTests,readProofs,beforeEntries,afterEntries,sourcePlanStepId:sourcePlan.stepId,validatedStepId:validation.stepId,applyStepId:`${base+1}:apply_patch`,testStepId:`${base+2}:run_focused_tests`,predecessorGenerationId:predecessor.activeContinuation.generationId,predecessorStepProofs:steps.map(step=>({stepId:step.stepId,stepHash:recoveryHash(step)})),immutableHistoryHashes:histories(task),historicalPlannedStepsHash:recoveryHash(task.metadata.steps),historicalPlannedStepsCount:task.metadata.steps.length,historicalContinuationsHash:recoveryHash(task.metadata.continuationHistory),historicalContinuationsCount:task.metadata.continuationHistory.length,successorStepsHash:recoveryHash(nextSteps),repairIteration:task.repairIteration,retryCount:task.retryCount,maxRetries:task.maxRetries,workerBindingState:"awaiting_worker_bind",workerId:null,rejectedPriorWorkerIds:[...new Set([predecessor.workerId,...predecessor.rejectedPriorWorkerIds])],activeContinuation,recoveredAt:now};
  const updated=await storage.updateAutonomyTask(task.id,ownerId,{status:"queued",currentStep:base,currentPhase:"apply_patch",nextRunAt:now,startedAt:now,completedAt:null,errorCode:null,blockedReason:null,checkpoint:{...task.checkpoint,pendingStep:null},metadata:{...task.metadata,steps:[...task.metadata.steps,...nextSteps],activeContinuation,continuationHistory:[...task.metadata.continuationHistory,activeContinuation],executionScopeRecoveryHistory:[record],requiredCapability:"repo_mutate_local",autoDispatch:true}},task.stateVersion);
  requireProof(updated,"recovery_compare_and_swap");
  await storage.appendActivity({ownerId,projectId:task.projectId,runId:task.id,action:"self_development_execution_scope_recovered",status:"queued",summary:"One exact owner-approved validated-plan application and focused-test run; no further repair, renewal or delivery authority.",metadata:record});
  return{task:updated,recovery:record,idempotent:false};
}

export function validateExecutionScopeEvidence(task,steps,clock=()=>new Date()){
  const history=task.metadata?.executionScopeRecoveryHistory,record=history?.[0],active=task.metadata?.activeContinuation,plan=task.metadata?.selfDevelopmentImplementationPlan;
  requireProof(history?.length===1&&record?.recoveryClass===EXECUTION_SCOPE_RECOVERY_CLASS&&active&&record.consumed===false&&record.authorizationConsumed===true&&record.taskId===task.id&&record.repository===task.metadata.selfDevelopment?.repository&&record.branch===task.branch&&record.currentCommit===task.currentCommit&&task.startingCommit===task.currentCommit&&same(record.activeContinuation,active)&&same(active,task.metadata.continuationHistory?.at(-1))&&active.maxSteps===2&&active.runtimeMinutes===15&&record.maxRecoveries===1&&record.maxProductMutations===1&&record.maxApplyAttempts===1&&record.maxFocusedTestRuns===1&&record.maxAdditionalAttempts===0&&["queued","waiting_for_worker","running"].includes(task.status)&&task.currentStep>=active.startStep&&task.currentStep<active.startStep+2,"execution_successor_generation");
  requireProof(Date.parse(active.runtimeDeadline)>clock().getTime(),"execution_runtime_window");
  requireProof(same(histories(task),record.immutableHistoryHashes)&&task.repairIteration===record.repairIteration&&task.retryCount===record.retryCount&&task.maxRetries===record.maxRetries&&record.historicalContinuationsCount===task.metadata.continuationHistory.length-1&&recoveryHash(task.metadata.continuationHistory.slice(0,-1))===record.historicalContinuationsHash,"preserved_authority");
  preservedSteps(steps,record.predecessorStepProofs);
  requireProof(record.historicalPlannedStepsCount===active.startStep&&recoveryHash(task.metadata.steps.slice(0,active.startStep))===record.historicalPlannedStepsHash&&task.metadata.steps.length===active.startStep+2&&recoveryHash(task.metadata.steps.slice(active.startStep))===record.successorStepsHash,"bounded_execution_steps");
  const binding={taskId:task.id,projectId:task.projectId,expectedVersion:record.fromStateVersion,repository:record.repository,branch:record.branch,currentCommit:record.currentCommit,workspaceRoot:record.workspaceRoot,runtimeVersion:record.runtimeVersion,planGenerationId:record.planGenerationId,sourcePlanStepId:record.sourcePlanStepId,validatedStepId:record.validatedStepId,predecessorGenerationId:record.predecessorGenerationId,readEvidenceHash:recoveryHash(record.readProofs),mutationScopeHash:recoveryHash(record.requiredPaths),maxRecoveries:1,runtimeMinutes:15,maxSteps:2,maxProductMutations:1,maxApplyAttempts:1,maxFocusedTestRuns:1,maxAdditionalAttempts:0};
  requireProof(record.approvalArguments&&Object.entries(binding).every(([key,value])=>same(record.approvalArguments[key],value))&&record.applyStepId===`${active.startStep+1}:apply_patch`&&record.testStepId===`${active.startStep+2}:run_focused_tests`,"approved_execution_binding");
  const claimed=record.claimedStepIds||[];
  requireProof(Array.isArray(claimed)&&claimed.length<=2&&same(claimed,[record.applyStepId,record.testStepId].slice(0,claimed.length)),"single_use_claim_reservations");
  requireProof(recoveryHash(plan)===record.fullPlanHash&&recoveryHash(plan.files)===record.filesHash&&plan.planHash===record.planHash&&plan.provenance.planningOnly===true&&plan.provenance.generationId===record.planGenerationId&&same(plan.focusedTests.map(item=>item.path),record.focusedTests)&&record.approvalArguments.fullPlanHash===record.fullPlanHash&&record.approvalArguments.filesHash===record.filesHash&&record.approvalArguments.planHash===record.planHash&&record.approvalArguments.runtimeVersion===record.runtimeVersion&&record.approvalArguments.beforeEvidenceHash===recoveryHash(record.beforeEntries)&&record.approvalArguments.afterEvidenceHash===recoveryHash(record.afterEntries)&&same(record.approvalArguments.focusedTests,record.focusedTests),"exact_execution_plan");
  const executions=steps.filter(step=>ordinal(step)>active.startStep),apply=executions.find(step=>step.stepId===record.applyStepId),focused=executions.find(step=>step.stepId===record.testStepId);
  requireProof(executions.length<=2&&new Set(executions.map(step=>step.stepId)).size===executions.length&&executions.every(step=>step.taskId===task.id&&step.attempt===1&&["running","completed"].includes(step.status)&&((step.stepId===record.applyStepId&&step.stepType==="apply_patch")||(step.stepId===record.testStepId&&step.stepType==="run_focused_tests")))&&(!focused||apply?.status==="completed")&&(task.currentStep===active.startStep?!focused:apply?.status==="completed"),"one_apply_one_focused_attempt");
  if(apply?.status==="completed"){
    const lineage=apply.result?.taskOwnedDirtyLineage;
    requireProof(apply.result?.ok===true&&same(apply.result.files,plan.files.map(file=>file.path))&&lineage?.version===1&&lineage.taskId===task.id&&lineage.repository===record.repository&&lineage.branch===record.branch&&lineage.currentCommit===record.currentCommit&&lineage.sourcePlanStepId===record.sourcePlanStepId&&lineage.sourceApplyStepId===record.applyStepId&&Array.isArray(lineage.entries)&&same(sorted(lineage.entries).map(({path,contentHash})=>({path,contentHash})),sorted(record.afterEntries).map(({path,contentHash})=>({path,contentHash})))&&same(apply.result.executionScopeEvidence,{generationId:active.generationId,planHash:record.planHash,entries:record.afterEntries}),"complete_applied_lineage");
  }
  return{record,history,plan,apply,focused};
}

export function validateExecutionScopeContext(task,steps,context,clock=()=>new Date()){
  const state=validateExecutionScopeEvidence(task,steps,clock),{record}=state,firstBind=context.allowFirstBind===true&&record.workerBindingState==="awaiting_worker_bind"&&record.workerId===null&&task.currentStep===record.activeContinuation.startStep;
  requireProof(context.runtimeVersion===record.runtimeVersion&&context.generationId===record.activeContinuation.generationId&&context.repository===record.repository&&context.branch===record.branch&&recoveryRoot(context.root)===record.workspaceRoot,"worker_context");
  requireProof(WORKER.test(context.workerId||"")&&!record.rejectedPriorWorkerIds.includes(context.workerId)&&(firstBind||record.workerBindingState==="bound"&&record.workerId===context.workerId),"worker_succession");
  return{...state,firstBind};
}

export function executionScopePayload(record){
  return{version:1,recoveryClass:record.recoveryClass,taskId:record.taskId,approvalId:record.approvalId,repository:record.repository,branch:record.branch,currentCommit:record.currentCommit,workspaceRoot:record.workspaceRoot,runtimeVersion:record.runtimeVersion,workerId:record.workerId,continuationGenerationId:record.activeContinuation.generationId,runtimeDeadline:record.activeContinuation.runtimeDeadline,planHash:record.planHash,planGenerationId:record.planGenerationId,fullPlanHash:record.fullPlanHash,filesHash:record.filesHash,focusedTests:structuredClone(record.focusedTests),requiredPaths:structuredClone(record.requiredPaths),beforeEntries:structuredClone(record.beforeEntries),afterEntries:structuredClone(record.afterEntries),sourcePlanStepId:record.sourcePlanStepId,validatedStepId:record.validatedStepId,applyStepId:record.applyStepId,testStepId:record.testStepId,maxProductMutations:1,maxApplyAttempts:1,maxFocusedTestRuns:1,maxAdditionalAttempts:0};
}
