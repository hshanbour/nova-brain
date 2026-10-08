import {createHash} from "node:crypto";

const SECRET=/\b(?:sk-[A-Za-z0-9_-]{10,}|github_pat_[A-Za-z0-9_]{10,}|(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+)/i;
const clean=(value,max)=>String(value||"").replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim().slice(0,max);
const memory=value=>({id:clean(value.id,160),category:clean(value.category,64),content:clean(value.content,1600),scope:clean(value.scope,32),projectId:value.projectId?clean(value.projectId,128):null,provenance:clean(value.provenance,240),privacy:clean(value.privacy,32),sensitivity:clean(value.sensitivity,32)});

export function createTaskContextSnapshot({retrieved,projectId,request,clock=()=>new Date()}={}){
  if(!retrieved||!projectId)return null;
  const project=(retrieved.projects||[]).find(item=>item.id===projectId);
  if(!project)return null;
  const acceptedMemories=(retrieved.memories||[]).filter(item=>item.status!=="deleted"&&(!item.projectId||item.projectId===projectId)&&!SECRET.test(item.content||"")).slice(0,6).map(memory);
  const applicableConstraints=acceptedMemories.filter(item=>["preference","decision","reusable_instruction"].includes(item.category)).map(item=>({memoryId:item.id,content:item.content,provenance:item.provenance})).slice(0,4);
  const knownUnknowns=acceptedMemories.filter(item=>item.category==="project_context"&&/hypothesis|unresolved_question/.test(item.provenance)).map(item=>({memoryId:item.id,content:item.content,provenance:item.provenance})).slice(0,4);
  const verifiedHistory=(retrieved.recentWork||[]).slice(0,4).map(item=>({kind:clean(item.kind,32),status:clean(item.status,40),summary:clean(item.summary,600),at:item.at||null}));
  const snapshot={version:1,project:{id:project.id,name:clean(project.name,120),description:clean(project.description,1000)},acceptedMemories,applicableConstraints,knownUnknowns,verifiedHistory,privacy:{ownerBound:true,projectBound:true,crossProjectFallback:false},capturedAt:clock().toISOString(),requestHash:createHash("sha256").update(String(request||"")).digest("hex")};
  const encoded=JSON.stringify(snapshot);
  if(Buffer.byteLength(encoded)>16_384)throw Object.assign(new Error("The bounded task context exceeded its safe limit."),{code:"task_context_too_large"});
  return Object.freeze({...snapshot,snapshotHash:createHash("sha256").update(encoded).digest("hex")});
}
