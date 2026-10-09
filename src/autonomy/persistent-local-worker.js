import {randomUUID} from "node:crypto";
import {createToolRegistry} from "../tools/tool-registry.js";
import {registerHandsTools} from "../tools/hands-runtime.js";
import {canonicalSchemaDiagnostic,localSchemaDiagnostic} from "./schema-diagnostics.js";
import {REVIEW_REMEDIATION_CLASS,reviewRemediationDescriptorForClass} from "./review-remediation-scope.js";
import {registerCodexExecutorTool} from "../tools/codex-executor-tool.js";
import {CODING_ACTIVE_PROGRESS_PHASES,requireCodingTaskId} from "./coding-executor.js";

const ALLOWED=new Set(["repo_read_task_owned_local","repo_apply_patch","repo_validate_patch","test_run","test_run_full","repo_diff","repo_review_commit","git_commit","git_integrate_reviewed_commit","codex_execute"]);
const SHA=/^[a-f0-9]{40}$/;
export function createCodingProgressReporter(client){
  return async({context,phase,summary})=>{
    const taskId=requireCodingTaskId(context?.taskId);
    if(!CODING_ACTIVE_PROGRESS_PHASES.includes(phase))throw Object.assign(new Error("Coding progress phase is invalid."),{code:"coding_progress_invalid"});
    return client.request(`/api/admin/coding-jobs/${encodeURIComponent(taskId)}/progress`,{handoffId:context.handoffId,phase,summary,executionAttempt:context.executionAttempt});
  };
}
function exactApprovedDelivery(task,job,{repository,branch}){
  const binding=job?.approvedDelivery;
  return Boolean(task?.mode==="local_handoff"&&task.stepType==="push"&&job?.tool==="git_push"&&job.stepType==="push"&&binding?.contractVersion===1&&["self_development","artifact_delivery"].includes(binding.taskType)&&binding.taskId===task.id&&binding.taskId===job.taskId&&typeof binding.approvalId==="string"&&binding.approvalId.length>0&&binding.approved===true&&binding.revoked===false&&binding.reviewedCommit===task.expectedCommit&&binding.reviewedCommit===job.expectedCommit&&binding.reviewedCommit===job.arguments?.commitSha&&SHA.test(binding.reviewedCommit)&&binding.repository===repository&&binding.repository===job.repository&&binding.branch===branch&&binding.branch===task.branch&&binding.branch===job.branch&&binding.branch===job.arguments?.branch&&!['main','master'].includes(binding.branch)&&binding.logicalStepId===job.stepId&&binding.logicalStepId.endsWith(":push")&&binding.localHandoff===true&&binding.reviewHistoryImmutable===true&&binding.postReviewMutation===false&&binding.deliveryConsumed===false&&binding.gitPushSucceeded===false&&binding.secondLogicalPush===false&&binding.repositoryProvenanceValid===true);
}
function exactExecutionScope(task,job,{repository,branch,root,runtimeVersion,workerId}){
  const scope=job?.executionScope,canonical=value=>String(value||"").replaceAll("\\","/").replace(/\/$/,"").toLowerCase();
  return !scope?task.executionScopeRequired!==true:Boolean(scope.taskId===task.id&&scope.repository===repository&&scope.branch===branch&&scope.currentCommit===task.expectedCommit&&scope.runtimeVersion===runtimeVersion&&scope.workerId===workerId&&canonical(scope.workspaceRoot)===canonical(root)&&scope.continuationGenerationId===task.continuationGenerationId&&((job.stepId===scope.applyStepId&&job.tool==="repo_apply_patch"&&job.stepType==="apply_patch")||(job.stepId===scope.testStepId&&job.tool==="test_run"&&job.stepType==="run_focused_tests")));
}
function exactFullTestScope(task,job,{repository,branch,root,runtimeVersion,workerId}){
  const scope=job?.fullTestScope,canonical=value=>String(value||"").replaceAll("\\","/").replace(/\/$/,"").toLowerCase();
  return !scope?task.fullTestScopeRequired!==true:Boolean(!job.executionScope&&(!task.fullTestScopeRecoveryClass||scope.recoveryClass===task.fullTestScopeRecoveryClass)&&scope.taskId===task.id&&scope.repository===repository&&scope.branch===branch&&scope.currentCommit===task.expectedCommit&&scope.runtimeVersion===runtimeVersion&&scope.workerId===workerId&&canonical(scope.workspaceRoot)===canonical(root)&&scope.continuationGenerationId===task.continuationGenerationId&&job.stepId===scope.fullTestStepId&&job.tool==="test_run_full"&&job.stepType==="run_full_tests");
}
function exactReviewRemediationScope(task,job,{repository,branch,root,runtimeVersion,workerId}){
  const scope=job?.reviewRemediationScope,canonical=value=>String(value||"").replaceAll("\\","/").replace(/\/$/,"").toLowerCase();
  if(!scope)return task.reviewRemediationScopeRequired!==true;
  const expectedClass=task.reviewRemediationRecoveryClass||REVIEW_REMEDIATION_CLASS,actualClass=scope.recoveryClass||REVIEW_REMEDIATION_CLASS;
  if(!reviewRemediationDescriptorForClass(expectedClass)||actualClass!==expectedClass)return false;
  const steps=new Map([...(scope.readStepIds||[]).map(id=>[id,["read_files","repo_read_task_owned_local"]]),[scope.validateStepId,["validate_patch","repo_validate_patch"]],[scope.applyStepId,["apply_patch","repo_apply_patch"]],[scope.focusedStepId,["run_focused_tests","test_run"]],[scope.fullTestStepId,["run_full_tests","test_run_full"]]]),expected=steps.get(job.stepId);
  return Boolean(task.reviewRemediationScopeRequired===true&&!job.executionScope&&!job.fullTestScope&&!job.approvedDelivery&&scope.taskId===task.id&&scope.repository===repository&&scope.branch===branch&&scope.currentCommit===task.expectedCommit&&scope.runtimeVersion===runtimeVersion&&scope.workerId===workerId&&canonical(scope.workspaceRoot)===canonical(root)&&scope.continuationGenerationId===task.continuationGenerationId&&expected&&expected[0]===job.stepType&&expected[1]===job.tool);
}
export function createPersistentLocalWorker({client:sourceClient,root,branch,repository="hshanbour/nova-brain",runtimeVersion,gitExecutable, codexExecutable,environment=process.env,workerId=`persistent-local-${randomUUID()}`,registry}={}){
  if(!sourceClient)throw new Error("Protected local Worker client is required.");
  if(!branch||["main","master"].includes(branch))throw Object.assign(new Error("An explicit non-production worker branch is required."),{code:"worker_repository_branch_required"});
  let prefetchedDispatch=null;
  const client={request(path,input,options){if(path==="/api/admin/worker/auto-dispatch/next"&&prefetchedDispatch){const value=prefetchedDispatch;prefetchedDispatch=null;return Promise.resolve(value);}return sourceClient.request(path,input,options);}};
  if(!root&&!registry)throw Object.assign(new Error("An explicit controlled repository root is required."),{code:"repository_context_unproven"});
  const controlledRoot=root||"injected-registry";
  const repositoryContext=Object.freeze({version:1,source:"persistent_worker_startup",repository,root:controlledRoot,branch});
  const tools=registry||createToolRegistry();if(!registry){registerHandsTools(tools,{root:controlledRoot,environment:{...environment,VERCEL:"",NOVA_BRAIN_DEVELOPMENT_BRANCH:branch}});registerCodexExecutorTool(tools,{root:controlledRoot,repository,branch,gitExecutable,codexExecutable,activity:createCodingProgressReporter(client)});}
  async function handoff(task){
    const key=`${task.id}:${task.stateVersion}:${task.stepType||"local"}`,deliveryCandidate=task.mode==="local_handoff"&&task.stepType==="push",claimed=await client.request("/api/admin/worker/handoff/claim",{workerId,runtimeVersion,repository,repositoryRoot:controlledRoot,continuationGenerationId:task.continuationGenerationId,capabilities:["repo_mutate_local","test_local","repo_read_remote","codex_local",...(deliveryCandidate?["approved_delivery_git_push"]:[])],expectedBranch:task.branch,expectedCommit:task.expectedCommit,taskId:task.id,idempotencyKey:key});
    if(!claimed.claimed)return{worked:false,taskId:task.id};
    const job=claimed.handoff,approvedPush=exactApprovedDelivery(task,job,{repository,branch});
    if(!job||job.taskId!==task.id||job.branch!==branch||job.expectedCommit!==task.expectedCommit||(!ALLOWED.has(job.tool)&&!approvedPush)||!exactReviewRemediationScope(task,job,{repository,branch,root:controlledRoot,runtimeVersion,workerId})||!exactFullTestScope(task,job,{repository,branch,root:controlledRoot,runtimeVersion,workerId})||!exactExecutionScope(task,job,{repository,branch,root:controlledRoot,runtimeVersion,workerId}))throw Object.assign(new Error("Server returned an invalid bounded handoff."),{code:"invalid_handoff"});
    const attempt=job.executionAttempt,attemptPayload=attempt?{id:attempt.id,generation:attempt.generation,fenceToken:attempt.fenceToken}:null,heartbeat=async(phase,executorStarted=false,progress=false)=>attempt?client.request(`/api/admin/worker/execution-attempts/${encodeURIComponent(attempt.id)}/heartbeat`,{taskId:task.id,handoffId:job.handoffId,workerId,generation:attempt.generation,fenceToken:attempt.fenceToken,phase,executorStarted,progress}):null;
    const context={taskId:task.id,handoffId:job.handoffId,stepId:job.stepId,stepType:job.stepType,tool:job.tool,schemaVersion:"1",validationLayer:"local_worker",payloadProvenance:"server_handoff",continuationGenerationId:task.continuationGenerationId,executionAttempt:attemptPayload};
    try{
      if(job.tool==="codex_execute")requireCodingTaskId(task.id);
      if(!job.arguments||typeof job.arguments!=="object"||Array.isArray(job.arguments))throw Object.assign(new Error("Handoff arguments must be an object."),{code:"schema_mismatch",safeDiagnostics:canonicalSchemaDiagnostic({...context,fieldPath:"handoff.arguments",expected:{type:"object"},received:job.arguments,validationCode:"invalid_type"})});
      await heartbeat("preparing",false,true);const executorStarted=job.tool!=="codex_execute";if(executorStarted)await heartbeat("executing",true,true);const controller=new AbortController(),timer=attempt?setInterval(()=>heartbeat(null,executorStarted,false).catch(()=>controller.abort(Object.assign(new Error("Execution attempt heartbeat was fenced."),{code:"execution_attempt_stale"}))),15000):null;
      const started=Date.now();let raw;try{raw=await tools.execute(job.tool,job.arguments,{taskId:task.id,runId:task.id,handoffId:job.handoffId,stepId:job.stepId,workerId,runtimeVersion,projectId:"nova-brain",continuationGenerationId:context.continuationGenerationId,executionAttempt:attemptPayload,signal:controller.signal,...(job.reviewRemediationScope?{reviewRemediationScope:job.reviewRemediationScope}:{}),...(job.executionScope?{executionScope:job.executionScope}:{}),...(job.fullTestScope?{fullTestScope:job.fullTestScope}:{}),approvalId:approvedPush?job.approvedDelivery.approvalId:undefined,schemaDiagnosticContext:{...context,validationLayer:"hands_tool_registry",payloadProvenance:"server_handoff_arguments"},repositoryContext:{...repositoryContext,expectedHead:job.expectedCommit,source:"persistent_worker_handoff"}});}finally{if(timer)clearInterval(timer);}
      if(raw?.ok===false)throw Object.assign(new Error(raw.error?.message||"Bounded local step failed."),{code:raw.error?.code||"worker_failed",safeDiagnostics:raw.error?.evidence});
      const result=raw?.ok===undefined?{...raw,ok:true}:raw;
      const completed=await client.request(`/api/admin/worker/handoff/${encodeURIComponent(job.handoffId)}/complete`,{taskId:task.id,workerId,idempotencyKey:key,executionAttempt:attemptPayload,result:{...result,durationMs:result.durationMs??Date.now()-started}});
      return{worked:true,taskId:task.id,status:completed.status};
    }catch(error){
      if(error.code==="schema_mismatch")error.safeDiagnostics=canonicalSchemaDiagnostic({...context,...error.safeDiagnostics});
      await client.request(`/api/admin/worker/handoff/${encodeURIComponent(job.handoffId)}/fail`,{taskId:task.id,workerId,idempotencyKey:key,executionAttempt:attemptPayload,error:{code:error.code||"worker_failed",message:String(error.message).slice(0,300),...(error.safeDiagnostics?{diagnostics:error.safeDiagnostics}:{})}});
      if(error.code==="schema_mismatch")error.localDiagnostic=localSchemaDiagnostic(error.safeDiagnostics);
      throw error;
    }
  }
  async function runOnce(){const found=await client.request("/api/admin/worker/auto-dispatch/next",{workerId,branch});if(!found.dispatched)return{worked:false};const task=found.task;if(!task)throw Object.assign(new Error("Dispatch binding is invalid."),{code:"invalid_dispatch"});if(task.mode==="remote_browser"){if(!/^web_[a-f0-9]{32}$/.test(task.id)||task.branch!==null||task.expectedCommit!==null||task.stepType!=="public_browser_read")throw Object.assign(new Error("Remote browser dispatch binding is invalid."),{code:"invalid_dispatch"});const result=await client.request(`/api/admin/web-browser/tasks/${encodeURIComponent(task.id)}/execute`,{workerId,expectedVersion:task.stateVersion},{timeoutMs:330000});return{worked:true,taskId:task.id,status:result.task.status,stepType:"public_browser_read"};}if(task.mode==="remote_research"){if(!/^web_[a-f0-9]{32}$/.test(task.id)||task.branch!==null||task.expectedCommit!==null||!["public_web_research","research_synthesis"].includes(task.stepType))throw Object.assign(new Error("Remote research dispatch binding is invalid."),{code:"invalid_dispatch"});const result=await client.request(`/api/admin/web-research/tasks/${encodeURIComponent(task.id)}/execute`,{workerId,expectedVersion:task.stateVersion},{timeoutMs:330000});return{worked:true,taskId:task.id,status:result.task.status,stepType:task.stepType};}if(task.branch!==branch)throw Object.assign(new Error("Dispatch binding is invalid."),{code:"invalid_dispatch"});if(task.mode==="local_handoff")return handoff(task);if(task.mode==="scope_resolution"){
    const replanned=await client.request(`/api/admin/self-development/tasks/${encodeURIComponent(task.id)}/replan-discovery-only`,{expectedVersion:task.stateVersion});
    return{worked:true,taskId:task.id,status:replanned.task.status,stepType:"automatic_scope_resolution"};
  }const result=await client.request(`/api/autonomy/worker/tasks/${encodeURIComponent(task.id)}/tick`,{idempotencyKey:`auto:${task.id}:${task.stateVersion}`});if(result.status==="blocked"&&result.task?.errorCode==="implementation_scope_required"){
    const replanned=await client.request(`/api/admin/self-development/tasks/${encodeURIComponent(task.id)}/replan-discovery-only`,{expectedVersion:result.task.stateVersion});
    return{worked:true,taskId:task.id,status:replanned.task.status,stepType:"automatic_discovery_replan"};
  }return{worked:true,taskId:task.id,status:result.status,stepType:result.stepType};}
  const runOnceWithChannels=async()=>{const found=await sourceClient.request("/api/admin/worker/auto-dispatch/next",{workerId,branch});if(found.dispatched){prefetchedDispatch=found;return runOnce();}if(!found.channelPolling?.includes("whatsapp"))return{worked:false};const channel=await sourceClient.request("/api/admin/worker/whatsapp/tick",{workerId});return channel?.worked?{...channel,stepType:"whatsapp_inbound"}:{worked:false};};
  return Object.freeze({workerId,runOnce:runOnceWithChannels});
}

export async function runPersistentWorkerLoop({worker,intervalMs=5000,delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),shouldStop=()=>false,onState=()=>{},maxIterations=Infinity}={}){
  if(!worker?.runOnce)throw new Error("Persistent Worker instance is required.");const interval=Math.max(1000,Math.min(60000,Number(intervalMs)||5000));let iterations=0;
  while(!shouldStop()&&iterations<maxIterations){iterations+=1;await onState({state:"polling",iterations});try{const result=await worker.runOnce();await onState({state:result.worked?"executing":"idle",taskId:result.taskId||null,status:result.status||null,lastSuccessfulPoll:new Date().toISOString(),iterations});}catch(error){await onState({state:"retrying",code:error.code||error.name||"unexpected_error",schemaDiagnostic:error.localDiagnostic||null,iterations});}if(!shouldStop()&&iterations<maxIterations)await delay(interval);}
  return{stopped:true,iterations};
}
