import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readConfig } from "../src/config/env.js";
import { OWNER_ID } from "../src/identity/initial-context.js";
import { createActionPolicy, ApprovalRequiredError } from "../src/policy/action-policy.js";
import { createMetaPublishingAdapter, createSocialService } from "../src/social/social-service.js";
import { registerSocialTools } from "../src/social/social-tools.js";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";
import { SCHEMA_STATEMENTS, SCHEMA_VERSION } from "../src/storage/schema.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";

const ENV=Object.freeze({NOVA_META_GRAPH_API_VERSION:"v24.0",NOVA_META_FACEBOOK_PAGE_ID:"12345678901",NOVA_META_INSTAGRAM_ACCOUNT_ID:"23456789012",NOVA_META_PAGE_ACCESS_TOKEN:"server-only-token"});
const now=()=>new Date("2026-10-15T10:00:00.000Z");

async function fixture({live=true,publisher}={}){
  const storage=createInMemoryStorage({clock:now});
  await storage.initialize({owner:{id:OWNER_ID,fullName:"Owner"},projects:[{id:"nova-digital-services-uk",name:"Nova Digital Services UK"},{id:"independent-project",name:"Independent Project"}]});
  const config=readConfig({...ENV,NOVA_SOCIAL_LIVE_ENABLED:String(live)});
  const calls=[];
  const service=createSocialService({config,storage,ownerId:OWNER_ID,clock:now,publisher:publisher||{async publish(input){calls.push(input);return{id:`provider-${input.platform}`};}}});
  return{storage,config,service,calls};
}

const draftInput=(overrides={})=>({projectId:"nova-digital-services-uk",kind:"post",title:"A practical AI tip",caption:"Use AI to remove one repetitive admin step, then measure the time saved.",platforms:["facebook"],media:[],sourceRefs:[],evidenceStatus:"not_applicable",originalityStatus:"passed",...overrides});

test("Social configuration is server-only, complete, and live-disabled by default",()=>{
  assert.equal(readConfig({}).social.configured,false);
  assert.throws(()=>readConfig({NOVA_META_GRAPH_API_VERSION:"v24.0"}),/all four/i);
  const config=readConfig(ENV);assert.equal(config.social.configured,true);assert.equal(config.social.liveEnabled,false);assert.equal(config.social.accessToken,"server-only-token");
});

test("schema 25 contains project-scoped content and durable exactly-once publication records",()=>{
  assert.equal(SCHEMA_VERSION,25);
  for(const table of["nova_social_content","nova_social_publications"])assert.ok(SCHEMA_STATEMENTS.some(statement=>statement.includes(`CREATE TABLE IF NOT EXISTS ${table}`)));
  const publication=SCHEMA_STATEMENTS.find(statement=>statement.includes("CREATE TABLE IF NOT EXISTS nova_social_publications"));
  assert.match(publication,/UNIQUE\(owner_id,intent_hash\)/);assert.match(publication,/lease_token/);assert.match(publication,/approval_id/);
});

test("drafts are project isolated, evidence gated, original, rights declared, and content-addressed",async()=>{
  const {service}=await fixture();
  await assert.rejects(service.createDraft(draftInput({evidenceStatus:"verified"})),error=>error.code==="social_source_required");
  await assert.rejects(service.createDraft(draftInput({media:[{type:"image",url:"https://cdn.example/owned.jpg"}]})),error=>error.code==="social_media_rights_required");
  const {content}=await service.createDraft(draftInput({media:[{type:"image",url:"https://cdn.example/owned.jpg",rightsStatus:"owned",alt:"Nova dashboard"}]}));
  assert.equal(content.status,"review_ready");assert.equal(content.projectId,"nova-digital-services-uk");assert.match(content.contentHash,/^[a-f0-9]{64}$/);
  assert.equal((await service.list({projectId:"independent-project"})).content.length,0);
  assert.equal((await service.list({projectId:"nova-digital-services-uk"})).content.length,1);
});

test("scheduling requires formal approval and binds the exact immutable caption, media, platforms, and hash",async()=>{
  const {service,storage}=await fixture();const {content}=await service.createDraft(draftInput());const {envelope}=await service.current(content.id);
  const registry=createToolRegistry({policy:createActionPolicy({storage,ownerId:OWNER_ID,approvedBranch:"preview"})});registerSocialTools(registry,{service});
  const input={contentId:content.id,contentHash:content.contentHash,caption:content.caption,media:content.media,platforms:content.platforms,publishAt:"2026-10-15T11:00:00.000Z"};
  await assert.rejects(registry.execute("social_schedule_publish",input,{projectId:content.projectId}),error=>error instanceof ApprovalRequiredError&&error.approval.tool==="social_schedule_publish"&&error.approval.arguments.contentHash===envelope.contentHash);
  await assert.rejects(service.schedule({...input,caption:"changed"}),error=>error.code==="social_content_changed");
});

test("live-off worker performs no provider action",async()=>{
  const {service,calls}=await fixture({live:false});const {content}=await service.createDraft(draftInput());await service.schedule({contentId:content.id,contentHash:content.contentHash,caption:content.caption,media:content.media,platforms:content.platforms,publishAt:"2026-10-15T10:00:00.000Z"});
  assert.deepEqual(await service.processNext({workerId:"worker"}),{worked:false,reason:"not_enabled"});assert.equal(calls.length,0);
});

test("durable publisher submits each approved platform once and does not duplicate an idempotent schedule",async()=>{
  const {service,calls}=await fixture();const {content}=await service.createDraft(draftInput({platforms:["facebook","instagram"],kind:"reel",media:[{type:"video",url:"https://cdn.example/reel.mp4",rightsStatus:"owned"}]}));const input={contentId:content.id,contentHash:content.contentHash,caption:content.caption,media:content.media,platforms:content.platforms,publishAt:"2026-10-15T10:00:00.000Z"};
  const first=await service.schedule(input,{approvalId:"approval-1"}),second=await service.schedule(input,{approvalId:"approval-1"});assert.equal(first.publication.id,second.publication.id);
  const result=await service.processNext({workerId:"worker"});assert.equal(result.status,"published");assert.deepEqual(calls.map(call=>call.platform),["facebook","instagram"]);assert.equal((await service.processNext({workerId:"worker"})).worked,false);
});

test("ambiguous provider outcome becomes uncertain and is never automatically retried",async()=>{
  let attempts=0;const {service}=await fixture({publisher:{async publish(){attempts+=1;const error=new Error("network failed token=private");error.code="social_publish_uncertain";throw error;}}});const {content}=await service.createDraft(draftInput());await service.schedule({contentId:content.id,contentHash:content.contentHash,caption:content.caption,media:content.media,platforms:content.platforms,publishAt:"2026-10-15T10:00:00.000Z"});
  assert.equal((await service.processNext({workerId:"worker"})).status,"uncertain");assert.equal((await service.processNext({workerId:"worker"})).worked,false);assert.equal(attempts,1);
});

test("Instagram adapter waits for a finished media container before publishing",async()=>{
  const requests=[];const responses=[{id:"container-1"},{status_code:"IN_PROGRESS"},{status_code:"FINISHED"},{id:"media-1"}];
  const adapter=createMetaPublishingAdapter({config:readConfig({...ENV,NOVA_SOCIAL_LIVE_ENABLED:"true"}),sleep:async()=>{},fetchImpl:async(url,options)=>{requests.push({url:String(url),options});return{ok:true,async json(){return responses.shift();}};}});
  const result=await adapter.publish({platform:"instagram",content:{kind:"reel",caption:"Arabic عربي and English",media:[{type:"video",url:"https://cdn.example/reel.mp4",rightsStatus:"owned"}]}});
  assert.equal(result.id,"media-1");assert.deepEqual(requests.map(item=>item.options.method),["POST","GET","GET","POST"]);assert.match(requests[1].url,/status_code,status/);
});

test("Console exposes a Social Command Centre while approval copy shows exact publication data",async()=>{
  const [html,consoleJs,presenter]=await Promise.all([readFile(new URL("../index.html",import.meta.url),"utf8"),readFile(new URL("../assets/console.js",import.meta.url),"utf8"),readFile(new URL("../assets/approval-presenter.js",import.meta.url),"utf8")]);
  assert.match(html,/Social Command Centre/);assert.match(html,/data-section="social"/);assert.match(consoleJs,/socialDashboard/);assert.match(presenter,/Approve social publication/);assert.match(presenter,/Immutable content hash/);
});
