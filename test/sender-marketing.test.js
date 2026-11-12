import test from "node:test";
import assert from "node:assert/strict";
import {buildSharpCutsWinbackReview} from "../src/automation/sharp-cuts-campaign.js";
import {buildSenderCampaignDraft,createSenderMarketingClient,parseSharpCutsSenderConfig,senderReadiness,SHARP_CUTS_SENDER_PLAN} from "../src/email/sender-marketing.js";

const CONFIG=parseSharpCutsSenderConfig({
  NOVA_SHARP_CUTS_SENDER_API_TOKEN:"provider-secret-token",
  NOVA_SHARP_CUTS_SENDER_GROUP_ID:"group_90day",
  NOVA_SHARP_CUTS_SENDER_DOMAIN:"sharpcuts.uk",
  NOVA_SHARP_CUTS_SENDER_FROM_EMAIL:"info@sharpcuts.uk",
});

test("Sender.net free readiness fits the candidate audience but fails closed without an owned domain",()=>{
  const empty=parseSharpCutsSenderConfig({}),status=senderReadiness(empty);
  assert.equal(status.suitableForCandidateAudience,true);assert.equal(status.cost.monthly,0);assert.equal(status.limits.subscribers,2500);assert.equal(status.limits.emailsPerMonth,15000);
  assert.equal(status.plan,"Professional trial → Free Forever");assert.match(status.planEvidence,/automatically moves to Free Forever/);
  assert.equal(status.domain.gmailAllowedAsFrom,false);assert.equal(status.suppression.realtimeWebhooks,false);assert.equal(status.safeguards.sendAuthorised,false);
  const tokenOnly=parseSharpCutsSenderConfig({NOVA_SHARP_CUTS_SENDER_API_TOKEN:"x"});assert.equal(tokenOnly.configured,true);assert.equal(tokenOnly.draftConfigured,false);assert.equal(tokenOnly.sendingDomain,"sharpcuts.uk");assert.equal(tokenOnly.fromEmail,"info@sharpcuts.uk");
  for(const domain of ["gmail.com","sharp-cuts-web-blue.vercel.app"]){assert.throws(()=>parseSharpCutsSenderConfig({NOVA_SHARP_CUTS_SENDER_API_TOKEN:"x",NOVA_SHARP_CUTS_SENDER_GROUP_ID:"group_1",NOVA_SHARP_CUTS_SENDER_DOMAIN:domain,NOVA_SHARP_CUTS_SENDER_FROM_EMAIL:`hello@${domain}`}),/owned DNS domain/);}
  assert.equal(SHARP_CUTS_SENDER_PLAN.displayName,"Sharp Cuts");assert.equal(SHARP_CUTS_SENDER_PLAN.sendingDomain,"sharpcuts.uk");assert.equal(SHARP_CUTS_SENDER_PLAN.fromEmail,"info@sharpcuts.uk");assert.equal(SHARP_CUTS_SENDER_PLAN.accountMailbox,"sharpcuts.luton@gmail.com");
  assert.throws(()=>parseSharpCutsSenderConfig({NOVA_SHARP_CUTS_SENDER_API_TOKEN:"x",NOVA_SHARP_CUTS_SENDER_GROUP_ID:"group_1",NOVA_SHARP_CUTS_SENDER_DOMAIN:"another-owned.example",NOVA_SHARP_CUTS_SENDER_FROM_EMAIL:"hello@another-owned.example"}),/approved sharpcuts\.uk sender identity/);
});

test("Sender client exposes only bounded safe probes and never sends",async()=>{
  const calls=[],client=createSenderMarketingClient({config:CONFIG,fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json({data:[{id:"private-group-id",title:"private"}]});}}),probe=await client.probe();
  assert.deepEqual(probe,{connected:true,provider:"Sender.net",groupCount:null,groupsOnProbePage:1,tokenExposed:false});assert.equal(calls[0].url,"https://api.sender.net/v2/groups?limit=1");assert.equal(calls[0].options.headers.Authorization,"Bearer provider-secret-token");assert.doesNotMatch(JSON.stringify(probe),/provider-secret|private-group/);
  await assert.rejects(()=>client.sendCampaign("campaign_1"),error=>error.code==="sender_live_send_disabled");
});

test("provider failures are redacted and never expose secrets or response bodies",async()=>{
  const client=createSenderMarketingClient({config:CONFIG,fetchImpl:async()=>new Response(JSON.stringify({error:"provider-secret-token leaked body"}),{status:401,headers:{"content-type":"application/json"}})});
  await assert.rejects(()=>client.probe(),error=>{assert.equal(error.code,"sender_authentication_required");assert.doesNotMatch(`${error.message}${JSON.stringify(error)}`,/provider-secret|leaked body/);return true;});
});

test("provider account restrictions are classified without exposing the response body",async()=>{
  const client=createSenderMarketingClient({config:CONFIG,fetchImpl:async()=>new Response(JSON.stringify({error:"private provider review detail"}),{status:403,headers:{"content-type":"application/json"}})});
  await assert.rejects(()=>client.sendOwnerTest({recipient:"sharpcuts.luton@gmail.com"},{authority:{operation:"send_owner_test",projectId:"sharp-cuts-web",recipient:"sharpcuts.luton@gmail.com"}}),error=>{assert.equal(error.code,"sender_account_restricted");assert.equal(error.upstreamStatus,403);assert.equal(error.statusCode,502);assert.doesNotMatch(`${error.message}${JSON.stringify(error)}`,/private provider review detail|provider-secret-token/);return true;});
});

test("campaign draft uses Sharp Cuts identity, authenticated-domain address and mandatory unsubscribe",()=>{
  const audience={segment:"inactive_more_than_90_days",rawIdentifiersRetained:false,candidateProfiles:3,email:{uniqueRecipientCandidates:2,duplicateAddressProfilesExcluded:1},futureDateProxyExcluded:0,verifiedEligibility:{email:2},evidence:{futureBooking:"authoritative"},audienceSnapshotHash:"a".repeat(64)};
  const review=buildSharpCutsWinbackReview(audience,{sender:{connected:true,identity:"Sharp Cuts",provider:"Sender.net",verifiedDailyRecipientLimit:2500,config:CONFIG}});
  assert.equal(review.approval.approveEnabled,true);assert.equal(review.audience.verifiedSendableRecipients,2);
  const draft=buildSenderCampaignDraft({review,config:CONFIG});
  assert.equal(draft.provider.from,"Sharp Cuts");assert.equal(draft.provider.reply_to,"info@sharpcuts.uk");assert.equal(draft.provider.auto_followup_active,false);assert.deepEqual(draft.provider.groups,["group_90day"]);assert.match(draft.provider.content,/\{\$unsubscribe_link\}/);assert.match(draft.provider.content,/57 Cheapside/);assert.equal(draft.sendEnabled,false);assert.doesNotMatch(JSON.stringify(draft),/provider-secret-token/);
  assert.doesNotMatch(JSON.stringify(review),/provider-secret-token|group_90day/);
});

test("token-only connection can probe but cannot create a provider draft",()=>{
  const config=parseSharpCutsSenderConfig({NOVA_SHARP_CUTS_SENDER_API_TOKEN:"provider-secret-token"});
  assert.equal(config.configured,true);assert.equal(config.draftConfigured,false);
  assert.throws(()=>buildSenderCampaignDraft({review:{projectId:"sharp-cuts-web",approval:{approveEnabled:true},audience:{verifiedSendableRecipients:1}},config}),error=>error.code==="sender_group_required");
});

test("campaign draft creation requires exact immutable authority and still does not send",async()=>{
  const payload={projectId:"sharp-cuts-web",audienceSnapshotHash:"a".repeat(64),copyHash:"b".repeat(64),provider:{subject:"Review only"}},calls=[];
  const client=createSenderMarketingClient({config:CONFIG,fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json({data:{id:"campaign_1",status:"DRAFT"}});}});
  await assert.rejects(()=>client.createCampaignDraft(payload),error=>error.code==="sender_campaign_authority_required");assert.equal(calls.length,0);
  const result=await client.createCampaignDraft(payload,{authority:{operation:"create_campaign_draft",projectId:"sharp-cuts-web",audienceSnapshotHash:payload.audienceSnapshotHash,copyHash:payload.copyHash}});
  assert.deepEqual(result,{created:true,campaignId:"campaign_1",status:"DRAFT",sent:false});assert.equal(calls.length,1);
});

test("owner test is one-recipient transactional mail and never uploads a subscriber",async()=>{
  const calls=[],client=createSenderMarketingClient({config:CONFIG,fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json({success:true,message:"Email sent",emailId:"owner-test-1"});}});
  await assert.rejects(()=>client.sendOwnerTest(),error=>error.code==="sender_test_authority_required");
  const result=await client.sendOwnerTest({recipient:"sharpcuts.luton@gmail.com"},{authority:{operation:"send_owner_test",projectId:"sharp-cuts-web",recipient:"sharpcuts.luton@gmail.com"}});
  assert.equal(result.accepted,true);assert.equal(result.subscriberUploads,0);assert.equal(calls.length,1);assert.equal(calls[0].url,"https://api.sender.net/v2/message/send");const body=JSON.parse(calls[0].options.body);assert.equal(body.from.email,"info@sharpcuts.uk");assert.equal(body.from.name,"Sharp Cuts");assert.equal(body.to.email,"sharpcuts.luton@gmail.com");assert.doesNotMatch(JSON.stringify(body),/groups|subscribers/);
});


test('campaign inspection keeps 1562 membership intact and reports provider errors rather than assuming readiness',async()=>{
 const calls=[];const client=createSenderMarketingClient({config:CONFIG,fetchImpl:async(url,options)=>{
  calls.push([url,options.method]);return Response.json(url.endsWith('/groups')?{data:[{id:'group_90day',title:'Sharp Cuts',recipient_count:1562,active_subscribers:1550,unsubscribed_count:10,bounced_count:2}],links:{next:null}}:url.endsWith('/campaigns')?{data:[{id:'draft_1',status:'DRAFT',recipient_count:1562}],links:{next:null}}:{errors:[{title:'Account verification required'}],warnings:[]});
 }});
 const r=await client.inspectCampaignReadiness();assert.equal(r.groups[0].total,1562);assert.equal(r.groups[0].active,1550);assert.equal(r.contactsChanged,0);assert.equal(r.sendPermissionVerified,false);assert.deepEqual(r.campaigns[0].validation.errors,['Account verification required']);assert.ok(calls.every(x=>x[1]==='GET'));
});

test('sent reporting uses provider pagination total and never equates sent with delivered',async()=>{
 const client=createSenderMarketingClient({config:CONFIG,fetchImpl:async url=>Response.json(url.endsWith('/errors')?{errors:[{title:'No subscribers selected'}],warnings:[{title:'SPF warning'}]}:{data:[{email:'must-not-return@example.invalid'}],meta:{total:1562},links:{next:'page-2'}})});
 const r=await client.campaignStatus('campaign_1');assert.equal(r.sentCount,1562);assert.equal(r.deliveredCount,null);assert.equal(r.errors.length,1);assert.equal(r.warnings.length,1);assert.doesNotMatch(JSON.stringify(r),/must-not-return/);
});
