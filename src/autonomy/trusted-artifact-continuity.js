const CODING_ID=/^coding_[a-f0-9]{32}$/;
const ORCHESTRATION_ID=/^orchestration_[a-f0-9]{32}$/;
const SHA=/^[a-f0-9]{40}$/;

const fail=(code,message,statusCode=409)=>{throw Object.assign(new Error(message),{code,statusCode});};
const bounded=(value,max=160)=>typeof value==="string"?value.trim().slice(0,max):"";
export const isExplicitTrustedArtifactRequest=(message,taskId)=>CODING_ID.test(taskId||"")&&String(message||"").includes(taskId)&&/\b(?:ship|deploy|continue|resume|use|adopt|integrate)\b/i.test(String(message||""));
export const isTrustedArtifactContinuationCandidate=task=>{
  const adoption=task?.metadata?.trustedArtifactAdoption,hash=task?.metadata?.codingDelegation?.codingJobHash,state=task?.approvalState,handle=state?.arguments;
  if(task?.taskType!=="coding_orchestration"||adoption?.version!==1||!CODING_ID.test(adoption.sourceTaskId||"")||!/^[a-f0-9]{64}$/.test(hash||"")||adoption.specificationHash!==hash||task?.metadata?.delegatedTaskId||task?.leaseOwner||task?.leaseToken)return false;
  if(task.status==="queued")return task.stateVersion===1&&!state;
  return task.status==="waiting_for_approval"&&state?.bindingSource==="trusted_artifact_adoption"&&state?.tool==="coding_job_create"&&handle?.parentTaskId===task.id&&handle?.specificationHash===hash;
};

export function createTrustedArtifactContinuity({storage,ownerId,approvedRepository,approvedBranch,verifyRemote,codingDelegation,artifactDelivery,verifyLocalArtifact}={}){
  if(!storage?.listAutonomyTasks||!storage?.listAutonomySteps||typeof verifyRemote!=="function"||!codingDelegation?.prepareTrustedArtifact||!artifactDelivery?.create)throw new Error("Trusted artifact continuity requires durable storage, repository verification, coding delegation, and artifact delivery.");
  const inspect=async task=>{
    if(!task||task.ownerId!==ownerId||task.taskType!=="coding_delegation"||task.status!=="completed")return null;
    const steps=await storage.listAutonomySteps(task.id),step=[...steps].reverse().find(item=>item.stepType==="delegate_coding"&&item.status==="completed"),result=step?.result?.diagnostics?.codingResult||step?.result;
    const repository=task.metadata?.codingJob?.repository;
    if(!repository||repository.slug!==approvedRepository||!SHA.test(result?.finalLocalSha||"")||result.finalLocalSha!==task.currentCommit||result?.status!=="completed"||result.pushOccurred!==false||result.deploymentOccurred!==false||result.executor?.localRef!==`refs/nova/coding-jobs/${task.id}`)return null;
    const deliveries=(await storage.listAutonomyTasks(ownerId,{limit:200})).filter(item=>item.taskType==="artifact_delivery"&&item.metadata?.artifactDelivery?.sourceTaskId===task.id);
    if(deliveries.length)return null;
    return Object.freeze({task,result,repository,artifact:Object.freeze({version:1,sourceTaskId:task.id,sourceStateVersion:task.stateVersion,repository:repository.slug,sourceBranch:repository.branch,commitSha:result.finalLocalSha,artifactRef:result.executor.localRef,filesChanged:Object.freeze([...(result.filesChanged||[])])})});
  };
  const adopt=async(sourceTaskId,{conversationId,runId,signal}={})=>{
    if(!CODING_ID.test(sourceTaskId||""))fail("trusted_artifact_source_invalid","A canonical completed coding task is required.",400);
    const source=await storage.getAutonomyTask(sourceTaskId,ownerId),trusted=await inspect(source);
    if(!trusted)fail("trusted_artifact_source_invalid","The requested task is not a trusted unshipped completed coding artifact.");
    if(typeof conversationId!=="string"||!conversationId)fail("trusted_artifact_conversation_unbound","Artifact adoption requires the current trusted conversation.",400);
    const remote=await verifyRemote({repository:approvedRepository,branch:approvedBranch,requiredAncestors:[],signal});
    if(!SHA.test(remote?.currentTip||""))fail("trusted_artifact_baseline_unresolved","The current integration baseline could not be resolved.");
    const directlyCompatible=trusted.repository.branch===approvedBranch&&source.startingCommit===remote.currentTip;
    if(directlyCompatible&&typeof verifyLocalArtifact==="function"){
      const proof=await verifyLocalArtifact(trusted.artifact);
      if(proof?.commitExists===true&&proof?.refMatches===true)return{...(await artifactDelivery.create(sourceTaskId,{conversationId,runId})),adoptionMode:"direct_delivery"};
    }
    const prepared=await codingDelegation.prepareTrustedArtifact({projectId:source.projectId,trustedArtifact:trusted.artifact},{projectId:source.projectId,conversationId,runId,signal});
    return{...prepared,adoptionMode:"current_baseline_integration",sourceTaskId,currentBaseline:remote.currentTip};
  };
  return Object.freeze({
    async candidates({limit=8}={}){
      const tasks=await storage.listAutonomyTasks(ownerId,{status:"completed",limit:100}),items=[];
      for(const task of tasks){const value=await inspect(task);if(value)items.push(Object.freeze({id:task.id,taskType:task.taskType,status:task.status,stateVersion:task.stateVersion,currentPhase:task.currentPhase||null,currentCommit:task.currentCommit,title:bounded(task.title),objective:bounded(task.objective,300),allowedTransitions:["artifact_adoption"]}));if(items.length>=limit)break;}
      return items;
    },
    adopt,
    async continueWorkflow(parentTaskId,{conversationId,runId,signal}={}){
      if(!ORCHESTRATION_ID.test(parentTaskId||""))fail("workflow_continuation_invalid","A canonical coding orchestration is required.",400);
      const parent=await storage.getAutonomyTask(parentTaskId,ownerId);
      if(!isTrustedArtifactContinuationCandidate(parent))fail("workflow_continuation_unavailable","This workflow has no server-owned continuation from its current state.");
      if(parent.metadata?.terminalReporting?.conversationId!==conversationId)fail("trusted_artifact_conversation_unbound","Workflow continuation requires the original trusted conversation.",400);
      const result=await adopt(parent.metadata.trustedArtifactAdoption.sourceTaskId,{conversationId,runId,signal});
      if(result?.task?.id!==parent.id)fail("workflow_continuation_identity_changed","Workflow continuation resolved to a different durable parent.");
      return{...result,workflowContinued:true};
    },
  });
}
