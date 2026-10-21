import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readConfig } from "../src/config/env.js";
import { OWNER_ID } from "../src/identity/initial-context.js";
import { createActionPolicy, ApprovalRequiredError } from "../src/policy/action-policy.js";
import { createMetaPublishingAdapter, createSocialService } from "../src/social/social-service.js";
import { createInstagramOAuthService, FACEBOOK_SCOPES, INSTAGRAM_SCOPES } from "../src/social/instagram-oauth.js";
import { registerSocialTools } from "../src/social/social-tools.js";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";
import { SCHEMA_STATEMENTS, SCHEMA_VERSION } from "../src/storage/schema.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";

const ENV=Object.freeze({NOVA_META_GRAPH_API_VERSION:"v24.0",NOVA_META_FACEBOOK_PAGE_ID:"12345678901",NOVA_META_INSTAGRAM_ACCOUNT_ID:"23456789012",NOVA_META_PAGE_ACCESS_TOKEN:"server-only-token"});
const SHARP_META_ENV=Object.freeze({
  NOVA_SHARP_CUTS_META_APP_ID:"34567890123",
  NOVA_SHARP_CUTS_META_APP_SECRET:"sharp-server-only-secret",
  NOVA_SHARP_CUTS_META_OAUTH_REDIRECT_URI:"https://preview.example/api/integrations/instagram/oauth/callback",
  NOVA_SHARP_CUTS_META_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,8).toString("base64"),
  NOVA_SHARP_CUTS_META_INSTAGRAM_ACCOUNT_ID:"45678901234",
  NOVA_SHARP_CUTS_META_FACEBOOK_PAGE_ID:"56789012345",
});
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
  assert.throws(()=>readConfig({NOVA_META_GRAPH_API_VERSION:"v24.0"}),/GRAPH_API_VERSION.*INSTAGRAM_ACCOUNT_ID/i);
  const config=readConfig(ENV);assert.equal(config.social.configured,true);assert.equal(config.social.liveEnabled,false);assert.equal(config.social.accessToken,"server-only-token");
});

test("Instagram OAuth is independently configurable without inventing a Facebook Page token",()=>{
  const environment={NOVA_META_GRAPH_API_VERSION:"v24.0",NOVA_META_INSTAGRAM_ACCOUNT_ID:"17841421559881769",NOVA_META_INSTAGRAM_APP_ID:"1601026398491282",NOVA_META_INSTAGRAM_APP_SECRET:"server-only-secret",NOVA_META_INSTAGRAM_OAUTH_REDIRECT_URI:"https://preview.example/api/integrations/instagram/oauth/callback",NOVA_META_INSTAGRAM_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString("base64")};
  const config=readConfig(environment);assert.equal(config.social.configured,true);assert.equal(config.social.facebookConfigured,false);assert.equal(config.social.oauth.configured,true);assert.equal(config.social.liveEnabled,false);
});

test("Instagram-only metrics do not call Facebook and Facebook publishing fails closed",async()=>{
  const environment={NOVA_META_GRAPH_API_VERSION:"v24.0",NOVA_META_INSTAGRAM_ACCOUNT_ID:"17841421559881769",NOVA_META_INSTAGRAM_APP_ID:"1601026398491282",NOVA_META_INSTAGRAM_APP_SECRET:"server-only-secret",NOVA_META_INSTAGRAM_OAUTH_REDIRECT_URI:"https://preview.example/api/integrations/instagram/oauth/callback",NOVA_META_INSTAGRAM_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString("base64")};
  const requests=[],adapter=createMetaPublishingAdapter({config:readConfig(environment),instagramAccessToken:async()=>"instagram-private",fetchImpl:async url=>{requests.push(String(url));return{ok:true,async json(){return{followers_count:7,media_count:3};}};}});
  assert.deepEqual(await adapter.readMetrics(),{facebook:null,instagram:{followers:7,mediaCount:3}});assert.equal(requests.length,1);assert.match(requests[0],/^https:\/\/graph\.instagram\.com\//);
  await assert.rejects(adapter.publish({platform:"facebook",content:{caption:"Safe",media:[]}}),error=>error.code==="social_facebook_not_configured");
});

test("current schema contains project-scoped social data and encrypted Instagram OAuth storage",()=>{
  assert.ok(SCHEMA_VERSION>=29);
  for(const table of["nova_social_content","nova_social_publications"])assert.ok(SCHEMA_STATEMENTS.some(statement=>statement.includes(`CREATE TABLE IF NOT EXISTS ${table}`)));
  assert.ok(SCHEMA_STATEMENTS.some(statement=>statement.includes("CREATE TABLE IF NOT EXISTS nova_social_metric_snapshots")));
  assert.ok(SCHEMA_STATEMENTS.some(statement=>statement.includes("ADD COLUMN IF NOT EXISTS plan")));
  assert.ok(SCHEMA_STATEMENTS.some(statement=>statement.includes("CREATE TABLE IF NOT EXISTS nova_instagram_oauth_states")));
  assert.ok(SCHEMA_STATEMENTS.some(statement=>statement.includes("CREATE TABLE IF NOT EXISTS nova_instagram_connections")));
  assert.ok(SCHEMA_STATEMENTS.some(statement=>statement.includes("CREATE TABLE IF NOT EXISTS nova_project_meta_oauth_states")));
  assert.ok(SCHEMA_STATEMENTS.some(statement=>statement.includes("CREATE TABLE IF NOT EXISTS nova_project_meta_connections")));
  assert.ok(SCHEMA_STATEMENTS.some(statement=>statement.includes("SELECT owner_id,'nova-digital-services-uk','instagram_login',account_id,username,scopes,encrypted_access_token")));
  const publication=SCHEMA_STATEMENTS.find(statement=>statement.includes("CREATE TABLE IF NOT EXISTS nova_social_publications"));
  assert.match(publication,/UNIQUE\(owner_id,intent_hash\)/);assert.match(publication,/lease_token/);assert.match(publication,/approval_id/);
});

test("schema 29 migration copies the existing Nova connection without decrypting or replacing it",async()=>{
  const migration=await readFile(new URL("../migrations/029_project_scoped_meta.sql",import.meta.url),"utf8");
  assert.match(migration,/SELECT owner_id,'nova-digital-services-uk','instagram_login',account_id,username,scopes,encrypted_access_token/);
  assert.match(migration,/ON CONFLICT \(owner_id,project_id,provider\) DO NOTHING/);
  assert.match(migration,/UNIQUE \(owner_id,provider,account_id\)/);
  assert.match(migration,/VALUES \(29\)/);
  assert.doesNotMatch(migration,/decrypt|app_secret|access_token\s*=|DROP\s+TABLE|DELETE\s+FROM/i);
});

test("Instagram OAuth is single-use, exact-scope, owner-bound, encrypted, and verifies Nova's account",async()=>{
  const storage=createInMemoryStorage({clock:now});await storage.initialize({owner:{id:OWNER_ID,fullName:"Owner"},projects:[]});
  const environment={...ENV,NOVA_META_INSTAGRAM_ACCOUNT_ID:"17841421559881769",NOVA_META_INSTAGRAM_APP_ID:"1601026398491282",NOVA_META_INSTAGRAM_APP_SECRET:"server-only-secret",NOVA_META_INSTAGRAM_OAUTH_REDIRECT_URI:"https://preview.example/api/integrations/instagram/oauth/callback",NOVA_META_INSTAGRAM_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString("base64")};
  const replies=[{data:[{access_token:"short-private",user_id:"17841421559881769",permissions:INSTAGRAM_SCOPES.join(",")}]},{access_token:"long-private",expires_in:5184000},{id:"17841421559881769",user_id:"17841421559881769",username:"novadigitalservicesuk",account_type:"BUSINESS"}],requests=[];
  const service=createInstagramOAuthService({config:readConfig(environment),storage,ownerId:OWNER_ID,clock:now,randomBytesImpl:size=>Buffer.alloc(size,9),fetchImpl:async(url,options={})=>{requests.push({url:String(url),method:options.method||"GET"});return{ok:true,async json(){return replies.shift();}};}}),started=await service.start("nova-digital-services-uk"),url=new URL(started.authorizationUrl);
  assert.deepEqual(url.searchParams.get("scope").split(","),INSTAGRAM_SCOPES);assert.doesNotMatch(started.authorizationUrl,/messages|comments|advertising/);
  const state=url.searchParams.get("state"),completed=await service.complete({code:"provider-code",state,session:started.session});assert.equal(completed.username,"novadigitalservicesuk");
  assert.equal(requests.some(item=>item.method==="GET"&&item.url.includes("/me/permissions")),false);
  const stored=await storage.getProjectMetaConnection(OWNER_ID,"nova-digital-services-uk","instagram_login");assert.notEqual(stored.encryptedAccessToken.ciphertext,"long-private");assert.equal(JSON.stringify(stored).includes("long-private"),false);
  await assert.rejects(service.complete({code:"provider-code",state,session:started.session}),error=>error.code==="instagram_oauth_state_rejected");
});

test("Instagram OAuth normalizes observed token responses and rejects missing, unexpected, or malformed permission grants",async()=>{
  const environment={...ENV,NOVA_META_INSTAGRAM_ACCOUNT_ID:"17841421559881769",NOVA_META_INSTAGRAM_APP_ID:"1601026398491282",NOVA_META_INSTAGRAM_APP_SECRET:"server-only-secret",NOVA_META_INSTAGRAM_OAUTH_REDIRECT_URI:"https://preview.example/api/integrations/instagram/oauth/callback",NOVA_META_INSTAGRAM_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString("base64")};
  const attempt=async({profile,permissions,expectedCode})=>{
    const storage=createInMemoryStorage({clock:now});await storage.initialize({owner:{id:OWNER_ID,fullName:"Owner"},projects:[]});
    const requests=[];
    const service=createInstagramOAuthService({config:readConfig(environment),storage,ownerId:OWNER_ID,clock:now,randomBytesImpl:size=>Buffer.alloc(size,5),fetchImpl:async(url,options={})=>{const href=String(url),method=options.method||"GET";requests.push({url:href,method});let body={};if(href.startsWith("https://api.instagram.com/oauth/access_token"))body={access_token:"short-private",permissions};else if(href.startsWith("https://graph.instagram.com/access_token"))body={access_token:"long-private",expires_in:5184000};else if(method==="GET"&&href.startsWith("https://graph.instagram.com/me?"))body=profile;return{ok:true,async json(){return body;}};}}),started=await service.start("nova-digital-services-uk");
    await assert.rejects(service.complete({code:"provider-code",state:new URL(started.authorizationUrl).searchParams.get("state"),session:started.session}),error=>error.code===expectedCode);
    assert.equal(requests.at(-1).method,"DELETE");assert.equal(await storage.getProjectMetaConnection(OWNER_ID,"nova-digital-services-uk","instagram_login"),null);
  };
  await attempt({profile:{id:"not-nova",username:"someone_else"},permissions:INSTAGRAM_SCOPES,expectedCode:"instagram_wrong_account"});
  await attempt({permissions:INSTAGRAM_SCOPES.slice(0,2),expectedCode:"instagram_scope_missing"});
  await attempt({permissions:[...INSTAGRAM_SCOPES,"instagram_business_manage_messages"],expectedCode:"instagram_scope_unexpected"});
  await attempt({permissions:{invalid:true},expectedCode:"instagram_scope_response_invalid"});
});

test("Instagram OAuth revokes an acquired token after any later provider failure without persisting it",async()=>{
  const storage=createInMemoryStorage({clock:now});await storage.initialize({owner:{id:OWNER_ID,fullName:"Owner"},projects:[]});
  const environment={...ENV,NOVA_META_INSTAGRAM_ACCOUNT_ID:"17841421559881769",NOVA_META_INSTAGRAM_APP_ID:"1601026398491282",NOVA_META_INSTAGRAM_APP_SECRET:"server-only-secret",NOVA_META_INSTAGRAM_OAUTH_REDIRECT_URI:"https://preview.example/api/integrations/instagram/oauth/callback",NOVA_META_INSTAGRAM_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString("base64")},requests=[];
  const service=createInstagramOAuthService({config:readConfig(environment),storage,ownerId:OWNER_ID,clock:now,randomBytesImpl:size=>Buffer.alloc(size,4),fetchImpl:async(url,options={})=>{const href=String(url),method=options.method||"GET";requests.push({href,method});if(href.startsWith("https://api.instagram.com/oauth/access_token"))return{ok:true,async json(){return{data:[{access_token:"short-private",permissions:INSTAGRAM_SCOPES.join(",")}]};}};if(method==="DELETE")return{ok:true,async json(){return{};}};return{ok:false,async json(){return{error:{code:190}};}};}}),started=await service.start("nova-digital-services-uk");
  await assert.rejects(service.complete({code:"provider-code",state:new URL(started.authorizationUrl).searchParams.get("state"),session:started.session}),error=>error.code==="instagram_provider_rejected"&&!error.message.includes("short-private"));
  assert.equal(requests.at(-1).method,"DELETE");assert.equal(await storage.getProjectMetaConnection(OWNER_ID,"nova-digital-services-uk","instagram_login"),null);
});

test("Instagram OAuth configuration fails closed for incomplete settings, unsafe callbacks, and invalid encryption keys",()=>{
  assert.throws(()=>readConfig({...ENV,NOVA_META_INSTAGRAM_APP_ID:"1601026398491282"}),/all four Instagram OAuth/i);
  assert.throws(()=>readConfig({...ENV,NOVA_META_INSTAGRAM_APP_ID:"1601026398491282",NOVA_META_INSTAGRAM_APP_SECRET:"private",NOVA_META_INSTAGRAM_OAUTH_REDIRECT_URI:"http://preview.example/api/integrations/instagram/oauth/callback",NOVA_META_INSTAGRAM_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32).toString("base64")}),/HTTPS Instagram callback/i);
  assert.throws(()=>readConfig({...ENV,NOVA_META_INSTAGRAM_APP_ID:"1601026398491282",NOVA_META_INSTAGRAM_APP_SECRET:"private",NOVA_META_INSTAGRAM_OAUTH_REDIRECT_URI:"https://preview.example/api/integrations/instagram/oauth/callback",NOVA_META_INSTAGRAM_TOKEN_ENCRYPTION_KEY:"too-short"}),/exactly 32 bytes/i);
});

test("Sharp Cuts Facebook Login binds only the verified Page and Instagram account without changing Nova Digital Services",async()=>{
  const storage=createInMemoryStorage({clock:now});await storage.initialize({owner:{id:OWNER_ID,fullName:"Owner"},projects:[{id:"nova-digital-services-uk",name:"Nova Digital Services UK"},{id:"sharp-cuts-web",name:"Sharp Cuts"}]});
  await storage.saveProjectMetaConnection({ownerId:OWNER_ID,projectId:"nova-digital-services-uk",provider:"instagram_login",accountId:"23456789012",username:"novadigitalservicesuk",facebookPageId:null,facebookPageName:null,scopes:INSTAGRAM_SCOPES,encryptedAccessToken:{version:1,algorithm:"aes-256-gcm",iv:"existing",tag:"existing",ciphertext:"existing-nova-ciphertext"},encryptedSecondaryToken:null,expiresAt:"2026-12-15T10:00:00.000Z",lastSyncedAt:"2026-10-15T09:00:00.000Z"});
  const before=await storage.getProjectMetaConnection(OWNER_ID,"nova-digital-services-uk","instagram_login"),requests=[];
  const replies=[
    {access_token:"short-user-private",expires_in:3600},
    {access_token:"long-user-private",expires_in:5184000},
    {data:[...FACEBOOK_SCOPES,"public_profile"].map(permission=>({permission,status:"granted"}))},
    {data:[{id:"56789012345",name:"Sharp Cuts Gents Barbers",access_token:"page-private",instagram_business_account:{id:"45678901234",username:"sharpcuts.uk"}}]},
  ];
  const config=readConfig({...ENV,...SHARP_META_ENV}),service=createInstagramOAuthService({config,storage,ownerId:OWNER_ID,clock:now,randomBytesImpl:size=>Buffer.alloc(size,6),fetchImpl:async(url,options={})=>{requests.push({url:String(url),method:options.method||"GET"});return{ok:true,async json(){return replies.shift();}};}}),started=await service.start("sharp-cuts-web"),authorization=new URL(started.authorizationUrl);
  assert.equal(authorization.hostname,"www.facebook.com");assert.deepEqual(authorization.searchParams.get("scope").split(","),FACEBOOK_SCOPES);assert.doesNotMatch(authorization.searchParams.get("scope"),/ads|messages|comments/);
  const completed=await service.complete({code:"facebook-provider-code",state:authorization.searchParams.get("state"),session:started.session});
  assert.equal(completed.projectId,"sharp-cuts-web");assert.equal(completed.accountId,"45678901234");assert.equal(completed.facebookPageId,"56789012345");
  const sharp=await storage.getProjectMetaConnection(OWNER_ID,"sharp-cuts-web","facebook_login"),after=await storage.getProjectMetaConnection(OWNER_ID,"nova-digital-services-uk","instagram_login");
  assert.equal(JSON.stringify(sharp).includes("page-private"),false);assert.equal(JSON.stringify(sharp).includes("long-user-private"),false);assert.ok(sharp.encryptedSecondaryToken);assert.deepEqual(after,before);
  assert.equal((await service.credentials("sharp-cuts-web")).accessToken,"page-private");assert.equal(requests.filter(item=>item.url.includes("/me/accounts?")).length,1);
});

test("project-scoped Meta OAuth rejects cross-project access, wrong assets, and unauthorized permissions",async()=>{
  const config=readConfig({...ENV,...SHARP_META_ENV});
  const attempt=async({permissions=FACEBOOK_SCOPES,pageId="56789012345",instagramId="45678901234",pageName="Sharp Cuts Gents Barbers",expectedCode})=>{
    const storage=createInMemoryStorage({clock:now});await storage.initialize({owner:{id:OWNER_ID,fullName:"Owner"},projects:[{id:"nova-digital-services-uk",name:"Nova Digital Services UK"},{id:"sharp-cuts-web",name:"Sharp Cuts"}]});
    const responses=[{access_token:"short-user-private"},{access_token:"long-user-private",expires_in:5184000},{data:permissions.map(permission=>({permission,status:"granted"}))},{data:[{id:pageId,name:pageName,access_token:"page-private",instagram_business_account:{id:instagramId,username:"sharpcuts.uk"}}]}],requests=[];
    const service=createInstagramOAuthService({config,storage,ownerId:OWNER_ID,clock:now,randomBytesImpl:size=>Buffer.alloc(size,3),fetchImpl:async(url,options={})=>{requests.push({url:String(url),method:options.method||"GET"});return{ok:true,async json(){return options.method==="DELETE"?{}:responses.shift();}};}}),started=await service.start("sharp-cuts-web");
    await assert.rejects(service.complete({code:"facebook-provider-code",state:new URL(started.authorizationUrl).searchParams.get("state"),session:started.session}),error=>error.code===expectedCode);
    assert.equal(await storage.getProjectMetaConnection(OWNER_ID,"sharp-cuts-web","facebook_login"),null);assert.equal(requests.at(-1).method,"DELETE");
  };
  await attempt({permissions:FACEBOOK_SCOPES.slice(0,-1),expectedCode:"instagram_scope_missing"});
  await attempt({permissions:[...FACEBOOK_SCOPES,"ads_management"],expectedCode:"instagram_scope_unexpected"});
  await attempt({pageId:"99999999999",expectedCode:"instagram_wrong_account"});
  const storage=createInMemoryStorage({clock:now});await storage.initialize({owner:{id:OWNER_ID,fullName:"Owner"},projects:[{id:"independent-project",name:"Independent"}]});const service=createInstagramOAuthService({config,storage,ownerId:OWNER_ID,clock:now});
  await assert.rejects(service.start("independent-project"),error=>error.code==="instagram_project_not_authorized");await assert.rejects(service.credentials("independent-project"),error=>error.code==="instagram_project_not_authorized");
});

test("one verified Meta account cannot be bound to two Nova projects",async()=>{
  const storage=createInMemoryStorage({clock:now});await storage.initialize({owner:{id:OWNER_ID,fullName:"Owner"},projects:[{id:"sharp-cuts-web",name:"Sharp Cuts"},{id:"independent-project",name:"Independent"}]});
  await storage.saveProjectMetaConnection({ownerId:OWNER_ID,projectId:"independent-project",provider:"facebook_login",accountId:"45678901234",username:"sharpcuts.uk",facebookPageId:"56789012345",facebookPageName:"Sharp Cuts Gents Barbers",scopes:FACEBOOK_SCOPES,encryptedAccessToken:{version:1,algorithm:"aes-256-gcm",iv:"other",tag:"other",ciphertext:"other"},encryptedSecondaryToken:null,expiresAt:"2026-12-15T10:00:00.000Z"});
  await assert.rejects(storage.saveProjectMetaConnection({ownerId:OWNER_ID,projectId:"sharp-cuts-web",provider:"facebook_login",accountId:"45678901234",username:"sharpcuts.uk",facebookPageId:"56789012345",facebookPageName:"Sharp Cuts Gents Barbers",scopes:FACEBOOK_SCOPES,encryptedAccessToken:{version:1,algorithm:"aes-256-gcm",iv:"sharp",tag:"sharp",ciphertext:"sharp"},encryptedSecondaryToken:null,expiresAt:"2026-12-15T10:00:00.000Z"}),error=>error.code==="meta_account_scope_conflict");
});

test("Sharp Cuts Meta configuration is complete-only, Preview HTTPS-only, and live publishing stays off",()=>{
  assert.throws(()=>readConfig({...ENV,NOVA_SHARP_CUTS_META_APP_ID:"34567890123"}),/All six Sharp Cuts Meta OAuth/i);
  assert.throws(()=>readConfig({...ENV,...SHARP_META_ENV,NOVA_SHARP_CUTS_META_OAUTH_REDIRECT_URI:"http://preview.example/api/integrations/instagram/oauth/callback"}),/HTTPS Meta callback/i);
  const config=readConfig({...ENV,...SHARP_META_ENV});assert.equal(config.social.sharpCutsOAuth.configured,true);assert.equal(config.social.liveEnabled,false);
});

test("the five-concept launch batch is idempotent, English-first, project-scoped, and follows the 40/40/20 pillars",async()=>{
  const {service}=await fixture();const first=await service.createLaunchBatch("nova-digital-services-uk"),second=await service.createLaunchBatch("nova-digital-services-uk");
  assert.equal(first.created,5);assert.equal(second.created,0);assert.equal(first.content.length,5);
  assert.deepEqual(first.content.reduce((counts,item)=>(counts[item.plan.pillar]=(counts[item.plan.pillar]||0)+1,counts),{}),{ai_technology:2,ai_experiments:2,nova_projects_services:1});
  for(const item of first.content){assert.equal(item.projectId,"nova-digital-services-uk");assert.equal(item.plan.language,"english");assert.equal(item.plan.assetStatus,"planned");assert.equal(item.status,"draft");assert.equal(item.kind,"reel");assert.equal(item.media.length,0);assert.match(item.script,/HOOK/);}
});

test("Reels cannot become review-ready or scheduled until a rights-declared video exists",async()=>{
  const {service}=await fixture();const {content}=await service.createDraft(draftInput({kind:"reel",platforms:["instagram"],media:[],plan:{pillar:"ai_experiments",language:"english",hook:"Test",shotPlan:["Demo"],assetStatus:"planned",estimatedVariableCostUsd:0}}));assert.equal(content.status,"draft");
  await assert.rejects(service.schedule({contentId:content.id,contentHash:content.contentHash,caption:content.caption,media:content.media,platforms:content.platforms,publishAt:"2026-10-15T11:00:00.000Z"}),error=>error.code==="social_content_not_ready");
});

test("official Meta metric reads are retained as project-scoped snapshots without asset identifiers",async()=>{
  let reads=0;const storage=createInMemoryStorage({clock:now});await storage.initialize({owner:{id:OWNER_ID,fullName:"Owner"},projects:[{id:"nova-digital-services-uk",name:"Nova Digital Services UK"},{id:"independent-project",name:"Independent Project"}]});const config=readConfig({...ENV,NOVA_SOCIAL_LIVE_ENABLED:"true"}),service=createSocialService({config,storage,ownerId:OWNER_ID,clock:now,instagramOAuth:{status:async projectId=>({connected:projectId==="nova-digital-services-uk"})},publisher:{async publish(){throw new Error("not used");},async readMetrics(projectId){assert.equal(projectId,"nova-digital-services-uk");reads+=1;return{facebook:{followers:12,pageLikes:9},instagram:{followers:34,mediaCount:5}};}}});
  const {snapshot,cached}=await service.refreshMetrics("nova-digital-services-uk"),second=await service.refreshMetrics("nova-digital-services-uk");assert.deepEqual(snapshot.metrics.instagram,{followers:34,mediaCount:5});assert.equal(cached,false);assert.equal(second.cached,true);assert.equal(reads,1);
  assert.equal((await storage.listSocialMetricSnapshots(OWNER_ID,{projectId:"independent-project"})).length,0);assert.equal((await service.dashboard("nova-digital-services-uk")).status.metricsVerified,true);
});

test("Instagram Login uses the official Instagram host and separate server-only token",async()=>{
  const requests=[],responses=[{id:"container-2"},{status_code:"FINISHED"},{id:"media-2"}];const config=readConfig({...ENV,NOVA_META_INSTAGRAM_LOGIN_ACCESS_TOKEN:"instagram-server-only",NOVA_SOCIAL_LIVE_ENABLED:"true"});
  const adapter=createMetaPublishingAdapter({config,sleep:async()=>{},fetchImpl:async(url,options)=>{requests.push({url:String(url),authorization:options.headers.authorization});return{ok:true,async json(){return responses.shift();}};}});await adapter.publish({platform:"instagram",content:{kind:"reel",caption:"Original",media:[{type:"video",url:"https://cdn.example/reel.mp4",rightsStatus:"owned"}]}});
  assert.ok(requests.every(item=>item.url.startsWith("https://graph.instagram.com/")));assert.ok(requests.every(item=>item.authorization==="Bearer instagram-server-only"));
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

test("editing a draft creates a new hash, invalidates pending approval, and requires renewed review",async()=>{
  const {service,storage}=await fixture();const {content}=await service.createDraft(draftInput());
  await storage.createApproval({id:"social-edit-approval",ownerId:OWNER_ID,projectId:content.projectId,tool:"social_schedule_publish",riskLevel:"sensitive",status:"pending",reason:"Review exact publication",arguments:{contentId:content.id,contentHash:content.contentHash}});
  const result=await service.revise(content.id,{caption:"A materially revised owner caption."});
  assert.equal(result.content.status,"draft");assert.notEqual(result.content.contentHash,content.contentHash);assert.equal(result.content.approvedHash,null);assert.deepEqual(result.invalidatedApprovalIds,["social-edit-approval"]);assert.equal((await storage.getApproval("social-edit-approval",OWNER_ID)).status,"rejected");
  await assert.rejects(service.schedule({contentId:result.content.id,contentHash:result.content.contentHash,caption:result.content.caption,media:result.content.media,platforms:result.content.platforms,publishAt:"2026-10-15T11:00:00.000Z"}),error=>error.code==="social_content_not_ready");
});

test("review submission is production-gated and a requested revision returns content to draft",async()=>{
  const {service}=await fixture();const {content}=await service.createDraft(draftInput({kind:"reel",platforms:["instagram"],media:[],plan:{pillar:"ai_experiments",language:"english",hook:"Test",shotPlan:["Demo"],assetStatus:"planned",estimatedVariableCostUsd:0}}));
  await assert.rejects(service.submitReview(content.id),error=>error.code==="social_checks_incomplete");
  const revised=await service.revise(content.id,{media:[{type:"video",url:"https://cdn.example/owned.mp4",rightsStatus:"owned"}],plan:{...content.plan,assetStatus:"ready"}}),reviewed=await service.submitReview(revised.content.id);assert.equal(reviewed.content.status,"review_ready");
  const requested=await service.requestRevision(content.id,{reason:"Tighten the opening hook."});assert.equal(requested.content.status,"draft");assert.equal(requested.content.approvedHash,null);
});

test("only an unclaimed schedule can be cancelled and rescheduling needs a fresh approval",async()=>{
  const {service,storage}=await fixture();const {content}=await service.createDraft(draftInput()),input={contentId:content.id,contentHash:content.contentHash,caption:content.caption,media:content.media,platforms:content.platforms,publishAt:"2026-10-15T11:00:00.000Z"},scheduled=await service.schedule(input,{approvalId:"approval-1"});
  const result=await service.cancelPublication(scheduled.publication.id);assert.equal(result.publication.status,"cancelled");assert.equal((await storage.getSocialContent(content.id,OWNER_ID)).status,"review_ready");await assert.rejects(service.cancelPublication(scheduled.publication.id),error=>error.code==="social_cancel_not_allowed");
});

test("live-off worker performs no provider action",async()=>{
  const {service,calls}=await fixture({live:false});const {content}=await service.createDraft(draftInput());await service.schedule({contentId:content.id,contentHash:content.contentHash,caption:content.caption,media:content.media,platforms:content.platforms,publishAt:"2026-10-15T10:00:00.000Z"});
  assert.deepEqual(await service.processNext({workerId:"worker"}),{worked:false,reason:"not_enabled"});assert.equal(calls.length,0);
});

test("durable publisher submits each approved platform once and does not duplicate an idempotent schedule",async()=>{
  const {service,calls}=await fixture();const {content}=await service.createDraft(draftInput({platforms:["facebook","instagram"],kind:"post",media:[{type:"image",url:"https://cdn.example/post.jpg",rightsStatus:"owned"}]}));const input={contentId:content.id,contentHash:content.contentHash,caption:content.caption,media:content.media,platforms:content.platforms,publishAt:"2026-10-15T10:00:00.000Z"};
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
  const [html,consoleJs,presenter,memoryClient]=await Promise.all([readFile(new URL("../index.html",import.meta.url),"utf8"),readFile(new URL("../assets/console.js",import.meta.url),"utf8"),readFile(new URL("../assets/approval-presenter.js",import.meta.url),"utf8"),readFile(new URL("../assets/memory-client.js",import.meta.url),"utf8")]);
  assert.match(html,/Social Command Centre/);assert.match(html,/Organic audience growth/);assert.match(html,/socialProjectFilter/);assert.match(html,/Verified growth measurement/);assert.match(html,/socialDetailDialog/);assert.match(html,/socialActivityFilter/);assert.match(html,/data-section="social"/);assert.match(consoleJs,/socialDashboard/);assert.match(consoleJs,/openSocialContentDetail/);assert.match(consoleJs,/requestSocialRevision/);assert.match(consoleJs,/cancelSocialPublication/);assert.match(consoleJs,/socialApprovalList/);assert.match(consoleJs,/socialActivityLabels/);assert.match(presenter,/Approve social publication/);assert.match(presenter,/Immutable content hash/);
  assert.match(consoleJs,/loadGeneration=\+\+socialLoadGeneration/);assert.match(consoleJs,/if\(loadGeneration!==socialLoadGeneration\)return/);
  assert.match(consoleJs,/Connect Instagram/);assert.match(consoleJs,/startInstagramOAuth\(projectId\)/);assert.match(consoleJs,/www\.instagram\.com/);assert.match(consoleJs,/www\.facebook\.com/);assert.match(memoryClient,/\/api\/integrations\/instagram\/oauth\/start/);
  assert.match(consoleJs,/socialProject/);
});

test("dashboard isolates projects and returns only social approvals and activity",async()=>{
  const {service,storage}=await fixture();const {content}=await service.createDraft(draftInput());
  await storage.createApproval({id:"social-approval",ownerId:OWNER_ID,projectId:content.projectId,tool:"social_schedule_publish",riskLevel:"sensitive",status:"pending",reason:"Review exact publication",arguments:{contentId:content.id}});
  await storage.createApproval({id:"email-approval",ownerId:OWNER_ID,projectId:content.projectId,tool:"gmail_send",riskLevel:"sensitive",status:"pending",reason:"Email",arguments:{}});
  await storage.appendActivity({ownerId:OWNER_ID,projectId:content.projectId,action:"unrelated",tool:"gmail_send",status:"completed",summary:"Not social"});
  const dashboard=await service.dashboard(content.projectId);assert.equal(dashboard.content.length,1);assert.equal(dashboard.approvals.length,1);assert.equal(dashboard.approvals[0].id,"social-approval");assert.equal(dashboard.activity.length,1);assert.equal(dashboard.activity[0].tool,"social_content_draft");assert.equal(dashboard.summary.pendingApprovals,1);
  const isolated=await service.dashboard("independent-project");assert.equal(isolated.content.length,0);assert.equal(isolated.approvals.length,0);assert.equal(isolated.activity.length,0);
});
