import {createHash} from "node:crypto";

export const LIVE_PUSH_ATTESTATION=Object.freeze({
  taskId:"f72ee91d-4e06-4824-a395-0ef376f3e96a",
  repository:"hshanbour/nova-brain",
  branch:"feat/nova-brain-mvp-foundation",
  sha:"8be369022ffaad82e1693de854b815764ce31aeb",
  approvalId:"9bf918fe-eb69-44dd-9d9d-b8f5f9f78941",
  deploymentId:"dpl_9G7kQu2oDGMQMiDCtKdrmNZo7XRP",
  deploymentUrl:"nova-test-project-8rvjrq8xl-hamodehshanbour-6196.vercel.app",
});
export const REQUIRED_BLOCKER_SHA="1b8dd3f9f900801c0f3ffff1ae399421c0d1772b";
const COMPLETED=["1:inspect_repo","2:apply_patch","3:run_focused_tests","4:run_full_tests","5:inspect_diff","6:commit"];
const exact=(value,expected,code)=>{if(value!==expected)throw new AttestationError(code,"Attestation binding does not match.");};
const fingerprint=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class AttestationError extends Error{constructor(code,message,statusCode=409){super(message);this.name="AttestationError";this.code=code;this.statusCode=statusCode;}}

export function createGithubWriteAttestation({storage,ownerId,verifyRemote,verifyDeployment,clock=()=>new Date()}={}){
  if(!storage||!ownerId||!verifyRemote||!verifyDeployment)throw new Error("GitHub write attestation dependencies are required.");
  async function attest(input){
    const allowed=new Set(["taskId","repository","branch","sha","approvalId","deploymentId","deploymentUrl"]);
    if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(key=>!allowed.has(key)))throw new AttestationError("invalid_attestation","A bounded attestation is required.",400);
    for(const key of allowed)exact(input[key],LIVE_PUSH_ATTESTATION[key],`${key}_mismatch`);
    if(["main","master"].includes(input.branch))throw new AttestationError("production_target_forbidden","Protected branches cannot be attested.",403);
    const task=await storage.getAutonomyTask(input.taskId,ownerId);if(!task)throw new AttestationError("task_not_found","Task not found.",404);
    if(task.checkpoint?.completedSteps?.includes("8:deploy_preview"))return{task:publicTask(task),idempotent:true};
    if(task.status!=="waiting_for_worker"||task.currentStep!==6||task.metadata?.requiredCapability!=="github_write")throw new AttestationError("task_state_mismatch","Task is not at the exact push handoff.");
    exact(task.branch,input.branch,"branch_mismatch");exact(task.currentCommit,input.sha,"sha_mismatch");
    if(!COMPLETED.every(step=>task.checkpoint?.completedSteps?.includes(step)))throw new AttestationError("checkpoint_mismatch","Required checkpoints are incomplete.");
    const approval=await storage.getApproval(input.approvalId,ownerId);if(!approval)throw new AttestationError("approval_missing","Approval not found.");
    if(approval.status!=="approved")throw new AttestationError("approval_invalid","Approval is not valid.");
    if(approval.runId!==task.id||approval.tool!=="git_push")throw new AttestationError("approval_action_mismatch","Approval action does not match.");
    exact(approval.arguments?.branch,input.branch,"approval_branch_mismatch");exact(approval.arguments?.commitSha,input.sha,"approval_sha_mismatch");
    if(task.approvalState?.approvalId!==input.approvalId||task.approvalState?.approved!==true)throw new AttestationError("approval_state_mismatch","Task approval state does not match.");
    const remote=await verifyRemote({...input,requiredAncestors:[input.sha,REQUIRED_BLOCKER_SHA]});
    if(!/^[a-f0-9]{40}$/.test(remote?.currentTip||""))throw new AttestationError("remote_tip_invalid","Current feature tip could not be verified.");
    if(remote?.ancestors?.[input.sha]!==true)throw new AttestationError("acceptance_ancestry_mismatch","Acceptance SHA is not an exact ancestor of the current tip.");
    if(remote?.ancestors?.[REQUIRED_BLOCKER_SHA]!==true)throw new AttestationError("blocker_ancestry_mismatch","Blocker-fix SHA is not an exact ancestor of the current tip.");
    const deployment=await verifyDeployment(input);
    if(deployment?.target==="production")throw new AttestationError("production_target_forbidden","Production cannot be attached.",403);
    exact(deployment?.id,input.deploymentId,"deployment_mismatch");exact(deployment?.url,input.deploymentUrl,"deployment_url_mismatch");exact(deployment?.sha,input.sha,"deployment_sha_mismatch");exact(deployment?.branch,input.branch,"deployment_branch_mismatch");
    if(deployment?.status!=="READY")throw new AttestationError("deployment_not_ready","Preview is not ready.");
    const completed=[...task.checkpoint.completedSteps,"7:push","8:deploy_preview"];
    const result={ok:true,attested:true,repository:input.repository,branch:input.branch,commitSha:input.sha,approvalId:input.approvalId,deploymentId:input.deploymentId,url:input.deploymentUrl,status:"READY",verifiedAt:clock().toISOString()};
    const updated=await storage.updateAutonomyTask(task.id,ownerId,{status:"queued",currentStep:8,currentPhase:"deploy_preview",nextRunAt:clock().toISOString(),blockedReason:null,errorCode:null,approvalState:null,checkpoint:{...task.checkpoint,completedSteps:completed,pendingStep:null,latestResult:result},metadata:{...task.metadata,requiredCapability:null}},task.stateVersion);
    if(!updated)throw new AttestationError("version_conflict","Task changed during attestation.");
    for(const [stepId,stepType,stepResult] of [["7:push","push",{...result,deploymentId:undefined,url:undefined,status:undefined}],["8:deploy_preview","deploy_preview",result]])await storage.recordAutonomyStep({taskId:task.id,stepId,stepType,capability:stepType==="push"?"github_write_attestation":"vercel_preview",operationFingerprint:fingerprint([task.id,stepId,input.sha,input.deploymentId]),input:{attestation:true},status:"completed",result:stepResult,completedAt:clock().toISOString()});
    await storage.appendActivity({ownerId,projectId:task.projectId,runId:task.id,action:"github_write_attested",status:"completed",summary:"Recorded an already-approved exact push and attached its verified Preview.",metadata:{taskId:task.id,repository:input.repository,branch:input.branch,commitSha:input.sha,approvalId:input.approvalId,deploymentId:input.deploymentId,result:"verified"}});
    return{task:publicTask(updated),idempotent:false};
  }
  return Object.freeze({attest});
}
function publicTask(task){return{id:task.id,status:task.status,currentStep:task.currentStep,currentPhase:task.currentPhase,currentCommit:task.currentCommit,branch:task.branch,stateVersion:task.stateVersion,checkpoint:task.checkpoint};}
