import {LIVE_PUSH_ATTESTATION} from "./github-write-attestation.js";

export const LIVE_EXPIRY_RECOVERY=Object.freeze({taskId:LIVE_PUSH_ATTESTATION.taskId,runtimeMinutes:15});
const REQUIRED_CHECKPOINTS=["1:inspect_repo","2:apply_patch","3:run_focused_tests","4:run_full_tests","5:inspect_diff","6:commit","7:push","8:deploy_preview"];
export class ExpiryRecoveryError extends Error{constructor(code,message,statusCode=409){super(message);this.name="ExpiryRecoveryError";this.code=code;this.statusCode=statusCode;}}
const exact=(value,expected,code)=>{if(value!==expected)throw new ExpiryRecoveryError(code,"Recovery binding does not match.");};

export function createPostAttestationRecovery({storage,ownerId,verifyDeployment,clock=()=>new Date()}={}){
  if(!storage||!ownerId||!verifyDeployment)throw new Error("Post-attestation recovery dependencies are required.");
  async function recover(input){
    const allowed=new Set(["taskId","runtimeMinutes"]);
    if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(key=>!allowed.has(key)))throw new ExpiryRecoveryError("invalid_recovery","A bounded recovery request is required.",400);
    exact(input.taskId,LIVE_EXPIRY_RECOVERY.taskId,"task_mismatch");exact(input.runtimeMinutes,LIVE_EXPIRY_RECOVERY.runtimeMinutes,"runtime_budget_mismatch");
    const task=await storage.getAutonomyTask(input.taskId,ownerId);if(!task)throw new ExpiryRecoveryError("task_not_found","Task not found.",404);
    if(task.status!=="expired"||task.errorCode!=="max_runtime_reached")throw new ExpiryRecoveryError("task_state_mismatch","Only the exact post-attestation runtime expiry can recover.");
    exact(task.branch,LIVE_PUSH_ATTESTATION.branch,"branch_mismatch");exact(task.currentCommit,LIVE_PUSH_ATTESTATION.sha,"sha_mismatch");
    if(task.leaseToken||task.leaseOwner||task.leaseExpiresAt)throw new ExpiryRecoveryError("active_lease_conflict","Expired task still has a lease.");
    if(!REQUIRED_CHECKPOINTS.every(step=>task.checkpoint?.completedSteps?.includes(step)))throw new ExpiryRecoveryError("checkpoint_mismatch","Required checkpoints are incomplete.");
    if(task.checkpoint.completedSteps.length!==REQUIRED_CHECKPOINTS.length||task.currentStep!==8)throw new ExpiryRecoveryError("conflicting_acceptance_action","Unexpected completed work exists after deployment attestation.");
    const steps=await storage.listAutonomySteps(task.id),pushes=steps.filter(step=>step.stepId==="7:push"&&step.status==="completed"),deploys=steps.filter(step=>step.stepId==="8:deploy_preview"&&step.status==="completed");
    if(pushes.length!==1)throw new ExpiryRecoveryError(pushes.length?"duplicate_push_checkpoint":"push_checkpoint_missing","Push checkpoint must exist exactly once.");
    if(deploys.length!==1)throw new ExpiryRecoveryError(deploys.length?"duplicate_deploy_checkpoint":"deploy_checkpoint_missing","Preview checkpoint must exist exactly once.");
    exact(pushes[0].result?.commitSha,LIVE_PUSH_ATTESTATION.sha,"push_sha_mismatch");exact(pushes[0].result?.approvalId,LIVE_PUSH_ATTESTATION.approvalId,"approval_mismatch");exact(deploys[0].result?.deploymentId,LIVE_PUSH_ATTESTATION.deploymentId,"deployment_mismatch");
    const approval=await storage.getApproval(LIVE_PUSH_ATTESTATION.approvalId,ownerId);if(!approval||approval.status!=="approved"||approval.runId!==task.id||approval.tool!=="git_push")throw new ExpiryRecoveryError("approval_mismatch","Exact approval is no longer valid.");
    exact(approval.arguments?.branch,LIVE_PUSH_ATTESTATION.branch,"approval_mismatch");exact(approval.arguments?.commitSha,LIVE_PUSH_ATTESTATION.sha,"approval_mismatch");
    const deployment=await verifyDeployment(LIVE_PUSH_ATTESTATION);if(deployment?.target==="production")throw new ExpiryRecoveryError("production_target_forbidden","Production recovery is forbidden.",403);
    exact(deployment?.id,LIVE_PUSH_ATTESTATION.deploymentId,"deployment_mismatch");exact(deployment?.url,LIVE_PUSH_ATTESTATION.deploymentUrl,"deployment_mismatch");exact(deployment?.sha,LIVE_PUSH_ATTESTATION.sha,"deployment_sha_mismatch");exact(deployment?.branch,LIVE_PUSH_ATTESTATION.branch,"deployment_branch_mismatch");exact(deployment?.status,"READY","deployment_not_ready");
    const prior=task.metadata?.steps||[],plan=[...prior.slice(0,9),{type:"verify_preview",input:{tool:"deployment_status_existing",arguments:{deploymentId:LIVE_PUSH_ATTESTATION.deploymentId,commitSha:LIVE_PUSH_ATTESTATION.sha}}},{type:"verify_preview",input:{tool:"preview_verify_existing",arguments:{deploymentId:LIVE_PUSH_ATTESTATION.deploymentId,path:"/api/health",expectedStatus:200,commitSha:LIVE_PUSH_ATTESTATION.sha}}},{type:"summarize",input:{summary:"Worker Runtime V1 live capability handoff complete."}}];
    const recovered=await storage.recoverExpiredAutonomyTask({taskId:task.id,ownerId,expectedVersion:task.stateVersion,expectedBranch:task.branch,expectedCommit:task.currentCommit,runtimeMinutes:input.runtimeMinutes,plan,actorType:"scoped_server_recovery",previousStartedAt:task.startedAt,previousCompletedAt:task.completedAt});
    if(!recovered){const latest=await storage.getAutonomyTask(task.id,ownerId);throw new ExpiryRecoveryError(latest?.stateVersion!==task.stateVersion?"version_conflict":"task_state_mismatch","Task changed while recovery was applied.");}
    return{task:publicTask(recovered),idempotent:false};
  }
  return Object.freeze({recover});
}
function publicTask(task){return{id:task.id,status:task.status,currentStep:task.currentStep,currentPhase:task.currentPhase,currentCommit:task.currentCommit,branch:task.branch,stateVersion:task.stateVersion,maxRuntimeMinutes:task.maxRuntimeMinutes,checkpoint:task.checkpoint};}
