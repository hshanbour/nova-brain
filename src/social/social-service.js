import { createHash, randomUUID } from "node:crypto";

const KINDS=new Set(["post","reel","story"]),PLATFORMS=new Set(["facebook","instagram"]),READY=new Set(["verified","not_applicable"]);
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const hash=value=>createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const text=(value,name,max)=>{const result=String(value||"").trim();if(!result||Buffer.byteLength(result)>max)throw new SocialError(`${name} is required and must be at most ${max} bytes.`,{code:"social_input_invalid"});return result;};
const optional=(value,max)=>{const result=String(value||"").trim();if(Buffer.byteLength(result)>max)throw new SocialError("Social content is too large.",{code:"social_input_invalid"});return result;};
const iso=value=>{const date=new Date(value);if(!value||Number.isNaN(date.getTime()))throw new SocialError("publishAt must be an ISO date.",{code:"social_input_invalid"});return date.toISOString();};
const httpsUrl=(value,name)=>{let parsed;try{parsed=new URL(value);}catch{throw new SocialError(`${name} must be an HTTPS URL.`,{code:"social_input_invalid"});}if(parsed.protocol!=="https:"||parsed.username||parsed.password)throw new SocialError(`${name} must be an HTTPS URL.`,{code:"social_input_invalid"});return parsed.toString();};
const contentEnvelope=item=>({contentId:item.id,projectId:item.projectId,kind:item.kind,title:item.title,caption:item.caption,script:item.script,platforms:item.platforms,media:item.media,sourceRefs:item.sourceRefs,evidenceStatus:item.evidenceStatus,originalityStatus:item.originalityStatus});

export class SocialError extends Error{constructor(message,{code="social_error",statusCode=400,category="validation",retryable=false}={}){super(message);this.name="SocialError";this.code=code;this.statusCode=statusCode;this.category=category;this.retryable=retryable;}}

export function createMetaPublishingAdapter({config,fetchImpl=globalThis.fetch,sleep=(milliseconds)=>new Promise(resolve=>setTimeout(resolve,milliseconds))}={}){
  const settings=config.social;
  const request=async(path,{method="POST",body,requireId=true}={})=>{let response;try{response=await fetchImpl(`https://graph.facebook.com/${settings.graphVersion}/${path}`,{method,headers:{authorization:`Bearer ${settings.accessToken}`,...(body?{"content-type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});}catch{throw new SocialError("Meta publication outcome is uncertain; Nova will not retry automatically.",{code:"social_publish_uncertain",statusCode:502,category:"provider"});}const value=await response.json().catch(()=>({}));if(!response.ok||(requireId&&!value.id))throw new SocialError("Meta rejected the publication.",{code:"social_provider_rejected",statusCode:502,category:"provider"});return value;};
  const waitForContainer=async id=>{for(let attempt=0;attempt<20;attempt+=1){const state=await request(`${encodeURIComponent(id)}?fields=status_code,status`,{method:"GET",requireId:false}),code=String(state.status_code||state.status||"").toUpperCase();if(code==="FINISHED"||code==="PUBLISHED")return;if(["ERROR","EXPIRED"].includes(code))throw new SocialError("Meta could not process the Instagram media container.",{code:"social_media_processing_failed",statusCode:502,category:"provider"});await sleep(1000);}throw new SocialError("Meta media processing did not finish within the bounded publication window.",{code:"social_media_processing_timeout",statusCode:502,category:"provider"});};
  return Object.freeze({
    async publish({platform,content}){
      if(platform==="facebook"){
        const first=content.media[0];
        if(first?.type==="image")return request(`${settings.pageId}/photos`,{body:{url:first.url,caption:content.caption}});
        if(first)throw new SocialError("This Facebook media format is not enabled in Social V1.",{code:"social_format_unsupported"});
        return request(`${settings.pageId}/feed`,{body:{message:content.caption}});
      }
      const first=content.media[0];if(!first)throw new SocialError("Instagram publishing requires one public media asset.",{code:"social_media_required"});
      const creationBody=first.type==="image"?{image_url:first.url,caption:content.caption}:{media_type:content.kind==="story"?"STORIES":"REELS",video_url:first.url,...(content.kind==="story"?{}:{caption:content.caption}),share_to_feed:content.kind==="reel"};
      const creation=await request(`${settings.instagramAccountId}/media`,{body:creationBody});
      await waitForContainer(creation.id);
      return request(`${settings.instagramAccountId}/media_publish`,{body:{creation_id:creation.id}});
    }
  });
}

export function createSocialService({config,storage,ownerId,publisher,clock=()=>new Date()}={}){
  if(!config||!storage||!ownerId)throw new TypeError("Social service dependencies are required.");
  const settings=config.social;
  const provider=publisher||createMetaPublishingAdapter({config});
  const normaliseMedia=values=>(Array.isArray(values)?values:[]).slice(0,10).map((item,index)=>{if(!item||!new Set(["image","video"]).has(item.type))throw new SocialError(`media[${index}] is invalid.`,{code:"social_input_invalid"});const rightsStatus=String(item.rightsStatus||"");if(!new Set(["owned","licensed","permissioned","public_domain"]).has(rightsStatus))throw new SocialError(`media[${index}] requires a valid rightsStatus.`,{code:"social_media_rights_required"});return{type:item.type,url:httpsUrl(item.url,`media[${index}].url`),rightsStatus,...(item.sourceAttribution?{sourceAttribution:optional(item.sourceAttribution,1000)}:{}),...(item.alt?{alt:optional(item.alt,1000)}:{})};});
  const normaliseSources=values=>(Array.isArray(values)?values:[]).slice(0,20).map((item,index)=>({title:text(item?.title,`sourceRefs[${index}].title`,500),url:httpsUrl(item?.url,`sourceRefs[${index}].url`),...(item?.evidenceChunkId?{evidenceChunkId:text(item.evidenceChunkId,"evidenceChunkId",200)}:{})}));
  const get=async id=>{const item=await storage.getSocialContent(id,ownerId);if(!item)throw new SocialError("Social content was not found.",{code:"social_content_not_found",statusCode:404});return item;};
  const validateReady=item=>{const idempotentScheduled=item.status==="scheduled"&&item.approvedHash===item.contentHash;if(item.status!=="review_ready"&&!idempotentScheduled)throw new SocialError("Content must pass review checks before scheduling.",{code:"social_content_not_ready",statusCode:409});if(!READY.has(item.evidenceStatus)||item.originalityStatus!=="passed")throw new SocialError("Evidence and originality checks must pass before scheduling.",{code:"social_checks_incomplete",statusCode:409});};
  const status=async()=>({configured:settings.configured,liveEnabled:settings.liveEnabled,provider:"meta_graph_api",projectScoped:true,approvalRequired:true,workerProcessing:"persistent_worker",cloudScheduler:false,metricsVerified:false,facebook:{configured:Boolean(settings.pageId)},instagram:{configured:Boolean(settings.instagramAccountId)},expansion:{tiktok:"official_authorization_required",youtube:"official_authorization_required"}});
  return Object.freeze({
    status,
    async createDraft(input){
      const project=(await storage.listProjects(ownerId)).find(item=>item.id===input.projectId);if(!project)throw new SocialError("Project was not found.",{code:"social_project_not_found",statusCode:404});
      if(!KINDS.has(input.kind))throw new SocialError("kind must be post, reel, or story.",{code:"social_input_invalid"});
      const platforms=[...new Set(Array.isArray(input.platforms)?input.platforms:[])];if(!platforms.length||platforms.some(value=>!PLATFORMS.has(value)))throw new SocialError("platforms must contain Facebook or Instagram.",{code:"social_input_invalid"});
      const sourceRefs=normaliseSources(input.sourceRefs),evidenceStatus=String(input.evidenceStatus||"unverified"),originalityStatus=String(input.originalityStatus||"unverified");
      if(!new Set(["unverified","verified","not_applicable"]).has(evidenceStatus)||!new Set(["unverified","passed","failed"]).has(originalityStatus))throw new SocialError("Content check status is invalid.",{code:"social_input_invalid"});
      if(evidenceStatus==="verified"&&!sourceRefs.length)throw new SocialError("Verified factual content requires source references.",{code:"social_source_required"});
      const record={id:input.id||`social_${randomUUID().replaceAll("-","")}`,ownerId,projectId:project.id,kind:input.kind,title:text(input.title,"title",300),caption:text(input.caption,"caption",8000),script:optional(input.script,20000),platforms,media:normaliseMedia(input.media),sourceRefs,evidenceStatus,originalityStatus,status:READY.has(evidenceStatus)&&originalityStatus==="passed"?"review_ready":"draft"};
      record.contentHash=hash(contentEnvelope(record));const created=await storage.createSocialContent(record);await storage.appendActivity({ownerId,projectId:project.id,action:"social_content_created",tool:"social_content_draft",status:created.status,summary:"Created a project-scoped social content draft for owner review.",metadata:{contentId:created.id,kind:created.kind,platforms:created.platforms,contentHash:created.contentHash}});return{content:created};
    },
    async current(id){const content=await get(id);return{content,envelope:{...contentEnvelope(content),contentHash:content.contentHash}};},
    async list(filters={}){return{content:await storage.listSocialContent(ownerId,filters)};},
    async schedule(input,context={}){
      const item=await get(input.contentId);validateReady(item);const platforms=[...new Set(input.platforms||[])],publishAt=iso(input.publishAt),expected={...contentEnvelope(item),contentHash:item.contentHash};
      if(input.contentHash!==item.contentHash||input.caption!==item.caption||JSON.stringify(input.media||[])!==JSON.stringify(item.media)||JSON.stringify(platforms)!==JSON.stringify(item.platforms))throw new SocialError("The approved publication no longer matches the immutable content.",{code:"social_content_changed",statusCode:409});
      if(new Date(publishAt).getTime()<clock().getTime()-60_000)throw new SocialError("publishAt is in the past.",{code:"social_schedule_invalid"});
      const intentHash=hash({contentHash:item.contentHash,platforms,publishAt}),publication=await storage.createSocialPublication({id:`socialpub_${intentHash.slice(0,32)}`,ownerId,projectId:item.projectId,contentId:item.id,contentHash:item.contentHash,platforms,publishAt,intentHash,approvalId:context.approvalId||null,status:"scheduled"});
      await storage.updateSocialContent(item.id,ownerId,{status:"scheduled",approvedHash:item.contentHash});await storage.appendActivity({ownerId,projectId:item.projectId,runId:context.runId||null,action:"social_publication_scheduled",tool:"social_schedule_publish",status:"scheduled",summary:"Scheduled one immutable owner-approved social publication.",metadata:{publicationId:publication.id,contentId:item.id,platforms,publishAt,intentHash}});return{publication,content:expected};
    },
    async processNext({workerId=`social-${randomUUID()}`}={}){
      if(!settings.configured||!settings.liveEnabled)return{worked:false,reason:"not_enabled"};
      const claim=await storage.claimNextSocialPublication({ownerId,workerId,leaseMs:120000});if(!claim)return{worked:false};const content=await get(claim.contentId);
      if(content.contentHash!==claim.contentHash||content.approvedHash!==claim.contentHash){await storage.finishSocialPublication({...claim,status:"failed",errorCode:"content_hash_mismatch"});return{worked:true,publicationId:claim.id,status:"failed",errorCode:"content_hash_mismatch"};}
      const results={...(claim.providerResults||{})};try{for(const platform of claim.platforms){if(results[platform]?.status==="submitted")continue;results[platform]={status:"submitting"};await storage.checkpointSocialPublication({...claim,providerResults:results});const result=await provider.publish({platform,content});results[platform]={status:"submitted",providerId:String(result.id)};await storage.checkpointSocialPublication({...claim,providerResults:results});}await storage.finishSocialPublication({...claim,status:"published",providerResults:results,errorCode:null});await storage.updateSocialContent(content.id,ownerId,{status:"published"});await storage.appendActivity({ownerId,projectId:content.projectId,action:"social_publication_submitted",tool:"social_schedule_publish",status:"completed",summary:"Submitted the approved social content to every selected platform.",metadata:{publicationId:claim.id,platforms:claim.platforms}});return{worked:true,publicationId:claim.id,status:"published"};}catch(error){const uncertain=error?.code==="social_publish_uncertain";await storage.finishSocialPublication({...claim,status:uncertain?"uncertain":"failed",providerResults:results,errorCode:error?.code||"social_publish_failed"});await storage.updateSocialContent(content.id,ownerId,{status:uncertain?"uncertain":"failed"});return{worked:true,publicationId:claim.id,status:uncertain?"uncertain":"failed",errorCode:error?.code||"social_publish_failed"};}
    },
    async dashboard(projectId){
      const [content,publications,allActivity,allApprovals]=await Promise.all([
        storage.listSocialContent(ownerId,{projectId,limit:100}),
        storage.listSocialPublications(ownerId,{projectId,limit:100}),
        storage.listActivity(ownerId,{projectId,limit:100}),
        storage.listApprovals(ownerId,{status:"pending",limit:100})
      ]),activity=allActivity.filter(item=>item.tool?.startsWith("social_")||item.action?.startsWith("social_")),approvals=allApprovals.filter(item=>item.tool==="social_schedule_publish"&&(!projectId||item.projectId===projectId));
      return{status:await status(),summary:{drafts:content.filter(x=>x.status==="draft").length,reviewReady:content.filter(x=>x.status==="review_ready").length,pendingApprovals:approvals.length,scheduled:publications.filter(x=>x.status==="scheduled").length,published:publications.filter(x=>x.status==="published").length,failed:publications.filter(x=>["failed","uncertain"].includes(x.status)).length},content,publications,approvals,activity};
    }
  });
}
