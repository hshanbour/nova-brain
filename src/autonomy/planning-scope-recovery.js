import {createHash} from "node:crypto";
import {createActiveContinuation,canonicalContentHash} from "./self-development-plan-lifecycle.js";
import {FAILED_LOCAL_READ_RECOVERY_CLASS,recoveryHash,recoveryRoot,validateRecoveredReadEvidence} from "./failed-local-read-recovery.js";
import {focusedTestEvidenceRelevance} from "./focused-test-evidence-relevance.js";

export const PLANNING_SCOPE_RECOVERY_CLASS="failed_recovered_planning_scope_recovery";
export const PLANNING_SCOPE_RECOVERY_TOOL="self_development_planning_scope_recovery";
const SHA=/^[a-f0-9]{40}$/,HASH=/^[a-f0-9]{64}$/;
const WORKER=/^persistent-local-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ordinal=step=>Number.parseInt(step?.stepId,10);
const same=(a,b)=>recoveryHash(a)===recoveryHash(b);
const blobHash=content=>createHash("sha1").update(`blob ${Buffer.byteLength(content,"utf8")}\0`).update(content).digest("hex");
const snapshotKeys=["failedLocalReadRecoveryHistory","continuationRuntimeResumeHistory","implementationPlanRecoveryHistory","partialRepairPlanRecoveryHistory","escalatedRepairHistory"];
function requireProof(value,predicate){
  if(!value)throw Object.assign(new Error(`Planning scope recovery rejected: ${predicate}.`),{code:"planning_scope_recovery_precondition_failed",statusCode:409,safeDiagnostics:{predicate,mutationApplied:false}});
}
function historyHashes(task){return Object.fromEntries(snapshotKeys.map(key=>[key,recoveryHash(task.metadata?.[key])]));}
function signedRequest({taskId,input,actor,runtimeVersion}){
  requireProof(input&&Object.keys(input).every(key=>["expectedVersion","runtimeVersion","approvalId","workspaceProof","workspaceProofSignature"].includes(key))&&Number.isInteger(input.expectedVersion),"request_shape");
  const proof=input.workspaceProof;
  requireProof(actor?.actorType==="scoped_local_worker"&&actor.workspaceProof&&same(actor.workspaceProof,proof)&&proof.taskId===taskId&&proof.expectedVersion===input.expectedVersion&&proof.runtimeVersion===input.runtimeVersion&&Object.keys(proof).every(key=>["taskId","expectedVersion","runtimeVersion","workspace"].includes(key)),"authenticated_workspace_proof");
  requireProof(SHA.test(runtimeVersion||"")&&input.runtimeVersion===runtimeVersion,"active_runtime");
  return proof;
}
function preservedSteps(steps,proofs){
  for(const proof of proofs){
    const matching=steps.filter(step=>step.stepId===proof.stepId);
    requireProof(matching.length===1&&recoveryHash(matching[0])===proof.stepHash,"immutable_source_step");
  }
}

// Read-only eligibility and exact approval-binding construction. Authentication
// proves the current workspace; a separate durable owner decision authorizes the
// one-use successor. Neither authority grants mutation or another repair attempt.
export async function describePlanningScopeRecovery({taskId,input,actor,runtime,storage,ownerId,repository,approvedBranch,runtimeVersion,verifyRemote,clock=()=>new Date()}){
  const proof=signedRequest({taskId,input,actor,runtimeVersion});
  const task=await runtime.get(taskId);
  requireProof(task?.id===taskId&&task.taskType==="self_development"&&task.stateVersion===input.expectedVersion&&task.status==="failed"&&task.currentPhase==="read_files"&&task.errorCode==="implementation_scope_violation"&&!task.leaseOwner&&!task.leaseToken&&!task.metadata?.localHandoff&&!task.approvalState,"failed_task_state");
  requireProof(task.branch===approvedBranch&&task.metadata?.selfDevelopment?.repository===repository&&SHA.test(task.currentCommit||"")&&task.currentCommit===task.startingCommit,"product_identity");
  requireProof(!task.metadata.planningScopeRecoveryHistory?.length,"single_use_successor");
  const steps=await runtime.steps(taskId),matches=steps.filter(step=>step.stepId===`${task.currentStep+1}:plan_repair`),failed=matches[0],diagnostics=failed?.result?.diagnostics;
  requireProof(matches.length===1&&failed.taskId===taskId&&failed.stepType==="plan_repair"&&failed.status==="failed"&&failed.attempt===1&&failed.errorCode==="implementation_scope_violation"&&HASH.test(failed.operationFingerprint||"")&&failed.result?.message==="Focused test is not eligible for bounded evidence expansion."&&failed.result?.mutationApplied!==true&&diagnostics?.rejectionCode==="focused_test_evidence_rejected"&&diagnostics.classification==="unrelated"&&same(diagnostics.validationIssues,["focused_test_evidence_rejected"])&&!steps.some(step=>ordinal(step)>ordinal(failed)),"failed_planning_execution");
  let evidence;
  try{evidence=validateRecoveredReadEvidence(task,steps);}catch(error){requireProof(false,`current_read_evidence:${error.safeDiagnostics?.predicate||error.code||"invalid"}`);}
  const predecessor=evidence.record,active=task.metadata.activeContinuation,requiredPaths=predecessor.requiredPaths;
  requireProof(active.recoveryClass===FAILED_LOCAL_READ_RECOVERY_CLASS&&Date.parse(active.runtimeDeadline)<=clock().getTime()&&task.currentStep===active.startStep+requiredPaths.length&&requiredPaths.length>0&&requiredPaths.length<=12&&evidence.reads.size===requiredPaths.length&&predecessor.readPaths.length===requiredPaths.length&&requiredPaths.every(path=>predecessor.readPaths.includes(path))&&predecessor.workerBindingState==="bound"&&WORKER.test(predecessor.workerId||""),"expired_complete_read_predecessor");
  requireProof(steps.filter(step=>ordinal(step)>active.startStep&&ordinal(step)<ordinal(failed)).length===requiredPaths.length&&steps.filter(step=>ordinal(step)>active.startStep&&ordinal(step)<ordinal(failed)).every(step=>step.stepType==="read_files"&&step.status==="completed"&&requiredPaths.includes(step.result?.path)),"no_post_read_product_attempt");
  const planned=task.metadata.steps?.[task.currentStep],args=failed.input?.arguments;
  requireProof(planned?.type==="plan_repair"&&planned.input?.tool==="self_development_plan_implementation"&&failed.input?.tool===planned.input.tool&&args?.taskId===taskId&&same(args.candidatePaths,requiredPaths)&&same(planned.input.arguments?.candidatePaths,requiredPaths)&&[task.currentCommit,"$CURRENT_COMMIT"].includes(args.currentCommit)&&same(args.failureEvidence,planned.input.arguments.failureEvidence)&&args.failureEvidence?.code==="repair_plan_incomplete"&&args.failureEvidence.mutationApplied===false&&args.failureEvidence.fingerprint===predecessor.fingerprint&&args.failureEvidence.sourceApplyStepId===predecessor.sourceApplyStepId&&args.failureEvidence.sourcePlanStepId===predecessor.sourcePlanStepId&&same(args.failureEvidence.requiredPaths,requiredPaths),"rejected_plan_scope_binding");
  const discoveredPaths=[...new Set(steps.filter(step=>step.stepType==="read_files"&&step.status==="completed").map(step=>step.result?.path||step.input?.arguments?.path).filter(Boolean))];
  const rejectedPath=diagnostics.proposedPath,relevance=focusedTestEvidenceRelevance(rejectedPath,{candidatePaths:requiredPaths,userGoal:task.metadata.selfDevelopment.userGoal,discoveredPaths});
  requireProof(typeof rejectedPath==="string"&&/^test\/[a-z0-9._/-]+\.test\.js$/i.test(rejectedPath)&&!rejectedPath.split("/").includes("..")&&discoveredPaths.includes(rejectedPath)&&!requiredPaths.includes(rejectedPath)&&relevance.classification==="unrelated"&&!relevance.eligible,"offered_unrelated_evidence_class");
  const extensionHistory=task.metadata.escalatedRepairHistory,extension=extensionHistory?.[0],approval=extension?.approvalId?await storage.getApproval(extension.approvalId,ownerId):null,extensionArgs=approval?.arguments;
  requireProof(extensionHistory?.length===1&&extension.recoveryClass==="owner_approved_single_repair_extension"&&extension.maxAdditionalAttempts===1&&Number.isInteger(extension.globalRepairLimit)&&extension.previousRepairIteration===extension.globalRepairLimit&&task.repairIteration===extension.globalRepairLimit&&approval?.status==="approved"&&approval.tool==="self_development_escalated_repair"&&extensionArgs?.taskId===taskId&&extensionArgs.expectedVersion===extension.fromStateVersion&&extensionArgs.branch===task.branch&&extensionArgs.currentCommit===task.currentCommit&&extensionArgs.failedStepId===extension.failedStepId&&extensionArgs.failureFingerprint===extension.failureFingerprint&&extensionArgs.planGenerationId===extension.planGenerationId&&extensionArgs.maxAdditionalAttempts===1,"consumed_repair_extension");
  const workspace=proof.workspace,changed=workspace?.changedFiles;
  requireProof(workspace&&Object.keys(workspace).every(key=>["root","gitTopLevel","repository","branch","head","liveTip","clean","changedFiles"].includes(key))&&recoveryRoot(workspace.root)===recoveryRoot(predecessor.workspaceRoot)&&recoveryRoot(workspace.gitTopLevel)===recoveryRoot(predecessor.workspaceRoot)&&workspace.repository===repository&&workspace.branch===task.branch&&workspace.head===task.currentCommit&&workspace.liveTip===task.currentCommit&&workspace.clean===false&&Array.isArray(changed)&&changed.length===requiredPaths.length&&new Set(changed.map(item=>item.path)).size===requiredPaths.length&&changed.every(item=>evidence.reads.has(item.path)&&item.hashAlgorithm==="git_sha1"&&item.hash===blobHash(evidence.reads.get(item.path))&&item.contentHash===canonicalContentHash(evidence.reads.get(item.path))),"current_workspace");
  requireProof(typeof verifyRemote==="function","remote_verifier");
  const product=await verifyRemote({repository,branch:task.branch,requiredAncestors:[task.currentCommit]});
  const control=await verifyRemote({repository,branch:"stage13/control-plane-approved-delivery-runtime",requiredAncestors:[predecessor.runtimeVersion,runtimeVersion]});
  requireProof(product?.currentTip===task.currentCommit&&product.ancestors?.[task.currentCommit]===true,"live_product_tip");
  requireProof(control?.currentTip===runtimeVersion&&control.ancestors?.[runtimeVersion]===true&&control.ancestors?.[predecessor.runtimeVersion]===true,"runtime_transition");
  const readProofs=requiredPaths.map(path=>{
    const step=steps.find(item=>item.stepId===evidence.readStepIds.get(path));
    requireProof(step?.taskId===taskId&&ordinal(step)>active.startStep&&ordinal(step)<=task.currentStep,"same_task_current_read");
    return{path,stepId:step.stepId,stepHash:recoveryHash(step),contentHash:canonicalContentHash(evidence.reads.get(path)),rawHash:blobHash(evidence.reads.get(path))};
  });
  const approvalArguments={taskId,expectedVersion:task.stateVersion,repository,branch:task.branch,currentCommit:task.currentCommit,workspaceRoot:recoveryRoot(workspace.root),runtimeVersion,predecessorGenerationId:active.generationId,failedStepId:failed.stepId,failedExecutionFingerprint:failed.operationFingerprint,workspaceProofHash:recoveryHash(proof),readEvidenceHash:recoveryHash(readProofs),mutationScopeHash:recoveryHash(requiredPaths),maxRecoveries:1,runtimeMinutes:15,maxSteps:2,maxProductMutations:0,maxAdditionalAttempts:0};
  return{task,steps,failed,predecessor,readProofs,approvalArguments,requiredPaths,proof};
}

export async function recoverPlanningScope(options){
  const {input,storage,ownerId,clock=()=>new Date()}=options;
  const state=await describePlanningScopeRecovery(options),{task,steps,failed,predecessor,readProofs,approvalArguments,requiredPaths,proof}=state;
  const approval=typeof input.approvalId==="string"?await storage.getApproval(input.approvalId,ownerId):null;
  requireProof(approval&&approval.id===input.approvalId&&approval.ownerId===ownerId&&approval.status==="approved"&&approval.runId===task.id&&approval.tool===PLANNING_SCOPE_RECOVERY_TOOL&&same(approval.arguments,approvalArguments),"exact_owner_approval");
  const base=task.metadata.steps.length,now=clock().toISOString();
  const previous=task.metadata.steps[task.currentStep];
  const nextSteps=[
    {...structuredClone(previous),capability:"reasoning",idempotencyIdentity:`planning-scope:${task.id}:${task.stateVersion}:${failed.operationFingerprint}:plan`},
    {type:"validate_patch",capability:"repo_read_remote",input:{tool:"repo_validate_patch",arguments:{branch:"$TASK_BRANCH",currentCommit:"$CURRENT_COMMIT",files:"$IMPLEMENTATION_FILES",planProvenance:"$IMPLEMENTATION_PLAN_PROVENANCE"}},idempotencyIdentity:`planning-scope:${task.id}:${task.stateVersion}:${failed.operationFingerprint}:validate`}
  ];
  const activeContinuation=createActiveContinuation({task,startStep:base,plannedSteps:2,repairLimit:0,recoveryClass:PLANNING_SCOPE_RECOVERY_CLASS,runtimeStartedAt:now,runtimeMinutes:15});
  const sourceIds=[predecessor.sourcePlanStepId,predecessor.sourceApplyStepId,failed.stepId,...readProofs.map(item=>item.stepId)];
  const record={recoveryClass:PLANNING_SCOPE_RECOVERY_CLASS,taskId:task.id,fromStateVersion:task.stateVersion,toStateVersion:task.stateVersion+1,approvalId:approval.id,authorizationConsumed:true,maxRecoveries:1,maxProductMutations:0,maxAdditionalAttempts:0,repository:approvalArguments.repository,branch:task.branch,currentCommit:task.currentCommit,workspaceRoot:recoveryRoot(proof.workspace.root),runtimeVersion:options.runtimeVersion,failedStepId:failed.stepId,failedAttempt:failed.attempt,failedExecutionFingerprint:failed.operationFingerprint,predecessorGenerationId:predecessor.activeContinuation.generationId,predecessorHistoryHashes:historyHashes(task),historicalContinuationsHash:recoveryHash(task.metadata.continuationHistory),historicalContinuationsCount:task.metadata.continuationHistory.length,historicalPlannedStepsHash:recoveryHash(task.metadata.steps),successorStepsHash:recoveryHash(nextSteps),requestHash:recoveryHash(proof),approvalArguments,readProofs,requiredPaths:[...requiredPaths],entries:structuredClone(predecessor.entries),sourcePlanStepId:predecessor.sourcePlanStepId,sourceApplyStepId:predecessor.sourceApplyStepId,sourceApplyFingerprint:predecessor.sourceApplyFingerprint,fingerprint:predecessor.fingerprint,sourceStepProofs:sourceIds.map(stepId=>({stepId,stepHash:recoveryHash(steps.find(step=>step.stepId===stepId))})),repairIteration:task.repairIteration,retryCount:task.retryCount,maxRetries:task.maxRetries,workerBindingState:"awaiting_worker_bind",workerId:null,rejectedPriorWorkerIds:[...new Set([predecessor.workerId,...(predecessor.rejectedPriorWorkerIds||[])])],activeContinuation,recoveredAt:now};
  const updated=await storage.updateAutonomyTask(task.id,ownerId,{status:"queued",currentStep:base,currentPhase:"plan_repair",nextRunAt:now,startedAt:now,completedAt:null,errorCode:null,blockedReason:null,checkpoint:{...task.checkpoint,pendingStep:null},metadata:{...task.metadata,steps:[...task.metadata.steps,...nextSteps],activeContinuation,continuationHistory:[...task.metadata.continuationHistory,activeContinuation],planningScopeRecoveryHistory:[record],requiredCapability:"reasoning",autoDispatch:true}},task.stateVersion);
  requireProof(updated,"recovery_compare_and_swap");
  await storage.appendActivity({ownerId,projectId:task.projectId,runId:task.id,action:"self_development_planning_scope_recovered",status:"queued",summary:"One owner-approved planning-only successor preserves current evidence; no mutation or additional product attempt is authorized.",metadata:record});
  return{task:updated,recovery:record,idempotent:false};
}

function successor(task,steps){
  const history=task.metadata?.planningScopeRecoveryHistory||[],record=history[0],active=task.metadata?.activeContinuation;
  requireProof(history.length===1&&record?.recoveryClass===PLANNING_SCOPE_RECOVERY_CLASS&&record.consumed!==true&&record.maxRecoveries===1&&record.authorizationConsumed===true&&record.maxProductMutations===0&&record.maxAdditionalAttempts===0&&record.taskId===task.id&&record.repository===task.metadata.selfDevelopment?.repository&&record.branch===task.branch&&record.currentCommit===task.currentCommit&&task.currentCommit===task.startingCommit&&same(record.activeContinuation,active)&&same(active,task.metadata.continuationHistory?.at(-1))&&task.currentStep>=active.startStep&&task.currentStep<active.startStep+2&&active.maxSteps===2,"successor_generation");
  requireProof(same(record.predecessorHistoryHashes,historyHashes(task))&&record.historicalContinuationsCount===task.metadata.continuationHistory.length-1&&recoveryHash(task.metadata.continuationHistory.slice(0,-1))===record.historicalContinuationsHash&&task.repairIteration===record.repairIteration&&task.retryCount===record.retryCount&&task.maxRetries===record.maxRetries,"preserved_authority");
  preservedSteps(steps,record.sourceStepProofs);
  requireProof(recoveryHash(task.metadata.steps.slice(0,active.startStep))===record.historicalPlannedStepsHash&&task.metadata.steps.length===active.startStep+2&&recoveryHash(task.metadata.steps.slice(active.startStep))===record.successorStepsHash,"bounded_successor_plan");
  const newSteps=steps.filter(step=>ordinal(step)>Number.parseInt(record.failedStepId,10));
  requireProof(newSteps.length<=2&&new Set(newSteps.map(step=>step.stepId)).size===newSteps.length&&newSteps.every(step=>step.taskId===task.id&&step.attempt===1&&((step.stepType==="plan_repair"&&step.stepId===`${active.startStep+1}:plan_repair`)||(step.stepType==="validate_patch"&&step.stepId===`${active.startStep+2}:validate_patch`))),"no_successor_product_mutation");
  return{record,history};
}
export function validatePlanningScopeReadEvidence(task,steps,clock=()=>new Date()){
  const {record}=successor(task,steps),reads=new Map(),readStepIds=new Map();
  requireProof(Date.parse(record.activeContinuation.runtimeDeadline)>clock().getTime(),"successor_runtime_window");
  for(const proof of record.readProofs){
    const step=steps.find(item=>item.stepId===proof.stepId),content=step?.result?.content;
    requireProof(step?.taskId===task.id&&step.status==="completed"&&step.stepType==="read_files"&&step.result?.truncated===false&&typeof content==="string"&&step.result.path===proof.path&&canonicalContentHash(content)===proof.contentHash&&blobHash(content)===proof.rawHash&&recoveryHash(step)===proof.stepHash,"current_complete_read");
    reads.set(proof.path,content);readStepIds.set(proof.path,proof.stepId);
  }
  requireProof(reads.size===record.requiredPaths.length&&record.requiredPaths.every(path=>reads.has(path))&&recoveryHash(record.readProofs)===record.approvalArguments.readEvidenceHash&&recoveryHash(record.requiredPaths)===record.approvalArguments.mutationScopeHash,"complete_approved_scope");
  return{record,reads,readStepIds};
}
export function validatePlanningScopeContext(task,steps,context,clock=()=>new Date()){
  const {record,history}=successor(task,steps),firstBind=context.allowFirstBind===true&&record.workerBindingState==="awaiting_worker_bind"&&record.workerId===null;
  requireProof(context.runtimeVersion===record.runtimeVersion&&context.generationId===record.activeContinuation.generationId&&context.repository===record.repository&&context.branch===record.branch&&recoveryRoot(context.root)===record.workspaceRoot&&Date.parse(record.activeContinuation.runtimeDeadline)>clock().getTime(),"worker_context");
  requireProof(WORKER.test(context.workerId||"")&&!record.rejectedPriorWorkerIds.includes(context.workerId)&&(firstBind||record.workerBindingState==="bound"&&record.workerId===context.workerId),"worker_succession");
  validatePlanningScopeReadEvidence(task,steps,clock);
  return{record,history,firstBind};
}
