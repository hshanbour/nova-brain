import {createHash} from "node:crypto";

const TYPES=new Set(["verified_fact","owner_claim","preference","project_decision","hypothesis","unresolved_question","completed_task_outcome","failed_task_lesson","correction"]);
const SECRET=/\b(?:sk-[A-Za-z0-9_-]{10,}|github_pat_[A-Za-z0-9_]{10,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+)/i;
const EXPLICIT_MEMORY=/\b(?:remember|save (?:this|that) (?:to|in) memory|forget (?:this|that))\b|(?:تذكّر|احفظ.{0,20}الذاكرة|انسى)/iu;
const PREFERENCE=/\b(?:i prefer|my preference is|i like nova to|i want nova to|please always|please never)\b|(?:بفضّل|أفضل|بحب نوفا|دائماً اعمل|لا تعمل أبداً)/iu;
const DECISION=/\b(?:we decided|i decided|the decision is|from now on)\b|(?:قررنا|قررت|القرار هو|من الآن)/iu;
const CORRECTION=/\b(?:correction|actually[, :]|that(?:'s| is) (?:wrong|outdated)|not .{1,80} but )\b|(?:تصحيح|بالحقيقة|المعلومة القديمة|مش .{1,80} بل )/iu;
const OWNER_CLAIM=/\b(?:my name is|i am based in|i live in|i own|i run|my business is|my company is|my project is)\b|(?:اسمي|أنا ساكن|أنا مقيم|بملك|مشروعي|شركتي|عملي هو)/iu;
const HYPOTHESIS=/\b(?:hypothesis|we suspect|i suspect|might be|may be)\b|(?:فرضية|بنشك|أشك أن|ممكن يكون)/iu;
const UNRESOLVED=/\b(?:unresolved question|open question|we need to verify|needs verification)\b|(?:سؤال مفتوح|غير محسوم|لازم نتحقق|بحاجة للتحقق)/iu;
const terminalStatus=new Set(["completed","failed"]);
const clean=(value,max=4000)=>String(value||"").replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim().slice(0,max);
const fingerprint=(parts)=>createHash("sha256").update(parts.map(value=>String(value??"").normalize("NFKC").toLowerCase().replace(/\s+/g," ").trim()).join("\u001f")).digest("hex");

export function classifyTypedMemoryCandidate(message){
  const content=clean(message);
  if(content.length<8||content.length>4000||SECRET.test(content)||EXPLICIT_MEMORY.test(content))return null;
  const candidateType=CORRECTION.test(content)?"correction":PREFERENCE.test(content)?"preference":DECISION.test(content)?"project_decision":OWNER_CLAIM.test(content)?"owner_claim":UNRESOLVED.test(content)?"unresolved_question":HYPOTHESIS.test(content)?"hypothesis":null;
  return candidateType?Object.freeze({candidateType,content}):null;
}

export function createMemoryLearningService({storage,ownerId}={}){
  if(!storage||!ownerId||typeof storage.createMemoryCandidate!=="function")throw new Error("Memory learning requires candidate-capable storage and an owner.");
  async function create(input){
    if(!TYPES.has(input.candidateType))throw new Error("memory_candidate_type_invalid");
    const digest=fingerprint([input.sourceKind,input.sourceTaskId||"",input.candidateType,input.content,input.projectId]),id=`memory-candidate-${digest.slice(0,32)}`;
    const existing=await storage.getMemoryCandidate(id,ownerId);if(existing)return{candidate:existing,created:false};
    const candidate=await storage.createMemoryCandidate({...input,id,ownerId,fingerprint:digest,privacy:input.privacy||"private",scope:input.scope|| (input.projectId?"project":"global")});
    await storage.appendActivity({ownerId,projectId:candidate.projectId||null,runId:candidate.sourceRunId||null,action:"memory_candidate_created",status:"pending",summary:"Nova captured evidence for owner review; no memory was promoted automatically.",metadata:{candidateId:candidate.id,candidateType:candidate.candidateType,sourceKind:candidate.sourceKind,sourceTaskId:candidate.sourceTaskId||null}});
    return{candidate,created:true};
  }
  async function observeConversationTurn({message,conversationId,userMessageId,assistantMessageId,runId,projectId}={}){
    const classified=classifyTypedMemoryCandidate(message);if(!classified)return null;
    return create({...classified,projectId:projectId||null,conversationId,sourceMessageId:userMessageId,sourceRunId:runId||null,sourceTaskId:null,sourceKind:"typed_conversation",provenance:"owner-authored typed conversation",evidence:{version:1,userMessageId,assistantMessageId:assistantMessageId||null,runId:runId||null,conversationId,extraction:"deterministic_v1",authoritative:false}});
  }
  async function observeTaskOutcome(task,report){
    if(!task||!terminalStatus.has(task.status)||!task.id)return null;
    const failed=task.status==="failed",raw=failed?(task.blockedReason||task.errorCode||"The durable task failed safely."):(task.metadata?.researchFinalAnswer||task.resultSummary||report||"The durable task completed."),summary=clean(raw,failed?2000:3500);
    if(!summary||SECRET.test(summary))return null;
    const content=failed?`Failed-task lesson (${task.id}): ${summary}`:`Completed-task outcome (${task.id}): ${summary}`;
    const snapshot=task.metadata?.researchJob?.taskContextSnapshot;
    return create({candidateType:failed?"failed_task_lesson":"completed_task_outcome",content,projectId:task.projectId||null,conversationId:task.metadata?.terminalReporting?.conversationId||null,sourceMessageId:null,sourceRunId:null,sourceTaskId:task.id,sourceKind:failed?"failed_task":"completed_task",provenance:"canonical durable task terminal state",evidence:{version:2,taskId:task.id,taskType:task.taskType,status:task.status,stateVersion:task.stateVersion,errorCode:task.errorCode||null,reportHash:fingerprint([report||""]),taskContextSnapshotHash:snapshot?.snapshotHash||null,sourceMemoryIds:(snapshot?.acceptedMemories||[]).map(item=>item.id).slice(0,6),extraction:"deterministic_v1",authoritative:false}});
  }
  async function reviewCandidate(id,{decision,supersedesMemoryId=null,reason=null}={}){
    if(!["accepted","rejected"].includes(decision))throw Object.assign(new Error("Memory candidate decision is invalid."),{code:"memory_candidate_decision_invalid",statusCode:400});
    const candidate=await storage.getMemoryCandidate(id,ownerId);
    if(!candidate)return null;
    if(candidate.status===decision)return storage.decideMemoryCandidate(id,ownerId,{decision,supersedesMemoryId,decisionReason:reason});
    if(decision==="accepted"&&candidate.candidateType==="correction"&&!supersedesMemoryId)throw Object.assign(new Error("A correction must identify the active memory it supersedes."),{code:"memory_correction_target_required",statusCode:409});
    if(supersedesMemoryId){const target=await storage.getMemory(supersedesMemoryId,ownerId);if(!target||target.status!=="active"||(candidate.projectId||null)!==(target.projectId||null))throw Object.assign(new Error("The correction target is unavailable in this memory scope."),{code:"memory_correction_target_invalid",statusCode:409});}
    const result=await storage.decideMemoryCandidate(id,ownerId,{decision,supersedesMemoryId,decisionReason:reason});if(!result)return null;
    if(!result.idempotent)await storage.appendActivity({ownerId,projectId:result.candidate.projectId||null,runId:result.candidate.sourceRunId||null,action:`memory_candidate_${decision}`,status:decision,summary:decision==="accepted"?"Owner accepted reviewed evidence into Nova's existing memory.":"Owner rejected a memory candidate; no memory was created.",metadata:{candidateId:id,acceptedMemoryId:result.memory?.id||null,supersedesMemoryId:result.candidate.supersedesMemoryId||null,sourceTaskId:result.candidate.sourceTaskId||null}});
    return result;
  }
  return Object.freeze({observeConversationTurn,observeTaskOutcome,reviewCandidate});
}
