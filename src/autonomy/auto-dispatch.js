const ACTIVE=new Set(["queued","retrying","waiting","waiting_for_worker"]);
const LOCAL=new Set(["apply_patch","run_focused_tests","run_full_tests","inspect_diff","review_commit","commit"]);

export function createAutoDispatchService({storage,ownerId,approvedBranch="feat/nova-brain-mvp-foundation",clock=()=>new Date()}={}){
  if(!storage||!ownerId)throw new Error("Auto-dispatch requires durable task storage and an owner.");
  async function next({workerId,branch=approvedBranch}={}){
    if(typeof workerId!=="string"||!workerId.trim()||workerId.length>200)throw Object.assign(new Error("A bounded worker ID is required."),{code:"invalid_dispatch_request",statusCode:400});
    if(branch!==approvedBranch||["main","master"].includes(branch))throw Object.assign(new Error("Only the approved feature branch may be dispatched."),{code:"branch_not_allowed",statusCode:403});
    const tasks=await storage.listAutonomyTasks(ownerId,{limit:100});
    const task=tasks.find(item=>item.taskType==="self_development"&&item.branch===branch&&item.metadata?.autoDispatch!==false&&ACTIVE.has(item.status)&&item.status!=="waiting_for_approval"&&!item.approvalState&&!item.leaseToken&&!item.leaseOwner&&(item.status!=="waiting"?( !item.nextRunAt||new Date(item.nextRunAt)<=clock()):(item.nextRunAt&&new Date(item.nextRunAt)<=clock())));
    if(!task)return{dispatched:false};
    const step=task.metadata?.steps?.[task.currentStep],mode=task.status==="waiting_for_worker"||LOCAL.has(step?.type)?"local_handoff":"task_tick";
    return{dispatched:true,task:{id:task.id,status:task.status,branch:task.branch,expectedCommit:task.currentCommit,stateVersion:task.stateVersion,mode,stepType:step?.type||null}};
  }
  return Object.freeze({next});
}
