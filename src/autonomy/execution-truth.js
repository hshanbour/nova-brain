import {randomUUID} from "node:crypto";

export const EXECUTION_HEARTBEAT_MS=15000;
export const EXECUTION_LEASE_MS=60000;
export const EXECUTION_ACTIVE_STATUSES=Object.freeze(["preparing","executing"]);
const TERMINAL=new Set(["completed","failed","blocked","cancelled","expired"]);
const WAITING=new Set(["waiting","waiting_for_worker","waiting_for_approval","retrying","paused"]);

const fresh=(attempt,now)=>attempt&&EXECUTION_ACTIVE_STATUSES.includes(attempt.status)&&Date.parse(attempt.leaseExpiresAt)>now.getTime();
export function projectExecutionTruth(task,attempt,{clock=()=>new Date()}={}){
  const now=clock(),terminal=TERMINAL.has(task.status);
  if(terminal)return Object.freeze({state:"terminal",active:false,phase:task.currentPhase,lastHeartbeatAt:attempt?.lastHeartbeatAt||null,lastProgressAt:attempt?.lastProgressAt||null,activeElapsedEndedAt:task.completedAt||task.updatedAt});
  if(task.status==="waiting_for_approval")return Object.freeze({state:"waiting_for_approval",active:false,phase:"approval",condition:"owner_approval",activeElapsedEndedAt:task.updatedAt});
  if(task.status==="waiting_for_worker")return Object.freeze({state:"waiting_for_worker",active:false,phase:task.currentPhase,condition:"compatible_worker",activeElapsedEndedAt:task.updatedAt});
  if(task.status==="retrying")return Object.freeze({state:"retrying",active:false,phase:task.currentPhase,condition:"retry_delay",nextTransitionAt:task.nextRunAt||null,activeElapsedEndedAt:task.updatedAt});
  if(WAITING.has(task.status))return Object.freeze({state:"waiting",active:false,phase:task.currentPhase,condition:task.nextRunAt?"scheduled_time":"known_condition",nextTransitionAt:task.nextRunAt||null,activeElapsedEndedAt:task.updatedAt});
  if(["queued","planning"].includes(task.status)&&!attempt)return Object.freeze({state:"queued",active:false,phase:task.currentPhase,activeElapsedEndedAt:task.updatedAt});
  if(fresh(attempt,now))return Object.freeze({state:attempt.executorStarted?"executing":"preparing",active:true,phase:attempt.phase,attemptId:attempt.id,generation:attempt.generation,workerId:attempt.workerId,lastHeartbeatAt:attempt.lastHeartbeatAt,lastProgressAt:attempt.lastProgressAt||null,leaseExpiresAt:attempt.leaseExpiresAt,executorStarted:attempt.executorStarted,activeElapsedStartedAt:attempt.claimedAt});
  if(attempt&&EXECUTION_ACTIVE_STATUSES.includes(attempt.status))return Object.freeze({state:"recovering",active:false,phase:attempt.phase,attemptId:attempt.id,generation:attempt.generation,lastHeartbeatAt:attempt.lastHeartbeatAt,lastProgressAt:attempt.lastProgressAt||null,leaseExpiresAt:attempt.leaseExpiresAt,executorStarted:attempt.executorStarted,activeElapsedEndedAt:attempt.leaseExpiresAt});
  if(task.status==="running"||task.leaseOwner||task.leaseToken)return Object.freeze({state:"stalled",active:false,phase:task.currentPhase,reason:"execution_liveness_unproven",activeElapsedEndedAt:task.updatedAt});
  return Object.freeze({state:"queued",active:false,phase:task.currentPhase,activeElapsedEndedAt:task.updatedAt});
}

export function createExecutionTruthService({storage,ownerId,clock=()=>new Date(),leaseMs=EXECUTION_LEASE_MS}={}){
  if(!storage||!ownerId)throw new Error("Execution truth requires storage and ownerId.");
  const boundedLease=value=>Math.max(30000,Math.min(120000,Number(value)||leaseMs));
  async function attemptForTask(taskId){return(await storage.getActiveExecutionAttempt(taskId,ownerId))||(await storage.getLatestExecutionAttempt(taskId,ownerId));}
  async function project(task){return{...task,executionTruth:projectExecutionTruth(task,await attemptForTask(task.id),{clock})};}
  async function start({task,handoff,workerId}){
    const attempt=await storage.createExecutionAttempt({id:randomUUID(),taskId:task.id,ownerId,handoffId:handoff.id,workerId,generation:null,fenceToken:randomUUID(),status:"preparing",phase:"preparing",executorStarted:false,leaseMs:boundedLease(),metadata:{stepId:handoff.stepId,stepType:handoff.stepType}});
    if(!attempt)throw Object.assign(new Error("Another execution attempt already owns this task."),{code:"execution_attempt_conflict"});
    return attempt;
  }
  async function heartbeat(input,{phase,executorStarted=false,progress=false}={}){
    const attempt=await storage.heartbeatExecutionAttempt({...input,ownerId,phase,executorStarted,progress,leaseMs:boundedLease()});
    if(!attempt)throw Object.assign(new Error("Execution attempt is stale or fenced."),{code:"execution_attempt_stale",statusCode:409});
    return attempt;
  }
  async function finish(input,{status,reason}={}){
    const attempt=await storage.finishExecutionAttempt({...input,ownerId,status,reason});
    if(!attempt)throw Object.assign(new Error("Execution attempt is stale or fenced."),{code:"execution_attempt_stale",statusCode:409});
    return attempt;
  }
  async function reconcile({workerId}={}){
    const activeAttempts=await storage.listActiveExecutionAttempts(ownerId),activeByTask=new Map(activeAttempts.map(attempt=>[attempt.taskId,attempt])),taskMap=new Map(),results=[];
    for(const attempt of activeAttempts){const task=await storage.getAutonomyTask(attempt.taskId,ownerId);if(task)taskMap.set(task.id,task);}
    for(const task of await storage.listAutonomyTasks(ownerId,{status:"running",limit:1000}))taskMap.set(task.id,task);
    const tasks=[...taskMap.values()];
    for(const task of tasks){
      const active=activeByTask.get(task.id)||(await storage.getActiveExecutionAttempt(task.id,ownerId));
      if(TERMINAL.has(task.status)){if(active)await storage.finishExecutionAttempt({id:active.id,taskId:task.id,ownerId,handoffId:active.handoffId,workerId:active.workerId,generation:active.generation,fenceToken:active.fenceToken,status:"superseded",reason:"task_already_terminal"});continue;}
      if(active&&Date.parse(active.leaseExpiresAt)<=clock().getTime()){
        const handoff=task.metadata?.localHandoff,started=active.executorStarted===true;
        if(handoff?.id===active.handoffId){
          const status=started?"failed":"waiting_for_worker",errorCode=started?"execution_owner_lost_after_start":"execution_owner_lost_before_start",blockedReason=started?"The execution owner was lost after the executor started. A fresh owner-approved retry is required.":"The worker was lost before executor launch; the exact task is waiting for a compatible worker.";
          const updated=await storage.updateAutonomyTask(task.id,ownerId,{status,currentPhase:started?"execution_interrupted":"recovering",nextRunAt:started?null:clock().toISOString(),completedAt:started?clock().toISOString():null,errorCode,blockedReason,leaseOwner:null,leaseToken:null,leaseExpiresAt:null,metadata:{...task.metadata,localHandoff:null,executionRecovery:{attemptId:active.id,generation:active.generation,executorStarted:started,reconciledAt:clock().toISOString()}}},task.stateVersion);
          if(updated){await storage.updateAutonomyStep(task.id,handoff.stepId,{status:"failed",errorCode,completedAt:clock().toISOString(),result:{code:errorCode}});await storage.releaseAutonomyLocks(task.id,task.leaseToken);await storage.appendActivity({ownerId,projectId:task.projectId,runId:task.id,action:started?"execution_owner_lost_after_start":"execution_owner_lost_before_start",status,summary:blockedReason,metadata:{taskId:task.id,attemptId:active.id,generation:active.generation,executorStarted:started}});results.push({taskId:task.id,status});}
        }
        await storage.finishExecutionAttempt({id:active.id,taskId:task.id,ownerId,handoffId:active.handoffId,workerId:active.workerId,generation:active.generation,fenceToken:active.fenceToken,status:"interrupted",reason:started?"worker_lost_after_executor_start":"worker_lost_before_executor_start"});
        continue;
      }
      if(!active&&task.status==="running"&&task.metadata?.localHandoff){
        const owner=String(task.leaseOwner||"").replace(/^local:/,""),foreign=workerId&&owner&&owner!==workerId,expired=task.leaseExpiresAt&&Date.parse(task.leaseExpiresAt)<=clock().getTime();
        if(foreign||expired){const handoff=task.metadata.localHandoff,errorCode="legacy_execution_liveness_unproven",summary="Legacy execution ownership was lost without fenced liveness evidence; a fresh approved retry is required.";const updated=await storage.updateAutonomyTask(task.id,ownerId,{status:"failed",currentPhase:"execution_interrupted",completedAt:clock().toISOString(),nextRunAt:null,errorCode,blockedReason:summary,leaseOwner:null,leaseToken:null,leaseExpiresAt:null,metadata:{...task.metadata,localHandoff:null,legacyExecutionReconciliation:{workerId:owner||null,replacementWorkerId:workerId||null,reconciledAt:clock().toISOString(),executorStarted:"unproven"}}},task.stateVersion);if(updated){await storage.updateAutonomyStep(task.id,handoff.stepId,{status:"failed",errorCode,completedAt:clock().toISOString(),result:{code:errorCode}});await storage.releaseAutonomyLocks(task.id,task.leaseToken);await storage.appendActivity({ownerId,projectId:task.projectId,runId:task.id,action:"legacy_execution_orphan_reconciled",status:"failed",summary,metadata:{taskId:task.id,handoffId:handoff.id,legacyWorkerId:owner||null,replacementWorkerId:workerId||null}});results.push({taskId:task.id,status:"failed",legacy:true});}}
      }
    }
    return results;
  }
  return Object.freeze({start,heartbeat,finish,reconcile,project,attemptForTask});
}
