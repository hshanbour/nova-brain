import {createHash} from "node:crypto";

const SECRET=/\b(?:sk-[A-Za-z0-9_-]{10,}|github_pat_[A-Za-z0-9_]{10,}|(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+)/i;
const clean=(value,max)=>String(value||"").replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim().slice(0,max);
const evidenceType=value=>{
  const provenance=String(value.provenance||"");
  if(/completed_task/i.test(provenance))return"reviewed_completed_task";
  if(/failed_task/i.test(provenance))return"reviewed_failed_task_lesson";
  if(value.category==="preference")return"owner_preference";
  if(value.category==="decision")return"owner_decision";
  if(value.category==="identity"||/owner-explicit|user-provided|owner_claim/i.test(provenance))return"owner_claim";
  if(/hypothesis/i.test(provenance))return"hypothesis";
  if(/unresolved_question/i.test(provenance))return"unresolved_question";
  return"reviewed_memory";
};
const memory=value=>({id:clean(value.id,160),category:clean(value.category,64),content:clean(value.content,1600),scope:clean(value.scope,32),projectId:value.projectId?clean(value.projectId,128):null,provenance:clean(value.provenance,240),privacy:clean(value.privacy,32),sensitivity:clean(value.sensitivity,32),evidenceType:evidenceType(value)});

export function createTaskContextSnapshot({retrieved,projectId,request,clock=()=>new Date()}={}){
  if(!retrieved||!projectId)return null;
  const project=(retrieved.projects||[]).find(item=>item.id===projectId);
  if(!project)return null;
  const eligible=(retrieved.memories||[]).filter(item=>item.status!=="deleted"&&(!item.projectId||item.projectId===projectId)&&!SECRET.test(item.content||"")).map(memory),acceptedMemories=eligible.slice(0,6);
  for(const required of [eligible.find(item=>["reviewed_completed_task","reviewed_failed_task_lesson"].includes(item.evidenceType)),eligible.find(item=>["owner_preference","owner_decision"].includes(item.evidenceType))])if(required&&!acceptedMemories.some(item=>item.id===required.id)){if(acceptedMemories.length>=6)acceptedMemories.pop();acceptedMemories.push(required);}
  const applicableConstraints=acceptedMemories.filter(item=>["preference","decision","reusable_instruction"].includes(item.category)).map(item=>({memoryId:item.id,content:item.content,provenance:item.provenance,evidenceType:item.evidenceType})).slice(0,4);
  const knownUnknowns=acceptedMemories.filter(item=>item.category==="project_context"&&/hypothesis|unresolved_question/.test(item.provenance)).map(item=>({memoryId:item.id,content:item.content,provenance:item.provenance})).slice(0,4);
  const priorLessons=acceptedMemories.filter(item=>["reviewed_completed_task","reviewed_failed_task_lesson"].includes(item.evidenceType)).map(item=>({memoryId:item.id,content:item.content,provenance:item.provenance,evidenceType:item.evidenceType})).slice(0,4);
  const verifiedHistory=(retrieved.recentWork||[]).slice(0,4).map(item=>({kind:clean(item.kind,32),status:clean(item.status,40),summary:clean(item.summary,600),at:item.at||null}));
  const snapshot={version:2,project:{id:project.id,name:clean(project.name,120),description:clean(project.description,1000)},acceptedMemories,applicableConstraints,knownUnknowns,priorLessons,verifiedHistory,privacy:{ownerBound:true,projectBound:true,crossProjectFallback:false},capturedAt:clock().toISOString(),requestHash:createHash("sha256").update(String(request||"")).digest("hex")};
  const encoded=JSON.stringify(snapshot);
  if(Buffer.byteLength(encoded)>16_384)throw Object.assign(new Error("The bounded task context exceeded its safe limit."),{code:"task_context_too_large"});
  return Object.freeze({...snapshot,snapshotHash:createHash("sha256").update(encoded).digest("hex")});
}
