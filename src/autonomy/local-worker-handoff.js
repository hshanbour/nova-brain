import {createHash,createHmac,randomUUID,timingSafeEqual} from "node:crypto";
import {createActiveContinuation,taskRuntimeWindow} from "./self-development-plan-lifecycle.js";
import {assertActiveImplementationPlan,canonicalContentHash} from "./self-development-plan-lifecycle.js";
import {canonicalSchemaDiagnostic} from "./schema-diagnostics.js";
import {isExactApprovedDelivery} from "./auto-dispatch.js";
import {FAILED_LOCAL_READ_RECOVERY_CLASS,validateRecoveredLocalReadContext} from "./failed-local-read-recovery.js";
import {PLANNING_SCOPE_RECOVERY_CLASS,validatePlanningScopeContext} from "./planning-scope-recovery.js";
import {EXECUTION_SCOPE_RECOVERY_CLASS,EXECUTION_SCOPE_RECOVERY_TOOL,validateExecutionScopeContext,executionScopePayload} from "./execution-scope-recovery.js";
import {fullTestScopeDescriptor,validateFullTestScopeContext,fullTestScopePayload} from "./full-test-scope-recovery.js";
import {reviewRemediationDescriptor,validateReviewRemediationContext,reviewRemediationScopePayload,validateReviewRemediationTestResult} from "./review-remediation-scope.js";

const LOCAL_STEPS=Object.freeze({
  read_files:{capability:"repo_read_remote",tool:"repo_read_task_owned_local"},
  apply_patch:{capability:"repo_mutate_local",tool:"repo_apply_patch",lock:true},
  validate_patch:{capability:"repo_read_remote",tool:"repo_validate_patch",lock:true},
  run_focused_tests:{capability:"test_local",tool:"test_run"},
  run_full_tests:{capability:"test_local",tool:"test_run_full"},
  inspect_diff:{capability:"repo_read_remote",tool:"repo_diff"},
  review_commit:{capability:"repo_read_remote",tool:"repo_review_commit"},
  commit:{capability:"repo_mutate_local",tool:"git_commit",lock:true},
  integrate_commit:{capability:"repo_mutate_local",tool:"git_integrate_reviewed_commit",lock:true},
  push:{capability:"github_write",tool:"git_push",lock:true},
});
const SAFE_STATUSES=new Set(["queued","retrying","waiting_for_worker"]);
const RETRYABLE=new Set(["network_error","test_timeout","worker_crash"]);
const APPROVED_DELIVERY_RUNTIME_CLASSES=new Set(["historical_approved_delivery_runtime_recovery","historical_approved_delivery_handoff_recovery","historical_approved_delivery_handoff_runtime_recovery","historical_approved_delivery_worker_capability_runtime_recovery","approval_contract_delivery_runtime","historical_v288_approval_contract_delivery_runtime_recovery"]);
const SECRET=/token|secret|password|authorization|api.?key|database.?url/i;
const redact=value=>Array.isArray(value)?value.map(redact):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,SECRET.test(key)?"[REDACTED]":redact(item)])):value;
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const hash=value=>createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const nowIso=clock=>clock().toISOString();
const approvedDeliveryRuntimeWindow=(task,now)=>{const runtime=task.metadata?.approvedDeliveryRuntime,state=task.approvalState,startedMs=new Date(runtime?.startedAt).getTime(),deadlineMs=new Date(runtime?.deadline).getTime(),valid=APPROVED_DELIVERY_RUNTIME_CLASSES.has(runtime?.recoveryClass)&&runtime?.consumed===false&&runtime?.taskId===task.id&&runtime?.approvalId===state?.approvalId&&runtime?.approvedStateVersion===state?.approvedStateVersion&&runtime?.deliveryStateVersion===task.stateVersion&&runtime?.deliveryStateVersion===state?.deliveryStateVersion&&runtime?.repository===task.metadata?.selfDevelopment?.repository&&runtime?.branch===task.branch&&runtime?.commitSha===task.currentCommit&&runtime?.reviewStepId===`${task.currentStep}:review_commit`&&runtime?.deliveryStepId===`${task.currentStep+1}:push`&&runtime?.maxAdditionalDeliverySteps===1&&Number.isFinite(startedMs)&&Number.isFinite(deadlineMs)&&deadlineMs>startedMs;return Object.freeze({scope:"approved_delivery",startedAt:valid?new Date(startedMs).toISOString():null,deadline:valid?new Date(deadlineMs).toISOString():null,elapsedMs:valid?Math.max(0,now.getTime()-startedMs):null,maxRuntimeMs:valid?deadlineMs-startedMs:null,expired:!valid||deadlineMs<=now.getTime(),continuationGenerationId:null});};
const boundedString=(value,name,max=200)=>{if(typeof value!=="string"||!value.trim()||value.length>max)throw new HandoffError("invalid_handoff_request",`${name} is invalid.`,400);return value;};
const resolvePlan=(value,task)=>{if(Array.isArray(value))return value.map(item=>resolvePlan(item,task));if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,resolvePlan(item,task)]));const plan=task.metadata?.selfDevelopmentImplementationPlan;if(value==="$IMPLEMENTATION_FILES")return plan?.files;if(value==="$IMPLEMENTATION_TESTS")return plan?.focusedTests?.map(test=>typeof test==="string"?test:test.path);if(value==="$IMPLEMENTATION_PATHS")return plan?.files?.map(file=>file.path);if(value==="$IMPLEMENTATION_PLAN_PROVENANCE")return plan?.provenance;if(value==="$CURRENT_COMMIT")return task.currentCommit;if(value==="$TASK_BRANCH")return task.branch;return value;};
const taskOwnedDirtyLineage=(task,steps,files)=>{
  const apply=[...steps].filter(step=>step.stepType==="apply_patch"&&step.status==="completed").sort((a,b)=>Number.parseInt(a.stepId,10)-Number.parseInt(b.stepId,10)).at(-1);
  if(!apply||!Array.isArray(apply.result?.files))return null;
  const applyOrdinal=Number.parseInt(apply.stepId,10),plans=steps.filter(step=>["plan_implementation","plan_repair"].includes(step.stepType)&&step.status==="completed"&&Number.parseInt(step.stepId,10)<applyOrdinal).sort((a,b)=>Number.parseInt(a.stepId,10)-Number.parseInt(b.stepId,10));
  const planStep=plans.at(-1),activePlanStep=steps.filter(step=>["plan_implementation","plan_repair"].includes(step.stepType)&&step.status==="completed").sort((a,b)=>Number.parseInt(a.stepId,10)-Number.parseInt(b.stepId,10)).at(-1),priorFiles=planStep?.result?.implementationPlan?.files;
  if(!Array.isArray(priorFiles))return null;
  const durable=apply.result?.taskOwnedDirtyLineage,hasSourceApply=durable&&Object.prototype.hasOwnProperty.call(durable,"sourceApplyStepId"),canonicalSourceApplyStepId=hasSourceApply?durable.sourceApplyStepId:apply.stepId,applied=new Set(apply.result.files),derived=priorFiles.filter(file=>applied.has(file.path)&&typeof file.content==="string").map(file=>({path:file.path,contentHash:canonicalContentHash(file.content)})),durableExact=durable?.version===1&&durable.taskId===task.id&&durable.repository===task.metadata?.selfDevelopment?.repository&&durable.branch===task.branch&&durable.currentCommit===task.currentCommit&&canonicalSourceApplyStepId===apply.stepId&&Array.isArray(durable.entries),entries=durableExact?durable.entries:derived,targetPaths=[...new Set(files.map(file=>file.path))];
  if(entries.length===0||entries.length!==new Set(entries.map(entry=>entry.path)).size||targetPaths.length===0||targetPaths.some(path=>!entries.some(entry=>entry.path===path)))return null;
  return Object.freeze({version:1,taskId:task.id,repository:task.metadata?.selfDevelopment?.repository,branch:task.branch,currentCommit:task.currentCommit,sourcePlanStepId:durableExact?durable.sourcePlanStepId:planStep.stepId,sourceApplyStepId:apply.stepId,activePlanStepId:activePlanStep?.stepId||null,entries});
};
const taskBoundPatchArguments=(task,args,steps,{allowPlanningOnly=false}={})=>{if(args.branch!==undefined&&args.branch!==task.branch)throw new HandoffError("branch_mismatch","Patch branch does not match the exact task branch.");if(args.currentCommit!==undefined&&args.currentCommit!==task.currentCommit)throw new HandoffError("commit_mismatch","Patch commit does not match the exact task commit.");const planProvenance=assertActiveImplementationPlan(task,args.files,{allowPlanningOnly}),lineage=taskOwnedDirtyLineage(task,steps,args.files);return{branch:task.branch,currentCommit:task.currentCommit,files:args.files,planProvenance:{...planProvenance,...(lineage?{taskOwnedDirtyLineage:lineage}:{})}};};
const canonicalRoot=value=>String(value||"").replaceAll("\\","/").replace(/\/$/,"").toLowerCase();
const taskOwnedLocalReadArguments=(task,planned,steps,workerId,{allowFirstBind=false,clock=()=>new Date(),claimContext}={})=>{
  if(task.metadata?.activeContinuation?.recoveryClass===FAILED_LOCAL_READ_RECOVERY_CLASS||task.metadata?.failedLocalReadRecoveryHistory?.at(-1)?.activeContinuation?.generationId===task.metadata?.activeContinuation?.generationId){
    const {record,history,firstBind}=validateRecoveredLocalReadContext(task,steps,{...claimContext,workerId,allowFirstBind},clock),path=planned.input?.arguments?.path,entry=record.entries.find(item=>item.path===path);
    if(!entry||!record.readPaths.includes(path))throw new HandoffError("task_owned_local_read_unproven","The recovered read is outside the bound remaining set.");
    return{arguments:{path,expectedContentHash:entry.contentHash,binding:{version:1,taskId:task.id,repository:record.repository,branch:task.branch,currentCommit:task.currentCommit,workspaceRoot:record.workspaceRoot,sourcePlanStepId:record.sourcePlanStepId,sourceApplyStepId:record.sourceApplyStepId,sourceApplyFingerprint:record.sourceApplyFingerprint,runtimeVersion:record.runtimeVersion,continuationGenerationId:record.activeContinuation.generationId}},claimMetadata:firstBind?{failedLocalReadRecoveryHistory:[...history.slice(0,-1),{...record,workerBindingState:"bound",workerId,boundAt:nowIso(clock)}]}:null};
  }
  const existingHistory=task.metadata?.continuationRuntimeResumeHistory||[],legacyRenewal=existingHistory.at(-1);
  if(legacyRenewal&&!legacyRenewal.workerBindingState&&typeof legacyRenewal.workerId==="string")task={...task,metadata:{...task.metadata,continuationRuntimeResumeHistory:[...existingHistory.slice(0,-1),{...legacyRenewal,workerBindingState:"bound"}]}};
  const path=String(planned?.input?.arguments?.path||"").replaceAll("\\","/"),record=(task.metadata?.partialRepairPlanRecoveryHistory||[]).at(-1),recovery=(task.metadata?.implementationPlanRecoveryHistory||[]).at(-1),active=task.metadata?.activeContinuation,continuation=(task.metadata?.continuationHistory||[]).at(-1),resumeHistory=task.metadata?.continuationRuntimeResumeHistory||[],renewal=resumeHistory.at(-1),awaiting=renewal?.workerBindingState==="awaiting_worker_bind"&&renewal?.workerId===null,bound=renewal?.workerBindingState==="bound"&&renewal?.workerId===workerId,firstBind=allowFirstBind&&awaiting&&!renewal?.rejectedPriorWorkerIds?.includes(workerId),workerExact=bound||firstBind,renewedGeneration=renewal?.sourceRecoveryClass==="task_owned_local_read_recovery"&&renewal?.continuationGenerationId===active?.generationId&&workerExact&&renewal?.repository===record?.repository&&renewal?.branch===task.branch&&renewal?.currentCommit===task.currentCommit&&canonicalRoot(renewal?.workspaceRoot)===canonicalRoot(record?.workspaceRoot)&&renewal?.sourcePlanStepId===record?.sourcePlanStepId&&renewal?.sourceApplyStepId===record?.sourceApplyStepId&&renewal?.fingerprint===record?.fingerprint&&renewal?.runtimeWindow?.runtimeStartedAt===active?.runtimeStartedAt&&renewal?.runtimeWindow?.runtimeDeadline===active?.runtimeDeadline&&renewal?.maxRenewals===1&&renewal?.authorizationConsumed===true&&Array.isArray(renewal?.remainingReadPaths)&&renewal.remainingReadPaths.includes(path),historicalGeneration=record?.activeContinuation?.generationId===active?.generationId,recoveredGeneration=recovery?.recoveryClass==="task_owned_local_read_recovery"&&active?.recoveryClass===recovery.recoveryClass&&/^[a-f0-9]{64}$/.test(active?.generationId||"")&&continuation?.generationId===active.generationId&&continuation.recoveryClass===active.recoveryClass&&continuation.runtimeStartedAt===active.runtimeStartedAt&&continuation.runtimeDeadline===active.runtimeDeadline&&((recovery.previousStateVersion===task.stateVersion-1&&recovery.recoveredAt===active.runtimeStartedAt)||renewedGeneration)&&recovery.fingerprint===record?.fingerprint&&recovery.sourcePlanStepId===record?.sourcePlanStepId&&recovery.sourceApplyStepId===record?.sourceApplyStepId&&/^[a-f0-9]{40}$/.test(recovery.runtimeVersion||"")&&Array.isArray(recovery.readPaths)&&recovery.readPaths.includes(path)&&recovery.readPaths.every(item=>record?.requiredPaths?.includes(item)),apply=steps.filter(step=>step.stepType==="apply_patch"&&step.status==="completed").sort((a,b)=>Number.parseInt(a.stepId,10)-Number.parseInt(b.stepId,10)).at(-1),lineage=apply?.result?.taskOwnedDirtyLineage,lineageSourceApply=lineage&&Object.prototype.hasOwnProperty.call(lineage,"sourceApplyStepId")?lineage.sourceApplyStepId:apply?.stepId,recordEntry=record?.entries?.find(entry=>entry.path===path),lineageEntry=lineage?.entries?.find(entry=>entry.path===path),exact=task.taskType==="self_development"&&planned?.input?.tool==="repo_read_task_owned_local"&&/^[a-z0-9._/-]+$/i.test(path)&&!path.split("/").includes("..")&&record?.taskId===task.id&&record.repository===task.metadata?.selfDevelopment?.repository&&record.branch===task.branch&&record.currentCommit===task.currentCommit&&typeof record.workspaceRoot==="string"&&canonicalRoot(record.workspaceRoot)&&(historicalGeneration||recoveredGeneration)&&Array.isArray(record.requiredPaths)&&record.requiredPaths.includes(path)&&record.sourceApplyStepId===apply?.stepId&&lineage?.version===1&&lineage.taskId===task.id&&lineage.repository===record.repository&&lineage.branch===task.branch&&lineage.currentCommit===task.currentCommit&&lineageSourceApply===apply.stepId&&lineage.sourcePlanStepId===record.sourcePlanStepId&&recordEntry&&lineageEntry&&/^[a-f0-9]{64}$/.test(recordEntry.contentHash||"")&&recordEntry.contentHash===lineageEntry.contentHash;
  if(!exact)throw new HandoffError("task_owned_local_read_unproven","Only an exact task-owned local file may be read.");
  const argumentsValue={path,expectedContentHash:recordEntry.contentHash,binding:{version:1,taskId:task.id,repository:record.repository,branch:task.branch,currentCommit:task.currentCommit,workspaceRoot:record.workspaceRoot,sourcePlanStepId:record.sourcePlanStepId,sourceApplyStepId:apply.stepId,sourceApplyFingerprint:apply.operationFingerprint,continuationGenerationId:task.metadata.activeContinuation.generationId}};
  if(!firstBind)return{arguments:argumentsValue,claimMetadata:null};
  const boundRenewal={...renewal,workerBindingState:"bound",workerId,boundAt:nowIso(clock)};
  return{arguments:argumentsValue,claimMetadata:{continuationRuntimeResumeHistory:[...resumeHistory.slice(0,-1),boundRenewal]}};
};

export class HandoffError extends Error{constructor(code,message,statusCode=409){super(message);this.name="HandoffError";this.code=code;this.statusCode=statusCode;}}
export function authorizeLocalWorker(request,token){const header=request?.headers?.authorization||request?.headers?.Authorization;if(!token)throw new HandoffError("handoff_not_configured","Local Worker handoff is unavailable.",503);if(typeof header!=="string"||!header.startsWith("Bearer "))throw new HandoffError("unauthorized","Local Worker authorization is required.",401);const supplied=Buffer.from(header.slice(7)),expected=Buffer.from(token);if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))throw new HandoffError("unauthorized","Local Worker authorization is required.",401);return{actorType:"scoped_local_worker"};}
export function verifyLocalWorkerWorkspaceProof(proof,signature,token){
  if(!proof||typeof proof!=="object"||Array.isArray(proof)||typeof signature!=="string"||!/^[a-f0-9]{64}$/.test(signature)||!token)throw new HandoffError("workspace_attestation_unauthorized","A signed local-worker workspace proof is required.",403);
  const expected=createHmac("sha256",token).update(JSON.stringify(stable(proof))).digest("hex"),supplied=Buffer.from(signature),wanted=Buffer.from(expected);
  if(supplied.length!==wanted.length||!timingSafeEqual(supplied,wanted))throw new HandoffError("workspace_attestation_unauthorized","The local-worker workspace proof signature is invalid.",403);
  return Object.freeze({actorType:"scoped_local_worker",workspaceProof:proof});
}

export function createLocalWorkerHandoff({storage,ownerId,approvedBranch="feat/nova-brain-mvp-foundation",clock=()=>new Date(),leaseMs=120000,deploymentEnvironment="preview"}={}){
  if(!storage||!ownerId)throw new Error("Local Worker handoff requires storage and ownerId.");
  const activity=(task,action,status,summary,metadata={})=>storage.appendActivity({ownerId,projectId:task.projectId,runId:task.id,action,status,summary,metadata:redact({taskId:task.id,...metadata})});
  const response=(task,handoff)=>({handoffId:handoff.id,taskId:task.id,stepId:handoff.stepId,stepType:handoff.stepType,repository:"hshanbour/nova-brain",branch:task.branch,expectedCommit:task.currentCommit,tool:handoff.tool,arguments:redact(handoff.arguments),...(handoff.reviewRemediationScope?{reviewRemediationScope:handoff.reviewRemediationScope}:{}),...(handoff.approvedDelivery?{approvedDelivery:handoff.approvedDelivery}:{}),...(handoff.executionScope?{executionScope:handoff.executionScope}:{}),...(handoff.fullTestScope?{fullTestScope:handoff.fullTestScope}:{}),idempotencyKey:handoff.idempotencyKey,deadline:handoff.expiresAt});
  const executionApproval=async(task,record)=>{const approval=await storage.getApproval(record.approvalId,ownerId);if(approval?.status!=="approved"||approval.tool!==EXECUTION_SCOPE_RECOVERY_TOOL||approval.runId!==task.id||approval.ownerId!==ownerId||approval.projectId!==task.projectId||hash(approval.arguments)!==hash(record.approvalArguments))throw new HandoffError("execution_scope_approval_required","The exact owner-approved execution contract must remain approved.",403);};
  const fullTestApproval=async(task,record)=>{const descriptor=fullTestScopeDescriptor(task),approval=await storage.getApproval(record.approvalId,ownerId);if(!descriptor||record.recoveryClass!==descriptor.recoveryClass||approval?.status!=="approved"||approval.tool!==descriptor.tool||approval.runId!==task.id||approval.ownerId!==ownerId||approval.projectId!==task.projectId||hash(approval.arguments)!==hash(record.approvalArguments))throw new HandoffError("full_test_scope_approval_required","The exact owner-approved full-test contract must remain approved.",403);};
  async function claim(input){
    if(deploymentEnvironment==="production")throw new HandoffError("production_target_forbidden","Local Worker handoff is forbidden in Production.",403);
    const taskId=boundedString(input?.taskId,"taskId"),workerId=boundedString(input?.workerId,"workerId"),idempotencyKey=boundedString(input?.idempotencyKey,"idempotencyKey");
    if(input.expectedBranch!==approvedBranch||["main","master"].includes(input.expectedBranch))throw new HandoffError("branch_not_allowed","Only the approved feature branch may be handed off.",403);
    boundedString(input.expectedCommit,"expectedCommit",64);
    const capabilities=[...new Set(Array.isArray(input.capabilities)?input.capabilities:[])].filter(value=>["repo_mutate_local","test_local","repo_read_remote","approved_delivery_git_push"].includes(value));
    const before=await storage.getAutonomyTask(taskId,ownerId);if(!before)return{claimed:false};
    if(before.branch!==input.expectedBranch)throw new HandoffError("branch_mismatch","Task branch does not match.");
    if(before.currentCommit!==input.expectedCommit)throw new HandoffError("commit_mismatch","Task commit does not match.");
    if(reviewRemediationDescriptor(before))return claimReviewRemediation(before,input,workerId,idempotencyKey,capabilities);
    const recoveredRead=before.metadata?.steps?.[before.currentStep]?.input?.tool==="repo_read_task_owned_local"&&(before.metadata?.activeContinuation?.recoveryClass===FAILED_LOCAL_READ_RECOVERY_CLASS||before.metadata?.failedLocalReadRecoveryHistory?.at(-1)?.activeContinuation?.generationId===before.metadata?.activeContinuation?.generationId);
    const claimContext={runtimeVersion:input.runtimeVersion,generationId:input.continuationGenerationId,repository:input.repository,root:input.repositoryRoot,branch:input.expectedBranch};
    const fullTestDescriptor=fullTestScopeDescriptor(before),fullTestOnly=Boolean(fullTestDescriptor);
    const executionOnly=!fullTestOnly&&(before.metadata?.activeContinuation?.recoveryClass===EXECUTION_SCOPE_RECOVERY_CLASS||Boolean(before.metadata?.executionScopeRecoveryHistory?.length));
    const planningOnly=!fullTestOnly&&!executionOnly&&(before.metadata?.activeContinuation?.recoveryClass===PLANNING_SCOPE_RECOVERY_CLASS||Boolean(before.metadata?.planningScopeRecoveryHistory?.length));
    let planningProof=null,executionProof=null,fullTestProof=null;
    if(fullTestOnly){
      fullTestProof=validateFullTestScopeContext(before,await storage.listAutonomySteps(before.id),{...claimContext,workerId,allowFirstBind:true},clock);
      await fullTestApproval(before,fullTestProof.record);
      if(before.metadata?.steps?.[before.currentStep]?.type!=="run_full_tests")throw new HandoffError("full_test_scope_step_forbidden","Only the exact approved full-test step may be handed off.");
    }
    if(executionOnly){
      executionProof=validateExecutionScopeContext(before,await storage.listAutonomySteps(before.id),{...claimContext,workerId,allowFirstBind:true},clock);
      await executionApproval(before,executionProof.record);
      if(!["apply_patch","run_focused_tests"].includes(before.metadata?.steps?.[before.currentStep]?.type))throw new HandoffError("execution_scope_step_forbidden","Only the approved apply and focused-test successor may be handed off.");
    }
    if(planningOnly){
      planningProof=validatePlanningScopeContext(before,await storage.listAutonomySteps(before.id),{...claimContext,workerId,allowFirstBind:true},clock);
      if(before.metadata?.steps?.[before.currentStep]?.type!=="validate_patch")throw new HandoffError("planning_scope_mutation_forbidden","This continuation permits only a read-only patch preflight handoff.");
    }
    // Validate even an idempotent active-handoff request before returning it.
    if(recoveredRead)validateRecoveredLocalReadContext(before,await storage.listAutonomySteps(before.id),{...claimContext,workerId,allowFirstBind:true},clock);
    const active=before.metadata?.localHandoff;
    if(active&&new Date(active.expiresAt)>clock()){
      if(active.workerId===workerId&&active.idempotencyKey===idempotencyKey)return{claimed:true,idempotent:true,handoff:response(before,active)};
      return{claimed:false};
    }
    if(!SAFE_STATUSES.has(before.status)&&!(active&&new Date(active.expiresAt)<=clock()))return{claimed:false};
    if(fullTestProof){
      const stepId=`${before.currentStep+1}:run_full_tests`;
      if(active||(fullTestProof.record.claimedStepIds||[]).includes(stepId)||(await storage.listAutonomySteps(before.id)).some(step=>step.stepId===stepId))throw new HandoffError("full_test_scope_replay_forbidden","The single-use full-test step was already claimed and may not be retried.");
    }
    if(executionProof){
      const stepId=`${before.currentStep+1}:${before.metadata.steps[before.currentStep].type}`;
      if(active||(executionProof.record.claimedStepIds||[]).includes(stepId)||(await storage.listAutonomySteps(before.id)).some(step=>step.stepId===stepId))throw new HandoffError("execution_scope_replay_forbidden","The single-use execution step was already claimed; it may not be retried or rebound.");
    }
    let planned=before.metadata?.steps?.[before.currentStep];
    let exactApprovedDelivery=false;
    if(before.approvalState?.approved===true&&(!planned||planned.type==="push")){const approval=await storage.getApproval(before.approvalState.approvalId,ownerId),steps=await storage.listAutonomySteps(before.id);if(isExactApprovedDelivery({task:before,approval,steps,approvedBranch})){exactApprovedDelivery=true;if(!planned)planned={type:"push",input:{tool:"git_push",arguments:{branch:before.branch,commitSha:before.currentCommit}}};}}
    const runtimeWindow=exactApprovedDelivery?approvedDeliveryRuntimeWindow(before,clock()):taskRuntimeWindow(before,clock());
    if(runtimeWindow.expired){const runtimeExpiration={version:1,scope:runtimeWindow.scope,startedAt:runtimeWindow.startedAt,deadline:runtimeWindow.deadline,elapsedWindowMs:runtimeWindow.elapsedMs,maxRuntimeMs:runtimeWindow.maxRuntimeMs,continuationGenerationId:runtimeWindow.continuationGenerationId,expiredAt:nowIso(clock)},updated=await storage.updateAutonomyTask(before.id,ownerId,{status:"expired",errorCode:"max_runtime_reached",nextRunAt:null,leaseOwner:null,leaseToken:null,leaseExpiresAt:null,metadata:{...before.metadata,runtimeExpiration}},before.stateVersion);if(!updated)return{claimed:false,code:"version_conflict"};await activity(updated,"local_worker_task_runtime_expired","expired","The task-scoped local handoff runtime expired without stopping the persistent worker.",{claimStage:"pre_claim_runtime",runtimeExpiration});return{claimed:false,code:"max_runtime_reached",taskId:before.id};}
    const definition=LOCAL_STEPS[planned?.type];
    const capabilityAvailable=definition&&(exactApprovedDelivery?capabilities.includes("approved_delivery_git_push"):capabilities.includes(definition.capability));
    if(!capabilityAvailable)return{claimed:false};
    let args=resolvePlan(planned.input?.arguments||{},before),claimMetadata=null,executionScope=null,fullTestScope=null;
    if(fullTestProof){
      const {record,history,firstBind}=fullTestProof,boundRecord={...record,...(firstBind?{workerBindingState:"bound",workerId,boundAt:nowIso(clock)}:{}),claimedStepIds:[record.fullTestStepId],fullTestClaimedAt:nowIso(clock)};
      if(hash(args)!==hash({}))throw new HandoffError("full_test_scope_arguments_changed","Only the unfiltered default full-test command is approved.");
      fullTestScope=fullTestScopePayload(boundRecord);
      claimMetadata={[fullTestDescriptor.historyKey]:[...history.slice(0,-1),boundRecord]};
    }
    if(executionProof){
      const {record,history,firstBind}=executionProof,stepId=`${before.currentStep+1}:${planned.type}`,boundRecord={...record,...(firstBind?{workerBindingState:"bound",workerId,boundAt:nowIso(clock)}:{}),claimedStepIds:[...(record.claimedStepIds||[]),stepId],...(planned.type==="apply_patch"?{applyClaimedAt:nowIso(clock)}:{focusedClaimedAt:nowIso(clock)})};
      executionScope={...executionScopePayload(boundRecord),workerId};
      claimMetadata={executionScopeRecoveryHistory:[...history.slice(0,-1),boundRecord]};
      if(planned.type==="run_focused_tests"&&hash(args.files)!==hash(record.focusedTests))throw new HandoffError("execution_scope_tests_changed","Focused tests must exactly match the approved execution scope.");
    }
    if(planned.type==="validate_patch"){
      if(!planningProof)throw new HandoffError("planning_scope_precondition_failed","Patch preflight requires the exact planning continuation.");
      const {record,history,firstBind}=planningProof;
      args=taskBoundPatchArguments(before,args,await storage.listAutonomySteps(before.id),{allowPlanningOnly:true});
      if(args.planProvenance.planningOnly!==true||args.files.some(file=>!record.requiredPaths.includes(file.path))||!args.planProvenance.taskOwnedDirtyLineage)throw new HandoffError("planning_scope_precondition_failed","Preflight scope or complete dirty lineage is invalid.");
      args.planProvenance.planningScope={taskId:before.id,repository:record.repository,branch:record.branch,workspaceRoot:record.workspaceRoot,currentCommit:record.currentCommit,runtimeVersion:record.runtimeVersion,workerId,continuationGenerationId:record.activeContinuation.generationId,deadline:record.activeContinuation.runtimeDeadline,requiredPaths:record.requiredPaths,readProofs:record.readProofs};
      if(firstBind)claimMetadata={planningScopeRecoveryHistory:[...history.slice(0,-1),{...record,workerBindingState:"bound",workerId,boundAt:nowIso(clock)}]};
    }
    if(planned.input?.tool!==definition.tool)throw new HandoffError("invalid_step_payload","Server plan contains an invalid local tool.");
    if(before.taskType==="self_development"&&planned.type==="read_files"&&planned.input?.tool==="repo_read_task_owned_local"){const localRead=taskOwnedLocalReadArguments(before,planned,await storage.listAutonomySteps(before.id),workerId,{allowFirstBind:true,clock,claimContext});args=localRead.arguments;claimMetadata=localRead.claimMetadata;}
    if(before.taskType==="self_development"&&planned.type==="apply_patch")args=taskBoundPatchArguments(before,args,await storage.listAutonomySteps(before.id),{allowPlanningOnly:Boolean(executionProof)});
    if(before.taskType==="self_development"&&planned.type==="commit"){const reviewed=(await storage.listAutonomySteps(before.id)).filter(step=>step.stepType==="inspect_diff"&&step.status==="completed").at(-1)?.result?.reviewedChangeSet;if(!reviewed?.reviewHash)throw new HandoffError("review_required","Self-development commits require a durable reviewed change-set.");args={...args,reviewedChangeSet:reviewed};}
    let approvedDelivery=null;
    if(planned.type==="push"){const approval=await storage.getApproval(before.approvalState?.approvalId,ownerId),steps=await storage.listAutonomySteps(before.id);if(!isExactApprovedDelivery({task:before,approval,steps,approvedBranch}))throw new HandoffError("approved_delivery_invalid","Only the exact immutable approved delivery may be handed off.",409);const pushes=steps.filter(step=>step.stepType==="push"),successfulPush=pushes.some(step=>step.status==="completed"),review=steps.filter(step=>step.stepType==="review_commit"&&step.status==="completed").at(-1);approvedDelivery=Object.freeze({contractVersion:1,taskType:before.taskType,taskId:before.id,approvalId:approval.id,approved:approval.status==="approved",revoked:approval.status==="revoked",reviewedCommit:review?.result?.commitSha,repository:before.metadata?.selfDevelopment?.repository,branch:before.branch,logicalStepId:`${before.currentStep+1}:push`,localHandoff:true,reviewHistoryImmutable:true,postReviewMutation:false,deliveryConsumed:before.metadata?.approvedDeliveryRuntime?.consumed===true,gitPushSucceeded:successfulPush,secondLogicalPush:pushes.length>1,repositoryProvenanceValid:before.metadata?.selfDevelopment?.repository==="hshanbour/nova-brain"});}
    const scopedLeaseMs=fullTestProof?Math.min(300000,new Date(fullTestProof.record.activeContinuation.runtimeDeadline).getTime()-clock().getTime()):leaseMs;
    const handoff={id:randomUUID(),workerId,idempotencyKey,stepId:`${before.currentStep+1}:${planned.type}`,stepType:planned.type,tool:definition.tool,arguments:redact(args),...(approvedDelivery?{approvedDelivery}:{}),...(executionScope?{executionScope}:{}),...(fullTestScope?{fullTestScope}:{}),branch:before.branch,expectedCommit:before.currentCommit,expiresAt:new Date(Math.min(clock().getTime()+Math.max(30000,Math.min(300000,scopedLeaseMs)),executionProof?new Date(executionProof.record.activeContinuation.runtimeDeadline).getTime():fullTestProof?new Date(fullTestProof.record.activeContinuation.runtimeDeadline).getTime():Infinity)).toISOString(),fingerprint:hash([before.id,before.currentStep,planned.type,redact(planned.input),before.currentCommit])};
    const claimCapabilities=exactApprovedDelivery?[...capabilities,"github_write"]:capabilities;
    const task=await storage.claimAutonomyTask({ownerId,workerId:`local:${workerId}`,capabilities:claimCapabilities,leaseMs:scopedLeaseMs,idempotencyKey,taskId,expectedBranch:input.expectedBranch,expectedCommit:input.expectedCommit,expectedVersion:before.stateVersion,claimMetadata});if(!task)return{claimed:false};
    if(definition.lock&&!await storage.acquireAutonomyLock({lockKey:`${task.projectId||"repo"}:${task.branch}`,taskId:task.id,leaseToken:task.leaseToken,expiresAt:task.leaseExpiresAt})){await storage.releaseAutonomyLease(task.id,ownerId,task.leaseToken);return{claimed:false,code:"branch_locked"};}
    const priorStep=(await storage.listAutonomySteps(task.id)).find(step=>step.stepId===handoff.stepId);
    if(priorStep?.status==="failed")await storage.updateAutonomyStep(task.id,handoff.stepId,{status:"running",attempt:(priorStep.attempt||1)+1,result:null,errorCode:null,startedAt:nowIso(clock),completedAt:null});
    else await storage.recordAutonomyStep({taskId:task.id,stepId:handoff.stepId,stepType:handoff.stepType,capability:definition.capability,operationFingerprint:handoff.fingerprint,input:redact(recoveredRead?{tool:definition.tool,arguments:args}:planned.input),status:"running"});
    handoff.expectedVersion=task.stateVersion+1;
    const updated=await storage.updateAutonomyTask(task.id,ownerId,{status:"running",metadata:{...task.metadata,localHandoff:handoff}},task.stateVersion);
    if(!updated)throw new HandoffError("version_conflict","Task changed while creating the handoff.");
    await activity(updated,"local_worker_handoff_created","running",`${handoff.stepType} handed to a controlled local worker.`,{handoffId:handoff.id,stepId:handoff.stepId,workerId});
    return{claimed:true,idempotent:false,handoff:response(updated,handoff)};
  }
  async function reviewRemediationApproval(task,record){
    const descriptor=reviewRemediationDescriptor(task),approval=await storage.getApproval(record.approvalId,ownerId);
    if(!descriptor||record.recoveryClass!==descriptor.recoveryClass||approval?.status!=="approved"||approval.tool!==descriptor.tool||approval.runId!==task.id||approval.ownerId!==ownerId||approval.projectId!==task.projectId||hash(approval.arguments)!==hash(record.approvalArguments))throw new HandoffError("review_remediation_approval_required","The exact review-remediation owner approval must remain approved.",403);
  }
  async function claimReviewRemediation(before,input,workerId,idempotencyKey,capabilities){
    const active=before.metadata?.localHandoff,descriptor=reviewRemediationDescriptor(before);
    const deadline=Date.parse(before.metadata[descriptor.historyKey]?.at(-1)?.activeContinuation?.runtimeDeadline),expired=Number.isFinite(deadline)&&deadline<=clock().getTime();
    const steps=await storage.listAutonomySteps(before.id),{record,history,firstBind}=validateReviewRemediationContext(before,steps,{runtimeVersion:input.runtimeVersion,generationId:input.continuationGenerationId,repository:input.repository,root:input.repositoryRoot,branch:input.expectedBranch,workerId,allowFirstBind:true},expired?()=>new Date(deadline-1):clock);
    await reviewRemediationApproval(before,record);
    if(active&&(active.workerId!==workerId||active.idempotencyKey!==idempotencyKey))return{claimed:false};
    if(active&&new Date(active.expiresAt)<=clock()){await stopReviewRemediation(before,active,{code:"review_remediation_handoff_expired",message:"The one-time handoff expired."});throw new HandoffError("handoff_expired","Review remediation stopped without retry.");}
    if(expired){const planned=before.metadata.steps[before.currentStep];await stopReviewRemediation(before,{stepId:`${before.currentStep+1}:${planned.type}`,stepType:planned.type},{code:"review_remediation_runtime_expired",message:"The bounded remediation runtime expired."});return{claimed:false,code:"review_remediation_runtime_expired"};}
    if(active){if(active.workerId===workerId&&active.idempotencyKey===idempotencyKey)return{claimed:true,idempotent:true,handoff:response(before,active)};return{claimed:false};}
    if(!SAFE_STATUSES.has(before.status))return{claimed:false};
    const planned=before.metadata.steps[before.currentStep],definition=LOCAL_STEPS[planned?.type],stepId=`${before.currentStep+1}:${planned?.type}`;
    const allowed=new Set([...record.readStepIds,record.validateStepId,record.applyStepId,record.focusedStepId,record.fullTestStepId]);
    if(!allowed.has(stepId)||!definition||planned.input?.tool!==definition.tool)throw new HandoffError("review_remediation_step_forbidden","Only the current approved remediation phase may be handed off.");
    if(record.claimedStepIds.includes(stepId)||steps.some(step=>step.stepId===stepId))throw new HandoffError("review_remediation_replay_forbidden","The one-time remediation phase was already reserved.");
    if(!capabilities.includes(definition.capability))return{claimed:false};
    let args=resolvePlan(planned.input.arguments||{},before);
    if(planned.type==="read_files"){
      const path=record.requiredPaths[record.readStepIds.indexOf(stepId)],entry=record.beforeEntries.find(item=>item.path===path);
      if(args.path!==path)throw new HandoffError("review_remediation_read_changed","The fresh read path differs from its approved position.");
      args={path,expectedContentHash:entry.contentHash,binding:{version:1,taskId:before.id,repository:record.repository,branch:record.branch,currentCommit:record.currentCommit,workspaceRoot:record.workspaceRoot,sourcePlanStepId:record.sourcePlanStepId,sourceApplyStepId:record.sourceApplyStepId,sourceApplyFingerprint:record.sourceApplyFingerprint,runtimeVersion:record.runtimeVersion,continuationGenerationId:record.activeContinuation.generationId}};
    }else if(["apply_patch","validate_patch"].includes(planned.type))args=taskBoundPatchArguments(before,args,steps);
    else if(planned.type==="run_focused_tests"&&hash(args)!==hash({files:record.focusedTests}))throw new HandoffError("review_remediation_tests_changed","Focused tests must match the accepted remediation plan.");
    else if(planned.type==="run_full_tests"&&hash(args)!==hash({}))throw new HandoffError("review_remediation_tests_changed","Only the unfiltered full suite is authorized.");
    const bound={...record,...(firstBind?{workerBindingState:"bound",workerId,boundAt:nowIso(clock)}:{}),claimedStepIds:[...record.claimedStepIds,stepId]};
    const scopedLeaseMs=Math.min(300000,new Date(record.activeContinuation.runtimeDeadline).getTime()-clock().getTime());
    const handoff={id:randomUUID(),workerId,idempotencyKey,stepId,stepType:planned.type,tool:definition.tool,arguments:redact(args),reviewRemediationScope:reviewRemediationScopePayload(bound),branch:before.branch,expectedCommit:before.currentCommit,expiresAt:new Date(clock().getTime()+scopedLeaseMs).toISOString(),fingerprint:hash([before.id,before.currentStep,planned.type,redact(planned.input),before.currentCommit,record.activeContinuation.generationId])};
    const task=await storage.claimAutonomyTask({ownerId,workerId:`local:${workerId}`,capabilities,leaseMs:scopedLeaseMs,idempotencyKey,taskId:before.id,expectedBranch:input.expectedBranch,expectedCommit:input.expectedCommit,expectedVersion:before.stateVersion,claimMetadata:{[descriptor.historyKey]:[...history.slice(0,-1),bound]}});
    if(!task)return{claimed:false};
    if(definition.lock&&!await storage.acquireAutonomyLock({lockKey:`${task.projectId||"repo"}:${task.branch}`,taskId:task.id,leaseToken:task.leaseToken,expiresAt:task.leaseExpiresAt})){await stopReviewRemediation(task,handoff,{code:"branch_locked",message:"The bound repository branch is locked."});return{claimed:false,code:"branch_locked"};}
    await storage.recordAutonomyStep({taskId:task.id,stepId,stepType:planned.type,capability:definition.capability,operationFingerprint:handoff.fingerprint,input:redact({tool:definition.tool,arguments:args}),status:"running"});
    handoff.expectedVersion=task.stateVersion+1;
    const updated=await storage.updateAutonomyTask(task.id,ownerId,{status:"running",metadata:{...task.metadata,localHandoff:handoff}},task.stateVersion);
    if(!updated)throw new HandoffError("version_conflict","Task changed while its remediation handoff was created.");
    return{claimed:true,idempotent:false,handoff:response(updated,handoff)};
  }
  async function finishReviewRemediation(task,handoff,result,{failed=false,errorCode}={}){
    const descriptor=reviewRemediationDescriptor(task),latest=task.metadata[descriptor.historyKey].at(-1),{record}=validateReviewRemediationContext(task,await storage.listAutonomySteps(task.id),{runtimeVersion:latest.runtimeVersion,generationId:task.metadata.activeContinuation.generationId,repository:latest.repository,root:latest.workspaceRoot,branch:task.branch,workerId:handoff.workerId},clock);
    await reviewRemediationApproval(task,record);
    if(!handoff.reviewRemediationScope||handoff.executionScope||handoff.fullTestScope||hash(handoff.reviewRemediationScope)!==hash(reviewRemediationScopePayload(record)))throw new HandoffError("review_remediation_context_changed","The result must retain the exact approved remediation authority.");
    const evidence=failed?result.diagnostics?.reviewRemediationEvidence:result.reviewRemediationEvidence,after=["apply_patch","run_focused_tests","run_full_tests"].includes(handoff.stepType),entries=after?record.afterEntries:record.beforeEntries;
    if((!failed||errorCode==="test_failed")&&(evidence?.generationId!==record.activeContinuation.generationId||evidence?.reviewHash!==record.reviewHash||evidence?.planHash!==(record.planHash||null)||hash(evidence?.entries)!==hash(entries)))throw new HandoffError("review_remediation_result_invalid","The phase result must prove every bound current workspace hash.");
    if(!failed&&handoff.stepType==="read_files"&&(canonicalContentHash(result.content)!==handoff.arguments.expectedContentHash||result.baselineCommit!==record.currentCommit||(result.baselineContent!==null&&typeof result.baselineContent!=="string")||result.baselineContentHash!==(result.baselineContent===null?null:canonicalContentHash(result.baselineContent))))throw new HandoffError("review_remediation_result_invalid","The fresh read and same-path baseline must retain exact hashes.");
    if(!failed&&handoff.stepType==="validate_patch"&&(result.preMutationValidated!==true||result.mutationApplied!==false||result.currentCommit!==task.currentCommit||result.planGenerationId!==record.planGenerationId||hash(result.files)!==hash(handoff.arguments.files.map(item=>item.path))))throw new HandoffError("review_remediation_result_invalid","Preflight must prove the accepted plan without mutation.");
    if(!failed&&handoff.stepType==="apply_patch"){
      const lineage=result.taskOwnedDirtyLineage;
      if(hash(result.files)!==hash(handoff.arguments.files.map(item=>item.path))||lineage?.version!==1||lineage.taskId!==task.id||lineage.repository!==record.repository||lineage.branch!==task.branch||lineage.currentCommit!==task.currentCommit||lineage.sourcePlanStepId!==record.planStepId||lineage.sourceApplyStepId!==record.applyStepId||hash(lineage.entries)!==hash(record.afterEntries.map(({path,contentHash})=>({path,contentHash}))))throw new HandoffError("review_remediation_result_invalid","Apply must refresh the complete eight-file dirty lineage.");
    }
    if(!failed&&["run_focused_tests","run_full_tests"].includes(handoff.stepType))validateReviewRemediationTestResult(record,task.metadata.selfDevelopmentImplementationPlan,result,{focused:handoff.stepType==="run_focused_tests"});
    return persistReviewRemediationResult(task,handoff,result,{failed,errorCode});
  }
  async function persistReviewRemediationResult(task,handoff,result,{failed=false,errorCode}={}){
    const descriptor=reviewRemediationDescriptor(task),history=task.metadata[descriptor.historyKey],record=history.at(-1),terminal=failed||handoff.stepType==="run_full_tests",now=nowIso(clock),boundary=terminal?{kind:failed?"product_repair_decision":"review_ready",executionAuthorized:false,reviewHash:record.reviewHash,planHash:record.planHash||null,planGenerationId:record.planGenerationId||null,stepId:handoff.stepId,errorCode:failed?errorCode||"worker_failed":null,findingsResolved:false,mutationApplied:failed?(typeof result.diagnostics?.mutationApplied==="boolean"?result.diagnostics.mutationApplied:null):false}:null;
    const completed=[...(task.checkpoint?.completedSteps||[]),...(!failed?[handoff.stepId]:[])],next=task.metadata.steps[task.currentStep+1];
    const updatedRecord={...record,...(!failed&&handoff.stepType==="validate_patch"?{validated:true,validatedAt:now}:{}),...(!failed&&handoff.stepType==="apply_patch"?{applyCompleted:true,applyCompletedAt:now,applyResultHash:hash(result)}:{}),...(!failed&&handoff.stepType==="run_focused_tests"?{focusedCompleted:true,focusedResultHash:hash(result)}:{}),...(terminal?{consumed:true,completedAt:now,result:failed?"failed":"full_tests_completed",boundary}:{})};
    const metadata={...task.metadata,localHandoff:null,completedHandoffs:[...(task.metadata.completedHandoffs||[]),...(handoff.id?[handoff.id]:[])],requiredCapability:terminal?null:next?.type==="plan_repair"?"reasoning":LOCAL_STEPS[next?.type]?.capability||null,[descriptor.historyKey]:[...history.slice(0,-1),updatedRecord],...(boundary?{[descriptor.boundaryKey]:boundary}:{})};
    const updated=await storage.updateAutonomyTask(task.id,ownerId,{status:terminal?"blocked":"queued",currentStep:failed?task.currentStep:task.currentStep+1,currentPhase:handoff.stepType,nextRunAt:terminal?null:now,errorCode:failed?errorCode||"worker_failed":null,blockedReason:terminal?(failed?"Review remediation stopped; a new owner decision is required. No retry or repair extension is authorized.":"Remediation tests passed; a fresh product review is required. Findings are not automatically resolved."):null,checkpoint:{...task.checkpoint,completedSteps:completed,pendingStep:null,latestResult:result},metadata,leaseOwner:null,leaseToken:null,leaseExpiresAt:null},task.stateVersion);
    if(!updated)throw new HandoffError("version_conflict","Task changed before its one-time remediation result was persisted.");
    await storage.updateAutonomyStep(task.id,handoff.stepId,{status:failed?"failed":"completed",result,errorCode:failed?errorCode||"worker_failed":null,completedAt:now});
    await storage.releaseAutonomyLocks(task.id,task.leaseToken);
    await activity(updated,terminal?"self_development_review_remediation_stopped":"self_development_review_remediation_advanced",updated.status,"One bounded remediation phase completed without widening scope or delivery authority.",{stepId:handoff.stepId,boundary});
    return{idempotent:false,status:updated.status,task:publicTask(updated)};
  }
  const stopReviewRemediation=(task,handoff,error)=>persistReviewRemediationResult(task,handoff,{message:error.message,diagnostics:{mutationApplied:null}},{failed:true,errorCode:error.code});
  async function finish(handoffId,input,{failed=false}={}){
    boundedString(handoffId,"handoffId");const taskId=boundedString(input?.taskId,"taskId"),workerId=boundedString(input?.workerId,"workerId"),idempotencyKey=boundedString(input?.idempotencyKey,"idempotencyKey");
    const task=await storage.getAutonomyTask(taskId,ownerId);if(!task)throw new HandoffError("handoff_not_found","Handoff was not found.",404);
    if((task.metadata?.completedHandoffs||[]).includes(handoffId))return{idempotent:true,task:publicTask(task)};
    const handoff=task.metadata?.localHandoff;if(!handoff||handoff.id!==handoffId||handoff.workerId!==workerId||handoff.idempotencyKey!==idempotencyKey)throw new HandoffError("handoff_mismatch","Handoff does not match the active task.",403);
    if(task.stateVersion!==handoff.expectedVersion)throw new HandoffError("version_conflict","Task changed while the local step was running.");
    if(task.branch!==handoff.branch||task.currentCommit!==handoff.expectedCommit)throw new HandoffError("task_binding_changed","Task branch or commit changed while the local step was running.");
    if(new Date(handoff.expiresAt)<=clock()){await recover(task,handoff,"local_worker_handoff_expired");throw new HandoffError("handoff_expired",handoff.executionScope||handoff.fullTestScope?"The single-use handoff expired and was stopped without retry.":"Handoff expired and was safely requeued.");}
    const result=redact(failed?input.error:input.result);if(!result||typeof result!=="object"||Array.isArray(result)||JSON.stringify(result).length>200000)throw new HandoffError("invalid_handoff_result","Structured bounded result is required.",400);
    if(!failed&&result.ok!==true)throw new HandoffError("invalid_handoff_result","Successful result must report ok=true.",400);
    if(!failed&&["commit","integrate_commit"].includes(handoff.stepType)&&!/^[a-f0-9]{40}$/.test(result.commitSha||""))throw new HandoffError("invalid_handoff_result","Commit result requires an exact SHA.",400);
    if(!failed&&["run_focused_tests","run_full_tests","inspect_diff","review_commit"].includes(handoff.stepType)&&result.exitCode!==0)throw new HandoffError("invalid_handoff_result","Successful local command result requires exitCode 0.",400);
    if(!failed&&handoff.stepType==="review_commit"&&(!result.reviewedChangeSet?.reviewHash||result.commitSha!==task.currentCommit))throw new HandoffError("invalid_handoff_result","Reviewed commit result must bind the exact task commit.",400);
    if(!failed&&handoff.tool==="repo_read_task_owned_local"&&(result.path!==handoff.arguments.path||result.contentHash!==handoff.arguments.expectedContentHash||typeof result.content!=="string"||result.truncated!==false))throw new HandoffError("invalid_handoff_result","Local read result does not match its task-owned binding.",400);
    if(!failed&&handoff.stepType==="apply_patch"){const allowed=new Set((handoff.arguments.files||[]).map(item=>item.path));if(!Array.isArray(result.files)||result.files.some(path=>!allowed.has(path)))throw new HandoffError("invalid_handoff_result","Patch result files do not match the server plan.",400);}
    if(reviewRemediationDescriptor(task))return finishReviewRemediation(task,handoff,result,{failed,errorCode:input.error?.code});
    let executionProof=null,fullTestProof=null;
    const fullTestDescriptor=fullTestScopeDescriptor(task);
    if(fullTestDescriptor){
      const record=task.metadata[fullTestDescriptor.historyKey]?.at(-1);
      fullTestProof=validateFullTestScopeContext(task,await storage.listAutonomySteps(task.id),{runtimeVersion:record.runtimeVersion,generationId:task.metadata?.activeContinuation?.generationId,repository:record.repository,root:record.workspaceRoot,branch:task.branch,workerId},clock);
      await fullTestApproval(task,record);
      if(handoff.executionScope||!handoff.fullTestScope||hash(handoff.fullTestScope)!==hash(fullTestScopePayload(record))||handoff.stepType!=="run_full_tests")throw new HandoffError("full_test_scope_context_changed","The full-test result must retain the exact owner-approved single-use binding.");
      const evidence=failed?result.diagnostics?.fullTestScopeEvidence:result.fullTestScopeEvidence;
      if((!failed||input.error?.code==="test_failed")&&(evidence?.generationId!==record.activeContinuation.generationId||evidence?.planHash!==record.planHash||hash(evidence?.entries)!==hash(record.entries)))throw new HandoffError("full_test_scope_result_invalid","The full-test result must prove all current product bytes remained unchanged.");
      const dependency=failed?result.diagnostics?.dependencyPreflight:result.dependencyPreflight;
      if(fullTestDescriptor.isRetry&&(!failed||input.error?.code==="test_failed")&&hash(dependency||null)!==hash({package:"@neondatabase/serverless",cwd:record.workspaceRoot,resolved:true}))throw new HandoffError("full_test_scope_result_invalid","A retry result must prove dependency resolution from the exact worker cwd.");
    }
    else if(task.metadata?.executionScopeRecoveryHistory?.length){
      const record=task.metadata.executionScopeRecoveryHistory.at(-1);
      executionProof=validateExecutionScopeContext(task,await storage.listAutonomySteps(task.id),{runtimeVersion:record.runtimeVersion,generationId:task.metadata?.activeContinuation?.generationId,repository:record.repository,root:record.workspaceRoot,branch:task.branch,workerId},clock);
      await executionApproval(task,record);
      if(!handoff.executionScope||hash(handoff.executionScope)!==hash({...executionScopePayload(record),workerId}))throw new HandoffError("execution_scope_context_changed","The completed handoff must retain its exact owner-approved execution context.");
      if(!failed&&(result.executionScopeEvidence?.generationId!==record.activeContinuation.generationId||result.executionScopeEvidence?.planHash!==record.planHash||hash(result.executionScopeEvidence?.entries)!==hash(record.afterEntries)))throw new HandoffError("execution_scope_result_invalid","Successful execution must prove the complete exact approved post-apply bytes.");
      if(!failed&&handoff.stepType==="apply_patch"){
        const lineage=result.taskOwnedDirtyLineage,expectedEntries=record.afterEntries.map(({path,contentHash})=>({path,contentHash}));
        if(hash(result.files)!==hash(handoff.arguments.files.map(file=>file.path))||lineage?.version!==1||lineage.taskId!==task.id||lineage.repository!==record.repository||lineage.branch!==task.branch||lineage.currentCommit!==task.currentCommit||lineage.sourcePlanStepId!==record.sourcePlanStepId||lineage.sourceApplyStepId!==record.applyStepId||hash(lineage.entries)!==hash(expectedEntries))throw new HandoffError("execution_scope_result_invalid","Apply must return the exact approved complete output lineage.");
      }
    }
    if(handoff.stepType==="validate_patch"){
      const record=task.metadata?.planningScopeRecoveryHistory?.at(-1);
      validatePlanningScopeContext(task,await storage.listAutonomySteps(task.id),{runtimeVersion:record?.runtimeVersion,generationId:task.metadata?.activeContinuation?.generationId,repository:record?.repository,root:record?.workspaceRoot,branch:task.branch,workerId},clock);
      if(!failed&&(result.preMutationValidated!==true||result.mutationApplied!==false||result.currentCommit!==task.currentCommit||result.planGenerationId!==handoff.arguments.planProvenance.generationId||hash(result.files)!==hash(handoff.arguments.files.map(file=>file.path))))throw new HandoffError("invalid_handoff_result","Read-only patch validation did not prove the exact accepted plan without mutation.",400);
    }
    const completed=[...(task.checkpoint?.completedSteps||[]),handoff.stepId],handoffHistory=[...(task.metadata?.completedHandoffs||[]),handoff.id],completedHandoffs=executionProof||fullTestProof?handoffHistory:handoffHistory.slice(-20),metadata={...task.metadata,localHandoff:null,completedHandoffs,requiredCapability:null};
    if(fullTestProof){
      const {record,history}=fullTestProof,diagnostics=result.diagnostics,productFailure=failed&&input.error?.code==="test_failed"&&diagnostics?.version===1&&diagnostics.identity?.command==="npm:test"&&Number.isInteger(diagnostics.counts?.failed)&&diagnostics.counts.failed>0&&!diagnostics.signal,status=!failed||productFailure?"blocked":"failed",errorCode=failed?(input.error?.code||"worker_failed"):null,postRunObservation=failed&&diagnostics?.verificationPhase==="post_run",boundary={kind:failed?(productFailure?"product_repair_decision":"full_test_infrastructure_failure"):"review_ready",executionAuthorized:false,mutationApplied:!failed||productFailure?false:typeof diagnostics?.mutationApplied==="boolean"?diagnostics.mutationApplied:null,...(postRunObservation?{verificationPhase:"post_run",workspaceDriftObserved:typeof diagnostics.workspaceDriftObserved==="boolean"?diagnostics.workspaceDriftObserved:null}:{}),planHash:record.planHash,planGenerationId:record.planGenerationId,stepId:handoff.stepId,errorCode};
      metadata[fullTestDescriptor.historyKey]=[...history.slice(0,-1),{...record,consumed:true,completedAt:nowIso(clock),result:failed?(productFailure?"test_failed":"infrastructure_failed"):"full_tests_completed",resultHash:hash(result),boundary}];metadata[fullTestDescriptor.boundaryKey]=boundary;
      const updated=await storage.updateAutonomyTask(task.id,ownerId,{status,currentStep:task.currentStep+1,currentPhase:"run_full_tests",nextRunAt:null,errorCode,blockedReason:failed?(productFailure?"Full-suite product failures recorded; product repair requires a new owner decision.":"The single-use full-test successor stopped at an infrastructure failure; no retry is authorized."):"Full tests passed; review is ready but has not been authorized or executed.",checkpoint:{...task.checkpoint,completedSteps:failed?(task.checkpoint?.completedSteps||[]):completed,pendingStep:null,latestResult:result},metadata,leaseOwner:null,leaseToken:null,leaseExpiresAt:null},task.stateVersion);
      if(!updated)throw new HandoffError("version_conflict","Task changed before its one-time full-test result could be recorded.");
      await storage.updateAutonomyStep(task.id,handoff.stepId,{status:failed?"failed":"completed",result,errorCode,completedAt:nowIso(clock)});await storage.releaseAutonomyLocks(task.id,task.leaseToken);
      await activity(updated,fullTestDescriptor.isRetry?"self_development_failed_full_test_retry_stopped":"self_development_full_test_scope_stopped",status,"The full-test-only successor stopped without any repair, review or delivery execution.",{handoffId,stepId:handoff.stepId,errorCode,boundary});
      return{idempotent:false,status,task:publicTask(updated)};
    }
    if(executionProof){
      const {record,history}=executionProof,isApply=handoff.stepType==="apply_patch",terminal=failed||!isApply,status=failed?"failed":isApply?"queued":"blocked",errorCode=failed?(input.error?.code||"worker_failed"):null,boundary=terminal?{kind:failed?"execution_failed":"focused_tests_completed",executionAuthorized:false,planHash:record.planHash,planGenerationId:record.planGenerationId,stepId:handoff.stepId,focusedTests:record.focusedTests,errorCode}:null;
      metadata.executionScopeRecoveryHistory=[...history.slice(0,-1),{...record,...(isApply&&!failed?{applyCompleted:true,applyCompletedAt:nowIso(clock),applyResultHash:hash(result)}:{}),...(terminal?{consumed:true,completedAt:nowIso(clock),result:failed?"failed":"focused_tests_completed",boundary}:{})}];
      if(boundary)metadata.executionScopeBoundary=boundary;
      metadata.requiredCapability=terminal?null:"test_local";
      const updated=await storage.updateAutonomyTask(task.id,ownerId,{status,currentStep:failed?task.currentStep:task.currentStep+1,currentPhase:handoff.stepType,nextRunAt:terminal?null:nowIso(clock),errorCode,blockedReason:terminal?(failed?"The single owner-approved execution successor failed; no automatic retry or repair is authorized.":"Approved apply and focused tests completed; further execution requires a new explicit authority."):null,checkpoint:{...task.checkpoint,completedSteps:failed?(task.checkpoint?.completedSteps||[]):completed,pendingStep:null,latestResult:result},metadata,leaseOwner:null,leaseToken:null,leaseExpiresAt:null},task.stateVersion);
      if(!updated)throw new HandoffError("version_conflict","Task changed before its single-use execution result was recorded.");
      await storage.updateAutonomyStep(task.id,handoff.stepId,{status:failed?"failed":"completed",result,errorCode,completedAt:nowIso(clock)});
      await storage.releaseAutonomyLocks(task.id,task.leaseToken);
      await activity(updated,terminal?"self_development_execution_scope_stopped":"self_development_execution_scope_applied",status,terminal?"The exact execution successor stopped without granting another attempt.":"The exact approved plan was applied once; only its bound focused tests remain.",{handoffId,stepId:handoff.stepId,planHash:record.planHash,errorCode,boundary});
      return{idempotent:false,status,task:publicTask(updated)};
    }
    if(!failed&&handoff.stepType==="validate_patch"){
      const history=metadata.planningScopeRecoveryHistory,record=history.at(-1),focusedTests=(metadata.selfDevelopmentImplementationPlan?.focusedTests||[]).map(item=>item.path);
      if(!focusedTests.length||focusedTests.some(path=>!record.requiredPaths.includes(path)))throw new HandoffError("planning_scope_precondition_failed","Focused scheduling would exceed the unchanged implementation scope.");
      const boundary={kind:"focused_test_scheduling_ready",tool:"test_run",arguments:{files:focusedTests},executionAuthorized:false,mutationApplied:false,planGenerationId:result.planGenerationId,validatedStepId:handoff.stepId};
      metadata.planningScopeRecoveryHistory=[...history.slice(0,-1),{...record,consumed:true,completedAt:nowIso(clock),boundary}];metadata.planningScopeBoundary=boundary;
      const updated=await storage.updateAutonomyTask(task.id,ownerId,{status:"blocked",currentStep:task.currentStep+1,currentPhase:"validate_patch",nextRunAt:null,errorCode:null,blockedReason:"Planning complete: exact patch preconditions validated without mutation; focused tests prepared but not executed.",checkpoint:{...task.checkpoint,completedSteps:completed,pendingStep:null,latestResult:result},metadata,leaseOwner:null,leaseToken:null,leaseExpiresAt:null},task.stateVersion);
      if(!updated)throw new HandoffError("version_conflict","Task changed before the planning boundary was persisted.");
      await storage.updateAutonomyStep(task.id,handoff.stepId,{status:"completed",result,errorCode:null,completedAt:nowIso(clock)});await storage.releaseAutonomyLocks(task.id,task.leaseToken);
      await activity(updated,"self_development_planning_scope_ready","blocked","Planning-only continuation reached the exact pre-mutation and focused-test scheduling boundary.",{handoffId,stepId:handoff.stepId,boundary});
      return{idempotent:false,status:"blocked",task:publicTask(updated)};
    }
    if(failed){
      const failureEvidence=input.error?.code==="schema_mismatch"?canonicalSchemaDiagnostic({...result.diagnostics,taskId:task.id,handoffId:handoff.id,stepId:handoff.stepId,stepType:handoff.stepType,tool:handoff.tool}):result.diagnostics;if(input.error?.code==="schema_mismatch")result.diagnostics=failureEvidence;
      const structuredFullFailure=task.taskType==="self_development"&&handoff.stepType==="run_full_tests"&&input.error?.code==="test_failed"&&failureEvidence?.version===1&&typeof failureEvidence.fingerprint==="string";
      let retryable=RETRYABLE.has(input.error?.code),retry=task.retryCount+1,status=retryable&&retry<=task.maxRetries?"retrying":"failed",failureMetadata=metadata,currentStep=task.currentStep,nextRunAt=retryable?new Date(clock().getTime()+1000).toISOString():null,errorCode=input.error?.code||"worker_failed";
      if(structuredFullFailure){
        const history=task.metadata?.fullTestRepairHistory||[],duplicate=history.some(item=>item.fingerprint===failureEvidence.fingerprint),iteration=history.length,maxIterations=Math.min(2,task.metadata?.selfDevelopment?.repairLimit??task.repairLimit??2);
        if(!duplicate&&iteration<maxIterations){
          const base=task.metadata.steps.length,paths=(task.metadata?.selfDevelopmentImplementationPlan?.files||[]).map(file=>file.path),remaining=task.metadata.steps.slice(task.currentStep+1),repairSteps=[
            {type:"plan_repair",input:{tool:"self_development_plan_implementation",arguments:{taskId:task.id,candidatePaths:paths,currentCommit:"$CURRENT_COMMIT",failureEvidence}},idempotencyIdentity:`full-test-repair:${failureEvidence.fingerprint}`},
            {type:"apply_patch",input:{tool:"repo_apply_patch",arguments:{branch:"$TASK_BRANCH",currentCommit:"$CURRENT_COMMIT",files:"$IMPLEMENTATION_FILES",planProvenance:"$IMPLEMENTATION_PLAN_PROVENANCE"}},idempotencyIdentity:`full-test-repair-patch:${failureEvidence.fingerprint}`},
            {type:"run_focused_tests",input:{tool:"test_run",arguments:{files:"$IMPLEMENTATION_TESTS"}},idempotencyIdentity:`full-test-repair-focused:${failureEvidence.fingerprint}`},
            {type:"run_full_tests",input:{tool:"test_run_full",arguments:{}},idempotencyIdentity:`full-test-repair-full:${failureEvidence.fingerprint}`},...remaining];
          failureMetadata={...metadata,steps:[...task.metadata.steps,...repairSteps],fullTestRepairHistory:[...history,{fingerprint:failureEvidence.fingerprint,iteration:iteration+1,failedStepId:handoff.stepId,recordedAt:nowIso(clock)}],activeContinuation:createActiveContinuation({task,startStep:base,plannedSteps:repairSteps.length,repairLimit:maxIterations,recoveryClass:"structured_full_test_repair",runtimeStartedAt:nowIso(clock),runtimeMinutes:15}),requiredCapability:"reasoning",autoDispatch:true};
          currentStep=base;status="queued";nextRunAt=nowIso(clock);errorCode:null;
        }else{status="failed";nextRunAt=null;errorCode="repair_limit_reached";}
      }
      const updated=await storage.updateAutonomyTask(task.id,ownerId,{status,currentStep,retryCount:retry,errorCode,nextRunAt,metadata:failureMetadata,leaseOwner:null,leaseToken:null,leaseExpiresAt:null},task.stateVersion);if(!updated)throw new HandoffError("version_conflict","Task changed before failure could be persisted.");await storage.updateAutonomyStep(task.id,handoff.stepId,{status:"failed",result,errorCode:input.error?.code||"worker_failed",completedAt:nowIso(clock)});await storage.releaseAutonomyLocks(task.id,task.leaseToken);await activity(updated,structuredFullFailure&&status==="queued"?"self_development_full_test_repair_scheduled":"local_worker_handoff_failed",status,structuredFullFailure&&status==="queued"?"Structured full-suite failure evidence scheduled a bounded autonomous repair.":"Controlled local step failed.",{handoffId,stepId:handoff.stepId,errorCode:input.error?.code,failureEvidence});return{idempotent:false,status};}
    const commitSha=result.commitSha||task.currentCommit;let status=handoff.stepType==="push"?"completed":"queued",approvalState=null;
    if(handoff.stepType==="push"&&(result.commitSha!==task.currentCommit||result.branch!==task.branch))throw new HandoffError("invalid_handoff_result","Push result must bind the exact approved commit and branch.",400);
    const nextPlanned=task.metadata?.steps?.[task.currentStep+1];if(handoff.stepType==="review_commit"||(handoff.stepType==="commit"&&nextPlanned?.type!=="review_commit")){
      const exactSelfDevelopment=task.taskType==="self_development",repository=task.metadata?.selfDevelopment?.repository,approvedStateVersion=task.stateVersion+1,args={...(exactSelfDevelopment?{repository,approvedStateVersion}:{}),branch:task.branch,commitSha};const approval=await storage.createApproval({id:randomUUID(),ownerId,projectId:task.projectId,runId:task.id,tool:"git_push",reason:"Owner approval is required to push the exact local Worker commit.",riskLevel:"SENSITIVE",arguments:args});status="waiting_for_approval";approvalState={approvalId:approval.id,tool:"git_push",arguments:args,...(exactSelfDevelopment?{repository,approvedStateVersion,bindingSource:"approval_contract"}:{}),branch:task.branch,commitSha,stepId:`${task.currentStep+2}:push`};
      await activity(task,"autonomy_approval_requested","waiting","Task paused for exact public-push approval.",{approvalId:approval.id,commitSha,branch:task.branch});
    }
    if(handoff.stepType==="push")metadata.approvedDeliveryRuntime={...metadata.approvedDeliveryRuntime,consumed:true,consumedAt:nowIso(clock)};
    const updated=await storage.updateAutonomyTask(task.id,ownerId,{status,currentStep:task.currentStep+1,currentPhase:handoff.stepType,currentCommit:commitSha,nextRunAt:status==="completed"?null:nowIso(clock),completedAt:status==="completed"?nowIso(clock):null,checkpoint:{...task.checkpoint,completedSteps:completed,pendingStep:null,latestResult:result},metadata,approvalState,blockedReason:status==="waiting_for_approval"?"Owner approval required.":null,errorCode:null,leaseOwner:null,leaseToken:null,leaseExpiresAt:null},task.stateVersion);
    if(!updated)throw new HandoffError("version_conflict","Task changed before the result could be persisted.");
    await storage.updateAutonomyStep(task.id,handoff.stepId,{status:"completed",result,errorCode:null,completedAt:nowIso(clock)});
    await storage.releaseAutonomyLocks(task.id,task.leaseToken);await activity(updated,"local_worker_handoff_completed","completed",`${handoff.stepType} completed by the controlled local worker.`,{handoffId,stepId:handoff.stepId,commitSha:result.commitSha});
    return{idempotent:false,status,task:publicTask(updated)};
  }
  async function recover(task,handoff,action){
    if(handoff.reviewRemediationScope)return stopReviewRemediation(task,handoff,{code:"review_remediation_handoff_expired",message:"The single-use remediation handoff expired."});
    if(handoff.fullTestScope){
      const descriptor=fullTestScopeDescriptor(task),history=descriptor?task.metadata?.[descriptor.historyKey]||[]:[],record=history.at(-1);
      if(!record||handoff.fullTestScope.recoveryClass!==descriptor.recoveryClass||record.workerId!==handoff.workerId||record.fullTestStepId!==handoff.stepId)throw new HandoffError("full_test_scope_context_changed","Expired full-test context no longer matches its durable authority.");
      const boundary={kind:"full_test_infrastructure_failure",executionAuthorized:false,mutationApplied:null,workspaceDriftObserved:null,verificationPhase:"post_run_unavailable",planHash:record.planHash,stepId:handoff.stepId,errorCode:"full_test_scope_handoff_expired"},updated=await storage.updateAutonomyTask(task.id,ownerId,{status:"failed",nextRunAt:null,errorCode:boundary.errorCode,blockedReason:"The one-time full-test handoff expired; automatic retry is forbidden.",metadata:{...task.metadata,localHandoff:null,[descriptor.boundaryKey]:boundary,[descriptor.historyKey]:[...history.slice(0,-1),{...record,consumed:true,completedAt:nowIso(clock),result:"infrastructure_failed",boundary}]},leaseOwner:null,leaseToken:null,leaseExpiresAt:null},task.stateVersion);
      if(!updated)throw new HandoffError("version_conflict","Task changed before the expired full-test execution was stopped.");
      await storage.updateAutonomyStep(task.id,handoff.stepId,{status:"failed",errorCode:boundary.errorCode,result:{code:boundary.errorCode},completedAt:nowIso(clock)});await storage.releaseAutonomyLocks(task.id,task.leaseToken);await activity(updated,action,"failed","Expired full-test successor stopped without another attempt.",{handoffId:handoff.id,stepId:handoff.stepId});return updated;
    }
    if(handoff.executionScope){
      const history=task.metadata?.executionScopeRecoveryHistory||[],record=history.at(-1);
      if(!record||record.workerId!==handoff.workerId||![record.applyStepId,record.testStepId].includes(handoff.stepId))throw new HandoffError("execution_scope_context_changed","Expired execution context no longer matches its durable single-use record.");
      const boundary={kind:"execution_failed",executionAuthorized:false,planHash:record.planHash,stepId:handoff.stepId,errorCode:"execution_scope_handoff_expired"},updated=await storage.updateAutonomyTask(task.id,ownerId,{status:"failed",nextRunAt:null,errorCode:boundary.errorCode,blockedReason:"The single-use execution handoff expired; retry requires a new explicit authority.",metadata:{...task.metadata,localHandoff:null,executionScopeBoundary:boundary,executionScopeRecoveryHistory:[...history.slice(0,-1),{...record,consumed:true,completedAt:nowIso(clock),result:"failed",boundary}]},leaseOwner:null,leaseToken:null,leaseExpiresAt:null},task.stateVersion);
      if(!updated)throw new HandoffError("version_conflict","Task changed before the expired execution was stopped.");
      await storage.updateAutonomyStep(task.id,handoff.stepId,{status:"failed",errorCode:boundary.errorCode,result:{code:boundary.errorCode},completedAt:nowIso(clock)});await storage.releaseAutonomyLocks(task.id,task.leaseToken);await activity(updated,action,"failed","Expired single-use execution stopped without requeue or counter reset.",{handoffId:handoff.id,stepId:handoff.stepId});return updated;
    }
    await storage.releaseAutonomyLocks(task.id,task.leaseToken);await storage.releaseAutonomyLease(task.id,ownerId,task.leaseToken);const updated=await storage.updateAutonomyTask(task.id,ownerId,{status:"queued",nextRunAt:nowIso(clock),metadata:{...task.metadata,localHandoff:null},blockedReason:null,errorCode:"worker_crash"});await activity(updated,action,"retrying","Expired local Worker handoff was safely requeued.",{handoffId:handoff.id,stepId:handoff.stepId});return updated;
  }
  const inspect=async(handoffId,taskId)=>{const task=await storage.getAutonomyTask(taskId,ownerId),handoff=task?.metadata?.localHandoff;if(!handoff||handoff.id!==handoffId)throw new HandoffError("handoff_not_found","Handoff was not found.",404);return{handoffId,taskId,status:task.status,stepId:handoff.stepId,stepType:handoff.stepType,deadline:handoff.expiresAt};};
  return Object.freeze({claim,complete:(id,input)=>finish(id,input),fail:(id,input)=>finish(id,input,{failed:true}),inspect});
}
function publicTask(task){return{id:task.id,status:task.status,currentStep:task.currentStep,currentPhase:task.currentPhase,currentCommit:task.currentCommit,branch:task.branch,stateVersion:task.stateVersion,approvalState:task.approvalState?{tool:task.approvalState.tool,branch:task.approvalState.branch,commitSha:task.approvalState.commitSha}:null};}
