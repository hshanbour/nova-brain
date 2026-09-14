import {createHash} from "node:crypto";
import {canonicalContentHash,createActiveContinuation} from "./self-development-plan-lifecycle.js";

export const FAILED_LOCAL_READ_RECOVERY_CLASS="failed_task_owned_local_read_recovery";
const SHA=/^[a-f0-9]{40}$/,HASH=/^[a-f0-9]{64}$/;
const WORKER=/^persistent-local-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ordinal=step=>Number.parseInt(step?.stepId,10);
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
export const recoveryHash=value=>createHash("sha256").update(JSON.stringify(stable(value))??"undefined").digest("hex");
export const recoveryRoot=value=>{
  const root=String(value||"").replaceAll("\\","/").replace(/\/+$/,"");
  if(!root||root.split("/").some(part=>part===".."||part==="."))return "";
  return /^[a-z]:\//i.test(root)?root.toLowerCase():root;
};
function requireProof(value,predicate){
  if(!value)throw Object.assign(new Error(`Failed local-read recovery rejected: ${predicate}.`),{code:"failed_local_read_recovery_precondition_failed",statusCode:409,safeDiagnostics:{predicate,mutationApplied:false}});
}
const same=(a,b)=>recoveryHash(a)===recoveryHash(b);
function entries(value){
  requireProof(Array.isArray(value)&&value.length>0&&value.length<=12,"dirty_entries");
  const result=value.map(item=>({path:item.path,contentHash:item.contentHash})).sort((a,b)=>String(a.path).localeCompare(String(b.path)));
  requireProof(new Set(result.map(item=>item.path)).size===result.length&&result.every(item=>typeof item.path==="string"&&/^[a-z0-9._/-]+$/i.test(item.path)&&!item.path.startsWith("/")&&!item.path.split("/").some(part=>part===".."||part===".")&&HASH.test(item.contentHash||"")),"dirty_entries_shape");
  return result;
}
function completeLineage(task,steps){
  const partial=task.metadata?.partialRepairPlanRecoveryHistory?.at(-1);
  const apply=steps.filter(step=>step.stepType==="apply_patch"&&step.status==="completed").sort((a,b)=>ordinal(a)-ordinal(b)).at(-1);
  const plan=steps.filter(step=>["plan_repair","plan_implementation"].includes(step.stepType)&&step.status==="completed"&&ordinal(step)<ordinal(apply)).sort((a,b)=>ordinal(a)-ordinal(b)).at(-1);
  const lineage=apply?.result?.taskOwnedDirtyLineage;
  requireProof(partial?.taskId===task.id&&partial.repository===task.metadata?.selfDevelopment?.repository&&partial.branch===task.branch&&partial.currentCommit===task.currentCommit&&recoveryRoot(partial.workspaceRoot),"partial_workspace_binding");
  requireProof(lineage?.version===1&&lineage.taskId===task.id&&lineage.repository===partial.repository&&lineage.branch===task.branch&&lineage.currentCommit===task.currentCommit&&(Object.hasOwn(lineage,"sourceApplyStepId")?lineage.sourceApplyStepId:apply?.stepId)===apply?.stepId&&lineage.sourcePlanStepId===plan?.stepId&&partial.sourceApplyStepId===apply?.stepId&&partial.sourcePlanStepId===plan?.stepId&&HASH.test(apply?.operationFingerprint||"")&&HASH.test(partial.fingerprint||"")&&(!Object.hasOwn(partial,"sourceApplyFingerprint")||partial.sourceApplyFingerprint===apply.operationFingerprint),"completed_apply_lineage");
  const current=entries(lineage.entries),prior=entries(partial.entries);
  requireProof(same(current,prior)&&Array.isArray(partial.requiredPaths)&&new Set(partial.requiredPaths).size===partial.requiredPaths.length&&same([...partial.requiredPaths].sort(),current.map(item=>item.path).sort()),"complete_dirty_set");
  return{partial,apply,plan,entries:current};
}
function currentReads(task,steps,record,{rereadStaleRemote=false}={}){
  const reads=new Map(),readStepIds=new Map(),staleRemotePaths=[];
  for(const entry of record.entries){
    const read=steps.filter(step=>step.stepType==="read_files"&&step.status==="completed"&&(step.result?.path||step.input?.arguments?.path)===entry.path).sort((a,b)=>ordinal(a)-ordinal(b)).at(-1);
    if(!read)continue;
    const valid=ordinal(read)>Number.parseInt(record.sourceApplyStepId,10)&&read.result?.truncated===false&&typeof read.result.content==="string"&&canonicalContentHash(read.result.content)===entry.contentHash&&(!read.result.contentHash||read.result.contentHash===entry.contentHash);
    // Historical remote reads can be complete yet contain the branch-tip bytes,
    // not this task's dirty output. Never reuse them as current evidence.
    if(!valid&&rereadStaleRemote&&read.input?.tool==="repo_read"&&ordinal(read)>Number.parseInt(record.sourceApplyStepId,10)&&read.result?.truncated===false&&typeof read.result.content==="string"){staleRemotePaths.push(entry.path);continue;}
    requireProof(valid,"current_complete_read");
    reads.set(entry.path,read.result.content);readStepIds.set(entry.path,read.stepId);
  }
  return{reads,readStepIds,staleRemotePaths};
}

// A distinct, operator-invoked infrastructure transition. It neither renews the
// predecessor window nor makes this error automatically retryable.
export async function recoverFailedLocalRead({taskId,input,actor,runtime,storage,ownerId,repository,approvedBranch,runtimeVersion,verifyRemote,clock}){
  const allowed=["expectedVersion","runtimeVersion","workspaceProof","workspaceProofSignature"];
  requireProof(input&&Object.keys(input).every(key=>allowed.includes(key))&&Number.isInteger(input.expectedVersion),"request_shape");
  const proof=input.workspaceProof,workspace=proof?.workspace;
  requireProof(actor?.actorType==="scoped_local_worker"&&actor.workspaceProof&&same(actor.workspaceProof,proof)&&proof.taskId===taskId&&proof.expectedVersion===input.expectedVersion&&proof.runtimeVersion===input.runtimeVersion&&Object.keys(proof).every(key=>["taskId","expectedVersion","runtimeVersion","workspace"].includes(key)),"authenticated_workspace_proof");
  requireProof(SHA.test(runtimeVersion||"")&&input.runtimeVersion===runtimeVersion,"active_runtime");
  const task=await runtime.get(taskId);
  requireProof(task?.id===taskId&&task.taskType==="self_development","task_identity");
  const history=task.metadata?.failedLocalReadRecoveryHistory||[];
  if(history.length){
    const prior=history.at(-1);
    requireProof(history.length===1&&prior.fromStateVersion===input.expectedVersion&&prior.requestHash===recoveryHash(proof)&&prior.runtimeVersion===runtimeVersion&&task.stateVersion===prior.toStateVersion&&task.status==="waiting_for_worker"&&!task.leaseToken&&!task.leaseOwner&&!task.metadata.localHandoff&&prior.workerBindingState==="awaiting_worker_bind"&&same(task.metadata.activeContinuation,prior.activeContinuation),"bounded_recovery_replay");
    return{task,recovery:prior,idempotent:true};
  }
  requireProof(task.stateVersion===input.expectedVersion&&task.status==="failed"&&task.currentPhase==="read_files"&&task.errorCode==="task_owned_local_read_unproven"&&!task.leaseOwner&&!task.leaseToken&&!task.metadata?.localHandoff&&!task.approvalState,"failed_task_state");
  requireProof(task.branch===approvedBranch&&task.metadata?.selfDevelopment?.repository===repository&&SHA.test(task.currentCommit||"")&&task.currentCommit===task.startingCommit,"product_identity");
  const steps=await runtime.steps(taskId),failed=steps.find(step=>step.stepId===`${task.currentStep+1}:read_files`);
  requireProof(failed?.result?.mutationApplied!==true&&failed?.taskId===taskId&&failed.stepType==="read_files"&&failed.status==="failed"&&failed.attempt===1&&failed.errorCode===task.errorCode&&failed.input?.tool==="repo_read_task_owned_local"&&failed.result?.message==="The task-owned local read binding is invalid."&&HASH.test(failed.operationFingerprint||"")&&!steps.some(step=>ordinal(step)>ordinal(failed)),"failed_local_execution");
  const lineage=completeLineage(task,steps),{partial,apply}=lineage;
  const active=task.metadata.activeContinuation,continuation=task.metadata.continuationHistory?.at(-1),recovery=task.metadata.implementationPlanRecoveryHistory?.at(-1),renewals=task.metadata.continuationRuntimeResumeHistory||[],renewal=renewals.at(-1);
  const original=task.metadata.continuationHistory?.find(item=>item.generationId===active?.generationId&&item.runtimeStartedAt===recovery?.recoveredAt);
  requireProof(active?.recoveryClass==="task_owned_local_read_recovery"&&HASH.test(active.generationId||"")&&active.startStep===task.currentStep&&same(active,continuation)&&recovery?.recoveryClass===active.recoveryClass&&original?.recoveryClass===active.recoveryClass&&original.startStep===active.startStep&&original.maxSteps===active.maxSteps&&SHA.test(recovery.runtimeVersion||"")&&recovery.fingerprint===partial.fingerprint&&recovery.sourcePlanStepId===apply.result.taskOwnedDirtyLineage.sourcePlanStepId&&recovery.sourceApplyStepId===apply.stepId&&task.metadata.continuationHistory.some(item=>same(item,partial.activeContinuation)),"predecessor_generation");
  requireProof(renewals.length===1&&renewal.sourceRecoveryClass===active.recoveryClass&&renewal.continuationGenerationId===active.generationId&&renewal.authorizationConsumed===true&&renewal.maxRenewals===1&&renewal.workerBindingState==="bound"&&WORKER.test(renewal.workerId||"")&&renewal.fromStateVersion===recovery.previousStateVersion+1&&renewal.runtimeWindow?.runtimeStartedAt===active.runtimeStartedAt&&renewal.runtimeWindow?.runtimeDeadline===active.runtimeDeadline&&Date.parse(active.runtimeDeadline)<=clock().getTime()&&renewal.repository===repository&&renewal.branch===task.branch&&renewal.currentCommit===task.currentCommit&&recoveryRoot(renewal.workspaceRoot)===recoveryRoot(partial.workspaceRoot)&&renewal.sourcePlanStepId===partial.sourcePlanStepId&&renewal.sourceApplyStepId===apply.stepId&&renewal.sourceApplyFingerprint===apply.operationFingerprint&&renewal.fingerprint===partial.fingerprint&&SHA.test(renewal.runtimeVersion||"")&&runtimeVersion!==renewal.runtimeVersion,"expired_consumed_predecessor");
  const extensionHistory=task.metadata.escalatedRepairHistory||[],extension=extensionHistory.at(-1),approval=extension?.approvalId?await storage.getApproval(extension.approvalId,ownerId):null,args=approval?.arguments;
  requireProof(extensionHistory.length===1&&extension.recoveryClass==="owner_approved_single_repair_extension"&&extension.maxAdditionalAttempts===1&&Number.isInteger(extension.globalRepairLimit)&&extension.previousRepairIteration===extension.globalRepairLimit&&task.repairIteration===extension.globalRepairLimit&&approval?.status==="approved"&&approval.tool==="self_development_escalated_repair"&&args?.taskId===task.id&&args.expectedVersion===extension.fromStateVersion&&args.branch===task.branch&&args.currentCommit===task.currentCommit&&args.failedStepId===extension.failedStepId&&args.failureFingerprint===extension.failureFingerprint&&args.planGenerationId===extension.planGenerationId&&args.maxAdditionalAttempts===1,"consumed_repair_extension");
  const remaining=task.metadata.steps.slice(task.currentStep),readSteps=[];
  for(const step of remaining){if(step.type!=="read_files")break;readSteps.push(step);}
  const originalReadPaths=readSteps.map(step=>step.input?.arguments?.path),readPaths=[...originalReadPaths],planner=remaining[readSteps.length];
  requireProof(readPaths.length>0&&readPaths.length<=12&&new Set(readPaths).size===readPaths.length&&readSteps.every(step=>step.input?.tool==="repo_read_task_owned_local"&&Object.keys(step.input.arguments||{}).every(key=>key==="path"))&&readPaths[0]===failed.input.arguments?.path&&readPaths.every(path=>partial.requiredPaths.includes(path))&&same(readPaths,renewal.remainingReadPaths)&&same(readPaths,recovery.readPaths)&&remaining.length<=21&&planner?.type==="plan_repair"&&planner.input?.tool==="self_development_plan_implementation"&&planner.input.arguments?.taskId===taskId&&same(planner.input.arguments.candidatePaths,partial.requiredPaths)&&planner.input.arguments.failureEvidence?.fingerprint===partial.fingerprint&&planner.input.arguments.failureEvidence?.sourcePlanStepId===partial.sourcePlanStepId&&planner.input.arguments.failureEvidence?.sourceApplyStepId===apply.stepId,"remaining_read_plan");
  // Paths already scheduled for a new read cannot contribute carried evidence;
  // obsolete discovery reads for them are neither reused nor required to pass.
  const complete=currentReads(task,steps,{entries:lineage.entries.filter(entry=>!originalReadPaths.includes(entry.path)),sourceApplyStepId:apply.stepId},{rereadStaleRemote:true});
  const refreshedReadPaths=complete.staleRemotePaths.filter(path=>!readPaths.includes(path));
  readPaths.push(...refreshedReadPaths);
  requireProof(partial.requiredPaths.every(path=>readPaths.includes(path)!==complete.reads.has(path)),"completed_read_partition");
  requireProof(workspace&&Object.keys(workspace).every(key=>["root","gitTopLevel","repository","branch","head","liveTip","clean","changedFiles"].includes(key))&&recoveryRoot(workspace.root)===recoveryRoot(partial.workspaceRoot)&&recoveryRoot(workspace.gitTopLevel)===recoveryRoot(partial.workspaceRoot)&&workspace.repository===repository&&workspace.branch===task.branch&&workspace.head===task.currentCommit&&workspace.liveTip===task.currentCommit&&workspace.clean===false&&same(entries(workspace.changedFiles),lineage.entries)&&workspace.changedFiles.every(item=>{const expected=partial.entries.find(entry=>entry.path===item.path);return item.hashAlgorithm==="git_sha1"&&SHA.test(item.hash||"")&&(!Object.hasOwn(expected,"hash")||expected.hashAlgorithm==="git_sha1"&&item.hash===expected.hash);}),"current_workspace");
  requireProof(typeof verifyRemote==="function","remote_verifier");
  const product=await verifyRemote({repository,branch:task.branch,requiredAncestors:[task.currentCommit]});
  const control=await verifyRemote({repository,branch:"stage13/control-plane-approved-delivery-runtime",requiredAncestors:[renewal.runtimeVersion,runtimeVersion]});
  requireProof(product?.currentTip===task.currentCommit&&product.ancestors?.[task.currentCommit]===true,"live_product_tip");
  requireProof(control?.currentTip===runtimeVersion&&control.ancestors?.[runtimeVersion]===true&&control.ancestors?.[renewal.runtimeVersion]===true,"runtime_transition");
  const base=task.metadata.steps.length,now=clock().toISOString();
  const refreshedReads=refreshedReadPaths.map(path=>({type:"read_files",capability:"repo_read_remote",input:{tool:"repo_read_task_owned_local",arguments:{path}}}));
  const nextSteps=[...readSteps,...refreshedReads,...remaining.slice(readSteps.length)].map((step,index)=>({...step,idempotencyIdentity:`failed-local-read:${task.id}:${task.stateVersion}:${base+index+1}:${failed.operationFingerprint}`}));
  requireProof(nextSteps.length<=30,"bounded_successor_steps");
  const next=createActiveContinuation({task,startStep:base,plannedSteps:nextSteps.length,repairLimit:0,recoveryClass:FAILED_LOCAL_READ_RECOVERY_CLASS,runtimeStartedAt:now,runtimeMinutes:15});
  const record={recoveryClass:FAILED_LOCAL_READ_RECOVERY_CLASS,taskId,fromStateVersion:task.stateVersion,toStateVersion:task.stateVersion+1,maxRecoveries:1,failedStepId:failed.stepId,failedAttempt:failed.attempt,failedExecutionFingerprint:failed.operationFingerprint,predecessorGenerationId:active.generationId,predecessorRenewalHash:recoveryHash(renewal),predecessorRecoveryHash:recoveryHash(recovery),requestHash:recoveryHash(proof),repository,branch:task.branch,currentCommit:task.currentCommit,workspaceRoot:recoveryRoot(workspace.root),runtimeVersion,sourcePlanStepId:partial.sourcePlanStepId,sourceApplyStepId:apply.stepId,sourceApplyFingerprint:apply.operationFingerprint,fingerprint:partial.fingerprint,entries:lineage.entries,requiredPaths:partial.requiredPaths,readPaths,originalRemainingReadPaths:originalReadPaths,refreshedReadPaths,extensionHistoryHash:recoveryHash(extensionHistory),repairIteration:task.repairIteration,retryCount:task.retryCount,maxRetries:task.maxRetries,workerBindingState:"awaiting_worker_bind",workerId:null,rejectedPriorWorkerIds:[...new Set([renewal.workerId,...(renewal.rejectedPriorWorkerIds||[])])],activeContinuation:next,recoveredAt:now};
  const updated=await storage.updateAutonomyTask(taskId,ownerId,{status:"waiting_for_worker",currentStep:base,currentPhase:"read_files",nextRunAt:now,startedAt:now,completedAt:null,errorCode:null,blockedReason:null,checkpoint:{...task.checkpoint,pendingStep:null},metadata:{...task.metadata,steps:[...task.metadata.steps,...nextSteps],activeContinuation:next,continuationHistory:[...(task.metadata.continuationHistory||[]),next],failedLocalReadRecoveryHistory:[record],requiredCapability:"repo_read_remote",autoDispatch:true}},task.stateVersion);
  requireProof(updated,"recovery_compare_and_swap");
  await storage.appendActivity({ownerId,projectId:task.projectId,runId:taskId,action:"self_development_failed_local_read_recovered",status:"waiting_for_worker",summary:"A bounded failed local-read infrastructure successor was created; predecessor authority remains historical.",metadata:record});
  return{task:updated,recovery:record,idempotent:false};
}

function recoveredRecord(task,steps){
  const history=task.metadata?.failedLocalReadRecoveryHistory||[],record=history.at(-1),active=task.metadata?.activeContinuation;
  requireProof(history.length===1&&record?.recoveryClass===FAILED_LOCAL_READ_RECOVERY_CLASS&&record.maxRecoveries===1&&record.taskId===task.id&&record.repository===task.metadata?.selfDevelopment?.repository&&record.branch===task.branch&&record.currentCommit===task.currentCommit&&record.currentCommit===task.startingCommit&&same(record.activeContinuation,active)&&same(active,task.metadata.continuationHistory?.at(-1))&&SHA.test(record.runtimeVersion||"")&&task.currentStep>=active.startStep&&task.currentStep<=active.startStep+active.maxSteps,"successor_generation");
  const {partial,apply,entries:current}=completeLineage(task,steps);
  requireProof(record.fingerprint===partial.fingerprint&&record.sourcePlanStepId===partial.sourcePlanStepId&&record.sourceApplyStepId===apply.stepId&&record.sourceApplyFingerprint===apply.operationFingerprint&&recoveryRoot(record.workspaceRoot)===recoveryRoot(partial.workspaceRoot)&&same(record.entries,current)&&same(record.requiredPaths,partial.requiredPaths),"successor_lineage");
  requireProof(recoveryHash(task.metadata.continuationRuntimeResumeHistory?.at(-1))===record.predecessorRenewalHash&&recoveryHash(task.metadata.implementationPlanRecoveryHistory?.at(-1))===record.predecessorRecoveryHash&&recoveryHash(task.metadata.escalatedRepairHistory)===record.extensionHistoryHash&&task.repairIteration===record.repairIteration,"preserved_authority");
  const failed=steps.find(step=>step.stepId===record.failedStepId);
  requireProof(failed?.status==="failed"&&failed.attempt===record.failedAttempt&&failed.operationFingerprint===record.failedExecutionFingerprint&&failed.errorCode==="task_owned_local_read_unproven","preserved_failed_execution");
  return{record,history};
}
export function validateRecoveredLocalReadContext(task,steps,context,clock=()=>new Date()){
  const {record,history}=recoveredRecord(task,steps),firstBind=context.allowFirstBind===true&&record.workerBindingState==="awaiting_worker_bind"&&record.workerId===null;
  requireProof(context.runtimeVersion===record.runtimeVersion&&context.generationId===record.activeContinuation.generationId&&context.repository===record.repository&&context.branch===record.branch&&recoveryRoot(context.root)===recoveryRoot(record.workspaceRoot)&&Date.parse(record.activeContinuation.runtimeDeadline)>clock().getTime(),"worker_context");
  requireProof(WORKER.test(context.workerId||"")&&!record.rejectedPriorWorkerIds.includes(context.workerId)&&(firstBind||record.workerBindingState==="bound"&&record.workerId===context.workerId),"worker_succession");
  return{record,history,firstBind};
}
export function validateRecoveredReadEvidence(task,steps){
  const {record}=recoveredRecord(task,steps);
  requireProof(record.workerBindingState==="bound"&&WORKER.test(record.workerId||""),"planner_bound_worker");
  const proof=currentReads(task,steps,record);
  requireProof(proof.reads.size===record.requiredPaths.length&&record.readPaths.every(path=>Number.parseInt(proof.readStepIds.get(path),10)>record.activeContinuation.startStep),"all_current_complete_reads");
  for(const path of record.readPaths){
    const step=steps.find(item=>item.stepId===proof.readStepIds.get(path)),args=step?.input?.arguments,binding=args?.binding;
    requireProof(step.input.tool==="repo_read_task_owned_local"&&args.path===path&&args.expectedContentHash===record.entries.find(item=>item.path===path).contentHash&&binding?.taskId===task.id&&binding.repository===record.repository&&binding.branch===record.branch&&binding.currentCommit===record.currentCommit&&recoveryRoot(binding.workspaceRoot)===recoveryRoot(record.workspaceRoot)&&binding.sourcePlanStepId===record.sourcePlanStepId&&binding.sourceApplyStepId===record.sourceApplyStepId&&binding.sourceApplyFingerprint===record.sourceApplyFingerprint&&binding.runtimeVersion===record.runtimeVersion&&binding.continuationGenerationId===record.activeContinuation.generationId,"recovered_read_binding");
  }
  return{...proof,record};
}
