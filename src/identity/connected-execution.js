// Server-stamped release boundary; historical queues never inherit this authority.
export const CONNECTED_EXECUTION = 'connected-preview-local-v1';
export function isFreshCodingParent(task) {
 return task?.taskType === 'coding_orchestration' && task.metadata?.connectedExecution === CONNECTED_EXECUTION;
}
export async function connectedTaskAllowed(storage,ownerId,task) {
 if(task?.ownerId!==ownerId || task.taskType!=='coding_delegation' || task.metadata?.connectedExecution!==CONNECTED_EXECUTION)return false;
 const job=task.metadata?.codingJob;
 if(job?.delivery?.boundary!=='local_commit'||job.delivery.allowPush!==false||job.delivery.allowDeploy!==false||!job.approval?.buildApproved)return false;
 const parent=await storage.getAutonomyTask(job.parentTaskId,ownerId), approval=await storage.getApproval(job.approval.approvalId,ownerId);
 return Boolean(isFreshCodingParent(parent)&&parent.projectId===task.projectId&&parent.metadata.codingDelegation?.codingJobHash===task.metadata.codingSpecificationHash&&approval?.status==='approved'&&approval.tool==='coding_job_create'&&approval.projectId===task.projectId&&approval.arguments?.parentTaskId===parent.id&&approval.arguments?.specificationHash===task.metadata.codingSpecificationHash);
}
export function connectedExecutionDenied(){return Object.assign(new Error('This task remains held; only a newly prepared, approved local coding job may execute.'),{code:'connected_preview_task_held',statusCode:403});}
