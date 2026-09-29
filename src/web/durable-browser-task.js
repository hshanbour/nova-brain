import {createHash,randomUUID} from "node:crypto";
import {BROWSER_RUN_LIMITS,BrowserRunError} from "./cloudflare-browser-run.js";

const TERMINAL=new Set(["completed","failed","blocked","cancelled"]);
const BLOCKED=new Set(["authentication_required","captcha_required","paywall_detected","robots_disallowed","browser_domain_forbidden","browser_network_forbidden"]);
const ACTIVE_PHASES=new Set(["starting_browser","opening_public_page","inspecting_rendered_content","navigating_public_page","comparing_pages"]);
const bounded=(value,max=500)=>String(value||"").replace(/Bearer\s+\S+/gi,"Bearer [REDACTED]").replace(/\b(?:sk-[A-Za-z0-9_-]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g,"[REDACTED]").replace(/\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi,"$1=[REDACTED]").replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim().slice(0,max);
const digest=value=>createHash("sha256").update(String(value)).digest("hex");
const taskIdFor=({runId,startUrl,allowedDomains})=>`web_${digest(JSON.stringify([runId,startUrl,[...allowedDomains].sort()])).slice(0,32)}`;
const attemptInput=(attempt)=>({id:attempt.id,taskId:attempt.taskId,handoffId:attempt.handoffId,workerId:attempt.workerId,generation:attempt.generation,fenceToken:attempt.fenceToken});
function validateSpec(startUrl,allowedDomains){let url;try{url=new URL(startUrl);}catch{throw Object.assign(new Error("The durable browser URL is invalid."),{code:"browser_url_invalid"});}if(url.protocol!=="https:"||url.username||url.password||(url.port&&url.port!=="443")||[...url.searchParams.keys()].some(key=>/^(?:access_?token|api_?key|auth|authorization|credential|password|secret|signature|sig)$/i.test(key)))throw Object.assign(new Error("The durable browser URL is outside the public read-only contract."),{code:"browser_url_forbidden"});const domains=[...new Set((allowedDomains||[]).map(value=>String(value).toLowerCase()))];if(!domains.includes(url.hostname.toLowerCase())||!domains.length||domains.length>50)throw Object.assign(new Error("The durable browser domain authority is invalid."),{code:"browser_domains_invalid"});return{url:url.href,domains};}
function validateNavigation(value){if(value===null||value===undefined)return null;if(!value||Object.keys(value).some(key=>!["type","label"].includes(key))||value.type!=="follow_link_text"||typeof value.label!=="string")throw Object.assign(new Error("The durable browser navigation is invalid."),{code:"browser_navigation_invalid"});const label=value.label.replace(/\s+/g," ").trim();if(!label||label.length>120||/[\u0000-\u001f\u007f]/.test(label))throw Object.assign(new Error("The durable browser link label is invalid."),{code:"browser_navigation_invalid"});return Object.freeze({type:"follow_link_text",label});}

export function createDurableBrowserTaskService({storage,ownerId,browserAdapter,providerBudget,modelCostController,executionTruth,model="gpt-6-luna",clock=()=>new Date(),workerId="nova-server-browser"}={}){
  if(!storage||!ownerId||!browserAdapter||!providerBudget||!modelCostController||!executionTruth)throw new Error("Durable browser task dependencies are required.");
  const update=async(taskId,patch)=>{const current=await storage.getAutonomyTask(taskId,ownerId),updated=current&&await storage.updateAutonomyTask(taskId,ownerId,patch,current.stateVersion);if(!updated)throw Object.assign(new Error("The durable browser task changed concurrently."),{code:"browser_task_fenced"});return updated;};
  const activity=(task,action,status,summary,metadata={})=>storage.appendActivity({ownerId,projectId:task.projectId,runId:task.id,action,tool:"public_browser_read",status,summary,metadata:{taskId:task.id,...metadata}});
  const blockBeforeExecution=async(task,error)=>{
    const code=bounded(error?.code,100)||"browser_budget_unavailable",summary=bounded(error?.message,500)||"The browser task could not reserve its bounded execution budget.";
    await storage.updateAutonomyStep(task.id,"1:public_browser_read",{status:"blocked",errorCode:code,completedAt:clock().toISOString(),result:{status:"blocked",code,reason:summary}});
    const blocked=await update(task.id,{status:"blocked",currentPhase:"blocked",completedAt:clock().toISOString(),errorCode:code,blockedReason:summary,metadata:{...task.metadata,browserResult:{status:"blocked",code,reason:summary}}});
    await activity(blocked,"browser_blocked","blocked",summary,{errorCode:code});
    return Object.freeze({task:blocked,result:blocked.metadata.browserResult,idempotent:false,error});
  };
  async function prepare({startUrl,allowedDomains,reason,navigation=null,heavy=false,conversationId,runId,projectId}={}){
      const verified=validateSpec(startUrl,allowedDomains);startUrl=verified.url;allowedDomains=verified.domains;navigation=validateNavigation(navigation);
      const taskId=taskIdFor({runId,startUrl,allowedDomains}),existing=await storage.getAutonomyTask(taskId,ownerId);
      if(existing){if(!await storage.getRun(taskId,ownerId))throw Object.assign(new Error("The durable browser task is missing its task-owned execution run."),{code:"browser_task_persistence_invalid"});const result=existing.metadata?.browserResult||null;return Object.freeze({task:existing,result,idempotent:true});}
      const canonical=Object.freeze({version:2,startUrl,allowedDomains:Object.freeze([...new Set(allowedDomains)].sort()),reason,navigation,limits:Object.freeze({ttlMs:heavy?BROWSER_RUN_LIMITS.maxTtlMs:BROWSER_RUN_LIMITS.defaultTtlMs,maxActions:heavy?BROWSER_RUN_LIMITS.heavyActions:BROWSER_RUN_LIMITS.normalActions,maxPages:BROWSER_RUN_LIMITS.maxPages,maxScreenshots:BROWSER_RUN_LIMITS.maxScreenshots,crashRetries:BROWSER_RUN_LIMITS.maxCrashRetries})});
      let prepared;try{prepared=await storage.prepareAutonomyTaskBundle({
        task:{id:taskId,ownerId,projectId:projectId||null,title:"Public browser research",objective:"Read one bounded public interactive source.",taskType:"public_web_browser",maxSteps:1,maxRetries:1,maxRuntimeMinutes:5,metadata:{requiredCapability:"remote_public_browser",browserJob:canonical,terminalReporting:{version:1,conversationId,runId}}},
        run:{id:taskId,ownerId,projectId:projectId||null,conversationId:conversationId||null,goal:"Read one bounded public interactive source.",status:"queued"},
        step:{taskId,stepId:"1:public_browser_read",stepType:"public_browser_read",capability:"remote_public_browser",operationFingerprint:digest(JSON.stringify(canonical)),status:"queued",input:{reason,allowedDomains:canonical.allowedDomains}},
        activity:{ownerId,projectId:projectId||null,runId:taskId,action:"browser_task_queued",tool:"public_browser_read",status:"queued",summary:"Queued bounded public browser research.",metadata:{taskId,reason}},
      });}catch(error){if(!["23505","autonomy_task_preparation_conflict"].includes(error?.code))throw error;const raced=await storage.getAutonomyTask(taskId,ownerId),racedRun=await storage.getRun(taskId,ownerId);if(!raced||!racedRun)throw error;return Object.freeze({task:raced,result:raced.metadata?.browserResult||null,idempotent:true});}
      const task=prepared.task;
      return Object.freeze({task,result:null,idempotent:false});
  }
  async function executeTask(taskId,{coordinatorId=workerId,expectedVersion,signal}={}){
      let task=await storage.getAutonomyTask(taskId,ownerId);if(!task||task.taskType!=="public_web_browser"||task.metadata?.requiredCapability!=="remote_public_browser")throw Object.assign(new Error("The durable browser task is unavailable."),{code:"browser_task_invalid"});
      if(!await storage.getRun(taskId,ownerId))throw Object.assign(new Error("The durable browser task is missing its task-owned execution run."),{code:"browser_task_persistence_invalid"});
      if(TERMINAL.has(task.status))return Object.freeze({task,result:task.metadata?.browserResult||null,idempotent:true});
      if(expectedVersion!==undefined&&task.stateVersion!==expectedVersion)throw Object.assign(new Error("The durable browser task version changed."),{code:"browser_task_fenced"});
      const canonical=task.metadata?.browserJob;if(![1,2].includes(canonical?.version))throw Object.assign(new Error("The durable browser specification is invalid."),{code:"browser_task_invalid"});
      const {heavy=false}=canonical.limits?.maxActions===BROWSER_RUN_LIMITS.heavyActions?{heavy:true}:{};const runId=task.metadata?.terminalReporting?.runId||task.id;
      let providerReservation,modelReservation,providerContacted=false;
      try{providerReservation=await providerBudget.reserve({taskId,runId,heavy});}
      catch(error){return blockBeforeExecution(task,error);}
      try{modelReservation=await modelCostController.reserve({model,stage:"browser_reasoning",serviceTier:"default",requestBody:{task:"Select only from server-validated read-only browser candidates."},maxOutputTokens:heavy?2048:1024,operationCapUsd:heavy?0.25:0.10,taskId,runId});}
      catch(error){await providerBudget.settle(providerReservation,{status:"released"});return blockBeforeExecution(task,error);}
      const claimed=await storage.claimAutonomyTask({ownerId,workerId:coordinatorId,capabilities:["remote_public_browser"],leaseMs:BROWSER_RUN_LIMITS.maxTtlMs,idempotencyKey:`browser:${taskId}:${task.stateVersion}`,taskId,expectedVersion:task.stateVersion,claimMetadata:{browserExecution:{version:1,coordinator:"persistent_worker",credentialsDelegatedToWorker:false}}});
      if(!claimed){await providerBudget.settle(providerReservation,{status:"released"});await modelCostController.release(modelReservation);throw Object.assign(new Error("The durable browser task could not be claimed."),{code:"browser_task_claim_failed"});}
      const claimLeaseToken=claimed.leaseToken,providerLock=await storage.acquireAutonomyLock({lockKey:`browser-provider:${ownerId}`,taskId,leaseToken:claimLeaseToken,expiresAt:claimed.leaseExpiresAt});
      if(!providerLock){await providerBudget.settle(providerReservation,{status:"released"});await modelCostController.release(modelReservation);task=await update(taskId,{status:"retrying",currentPhase:"waiting_for_browser_capacity",nextRunAt:new Date(clock().getTime()+5000).toISOString(),leaseOwner:null,leaseToken:null,leaseExpiresAt:null});return Object.freeze({task,result:null,idempotent:false});}
      task=claimed;const handoff={id:`browser_handoff_${digest(`${taskId}:${task.stateVersion}`).slice(0,24)}`,stepId:"1:public_browser_read",stepType:"public_browser_read"};task=await update(taskId,{metadata:{...task.metadata,localHandoff:handoff,browserExecution:{...task.metadata.browserExecution,coordinator:"persistent_worker",credentialsDelegatedToWorker:false}}});const attempt=await executionTruth.start({task,handoff,workerId:coordinatorId});
      await storage.updateAutonomyStep(taskId,handoff.stepId,{status:"running",startedAt:clock().toISOString()});
      let result=null,providerAccounting=null,lastError=null,heartbeatFailure=null,heartbeatTimer=null;const executionController=new AbortController(),cancel=()=>executionController.abort(signal?.reason instanceof Error?signal.reason:new DOMException("Browser task cancelled.","AbortError"));signal?.addEventListener?.("abort",cancel,{once:true});
      try{
        if(signal?.aborted)cancel();executionController.signal.throwIfAborted();
        await executionTruth.heartbeat(attemptInput(attempt),{phase:"starting_browser",executorStarted:true,progress:true});
        heartbeatTimer=setInterval(()=>{void (async()=>{const live=await storage.getAutonomyTask(taskId,ownerId);if(live?.status==="cancelled")return cancel();await executionTruth.heartbeat(attemptInput(attempt),{phase:live?.currentPhase||"starting_browser",executorStarted:true,progress:false});})().catch(error=>{heartbeatFailure=error;});},15000);heartbeatTimer.unref?.();
        task=await update(taskId,{status:"running",currentPhase:"starting_browser",currentStep:0,metadata:{...task.metadata,browserExecution:{...task.metadata.browserExecution,attemptId:attempt.id,generation:attempt.generation}}});
        for(let crash=0;crash<=canonical.limits.crashRetries;crash+=1){
          try{
            result=await browserAdapter.run({...canonical,signal:executionController.signal,onProgress:async event=>{
              executionController.signal.throwIfAborted();if(!ACTIVE_PHASES.has(event.phase))throw new BrowserRunError("browser_progress_invalid","The browser adapter emitted an invalid active phase.",{phase:bounded(event.phase,80)});
              const live=await storage.getAutonomyTask(taskId,ownerId);if(live?.status==="cancelled")throw new DOMException("Browser task cancelled.","AbortError");
              await executionTruth.heartbeat(attemptInput(attempt),{phase:event.phase,executorStarted:true,progress:true});task=await update(taskId,{status:"running",currentPhase:event.phase});await activity(task,`browser_${event.phase}`,"running",bounded(event.summary,300),event.metadata||{});if(event.phase==="starting_browser")providerContacted=true;
            }});if(heartbeatFailure)throw heartbeatFailure;break;
          }catch(error){lastError=error;if(error?.code!=="browser_session_failed"||crash>=canonical.limits.crashRetries)throw error;await activity(task,"browser_crash_retry","retrying","Retrying the isolated browser once after a provider session failure.",{retry:crash+1});}
        }
        const terminalCheck=await storage.getAutonomyTask(taskId,ownerId);if(terminalCheck?.status==="cancelled")cancel();executionController.signal.throwIfAborted();providerAccounting=await providerBudget.settle(providerReservation,{durationMs:result?.usage?.durationMs||0});await modelCostController.release(modelReservation);
        const extractedText=bounded(result.text,100000),sourceBinding=Object.freeze({url:result.finalUrl,domain:result.domain,title:result.title||null,retrievedAt:result.retrievedAt,contentHash:result.contentHash});
        const safeResult={status:"completed",finalUrl:result.finalUrl,domain:result.domain,title:result.title||null,text:extractedText,contentHash:result.contentHash,retrievedAt:result.retrievedAt,evidence:Object.freeze([Object.freeze({text:bounded(extractedText,2000),source:sourceBinding})]),observations:result.observations,usage:{...result.usage,providerCost:providerAccounting},limits:result.limits,isolation:result.isolation};
        await storage.updateAutonomyStep(taskId,handoff.stepId,{status:"completed",completedAt:clock().toISOString(),result:safeResult});
        task=await update(taskId,{status:"completed",currentPhase:"completed",currentStep:1,completedAt:clock().toISOString(),resultSummary:"Completed bounded public browser research.",leaseOwner:null,leaseToken:null,leaseExpiresAt:null,metadata:{...task.metadata,localHandoff:null,browserResult:safeResult}});
        await executionTruth.finish(attemptInput(attempt),{status:"completed",reason:"browser_completed"});await activity(task,"browser_completed","completed","Completed bounded public browser research.",{domain:result.domain,contentHash:result.contentHash});
        return Object.freeze({task,result:safeResult,idempotent:false});
      }catch(error){
        if(!providerAccounting)providerAccounting=await providerBudget.settle(providerReservation,providerContacted?{durationMs:Math.max(0,clock()-new Date(attempt.claimedAt))}:{status:"released"});await modelCostController.release(modelReservation).catch(()=>{});
        const cancelled=error?.name==="AbortError",blocked=BLOCKED.has(error?.code),status=cancelled?"cancelled":blocked?"blocked":"failed",code=cancelled?"browser_cancelled":bounded(error?.code,100)||"browser_session_failed",summary=cancelled?"The browser task was cancelled.":bounded(error?.message,500)||"The browser task failed safely.";
        const safeFailure={status,code,reason:summary,diagnostics:{stage:bounded(error?.safeDiagnostics?.stage,80)||null,domain:bounded(error?.safeDiagnostics?.domain,253)||null,status:Number.isInteger(error?.safeDiagnostics?.status)?error.safeDiagnostics.status:null,providerCode:bounded(error?.safeDiagnostics?.providerCode,80)||null},providerCost:providerAccounting};
        await storage.updateAutonomyStep(taskId,handoff.stepId,{status,errorCode:code,completedAt:clock().toISOString(),result:safeFailure});
        const durable=await storage.getAutonomyTask(taskId,ownerId);task=durable?.status==="cancelled"?durable:await update(taskId,{status,currentPhase:status,completedAt:clock().toISOString(),errorCode:code,blockedReason:summary,leaseOwner:null,leaseToken:null,leaseExpiresAt:null,metadata:{...task.metadata,localHandoff:null,browserResult:safeFailure}});
        await executionTruth.finish(attemptInput(attempt),{status,reason:code}).catch(()=>{});await activity(task,`browser_${status}`,status,summary,{errorCode:code});
        if(cancelled)throw error;return Object.freeze({task,result:safeFailure,idempotent:false,error:lastError||error});
      }finally{clearInterval(heartbeatTimer);signal?.removeEventListener?.("abort",cancel);await storage.releaseAutonomyLocks(taskId,claimLeaseToken).catch(()=>{});}
    }
  async function execute(input){const prepared=await prepare(input);if(TERMINAL.has(prepared.task.status))return prepared;return executeTask(prepared.task.id,{signal:input?.signal});}
  return Object.freeze({prepare,executeTask,execute});
}
