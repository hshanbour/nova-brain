const TERMINAL=new Set(["completed","failed","cancelled","expired","blocked"]);

export function createApprovalReconciliation({storage,ownerId,clock=()=>new Date()}={}){
  if(!storage||!ownerId)throw new Error("Approval reconciliation requires storage and an owner.");
  async function reconcileCodingParent(task){
    if(task.taskType!=="coding_orchestration"||task.status!=="waiting_for_approval"||task.leaseOwner||task.leaseToken)return null;
    const state=task.approvalState,approvalId=state?.approvalId;
    if(state?.tool!=="coding_job_create"||typeof approvalId!=="string")return null;
    const approval=await storage.getApproval(approvalId,ownerId);
    if(!approval||approval.tool!=="coding_job_create"||approval.arguments?.parentTaskId!==task.id||approval.projectId!==task.projectId)return null;
    if(approval.status==="pending")return null;
    const activity=approval.runId?await storage.listActivity(ownerId,{runId:approval.runId,limit:200}):[];
    const completed=activity.some(item=>item.tool==="coding_job_create"&&item.action==="approved_action_completed"&&item.status==="completed");
    const failed=activity.some(item=>item.tool==="coding_job_create"&&item.action==="approved_action_failed"&&item.status==="failed");
    const children=(await storage.listAutonomyTasks(ownerId,{limit:500})).filter(item=>item.metadata?.parentTaskId===task.id||item.parentTaskId===task.id);
    const child=children.find(item=>item.taskType==="coding_delegation")||null;
    let patch,reason;
    if(approval.status==="rejected"){
      patch={status:"cancelled",currentPhase:"approval_reconciled",errorCode:"owner_rejected",blockedReason:"Owner rejected the coding delegation.",completedAt:approval.decidedAt||clock().toISOString(),approvalState:{...state,approved:false,reconciled:true}};
      reason="rejected";
    }else if(approval.status==="approved"&&child&&completed){
      patch={status:"completed",currentPhase:"delegated_coding",errorCode:null,blockedReason:null,completedAt:approval.decidedAt||clock().toISOString(),approvalState:{...state,approved:true,reconciled:true},metadata:{...task.metadata,delegatedTaskId:child.id}};
      reason="completed_child_found";
    }else if(approval.status==="approved"&&failed){
      patch={status:"failed",currentPhase:"approval_reconciled",errorCode:"historical_approved_action_failed",blockedReason:"The historical approved coding action failed; Nova did not replay it during reconciliation.",completedAt:approval.decidedAt||clock().toISOString(),approvalState:{...state,approved:true,reconciled:true,failureCode:"historical_approved_action_failed"}};
      reason="recorded_failure";
    }else if(approval.status==="approved"){
      patch={status:"blocked",currentPhase:"approval_reconciled",errorCode:"approved_action_outcome_unknown",blockedReason:"The historical approval is terminal but no safe execution outcome is provable; Nova did not replay it.",completedAt:approval.decidedAt||clock().toISOString(),approvalState:{...state,approved:true,reconciled:true,failureCode:"approved_action_outcome_unknown"}};
      reason="unknown_outcome";
    }else return null;
    const updated=await storage.updateAutonomyTask(task.id,ownerId,patch,task.stateVersion);
    if(!updated)return null;
    await storage.appendActivity({ownerId,projectId:task.projectId,runId:approval.runId||null,action:"coding_approval_state_reconciled",tool:"coding_job_create",status:updated.status,summary:"Reconciled a terminal coding approval without replaying the historical action.",metadata:{taskId:task.id,approvalId:approval.id,reason,childTaskId:child?.id||null,replayed:false}});
    return updated;
  }
  async function reconcile(){
    const tasks=await storage.listAutonomyTasks(ownerId,{limit:500}),results=[];
    for(const task of tasks){if(TERMINAL.has(task.status))continue;const result=await reconcileCodingParent(task);if(result)results.push(result);}
    return results;
  }
  return Object.freeze({reconcile,reconcileCodingParent});
}
