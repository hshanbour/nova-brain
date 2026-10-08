import {createHash} from "node:crypto";

const clean=(value,max=500)=>String(value||"").replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim().slice(0,max);
const normalized=value=>clean(value,200).toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu," ").trim();
const tokens=value=>new Set(normalized(value).split(" ").filter(token=>token.length>1));
const slug=value=>normalized(value).replace(/\s+/g,"-").slice(0,80).replace(/^-|-$/g,"");
const phrase=(message,name)=>new RegExp(`(^|[^\\p{L}\\p{N}])${normalized(name).split(" ").map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("[\\s_-]+")}(?=$|[^\\p{L}\\p{N}])`,"iu").test(String(message||""));
const phraseCount=(message,name)=>{const haystack=` ${normalized(message)} `,needle=` ${normalized(name)} `;let count=0,offset=0;while((offset=haystack.indexOf(needle,offset))>=0){count+=1;offset+=needle.length-1;}return count;};
const compactProject=project=>({id:project.id,name:project.name,description:project.description||null});

export function createProjectService({storage,ownerId}={}){
  if(!storage||!ownerId)throw new Error("Project service requires storage and an owner.");
  async function resolve({message="",projectId=null}={}){
    const projects=await storage.listProjects(ownerId);
    if(projectId){
      const exact=projects.find(project=>project.id===projectId);
      return exact?{status:"resolved",project:compactProject(exact),source:"explicit_id"}:{status:"missing",project:null,source:"explicit_id",message:`Nova could not find the requested project ${clean(projectId,80)}.`};
    }
    const exact=projects.filter(project=>phrase(message,project.name)||phrase(message,project.id));
    if(exact.length){
      const strongest=exact.filter(project=>!exact.some(other=>other.id!==project.id&&(normalized(other.name).includes(normalized(project.name))||normalized(other.id).includes(normalized(project.id)))&&phraseCount(message,project.name)<=phraseCount(message,other.name)));
      if(strongest.length===1)return{status:"resolved",project:compactProject(strongest[0]),source:"exact_reference"};
      return{status:"multiple",projects:strongest.map(compactProject),source:"multiple_exact_references"};
    }
    const queryTokens=tokens(message),partial=projects.map(project=>{const projectTokens=tokens(`${project.id} ${project.name}`),matches=[...projectTokens].filter(token=>queryTokens.has(token));return{project,matches};}).filter(item=>item.matches.length>=2);
    if(partial.length===1)return{status:"resolved",project:compactProject(partial[0].project),source:"bounded_token_match"};
    if(partial.length>1)return{status:"ambiguous",projects:partial.map(item=>compactProject(item.project)),source:"bounded_token_match"};
    return{status:"unresolved",project:null,source:"none"};
  }
  async function create({id,name,description=""}={}){
    name=clean(name,120);description=clean(description,1000);id=clean(id||slug(name),80).toLowerCase();
    if(!name||!/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(id))throw Object.assign(new Error("A project name and safe project ID are required."),{code:"project_invalid"});
    const projects=await storage.listProjects(ownerId),nameKey=normalized(name);
    const existing=projects.find(project=>project.id===id||normalized(project.name)===nameKey);
    if(existing){
      if(existing.id===id&&normalized(existing.name)===nameKey)return{project:compactProject(existing),created:false};
      throw Object.assign(new Error("That project ID or name is already bound to another project."),{code:"project_conflict"});
    }
    if(typeof storage.createProject!=="function")throw Object.assign(new Error("Durable project creation is unavailable."),{code:"project_creation_unavailable"});
    const project=await storage.createProject({id,ownerId,name,description});
    await storage.appendActivity({ownerId,projectId:project.id,runId:null,action:"project_created",tool:"project_create",status:"completed",summary:`Created the durable project ${project.name}.`,metadata:{projectId:project.id,identityHash:createHash("sha256").update(`${project.id}\u001f${normalized(project.name)}`).digest("hex")}});
    return{project:compactProject(project),created:true};
  }
  return Object.freeze({resolve,create});
}

export function projectClarification(resolution){
  const names=(resolution?.projects||[]).map(project=>`${project.name} (${project.id})`);
  return names.length?`Which project do you mean: ${names.join(" or ")}?`:resolution?.message||"Which project should Nova use?";
}
