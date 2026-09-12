import {createHash,randomUUID,timingSafeEqual} from "node:crypto";
import {createActiveContinuation,taskRuntimeWindow} from "./self-development-plan-lifecycle.js";
import {assertActiveImplementationPlan,canonicalContentHash} from "./self-development-plan-lifecycle.js";
import {canonicalSchemaDiagnostic} from "./schema-diagnostics.js";
import {isExactApprovedDelivery} from "./auto-dispatch.js";

const LOCAL_STEPS=Object.freeze({
  apply_patch:{capability:"repo_mutate_local",tool:"repo_apply_patch",lock:true},
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
  const planStep=plans.at(-1),priorFiles=planStep?.result?.implementationPlan?.files;
  if(!Array.isArray(priorFiles))return null;
  const applied=new Set(apply.result.files),current=new Set(files.map(file=>file.path)),entries=priorFiles.filter(file=>applied.has(file.path)&&current.has(file.path)&&typeof file.content==="string").map(file=>({path:file.path,contentHash:canonicalContentHash(file.content)}));
  if(entries.length===0||entries.length!==new Set(entries.map(entry=>entry.path)).size)return null;
  return Object.freeze({version:1,taskId:task.id,repository:task.metadata?.selfDevelopment?.repository,branch:task.branch,currentCommit:task.currentCommit,sourcePlanStepId:planStep.stepId,sourceApplyStepId:apply.stepId,entries});
};
const taskBoundPatchArguments=(task,args,steps)=>{if(args.branch!==undefined&&args.branch!==task.branch)throw new HandoffError("branch_mismatch","Patch branch does not match the exact task branch.");if(args.currentCommit!==undefined&&args.currentCommit!==task.currentCommit)throw new HandoffError("commit_mismatch","Patch commit does not match the exact task commit.");const planProvenance=assertActiveImplementationPlan(task,args.files),lineage=taskOwnedDirtyLineage(task,steps,args.files);return{branch:task.branch,currentCommit:task.currentCommit,files:args.files,planProvenance:{...planProvenance,...(lineage?{taskOwnedDirtyLineage:lineage}:{})}};};

export class HandoffError extends Error{constructor(code,message,statusCode=409){super(message);this.name="HandoffError";this.code=code;this.statusCode=statusCode;}}
export function authorizeLocalWorker(request,token){const header=request?.headers?.authorization||request?.headers?.Authorization;if(!token)throw new HandoffError("handoff_not_configured","Local Worker handoff is unavailable.",503);if(typeof header!=="string"||!header.startsWith("Bearer "))throw new HandoffError("unauthorized","Local Worker authorization is required.",401);const supplied=Buffer.from(header.slice(7)),expected=Buffer.from(token);if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))throw new HandoffError("unauthorized","Local Worker authorization is required.",401);return{actorType:"scoped_local_worker"};}

export function createLocalWorkerHandoff({storage,ownerId,approvedBranch="feat/nova-brain-mvp-foundation",clock=()=>new Date(),leaseMs=120000,deploymentEnvironment="preview"}={}){
  if(!storage||!ownerId)throw new Error("Local Worker handoff requires storage and ownerId.");
  const activity=(task,action,status,summary,metadata={})=>storage.appendActivity({ownerId,projectId:task.projectId,runId:task.id,action,status,summary,metadata:redact({taskId:task.id,...metadata})});
  const response=(task,handoff)=>({handoffId:handoff.id,taskId:task.id,stepId:handoff.stepId,stepType:handoff.stepType,repository:"hshanbour/nova-brain",branch:task.branch,expectedCommit:task.currentCommit,tool:handoff.tool,arguments:redact(handoff.arguments),...(handoff.approvedDelivery?{approvedDelivery:handoff.approvedDelivery}:{}),idempotencyKey:handoff.idempotencyKey,deadline:handoff.expiresAt});
  async function claim(input){
    if(deploymentEnvironment==="production")throw new HandoffError("production_target_forbidden","Local Worker handoff is forbidden in Production.",403);
    const taskId=boundedString(input?.taskId,"taskId"),workerId=boundedString(input?.workerId,"workerId"),idempotencyKey=boundedString(input?.idempotencyKey,"idempotencyKey");
    if(input.expectedBranch!==approvedBranch||["main","master"].includes(input.expectedBranch))throw new HandoffError("branch_not_allowed","Only the approved feature branch may be handed off.",403);
    boundedString(input.expectedCommit,"expectedCommit",64);
    const capabilities=[...new Set(Array.isArray(input.capabilities)?input.capabilities:[])].filter(value=>["repo_mutate_local","test_local","repo_read_remote","approved_delivery_git_push"].includes(value));
    const before=await storage.getAutonomyTask(taskId,ownerId);if(!before)return{claimed:false};
    if(before.branch!==input.expectedBranch)throw new HandoffError("branch_mismatch","Task branch does not match.");
    if(before.currentCommit!==input.expectedCommit)throw new HandoffError("commit_mismatch","Task commit does not match.");
    const active=before.metadata?.localHandoff;
    if(active&&new Date(active.expiresAt)>clock()){
      if(active.workerId===workerId&&active.idempotencyKey===idempotencyKey)return{claimed:true,idempotent:true,handoff:response(before,active)};
      return{claimed:false};
    }
    if(!SAFE_STATUSES.has(before.status)&&!(active&&new Date(active.expiresAt)<=clock()))return{claimed:false};
    let planned=before.metadata?.steps?.[before.currentStep];
    let exactApprovedDelivery=false;
    if(before.approvalState?.approved===true&&(!planned||planned.type==="push")){const approval=await storage.getApproval(before.approvalState.approvalId,ownerId),steps=await storage.listAutonomySteps(before.id);if(isExactApprovedDelivery({task:before,approval,steps,approvedBranch})){exactApprovedDelivery=true;if(!planned)planned={type:"push",input:{tool:"git_push",arguments:{branch:before.branch,commitSha:before.currentCommit}}};}}
    const runtimeWindow=exactApprovedDelivery?approvedDeliveryRuntimeWindow(before,clock()):taskRuntimeWindow(before,clock());
    if(runtimeWindow.expired){const updated=await storage.updateAutonomyTask(before.id,ownerId,{status:"expired",errorCode:"max_runtime_reached",nextRunAt:null,leaseOwner:null,leaseToken:null,leaseExpiresAt:null},before.stateVersion);if(!updated)return{claimed:false,code:"version_conflict"};await activity(updated,"local_worker_task_runtime_expired","expired","The task-scoped local handoff runtime expired without stopping the persistent worker.",{claimStage:"pre_claim_runtime",runtimeScope:runtimeWindow.scope,deadline:runtimeWindow.deadline});return{claimed:false,code:"max_runtime_reached",taskId:before.id};}
    const definition=LOCAL_STEPS[planned?.type];
    const capabilityAvailable=definition&&(exactApprovedDelivery?capabilities.includes("approved_delivery_git_push"):capabilities.includes(definition.capability));
    if(!capabilityAvailable)return{claimed:false};
    let args=resolvePlan(planned.input?.arguments||{},before);
    if(planned.input?.tool!==definition.tool)throw new HandoffError("invalid_step_payload","Server plan contains an invalid local tool.");
    if(before.taskType==="self_development"&&planned.type==="apply_patch")args=taskBoundPatchArguments(before,args,await storage.listAutonomySteps(before.id));
    if(before.taskType==="self_development"&&planned.type==="commit"){const reviewed=(await storage.listAutonomySteps(before.id)).filter(step=>step.stepType==="inspect_diff"&&step.status==="completed").at(-1)?.result?.reviewedChangeSet;if(!reviewed?.reviewHash)throw new HandoffError("review_required","Self-development commits require a durable reviewed change-set.");args={...args,reviewedChangeSet:reviewed};}
    let approvedDelivery=null;
    if(planned.type==="push"){const approval=await storage.getApproval(before.approvalState?.approvalId,ownerId),steps=await storage.listAutonomySteps(before.id);if(!isExactApprovedDelivery({task:before,approval,steps,approvedBranch}))throw new HandoffError("approved_delivery_invalid","Only the exact immutable approved delivery may be handed off.",409);const pushes=steps.filter(step=>step.stepType==="push"),successfulPush=pushes.some(step=>step.status==="completed"),review=steps.filter(step=>step.stepType==="review_commit"&&step.status==="completed").at(-1);approvedDelivery=Object.freeze({contractVersion:1,taskType:before.taskType,taskId:before.id,approvalId:approval.id,approved:approval.status==="approved",revoked:approval.status==="revoked",reviewedCommit:review?.result?.commitSha,repository:before.metadata?.selfDevelopment?.repository,branch:before.branch,logicalStepId:`${before.currentStep+1}:push`,localHandoff:true,reviewHistoryImmutable:true,postReviewMutation:false,deliveryConsumed:before.metadata?.approvedDeliveryRuntime?.consumed===true,gitPushSucceeded:successfulPush,secondLogicalPush:pushes.length>1,repositoryProvenanceValid:before.metadata?.selfDevelopment?.repository==="hshanbour/nova-brain"});}
    const handoff={id:randomUUID(),workerId,idempotencyKey,stepId:`${before.currentStep+1}:${planned.type}`,stepType:planned.type,tool:definition.tool,arguments:redact(args),...(approvedDelivery?{approvedDelivery}:{}),branch:before.branch,expectedCommit:before.currentCommit,expiresAt:new Date(clock().getTime()+Math.max(30000,Math.min(300000,leaseMs))).toISOString(),fingerprint:hash([before.id,before.currentStep,planned.type,redact(planned.input),before.currentCommit])};
    const claimCapabilities=exactApprovedDelivery?[...capabilities,"github_write"]:capabilities;
    const task=await storage.claimAutonomyTask({ownerId,workerId:`local:${workerId}`,capabilities:claimCapabilities,leaseMs, idempotencyKey,taskId,expectedBranch:input.expectedBranch,expectedCommit:input.expectedCommit});if(!task)return{claimed:false};
    if(definition.lock&&!await storage.acquireAutonomyLock({lockKey:`${task.projectId||"repo"}:${task.branch}`,taskId:task.id,leaseToken:task.leaseToken,expiresAt:task.leaseExpiresAt})){await storage.releaseAutonomyLease(task.id,ownerId,task.leaseToken);return{claimed:false,code:"branch_locked"};}
    const priorStep=(await storage.listAutonomySteps(task.id)).find(step=>step.stepId===handoff.stepId);
    if(priorStep?.status==="failed")await storage.updateAutonomyStep(task.id,handoff.stepId,{status:"running",attempt:(priorStep.attempt||1)+1,result:null,errorCode:null,startedAt:nowIso(clock),completedAt:null});
    else await storage.recordAutonomyStep({taskId:task.id,stepId:handoff.stepId,stepType:handoff.stepType,capability:definition.capability,operationFingerprint:handoff.fingerprint,input:redact(planned.input),status:"running"});
    handoff.expectedVersion=task.stateVersion+1;
    const updated=await storage.updateAutonomyTask(task.id,ownerId,{status:"running",metadata:{...task.metadata,localHandoff:handoff}},task.stateVersion);
    if(!updated)throw new HandoffError("version_conflict","Task changed while creating the handoff.");
    await activity(updated,"local_worker_handoff_created","running",`${handoff.stepType} handed to a controlled local worker.`,{handoffId:handoff.id,stepId:handoff.stepId,workerId});
    return{claimed:true,idempotent:false,handoff:response(updated,handoff)};
  }
  async function finish(handoffId,input,{failed=false}={}){
    boundedString(handoffId,"handoffId");const taskId=boundedString(input?.taskId,"taskId"),workerId=boundedString(input?.workerId,"workerId"),idempotencyKey=boundedString(input?.idempotencyKey,"idempotencyKey");
    const task=await storage.getAutonomyTask(taskId,ownerId);if(!task)throw new HandoffError("handoff_not_found","Handoff was not found.",404);
    if((task.metadata?.completedHandoffs||[]).includes(handoffId))return{idempotent:true,task:publicTask(task)};
    const handoff=task.metadata?.localHandoff;if(!handoff||handoff.id!==handoffId||handoff.workerId!==workerId||handoff.idempotencyKey!==idempotencyKey)throw new HandoffError("handoff_mismatch","Handoff does not match the active task.",403);
    if(task.stateVersion!==handoff.expectedVersion)throw new HandoffError("version_conflict","Task changed while the local step was running.");
    if(task.branch!==handoff.branch||task.currentCommit!==handoff.expectedCommit)throw new HandoffError("task_binding_changed","Task branch or commit changed while the local step was running.");
    if(new Date(handoff.expiresAt)<=clock()){await recover(task,handoff,"local_worker_handoff_expired");throw new HandoffError("handoff_expired","Handoff expired and was safely requeued.");}
    const result=redact(failed?input.error:input.result);if(!result||typeof result!=="object"||Array.isArray(result)||JSON.stringify(result).length>200000)throw new HandoffError("invalid_handoff_result","Structured bounded result is required.",400);
    if(!failed&&result.ok!==true)throw new HandoffError("invalid_handoff_result","Successful result must report ok=true.",400);
    if(!failed&&["commit","integrate_commit"].includes(handoff.stepType)&&!/^[a-f0-9]{40}$/.test(result.commitSha||""))throw new HandoffError("invalid_handoff_result","Commit result requires an exact SHA.",400);
    if(!failed&&["run_focused_tests","run_full_tests","inspect_diff","review_commit"].includes(handoff.stepType)&&result.exitCode!==0)throw new HandoffError("invalid_handoff_result","Successful local command result requires exitCode 0.",400);
    if(!failed&&handoff.stepType==="review_commit"&&(!result.reviewedChangeSet?.reviewHash||result.commitSha!==task.currentCommit))throw new HandoffError("invalid_handoff_result","Reviewed commit result must bind the exact task commit.",400);
    if(!failed&&handoff.stepType==="apply_patch"){const allowed=new Set((handoff.arguments.files||[]).map(item=>item.path));if(!Array.isArray(result.files)||result.files.some(path=>!allowed.has(path)))throw new HandoffError("invalid_handoff_result","Patch result files do not match the server plan.",400);}
    const completed=[...(task.checkpoint?.completedSteps||[]),handoff.stepId],completedHandoffs=[...(task.metadata?.completedHandoffs||[]),handoff.id].slice(-20),metadata={...task.metadata,localHandoff:null,completedHandoffs,requiredCapability:null};
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
  async function recover(task,handoff,action){await storage.releaseAutonomyLocks(task.id,task.leaseToken);await storage.releaseAutonomyLease(task.id,ownerId,task.leaseToken);const updated=await storage.updateAutonomyTask(task.id,ownerId,{status:"queued",nextRunAt:nowIso(clock),metadata:{...task.metadata,localHandoff:null},blockedReason:null,errorCode:"worker_crash"});await activity(updated,action,"retrying","Expired local Worker handoff was safely requeued.",{handoffId:handoff.id,stepId:handoff.stepId});return updated;}
  const inspect=async(handoffId,taskId)=>{const task=await storage.getAutonomyTask(taskId,ownerId),handoff=task?.metadata?.localHandoff;if(!handoff||handoff.id!==handoffId)throw new HandoffError("handoff_not_found","Handoff was not found.",404);return{handoffId,taskId,status:task.status,stepId:handoff.stepId,stepType:handoff.stepType,deadline:handoff.expiresAt};};
  return Object.freeze({claim,complete:(id,input)=>finish(id,input),fail:(id,input)=>finish(id,input,{failed:true}),inspect});
}
function publicTask(task){return{id:task.id,status:task.status,currentStep:task.currentStep,currentPhase:task.currentPhase,currentCommit:task.currentCommit,branch:task.branch,stateVersion:task.stateVersion,approvalState:task.approvalState?{tool:task.approvalState.tool,branch:task.approvalState.branch,commitSha:task.approvalState.commitSha}:null};}
