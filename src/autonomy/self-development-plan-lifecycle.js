import {createHash} from "node:crypto";

export const IMPLEMENTATION_PLAN_PROVENANCE_VERSION="2";
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
export const lifecycleHash=value=>createHash("sha256").update(typeof value==="string"?value:JSON.stringify(stable(value))).digest("hex");
export const canonicalContent=value=>String(value??"").replace(/\r\n/g,"\n").replace(/\r/g,"\n");
export const canonicalContentHash=value=>lifecycleHash(canonicalContent(value));

export function bindImplementationPlan({task,plan,evidence,readStepIds=[],plannerAttempt=1}){
  const evidenceGenerationId=lifecycleHash({taskId:task.id,currentCommit:task.currentCommit,evidence:evidence.map(item=>({path:item.path,contentHash:canonicalContentHash(item.content)})),readStepIds});
  const mutationPreconditions=plan.files.map(file=>({path:file.path,operation:file.operation,...(file.operation==="replace"?{expectedContentHash:canonicalContentHash(file.expectedContent)}:{})}));
  const generationId=lifecycleHash({taskId:task.id,currentCommit:task.currentCommit,evidenceGenerationId,planHash:plan.planHash,mutationPreconditions,plannerAttempt});
  return Object.freeze({version:IMPLEMENTATION_PLAN_PROVENANCE_VERSION,generationId,authority:"active",taskId:task.id,currentCommit:task.currentCommit,evidenceGenerationId,plannerAttempt,mutationPreconditions});
}

export function rebindEquivalentImplementationPlan({task,plan,evidence,readStepIds=[]}){
  const contents=new Map(evidence.map(item=>[item.path,item.content]));
  if(!plan?.files?.length||plan.files.some(file=>file.operation==="replace"&&(!contents.has(file.path)||canonicalContentHash(file.expectedContent)!==canonicalContentHash(contents.get(file.path)))))throw Object.assign(new Error("Complete exact mutation-precondition equivalence is required to rebind an implementation plan."),{code:"implementation_plan_equivalence_unproven",retryable:false});
  const rebound={...plan};delete rebound.provenance;rebound.provenance=bindImplementationPlan({task,plan:rebound,evidence,readStepIds,plannerAttempt:(plan.provenance?.plannerAttempt||0)+1});return rebound;
}

export function planLifecycleMetadata(task,plan){
  const provenance=plan?.provenance;if(!provenance)return task.metadata;
  const history=(task.metadata?.implementationPlanGenerations||[]).map(item=>item.authority==="active"?{...item,authority:"superseded",supersededBy:provenance.generationId}:item);
  return{...task.metadata,selfDevelopmentImplementationPlan:plan,activeImplementationPlanGeneration:provenance.generationId,implementationPlanGenerations:[...history,{...provenance,planHash:plan.planHash}]};
}

export function assertActiveImplementationPlan(task,files){
  const plan=task.metadata?.selfDevelopmentImplementationPlan,provenance=plan?.provenance,history=task.metadata?.implementationPlanGenerations||[],active=history.filter(item=>item.authority==="active");
  const fail=(code,message)=>{throw Object.assign(new Error(message),{code,retryable:false,safeDiagnostics:{taskId:task.id,taskCurrentCommit:task.currentCommit,planGenerationId:provenance?.generationId||null,planCurrentCommit:provenance?.currentCommit||null,evidenceGenerationId:provenance?.evidenceGenerationId||null}});};
  if(!provenance||provenance.version!==IMPLEMENTATION_PLAN_PROVENANCE_VERSION)fail("implementation_plan_provenance_missing","A mutation-authoritative implementation plan generation is required.");
  if(provenance.taskId!==task.id||provenance.currentCommit!==task.currentCommit)fail("implementation_plan_stale","The implementation plan is not bound to the exact task commit.");
  if(task.metadata?.activeImplementationPlanGeneration!==provenance.generationId||active.length!==1||active[0].generationId!==provenance.generationId)fail("implementation_plan_superseded","The implementation plan is not the unique active generation.");
  if(!Array.isArray(files)||!Array.isArray(provenance.mutationPreconditions))fail("implementation_plan_precondition_mismatch","Implementation files do not match the active plan preconditions.");
  const expected=new Map(provenance.mutationPreconditions.map(item=>[item.path,item]));
  if(files.length!==expected.size||files.some(file=>{const bound=expected.get(file.path);return!bound||bound.operation!==file.operation||(file.operation==="replace"&&bound.expectedContentHash!==canonicalContentHash(file.expectedContent));}))fail("implementation_plan_precondition_mismatch","Implementation files do not match the active plan preconditions.");
  return provenance;
}

export function activeContinuationExceeded(task){
  const generation=task.metadata?.activeContinuation;
  if(!generation)return task.currentStep>=task.maxSteps;
  return task.currentStep-generation.startStep>=generation.maxSteps;
}

export function createActiveContinuation({task,startStep,plannedSteps,repairLimit=2,recoveryClass}){
  const maxSteps=Math.min(30,Math.max(1,plannedSteps+Math.max(0,Math.min(3,repairLimit))*2));
  return{version:1,generationId:lifecycleHash({taskId:task.id,startStep,currentCommit:task.currentCommit,recoveryClass,ordinal:(task.metadata?.continuationHistory||[]).length+1}),startStep,maxSteps,recoveryClass};
}
