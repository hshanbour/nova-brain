import { createHash } from "node:crypto";
import { codingSpecificationHash, immutableCodingSpecification } from "./coding-executor.js";

const CODING_ACTION = /\b(?:build|code|implement|fix|improve|change|update|finish|repair|refactor|add)\b/i;
const CODEX_DELEGATION = /\b(?:use|delegate|hand\s*off|assign|send)\b[\s\S]{0,80}\bCodex\b|\bCodex\b[\s\S]{0,80}\b(?:coding|executor|implement|engineer)/i;
const SHA = /^[a-f0-9]{40}$/;
const ORCHESTRATION_ID = /^orchestration_[a-f0-9]{32}$/;
const SPECIFICATION_HASH = /^[a-f0-9]{64}$/;

const stable = (value) => Array.isArray(value)
  ? value.map(stable)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    : value;
const digest = (value) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const exact = (left, right) => JSON.stringify(stable(left)) === JSON.stringify(stable(right));
const cleanList = (value, max = 40) => Array.isArray(value)
  ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, max)
  : [];
const publicParent = (task) => Object.freeze({
  id: task.id,
  taskType: task.taskType,
  status: task.status,
  stateVersion: task.stateVersion,
  projectId: task.projectId,
  branch: task.branch,
  startingCommit: task.startingCommit,
});

export function isChatCodingDelegationRequest(message) {
  const value = String(message || "");
  return CODING_ACTION.test(value) && CODEX_DELEGATION.test(value);
}

export function createCodingDelegationService({ runtime, storage, ownerId, bindings = [], verifyRemote } = {}) {
  if (!runtime?.create || !storage?.getAutonomyTask || !storage?.createApproval || !storage?.getApproval || !storage?.decideApproval || typeof verifyRemote !== "function") {
    throw new Error("Coding delegation requires durable runtime, storage, and trusted remote resolution.");
  }
  const trusted = new Map(bindings.map((binding) => {
    if(!binding?.projectId||!binding?.workspaceId||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(binding?.repository||"")||!binding?.branch||["main","master"].includes(String(binding.branch).toLowerCase()))
      throw Object.assign(new Error("A trusted coding project binding is invalid."),{code:"coding_binding_invalid"});
    return [binding.projectId, Object.freeze({ ...binding })];
  }));
  const persist=async({input,context,binding,requestFingerprint,remote,identityVersion="coding-delegation-v1",trustedArtifact})=>{
      const objective = String(input?.objective || "").trim();
      const acceptanceCriteria = cleanList(input?.acceptanceCriteria);
      if (!objective || objective.length > 8_000 || acceptanceCriteria.length === 0) {
        throw Object.assign(new Error("A bounded coding objective and acceptance criteria are required."), { code: "coding_delegation_invalid" });
      }
      const parentTaskId = `orchestration_${digest([identityVersion, requestFingerprint, binding.projectId, binding.repository, binding.branch, remote.currentTip, trustedArtifact||null]).slice(0, 32)}`;
      const jobId = `job_${digest([parentTaskId, "codex-local-v1"]).slice(0, 32)}`;
      const job = immutableCodingSpecification({
        jobId,parentTaskId,objective,acceptanceCriteria,constraints:cleanList(input?.constraints),
        repository:Object.freeze({slug:binding.repository,branch:binding.branch,baseline:remote.currentTip}),
        projectId:binding.projectId,workspaceId:binding.workspaceId,
        delivery:Object.freeze({boundary:"local_commit",allowPush:false,allowDeploy:false}),
        verification:cleanList(input?.verification,30),trustedArtifact,
      });
      const existing=await storage.getAutonomyTask(parentTaskId,ownerId);
      if(existing){const prepared=existing.metadata?.codingDelegation,specificationHash=prepared?.codingJobHash;if(existing.taskType!=="coding_orchestration"||!prepared?.codingJob||specificationHash!==codingSpecificationHash(prepared.codingJob))throw Object.assign(new Error("The coding delegation identity is already bound to invalid or different durable inputs."),{code:"coding_delegation_identity_conflict"});return{task:publicParent(existing),creationRequest:Object.freeze({parentTaskId:existing.id,specificationHash}),duplicate:true};}
      const task=await runtime.create({id:parentTaskId,title:`Codex delegation: ${objective.slice(0,90)}`,objective,taskType:"coding_orchestration",projectId:binding.projectId,branch:binding.branch,startingCommit:remote.currentTip,currentCommit:remote.currentTip,maxSteps:1,maxRetries:0,maxRuntimeMinutes:120,metadata:{autoDispatch:false,parentTask:true,codingDelegation:{version:1,requestFingerprint,codingJob:job,codingJobHash:codingSpecificationHash(job)},...(trustedArtifact?{trustedArtifactAdoption:{version:1,sourceTaskId:trustedArtifact.sourceTaskId,sourceStateVersion:trustedArtifact.sourceStateVersion,specificationHash:codingSpecificationHash(job)}}:{}),...(context.conversationId?{terminalReporting:{version:1,conversationId:context.conversationId,runId:context.runId||null}}:{}),steps:[]}});
      return{task:publicParent(task),creationRequest:Object.freeze({parentTaskId:task.id,specificationHash:task.metadata.codingDelegation.codingJobHash}),duplicate:false};
  };
  const selectBinding=requestedProject=>requestedProject?trusted.get(requestedProject):trusted.size===1?[...trusted.values()][0]:null;
  const bindTrustedArtifactApproval=async(prepared,context={})=>{
    const handle=prepared?.creationRequest||{},argumentKeys=Object.keys(handle).sort();
    if(argumentKeys.length!==2||argumentKeys[0]!=="parentTaskId"||argumentKeys[1]!=="specificationHash"||!ORCHESTRATION_ID.test(handle.parentTaskId||"")||!SPECIFICATION_HASH.test(handle.specificationHash||""))throw Object.assign(new Error("The trusted artifact creation handle is invalid."),{code:"coding_creation_handle_invalid"});
    let parent=await storage.getAutonomyTask(handle.parentTaskId,ownerId);
    const stored=parent?.metadata?.codingDelegation,job=stored?.codingJob,storedHash=job?codingSpecificationHash(job):null,conversationId=parent?.metadata?.terminalReporting?.conversationId;
    if(!parent||parent.taskType!=="coding_orchestration"||stored?.codingJobHash!==storedHash||storedHash!==handle.specificationHash||parent.metadata?.trustedArtifactAdoption?.specificationHash!==storedHash)throw Object.assign(new Error("The trusted artifact preparation is no longer canonical."),{code:"coding_parent_specification_changed"});
    if(typeof context.conversationId!=="string"||!context.conversationId||conversationId!==context.conversationId)throw Object.assign(new Error("The trusted artifact approval is not bound to this conversation."),{code:"trusted_artifact_conversation_unbound"});
    const approvalId=`approval_coding_${digest(["trusted-artifact-coding-approval-v1",handle.parentTaskId,handle.specificationHash]).slice(0,32)}`,approvalInput={id:approvalId,ownerId,projectId:parent.projectId,runId:parent.id,tool:"coding_job_create",reason:"Owner approval is required before Codex may integrate the trusted historical artifact on the current baseline.",riskLevel:"HIGH_IMPACT",arguments:handle};
    const bound=parent.approvalState?.approvalId===approvalId&&parent.approvalState?.tool==="coding_job_create"&&exact(parent.approvalState?.arguments,handle);
    if(parent.metadata?.delegatedTaskId)return{...prepared,task:publicParent(parent),approval:await storage.getApproval(approvalId,ownerId),duplicate:true};
    let transitioned=false;
    if(parent.status==="waiting_for_approval"&&bound){/* restart-safe convergence */}
    else{
      if(parent.status!=="queued"||parent.stateVersion!==1||parent.leaseOwner||parent.leaseToken)throw Object.assign(new Error("The trusted artifact parent cannot enter its approval boundary from this state."),{code:"coding_parent_transition_invalid"});
      const updated=await storage.updateAutonomyTask(parent.id,ownerId,{status:"waiting_for_approval",currentPhase:"waiting_for_approval",nextRunAt:null,blockedReason:"Owner approval is required before Codex may integrate the trusted historical artifact.",approvalState:{approvalId,approved:false,tool:"coding_job_create",stepId:"delegation:create",arguments:handle,bindingSource:"trusted_artifact_adoption"}},parent.stateVersion);
      if(updated){parent=updated;transitioned=true;}else{parent=await storage.getAutonomyTask(parent.id,ownerId);const converged=parent?.status==="waiting_for_approval"&&parent.approvalState?.approvalId===approvalId&&exact(parent.approvalState?.arguments,handle);if(!converged)throw Object.assign(new Error("The trusted artifact parent changed before approval binding completed."),{code:"coding_parent_transition_conflict"});}
    }
    let approval=await storage.getApproval(approvalId,ownerId);
    if(!approval){try{approval=await storage.createApproval(approvalInput);}catch(error){if(error?.code!=="23505"&&error?.cause?.code!=="23505")throw error;approval=await storage.getApproval(approvalId,ownerId);}}
    if(!approval||approval.ownerId!==ownerId||approval.projectId!==parent.projectId||approval.runId!==parent.id||approval.tool!=="coding_job_create"||!exact(approval.arguments,handle))throw Object.assign(new Error("The trusted artifact approval binding is invalid."),{code:"coding_approval_binding_invalid"});
    if(transitioned)await storage.appendActivity({ownerId,projectId:parent.projectId,runId:parent.id,action:"trusted_artifact_integration_approval_requested",tool:"coding_job_create",status:"waiting",summary:"Trusted artifact integration awaits owner approval.",metadata:{taskId:parent.id,sourceTaskId:parent.metadata?.trustedArtifactAdoption?.sourceTaskId,approvalId:approval.id,phase:"waiting_for_approval"}}).catch(()=>null);
    return{...prepared,task:publicParent(parent),approval,duplicate:prepared.duplicate===true||!transitioned};
  };
  return Object.freeze({
    async prepare(input, context = {}) {
      const requestedProject = context.projectId || input?.projectId || null;
      const binding = requestedProject ? trusted.get(requestedProject) : trusted.size === 1 ? [...trusted.values()][0] : null;
      if (requestedProject && !binding) {
        throw Object.assign(new Error("The requested project is not an approved coding binding."), { code: "coding_repository_binding_rejected" });
      }
      if (!binding) {
        const error = new Error(trusted.size > 1 ? "Which trusted project should Codex modify?" : "No trusted Codex project binding is available.");
        error.code = trusted.size > 1 ? "coding_project_binding_ambiguous" : "coding_project_binding_missing";
        throw error;
      }
      if (input?.projectId && input.projectId !== binding.projectId) {
        throw Object.assign(new Error("The requested project is not an approved coding binding."), { code: "coding_repository_binding_rejected" });
      }
      const requestFingerprint = String(context.delegationRequestFingerprint || "");
      if (!/^[a-f0-9]{64}$/.test(requestFingerprint)) {
        throw Object.assign(new Error("The Chat delegation request is not bound to its original message."), { code: "coding_delegation_unbound" });
      }
      const remote = await verifyRemote({ repository: binding.repository, branch: binding.branch, requiredAncestors: [], signal: context.signal });
      if (!SHA.test(remote?.currentTip || "")) {
        throw Object.assign(new Error("The trusted coding baseline could not be resolved."), { code: "coding_repository_not_resolved" });
      }
      return persist({input,context,binding,requestFingerprint,remote});
    },
    async prepareTrustedArtifact(input,context={}){
      const artifact=input?.trustedArtifact,requestedProject=context.projectId||input?.projectId||null,binding=selectBinding(requestedProject);
      if(!binding||!artifact||artifact.repository!==binding.repository)throw Object.assign(new Error("The historical artifact does not match a trusted coding binding."),{code:"trusted_artifact_repository_rejected"});
      const remote=await verifyRemote({repository:binding.repository,branch:binding.branch,requiredAncestors:[],signal:context.signal});
      if(!SHA.test(remote?.currentTip||""))throw Object.assign(new Error("The current integration baseline could not be resolved."),{code:"coding_repository_not_resolved"});
      const requestFingerprint=digest(["trusted-artifact-adoption-v1",artifact,context.conversationId||null]);
      const prepared=await persist({input:{...input,objective:`Integrate the trusted completed artifact ${artifact.sourceTaskId} at ${artifact.commitSha} onto the current ${binding.branch} baseline without changing its product intent.`,acceptanceCriteria:["The trusted historical artifact is ported without unrelated changes.","Relevant regression tests pass on the current integration baseline.","A new local-only coding artifact is retained for separate shipping approval."],constraints:["Use only the server-bound historical artifact provenance.","Do not push or deploy.",...(input?.constraints||[])],verification:["Verify the historical commit/ref identity before mutation.","Run focused and relevant broader tests.",...(input?.verification||[])]},context,binding,requestFingerprint,remote,identityVersion:"trusted-artifact-adoption-v1",trustedArtifact:artifact});
      try{return await bindTrustedArtifactApproval(prepared,context);}catch(error){
        const parent=await storage.getAutonomyTask(prepared.task.id,ownerId).catch(()=>null);
        if(parent?.status==="waiting_for_approval"&&parent.approvalState?.bindingSource==="trusted_artifact_adoption")await storage.decideApproval(parent.approvalState.approvalId,ownerId,"rejected").catch(()=>null);
        if(["queued","waiting_for_approval"].includes(parent?.status)&&!parent.leaseOwner&&!parent.leaseToken)await storage.updateAutonomyTask(parent.id,ownerId,{status:"blocked",currentPhase:"coding_creation_failed",nextRunAt:null,errorCode:"coding_creation_transition_failed",blockedReason:"Trusted artifact preparation completed, but the approval-bound coding transition failed safely."},parent.stateVersion).catch(()=>null);
        throw error;
      }
    },
  });
}

export function codingDelegationFingerprint(message) {
  return digest(["chat-coding-delegation-v1", String(message || "").trim().replace(/\s+/g, " ")]);
}
