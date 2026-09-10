const ACTIVE=new Set(["queued","retrying","waiting","waiting_for_worker"]);
const LOCAL=new Set(["apply_patch","run_focused_tests","run_full_tests","inspect_diff","review_commit","commit"]);
const ordinal=step=>Number.parseInt(step?.stepId,10);
const HISTORICAL_DELIVERY_RECOVERY="historical_approved_delivery_max_steps_recovery";

function exactRepository(task){return task?.metadata?.selfDevelopment?.repository;}
function exactVersionBinding({task,approval,state,allowClaimed}){
  const claimed=allowClaimed&&["planning","running"].includes(task?.status)&&Boolean(task?.leaseToken),deliveryStateVersion=task?.stateVersion-(claimed?1:0);
  if(!Number.isInteger(state?.approvedStateVersion)||state?.deliveryStateVersion!==deliveryStateVersion)return false;
  if(state.bindingSource===HISTORICAL_DELIVERY_RECOVERY){
    const record=task.metadata?.approvedDeliveryRecoveryHistory?.at(-1);
    return Boolean(record&&record.recoveryClass===HISTORICAL_DELIVERY_RECOVERY&&record.approvalId===state.approvalId&&record.approvedStateVersion===state.approvedStateVersion&&record.toStateVersion===deliveryStateVersion);
  }
  return state.bindingSource==="approval_contract"&&state.arguments?.approvedStateVersion===state.approvedStateVersion&&approval?.arguments?.approvedStateVersion===state.approvedStateVersion;
}

export function isExactApprovedDelivery({task,approval,steps=[],approvedBranch="feat/nova-brain-mvp-foundation",approvedRepository="hshanbour/nova-brain",allowClaimed=false}={}){
  const state=task?.approvalState,review=steps.filter(step=>step.stepType==="review_commit"&&step.status==="completed").at(-1),commit=steps.filter(step=>step.stepType==="commit"&&step.status==="completed"&&ordinal(step)<ordinal(review)).at(-1),reviewedCommit=review?.result?.commitSha,committedCommit=commit?.result?.commitSha;
  const repository=exactRepository(task),historical=state?.bindingSource===HISTORICAL_DELIVERY_RECOVERY,repositoryBound=historical?state?.repository===approvedRepository:state?.repository===approvedRepository&&state?.arguments?.repository===approvedRepository&&approval?.arguments?.repository===approvedRepository;
  return Boolean(task&&task.taskType==="self_development"&&(task.status==="queued"||(allowClaimed&&["planning","running"].includes(task.status)&&Boolean(task.leaseToken)))&&repository===approvedRepository&&repositoryBound&&task.branch===approvedBranch&&!['main','master'].includes(task.branch)&&state?.approved===true&&state.tool==="git_push"&&typeof state.approvalId==="string"&&state.stepId===`${task.currentStep+1}:push`&&state.branch===task.branch&&state.commitSha===task.currentCommit&&state.arguments?.branch===task.branch&&state.arguments?.commitSha===task.currentCommit&&approval?.id===state.approvalId&&approval.status==="approved"&&approval.tool==="git_push"&&approval.runId===task.id&&approval.projectId===task.projectId&&approval.arguments?.branch===task.branch&&approval.arguments?.commitSha===task.currentCommit&&exactVersionBinding({task,approval,state,allowClaimed})&&ordinal(review)===task.currentStep&&reviewedCommit===task.currentCommit&&committedCommit===task.currentCommit&&!steps.some(step=>ordinal(step)>task.currentStep));
}

export function createAutoDispatchService({storage,ownerId,approvedBranch="feat/nova-brain-mvp-foundation",approvedRepository="hshanbour/nova-brain",clock=()=>new Date()}={}){
  if(!storage||!ownerId)throw new Error("Auto-dispatch requires durable task storage and an owner.");
  async function next({workerId,branch=approvedBranch}={}){
    if(typeof workerId!=="string"||!workerId.trim()||workerId.length>200)throw Object.assign(new Error("A bounded worker ID is required."),{code:"invalid_dispatch_request",statusCode:400});
    if(branch!==approvedBranch||["main","master"].includes(branch))throw Object.assign(new Error("Only the approved feature branch may be dispatched."),{code:"branch_not_allowed",statusCode:403});
    const tasks=await storage.listAutonomyTasks(ownerId,{limit:100});
    let task,approvedDelivery=false;
    for(const item of tasks){
      const common=item.taskType==="self_development"&&item.branch===branch&&item.metadata?.autoDispatch!==false&&ACTIVE.has(item.status)&&item.status!=="waiting_for_approval"&&!item.leaseToken&&!item.leaseOwner&&(item.status!=="waiting"?(!item.nextRunAt||new Date(item.nextRunAt)<=clock()):(item.nextRunAt&&new Date(item.nextRunAt)<=clock()));if(!common)continue;
      if(!item.approvalState){task=item;break;}
      const approval=await storage.getApproval(item.approvalState.approvalId,ownerId),steps=await storage.listAutonomySteps(item.id);if(isExactApprovedDelivery({task:item,approval,steps,approvedBranch,approvedRepository})){task=item;approvedDelivery=true;break;}
    }
    if(!task)return{dispatched:false};
    const step=task.metadata?.steps?.[task.currentStep],stepType=approvedDelivery?"push":step?.type,mode=approvedDelivery?"task_tick":task.status==="waiting_for_worker"||LOCAL.has(stepType)?"local_handoff":"task_tick";
    return{dispatched:true,task:{id:task.id,status:task.status,branch:task.branch,expectedCommit:task.currentCommit,stateVersion:task.stateVersion,mode,stepType:stepType||null}};
  }
  return Object.freeze({next});
}
