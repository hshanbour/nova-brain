import {createHash,randomUUID} from "node:crypto";

const TYPES=new Set(["owner_statement","owner_document","public_url","github","vercel","neon","stripe"]);
const CONNECTORS=new Set(["github","vercel","neon","stripe"]);
const CANDIDATES=new Set(["verified_fact","owner_claim","project_decision","hypothesis","unresolved_question","correction"]);
const SECRET=/(?:api[_ -]?key|password|passcode|secret|bearer\s+|authorization|private\s+key|credit\s*card|cvv|seed\s+phrase)/i;
const clean=(value,max)=>String(value||"").replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim().slice(0,max);
const digest=value=>createHash("sha256").update(String(value).normalize("NFKC")).digest("hex");

export const PROJECT_CONNECTION_POLICIES=Object.freeze({
  github:Object.freeze({mode:"read_only",recommendedScope:"one repository via fine-grained token or GitHub App installation",accountWideForbidden:true,approvalRequired:true}),
  vercel:Object.freeze({mode:"read_only",recommendedScope:"one project/team-scoped token or narrow projection endpoint",accountWideForbidden:true,approvalRequired:true}),
  neon:Object.freeze({mode:"read_only",recommendedScope:"project-specific read-only database role or projection",accountWideForbidden:true,approvalRequired:true}),
  stripe:Object.freeze({mode:"read_only",recommendedScope:"restricted key limited to required read resources",accountWideForbidden:true,approvalRequired:true}),
});

export function createProjectOnboardingService({storage,ownerId,learningService}={}){
  if(!storage||!ownerId||!learningService)throw new Error("Project onboarding requires storage, learning, and an owner.");
  const project=async id=>(await storage.listProjects(ownerId)).find(item=>item.id===id)||null;
  async function registerSource({projectId,sourceType,label,locator=null,content=null}={}){
    const bound=await project(projectId);if(!bound)throw Object.assign(new Error("The project does not exist in this owner scope."),{code:"project_not_found",statusCode:404});
    if(!TYPES.has(sourceType))throw Object.assign(new Error("The source type is unsupported."),{code:"project_source_type_invalid",statusCode:400});
    label=clean(label,500);locator=locator?clean(locator,2000):null;content=content?clean(content,12000):null;
    if(!label||SECRET.test(`${label} ${locator||""} ${content||""}`))throw Object.assign(new Error("The source is invalid or contains protected credential material."),{code:"project_source_invalid",statusCode:400});
    if(["public_url","github","vercel","neon","stripe"].includes(sourceType)){let url;try{url=new URL(locator);}catch{throw Object.assign(new Error("A valid HTTPS source URL is required."),{code:"project_source_url_invalid",statusCode:400});}if(url.protocol!=="https:"||url.username||url.password)throw Object.assign(new Error("A credential-free HTTPS source URL is required."),{code:"project_source_url_invalid",statusCode:400});locator=url.toString();}
    const proposed=CONNECTORS.has(sourceType),contentHash=digest([projectId,sourceType,label,locator||"",content||""].join("\u001f"));
    const source=await storage.createProjectSource({id:`project-source-${contentHash.slice(0,32)}`,ownerId,projectId,sourceType,label,locator,contentHash,accessMode:proposed?"read_only":"reference_only",status:proposed?"proposed":"active",permissions:proposed?{provider:sourceType,connected:false,formalApprovalRequired:true,permissionEscalationApprovalRequired:true,policy:PROJECT_CONNECTION_POLICIES[sourceType]}:{connected:false,externalAccess:false}});
    await storage.appendActivity({ownerId,projectId,runId:null,action:proposed?"project_source_connection_proposed":"project_source_registered",tool:"project_source_register",status:source.status,summary:proposed?"Recorded a project-scoped read-only connection proposal; no provider access was granted.":"Registered an owner-authorized project knowledge source without external access.",metadata:{sourceId:source.id,sourceType,accessMode:source.accessMode,externalAccess:false}});
    return{source,externalAccess:false,approvalRequiredBeforeConnection:proposed};
  }
  async function proposeKnowledge({projectId,content,candidateType="owner_claim",sourceType="owner_statement",sourceLabel="Owner onboarding statement",sourceUrl=null,conversationId=null,sourceMessageId=null,sourceRunId=null}={}){
    content=clean(content,8000);if(!content||SECRET.test(content)||!CANDIDATES.has(candidateType))throw Object.assign(new Error("The proposed project knowledge is invalid."),{code:"project_knowledge_invalid",statusCode:400});
    const registered=await registerSource({projectId,sourceType,label:sourceLabel,locator:sourceUrl,content});
    const proposed=await learningService.proposeProjectKnowledge({projectId,content,candidateType,conversationId,sourceMessageId,sourceRunId,sourceId:registered.source.id,sourceType,sourceHash:registered.source.contentHash});
    return{...proposed,source:registered.source,externalAccess:false,authoritative:false};
  }
  async function summary(projectId){const bound=await project(projectId);if(!bound)return null;const [sources,memories,candidates]=await Promise.all([storage.listProjectSources(ownerId,{projectId,limit:100}),storage.listMemories(ownerId,{projectId,limit:100}),storage.listMemoryCandidates(ownerId,{projectId,limit:100})]);return{project:bound,sources,memories,candidates,connectionPolicies:PROJECT_CONNECTION_POLICIES};}
  async function revokeSource(id){const source=await storage.getProjectSource(id,ownerId);if(!source)return null;const revoked=await storage.revokeProjectSource(id,ownerId);await storage.appendActivity({ownerId,projectId:source.projectId,runId:null,action:"project_source_revoked",tool:"project_source_revoke",status:"completed",summary:"Revoked the project source authorization. Existing reviewed memory history was preserved.",metadata:{sourceId:id,sourceType:source.sourceType,connectionWasActive:false}});return revoked;}
  return Object.freeze({registerSource,proposeKnowledge,summary,revokeSource});
}
