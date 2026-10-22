import test from "node:test";
import assert from "node:assert/strict";
import {readConfig} from "../src/config/env.js";
import {mkdtemp,readFile,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {OWNER_ID} from "../src/identity/initial-context.js";
import {buildVerticalReelCommand} from "../src/social/ffmpeg-renderer.js";
import {buildRollingMarketingCalendar,createMediaAutomationService} from "../src/social/media-automation.js";
import {createLocalMediaWorkspace} from "../src/social/local-media-workspace.js";
import {createSocialService} from "../src/social/social-service.js";
import {createInMemoryStorage} from "../src/storage/in-memory-storage.js";

const now=()=>new Date("2026-10-22T12:00:00.000Z"),sha="a".repeat(64);
async function fixture(){
  const storage=createInMemoryStorage({clock:now});await storage.initialize({owner:{id:OWNER_ID,fullName:"Owner"},projects:[{id:"sharp-cuts-web",name:"Sharp Cuts"},{id:"nova-digital-services-uk",name:"Nova Digital Services UK"}]});
  const socialService=createSocialService({config:readConfig({}),storage,ownerId:OWNER_ID,clock:now,publisher:{async publish(){throw new Error("publishing must remain disabled");}}});
  const draft=(await socialService.createDraft({projectId:"sharp-cuts-web",kind:"reel",title:"Transformation",caption:"A genuine Sharp Cuts transformation.",script:"Before, detail, finish.",platforms:["instagram"],media:[],sourceRefs:[],evidenceStatus:"not_applicable",originalityStatus:"passed",plan:{pillar:"unspecified",language:"english",assetStatus:"in_production",shotPlan:["Before","Reveal"]}})).content;
  return{storage,socialService,draft,media:createMediaAutomationService({storage,socialService,ownerId:OWNER_ID,clock:now,bankHolidayProvider:async()=>[],maxApprovedCloudBytes:20_000_000})};
}

test("local render remains local until an exact formal promotion approval",async()=>{
  const{storage,socialService,draft,media}=await fixture(),original=(await media.registerLocalAsset({projectId:"sharp-cuts-web",contentId:draft.id,type:"video",sha256:"b".repeat(64),bytes:1000,mimeType:"video/mp4",rightsStatus:"owned",consentStatus:"owner_confirmed",localCapabilityId:"cap_original_123456789"})).asset;
  const queued=(await media.createRenderJob({projectId:"sharp-cuts-web",contentId:draft.id,inputAssetIds:[original.id],recipe:{format:"vertical_reel",segments:[{startSeconds:0,durationSeconds:8}]}})).job,claim=(await media.claimJob({workerId:"windows-preview-worker",type:"render"})).job;
  assert.equal(claim.id,queued.id);const rendered=await media.completeLocalRender({jobId:claim.id,leaseToken:claim.leaseToken,type:"video",sha256:sha,bytes:10_000_000,mimeType:"video/mp4",rightsStatus:"owned",consentStatus:"owner_confirmed",localCapabilityId:"cap_rendered_123456789"});
  assert.equal(rendered.asset.storage,"local");assert.equal((await socialService.current(draft.id)).content.media[0].storage,"local");assert.equal((await media.dashboard("sharp-cuts-web")).assets.some(item=>item.storage==="r2"),false);
  const requested=await media.requestPromotionApproval({projectId:"sharp-cuts-web",contentId:draft.id,assetId:rendered.asset.id});assert.equal(requested.approval.status,"pending");assert.equal((await media.dashboard("sharp-cuts-web")).jobs.filter(item=>item.type==="promote").length,0);
  await storage.decideApproval(requested.approval.id,OWNER_ID,"approved");const promotion=await media.queueApprovedPromotion(requested.approval.arguments,{approvalId:requested.approval.id});assert.equal(promotion.job.type,"promote");assert.equal((await storage.getSocialMediaAsset(rendered.asset.id,OWNER_ID)).state,"promotion_approved");
});

test("revision invalidates pending media promotion approval and changed content cannot promote",async()=>{
  const{storage,socialService,draft,media}=await fixture(),rendered=(await media.registerLocalAsset({projectId:"sharp-cuts-web",contentId:draft.id,type:"video",state:"rendered",sha256:sha,bytes:1000,mimeType:"video/mp4",rightsStatus:"owned",consentStatus:"owner_confirmed",localCapabilityId:"cap_rendered_987654321"})).asset;
  await socialService.attachRenderedLocalMedia(draft.id,{assetId:rendered.id,type:"video",sha256:sha,rightsStatus:"owned"});const requested=await media.requestPromotionApproval({projectId:"sharp-cuts-web",contentId:draft.id,assetId:rendered.id});
  await socialService.revise(draft.id,{caption:"A materially revised caption."});assert.equal((await storage.getApproval(requested.approval.id,OWNER_ID)).status,"rejected");await assert.rejects(media.queueApprovedPromotion(requested.approval.arguments,{approvalId:requested.approval.id}),error=>error.code==="social_media_approval_mismatch");
});

test("private R2 completion preserves integrity and attaches no persistent public URL",async()=>{
  const{storage,socialService,draft,media}=await fixture(),rendered=(await media.registerLocalAsset({projectId:"sharp-cuts-web",contentId:draft.id,type:"video",state:"rendered",sha256:sha,bytes:1000,mimeType:"video/mp4",rightsStatus:"owned",consentStatus:"owner_confirmed",localCapabilityId:"cap_rendered_555555555"})).asset;
  await socialService.attachRenderedLocalMedia(draft.id,{assetId:rendered.id,type:"video",sha256:sha,rightsStatus:"owned"});const approval=(await media.requestPromotionApproval({projectId:"sharp-cuts-web",contentId:draft.id,assetId:rendered.id})).approval;await storage.decideApproval(approval.id,OWNER_ID,"approved");await media.queueApprovedPromotion(approval.arguments,{approvalId:approval.id});const job=(await media.claimJob({workerId:"windows-preview-worker",type:"promote"})).job;
  const completed=await media.completeCloudPromotion({jobId:job.id,leaseToken:job.leaseToken,sha256:sha,bytes:1000,cloudKey:"sharp-cuts-web/approved/asset.mp4",cloudEtag:"etag-safe"});assert.equal(completed.asset.storage,"r2");assert.equal(completed.asset.cloudUrl,null);const content=(await socialService.current(draft.id)).content;assert.equal(content.media[0].storage,"r2");assert.equal("url" in content.media[0],false);
});

test("a revision after approval blocks the queued promotion before upload",async()=>{
  const{storage,socialService,draft,media}=await fixture(),rendered=(await media.registerLocalAsset({projectId:"sharp-cuts-web",contentId:draft.id,type:"video",state:"rendered",sha256:sha,bytes:1000,mimeType:"video/mp4",rightsStatus:"owned",consentStatus:"owner_confirmed",localCapabilityId:"cap_rendered_stale_12345"})).asset;await socialService.attachRenderedLocalMedia(draft.id,{assetId:rendered.id,type:"video",sha256:sha,rightsStatus:"owned"});const approval=(await media.requestPromotionApproval({projectId:"sharp-cuts-web",contentId:draft.id,assetId:rendered.id})).approval;await storage.decideApproval(approval.id,OWNER_ID,"approved");await media.queueApprovedPromotion(approval.arguments,{approvalId:approval.id});await socialService.revise(draft.id,{caption:"Changed after approval"});const claim=await media.claimJob({workerId:"windows-preview-worker",type:"promote"});assert.equal(claim.job,null);assert.equal(claim.reason,"approval_envelope_stale");assert.equal((await media.dashboard("sharp-cuts-web")).assets.some(item=>item.storage==="r2"),false);
});

test("FFmpeg recipe is deterministic, vertical, branded, subtitled, and shell-free",()=>{
  const args=buildVerticalReelCommand({segments:[{path:"C:\\media\\clip one.mp4",startSeconds:2,durationSeconds:8}],subtitlePath:"C:\\media\\captions.srt",logoPath:"C:\\media\\logo.png",outputPath:"C:\\media\\final.mp4"});
  assert.ok(args.includes("1080:1920:force_original_aspect_ratio=increase".split(":")[0])===false);assert.match(args.join(" "),/scale=1080:1920/);assert.match(args.join(" "),/subtitles=/);assert.match(args.join(" "),/overlay=/);assert.equal(args.at(-1),"C:\\media\\final.mp4");
});

test("12-week marketing calendar is bounded, seasonal, and approval-only",()=>{
  const entries=buildRollingMarketingCalendar({start:now(),bankHolidays:[{date:"2026-12-28",title:"Boxing Day substitute day"}]});assert.deepEqual(entries.map(item=>item.title),["Halloween","Christmas","Boxing Day substitute day","New Year"]);assert.ok(entries.every(item=>item.requiresOwnerApproval&&item.projectId==="sharp-cuts-web"));
});

test("local workspace copies genuine media privately and rejects cross-project or traversal capabilities",async()=>{
  const root=await mkdtemp(join(tmpdir(),"nova-media-test-")),source=join(root,"owner clip.mp4");await writeFile(source,Buffer.from("genuine-owner-media"));const workspace=createLocalMediaWorkspace({root:join(root,"workspace"),maxBytes:1024});
  const result=await workspace.ingest({sourcePath:source,projectId:"sharp-cuts-web"});assert.equal(result.sha256,"888137562498a1779871de4898273297ecbf862cc8fd89c47ac838baf92e0c15");assert.deepEqual(await readFile(result.storedPath),Buffer.from("genuine-owner-media"));assert.throws(()=>workspace.resolveCapability("nova-digital-services-uk",result.localCapabilityId,".mp4"),/restricted|Invalid/);assert.throws(()=>workspace.resolveCapability("sharp-cuts-web","../escape",".mp4"),/Invalid/);
});

test("migration 30 is additive, project-scoped, reversible by table isolation, and preserves existing data",async()=>{
  const migration=await readFile(new URL("../migrations/030_social_media_automation.sql",import.meta.url),"utf8");for(const table of["nova_social_media_assets","nova_social_media_jobs","nova_social_calendar_entries"])assert.match(migration,new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));assert.match(migration,/project_id text NOT NULL REFERENCES nova_projects/);assert.match(migration,/UNIQUE\(owner_id,intent_hash\)/);assert.doesNotMatch(migration,/DROP\s+TABLE|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE.*DROP/i);assert.match(migration,/VALUES \(30\)/);
});
