import {createReadStream} from "node:fs";
import {createLocalMediaWorkspace} from "./local-media-workspace.js";
import {renderVerticalReel} from "./ffmpeg-renderer.js";

const extensionFor=asset=>asset.mimeType==="video/mp4"?".mp4":asset.mimeType==="video/quicktime"?".mov":asset.mimeType==="video/x-m4v"?".m4v":asset.mimeType==="image/png"?".png":asset.mimeType==="image/webp"?".webp":".jpg";
const locationFor=asset=>asset.state==="rendered"?"renders":"originals";

export function createLocalSocialMediaWorker({client,root,workerId,ffmpegExecutable="ffmpeg",fetchImpl=globalThis.fetch,workspace=createLocalMediaWorkspace({root}),renderImpl=renderVerticalReel,fileBody=createReadStream}={}){
  if(!client?.request||!workerId)throw new Error("A protected Worker client and identity are required.");
  const resolveAsset=asset=>workspace.resolveCapability(asset.projectId,asset.localCapabilityId,extensionFor(asset),locationFor(asset));
  async function render(){
    const claimed=await client.request("/api/admin/worker/social-media/claim",{workerId,type:"render"});if(!claimed.job)return{worked:false,reason:claimed.reason||"no_render_job"};
    const {job,assets}=claimed,byId=new Map(assets.map(asset=>[asset.id,asset])),reserved=await workspace.reserveRender({projectId:job.projectId,extension:".mp4"}),logoPath=await workspace.brandLogo({projectId:job.projectId}),subtitle=await workspace.subtitleSidecar({projectId:job.projectId,cues:job.recipe.subtitleCues||[]});
    const segments=job.recipe.segments.map((segment,index)=>{const asset=byId.get(segment.assetId||job.inputAssetIds[index]||job.inputAssetIds[0]);if(!asset)throw new Error("Render recipe references an unavailable local asset.");return{...segment,path:resolveAsset(asset),mediaType:asset.type,hasAudio:segment.hasAudio!==false&&asset.type==="video"};});
    try{await renderImpl({segments,outputPath:reserved.outputPath,subtitlePath:subtitle?.path||null,logoPath},{executable:ffmpegExecutable});}finally{await subtitle?.cleanup?.();}const output=await workspace.inspectRender({projectId:job.projectId,localCapabilityId:reserved.localCapabilityId,extension:".mp4"});
    await client.request("/api/admin/worker/social-media/render-complete",{jobId:job.id,leaseToken:job.leaseToken,type:"video",sha256:output.sha256,bytes:output.bytes,mimeType:output.mimeType,rightsStatus:"owned",consentStatus:"owner_confirmed",localCapabilityId:reserved.localCapabilityId},{timeoutMs:60000});
    return{worked:true,stepType:"social_media_render",jobId:job.id};
  }
  async function promote(){
    const claimed=await client.request("/api/admin/worker/social-media/claim",{workerId,type:"promote"});if(!claimed.job)return{worked:false,reason:claimed.reason||"no_promotion_job"};
    const {job,assets,upload}=claimed,asset=assets.find(item=>item.id===job.outputAssetId);if(!asset||!upload?.url)throw new Error("Promotion handoff is incomplete.");const path=resolveAsset(asset);
    const response=await fetchImpl(upload.url,{method:"PUT",headers:upload.headers,body:fileBody(path),duplex:"half",signal:AbortSignal.timeout(20*60*1000)});if(!response.ok)throw Object.assign(new Error(`Private media upload failed with status ${response.status}.`),{code:"social_media_upload_failed"});
    await client.request("/api/admin/worker/social-media/promote-complete",{jobId:job.id,leaseToken:job.leaseToken,sha256:asset.sha256,bytes:asset.bytes,cloudKey:upload.key,cloudEtag:String(response.headers.get("etag")||"").slice(0,200)},{timeoutMs:60000});
    return{worked:true,stepType:"social_media_promote",jobId:job.id};
  }
  return Object.freeze({async runOnce(){const rendered=await render();if(rendered.worked)return rendered;return promote();}});
}
