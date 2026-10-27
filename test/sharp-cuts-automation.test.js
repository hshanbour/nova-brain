import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createInMemoryStorage} from "../src/storage/in-memory-storage.js";
import {analyseCalendarCapacity,buildMigrationReadySourceManifest,buildSharpCutsCampaignDryRun,buildSharpCutsChannelReadiness,buildSharpCutsSocialWorkflow,buildWinbackProgramme,buildWinbackProposal,classifyRetentionRecords,createSharpCutsAutomationService,estimateCampaignCost,SHARP_CUTS_FUTURE_AUTOMATION,syntheticRetentionFixture} from "../src/automation/sharp-cuts-automation.js";
import {buildSharpCutsWorkspaceManifest,SHARP_CUTS_WORKSPACE_ID} from "../src/automation/sharp-cuts-workspace.js";

const OWNER="owner-primary",AS_OF=new Date("2026-10-17T09:00:00.000Z");

test("30/45/60/90 retention segmentation excludes booked customers and fails closed on consent and suppression",()=>{
  const result=classifyRetentionRecords(syntheticRetentionFixture(AS_OF),{asOf:AS_OF});
  assert.deepEqual(result.counts,{inactive30:1,inactive45:1,inactive60:2,inactive90:1,notDue:1,alreadyBooked:1,blocked:2,eligibleForOwnerReview:3});
  assert.equal(result.records.find(item=>item.customerRef==="demo-customer-003").recommendedAction,"blocked");
  assert.match(result.records.find(item=>item.customerRef==="demo-customer-003").reason,/No verified electronic-marketing basis/);
  assert.equal(result.records.find(item=>item.customerRef==="demo-customer-004").recommendedAction,"blocked");
  assert.match(result.records.find(item=>item.customerRef==="demo-customer-004").reason,/Suppression/);
  assert.equal(result.records.find(item=>item.customerRef==="demo-customer-005").segment,"already_booked");
  assert.equal(result.records.every(item=>item.customerRef.startsWith("demo-customer-")),true);
});

test("win-back proposal is costed, approval-gated, and never authorises a send",()=>{
  const analysis=classifyRetentionRecords(syntheticRetentionFixture(AS_OF),{asOf:AS_OF}),proposal=buildWinbackProposal(analysis,{emailAllowanceRemaining:50});
  assert.equal(proposal.audienceCount,3);assert.equal(proposal.status,"waiting_for_owner_review");assert.equal(proposal.recommendedChannel,"email");assert.equal(proposal.emailCost.totalPenceIncVat,0);assert.equal(proposal.smsAlternativeCost.subtotalPenceExVat,24);assert.equal(proposal.smsAlternativeCost.totalPenceIncVat,29);assert.equal(proposal.safeguards.automaticSend,false);assert.equal(proposal.exclusions.alreadyBooked,1);assert.equal(proposal.exclusions.blockedForConsentOrSuppression,2);
  assert.match(proposal.audienceSnapshotHash,/^[a-f0-9]{64}$/);assert.match(proposal.proposalHash,/^[a-f0-9]{64}$/);assert.equal(proposal.approvalTool,"sharp_cuts_campaign_send");
  assert.throws(()=>estimateCampaignCost({recipientCount:1,channel:"whatsapp"}),error=>error.code==="sharp_cuts_campaign_invalid");
});

const privacySafeAudit=()=>({
  rawContactDataRetained:false,identifiers:"hmac_sha256",auditHash:"a".repeat(64),asOf:AS_OF.toISOString(),counts:{profiles:7},profiles:[
    {profileKey:"p30",inactivitySegment:"inactive_30",hasUpcomingBooking:false,marketingBasis:"consent",suppressed:false,emailEligible:true,smsEligible:false},
    {profileKey:"p45",inactivitySegment:"inactive_45",hasUpcomingBooking:false,marketingBasis:"soft_opt_in_verified",suppressed:false,emailEligible:true,smsEligible:true},
    {profileKey:"p60",inactivitySegment:"inactive_60",hasUpcomingBooking:false,marketingBasis:"unknown",suppressed:false,emailEligible:false,smsEligible:false},
    {profileKey:"p90a",inactivitySegment:"inactive_90",hasUpcomingBooking:false,marketingBasis:"consent",suppressed:false,emailEligible:true,smsEligible:true},
    {profileKey:"p90b",inactivitySegment:"inactive_90",hasUpcomingBooking:false,marketingBasis:"unknown",suppressed:false,emailEligible:false,smsEligible:false},
    {profileKey:"p90c",inactivitySegment:"inactive_90",hasUpcomingBooking:false,marketingBasis:"consent",suppressed:true,emailEligible:false,smsEligible:false},
    {profileKey:"booked",inactivitySegment:"inactive_90",hasUpcomingBooking:true,marketingBasis:"consent",suppressed:false,emailEligible:true,smsEligible:true}
  ]
});

test("complete win-back programme covers every inactivity band and prioritises 90+ without inferring consent",()=>{
  const programme=buildWinbackProgramme(privacySafeAudit());
  assert.deepEqual(programme.priorityOrder,["inactive_90","inactive_60","inactive_45","inactive_30"]);
  assert.equal(programme.segments.length,4);
  const ninety=programme.segments[0];assert.equal(ninety.total,3);assert.equal(ninety.email.eligible,1);assert.equal(ninety.sms.eligible,1);assert.equal(ninety.unknownBasis,1);assert.equal(ninety.suppressed,1);
  const sixty=programme.segments.find(item=>item.id==="inactive_60");assert.equal(sixty.status,undefined);assert.equal(sixty.email.status,"blocked_marketing_eligibility");
  assert.equal(programme.eligibility.sendPermissionInferred,false);assert.equal(programme.safeguards.liveSend,false);assert.equal(programme.channels.whatsapp,"manual_app_only_no_paid_api");
});

test("migration-ready source manifest retains only safe metadata and requires a separately approved import",()=>{
  const manifest=buildMigrationReadySourceManifest(privacySafeAudit());
  assert.equal(manifest.profileCount,7);assert.equal(manifest.pseudonymousProfileCount,7);assert.equal(manifest.rawContactsRetained,false);assert.equal(manifest.recordImportStatus,"not_authorised");assert.equal(manifest.sourceAuditHash,"a".repeat(64));
  assert.throws(()=>buildMigrationReadySourceManifest({profiles:[]}),error=>error.code==="sharp_cuts_customer_audit_required");
});

test("social workflow requires rights-verified shop footage and cannot publish",()=>{
  const blocked=buildSharpCutsSocialWorkflow(),ready=buildSharpCutsSocialWorkflow({mediaAssets:[{id:"shop-clip-01",kind:"video",rights:"owned",reusableThisMonth:true},{id:"unknown-clip",kind:"video",rights:"unknown"}]});
  assert.equal(blocked.status,"blocked_awaiting_owned_footage");assert.equal(ready.status,"draft_production_ready");assert.equal(ready.monthlyReuse.eligibleClipCount,1);assert.equal(ready.safeguards.livePublishing,false);assert.equal(ready.safeguards.ownerApprovalRequired,true);assert.equal(ready.platforms.tiktok,"draft_only_not_connected");
});

test("future automation remains fail-closed and evidence-based",()=>{
  assert.equal(SHARP_CUTS_FUTURE_AUTOMATION.emptySlotPromotions.status,"blocked_until_availability_is_certified");assert.equal(SHARP_CUTS_FUTURE_AUTOMATION.loyalty.liveProgrammeCreated,false);assert.equal(SHARP_CUTS_FUTURE_AUTOMATION.channels.whatsapp.status,"manual_app_only");assert.ok(SHARP_CUTS_FUTURE_AUTOMATION.measurement.metrics.includes("attributed_revenue"));
});

test("channel readiness is project-scoped, read-only, and does not infer WhatsApp or sending access",()=>{
  const channels=buildSharpCutsChannelReadiness({metaConnection:{instagram:{connected:true,username:"sharpcuts.uk"},facebook:{connected:true,pageId:"1707389769348747"}},senderProbe:{connected:true}}),byId=Object.fromEntries(channels.map(item=>[item.id,item]));
  assert.equal(byId.instagram.status,"connected_read_only");assert.equal(byId.facebook.status,"connected_read_only");assert.equal(byId.email.status,"provider_connected_draft_only");assert.equal(byId.whatsapp.status,"business_app_preserved_manual_only");assert.equal(byId.sms.status,"no_project_scoped_provider");assert.ok(byId.instagram.blocked.includes("publishing"));assert.ok(byId.whatsapp.blocked.includes("api_send"));assert.doesNotMatch(JSON.stringify(channels),/hamoodtrims/i);
});

test("campaign dry run completes the lifecycle in a deterministic synthetic sink without an external call",()=>{
  const dryRun=buildSharpCutsCampaignDryRun({asOf:AS_OF});
  assert.equal(dryRun.mode,"synthetic_test_sink");assert.equal(dryRun.projectId,"sharp-cuts-web");assert.deepEqual(dryRun.stages.map(item=>item.id),["identify","prepare","approve","schedule","execute","monitor"]);assert.equal(dryRun.audience.eligible,3);assert.equal(dryRun.result.attempted,3);assert.equal(dryRun.result.delivered,2);assert.equal(dryRun.result.failed,1);assert.equal(dryRun.result.duplicateSends,0);assert.equal(dryRun.safeguards.externalCalls,0);assert.equal(dryRun.safeguards.liveMessagesSent,false);assert.match(dryRun.runHash,/^[a-f0-9]{64}$/);
});

test("business workspace links resources without merging projects or granting external writes",()=>{
  const workspace=buildSharpCutsWorkspaceManifest({projectReady:true,senderConnected:true});
  assert.equal(workspace.id,SHARP_CUTS_WORKSPACE_ID);
  assert.equal(workspace.projectBoundary.primaryProjectId,"sharp-cuts-web");
  assert.equal(workspace.projectBoundary.legacyProjectId,"sharp-cuts");
  assert.equal(workspace.projectBoundary.legacyContextInjection,false);
  assert.equal(workspace.projectBoundary.mergeAuthorised,false);
  assert.equal(workspace.resources.find(item=>item.id==="instagram").novaStatus,"blocked_pending_project_scoped_oauth");
  assert.equal(workspace.resources.find(item=>item.id==="shop-operations").writesEnabled,false);
  assert.equal(workspace.resources.find(item=>item.id==="tiktok").novaStatus,"official_authorization_required");
  assert.equal(workspace.resources.find(item=>item.id==="email").externalStatus,"authenticated_provider_probe_passed");
  assert.equal(workspace.resources.every(item=>item.writesEnabled===false),true);
  assert.equal(workspace.controls.ownerApprovalRequired,true);
  assert.equal(workspace.controls.publishing,false);
  assert.doesNotMatch(JSON.stringify(workspace),/hamoodtrims/i);
});

test("business workspace reports only a verified project-scoped Sharp Cuts Meta binding",()=>{
  const workspace=buildSharpCutsWorkspaceManifest({projectReady:true,metaConnection:{connected:true,instagram:{connected:true,accountId:"45678901234",username:"sharpcuts.uk"},facebook:{connected:true,pageId:"56789012345",pageName:"Sharp Cuts Gents Barbers"}}});
  assert.equal(workspace.resources.find(item=>item.id==="instagram").novaStatus,"project_scoped_connection_verified");
  assert.equal(workspace.resources.find(item=>item.id==="facebook").novaStatus,"project_scoped_connection_verified");
  assert.equal(workspace.resources.find(item=>item.id==="instagram").writesEnabled,false);
  assert.equal(workspace.controls.publishing,false);
});

test("Sharp Cuts Command Centre exposes the resource boundary without adding another dashboard",async()=>{
  const consoleSource=await readFile(new URL("../assets/console.js",import.meta.url),"utf8");
  assert.match(consoleSource,/Sharp Cuts · isolated business workspace/);
  assert.match(consoleSource,/sharpCutsWorkspaceConnections/);
  assert.match(consoleSource,/legacy context blocked/);
  assert.match(consoleSource,/External writes off/);
  assert.match(consoleSource,/visibleProjects=projects\.filter\(project=>project\.id!=="sharp-cuts"\)/);
  assert.match(consoleSource,/socialProjects=projects\.filter\(project=>project\.id!=="sharp-cuts"\)/);
  assert.match(consoleSource,/One isolated business workspace for Shop Operations, Sharp Cuts Web, Fresha, Instagram, Facebook and future TikTok integration/);
});

test("calendar capacity never counts a long Walk-in block as a customer appointment or offerable time",()=>{
  const result=analyseCalendarCapacity([{barberRef:"demo-barber-01",date:"2026-10-19",shiftStartMinute:540,shiftEndMinute:1020,intervals:[
    {startMinute:540,endMinute:570,kind:"service",label:"Haircut",customerBound:true,serviceBound:true},
    {startMinute:600,endMinute:840,kind:"walk_in",label:"Walk-in",customerBound:false,serviceBound:false},
    {startMinute:900,endMinute:930,kind:"blocked",label:"Break"}
  ]}]);
  const item=result.records[0];assert.equal(item.serviceMinutes,30);assert.equal(item.blockedMinutes,30);assert.equal(item.ambiguousWalkInMinutes,240);assert.equal(item.knownBookableMinutes,210);assert.equal(item.genuinelyAvailableMinutes,180);assert.equal(item.occupancyPercent,14);assert.equal(item.offerSafe,false);assert.equal(item.ownerReviewRequired,true);assert.equal(result.counts.ambiguousWalkInMinutes,240);
});

test("short evidence-bound walk-ins count as services while explicit blocks reduce capacity",()=>{
  const item=analyseCalendarCapacity([{barberRef:"demo-barber-02",date:"2026-10-19",shiftStartMinute:540,shiftEndMinute:1020,intervals:[
    {startMinute:600,endMinute:630,kind:"walk_in",label:"Walk-in",customerBound:true,serviceBound:true},
    {startMinute:720,endMinute:780,kind:"blocked",label:"Unavailable"}
  ]}]).records[0];
  assert.equal(item.serviceMinutes,30);assert.equal(item.blockedMinutes,60);assert.equal(item.ambiguousWalkInMinutes,0);assert.equal(item.knownBookableMinutes,420);assert.equal(item.genuinelyAvailableMinutes,390);assert.equal(item.offerSafe,true);
});

test("the demonstration is idempotent, project-isolated, durable in Activity, and never sends",async()=>{
  const storage=createInMemoryStorage({clock:()=>AS_OF});await storage.initialize({owner:{id:OWNER,fullName:"Mohammad"},projects:[{id:"sharp-cuts",name:"Sharp Cuts"},{id:"sharp-cuts-web",name:"Sharp Cuts Web"}]});
  const service=createSharpCutsAutomationService({storage,ownerId:OWNER,clock:()=>AS_OF}),first=await service.runSyntheticRetentionDemo(),second=await service.runSyntheticRetentionDemo(),dashboard=await service.dashboard();
  assert.equal(first.created,true);assert.equal(second.created,false);assert.equal(dashboard.activity.length,1);assert.equal(dashboard.activity[0].projectId,"sharp-cuts-web");assert.equal(dashboard.safeguards.liveMessagesSent,false);assert.equal(dashboard.safeguards.rawCustomerDataStored,false);assert.equal(dashboard.safeguards.livePublishing,false);assert.equal(dashboard.sections.pendingApprovals.count,0);assert.equal(dashboard.latestDemo.proposal.audienceCount,3);assert.deepEqual(dashboard.latestDemo.winbackProgramme.priorityOrder,["inactive_90","inactive_60","inactive_45","inactive_30"]);assert.equal(dashboard.latestDemo.customerSource.recordImportStatus,"not_authorised");assert.equal(dashboard.latestDemo.socialWorkflow.status,"blocked_awaiting_owned_footage");assert.equal(dashboard.latestDemo.capacity.counts.ownerReview,2);assert.equal(dashboard.latestDemo.capacity.counts.ambiguousWalkInMinutes,240);assert.equal(dashboard.latestDemo.loyalty.liveProgrammeCreated,false);assert.equal(dashboard.activity[0].metadata.version,3);
  assert.equal((await storage.listActivity(OWNER,{projectId:"sharp-cuts"})).length,0);
  assert.equal(dashboard.stagingSnapshot.profiles,1991);assert.equal(dashboard.stagingSnapshot.contact.email,1571);assert.equal(dashboard.stagingSnapshot.contact.phone,1649);assert.equal(dashboard.stagingSnapshot.contact.both,1569);assert.equal(dashboard.stagingSnapshot.contact.missingBoth,340);
  assert.equal(dashboard.stagingSnapshot.duplicates.confirmedPairs,10);assert.equal(dashboard.stagingSnapshot.duplicates.ambiguousPairs,1647);assert.equal(dashboard.stagingSnapshot.duplicates.mergedProfiles,0);
  assert.equal(dashboard.campaignReview.audience.candidateProfiles,1530);assert.equal(dashboard.campaignReview.audience.potentialUniqueEmailRecipients,1161);assert.equal(dashboard.campaignReview.audience.duplicateAddressProfilesExcluded,7);assert.equal(dashboard.campaignReview.audience.verifiedSendableRecipients,0);
  assert.equal(dashboard.campaignReview.status,"blocked_before_approval");assert.equal(dashboard.campaignReview.approval.status,"not_created");assert.equal(dashboard.campaignReview.approval.approveEnabled,false);assert.equal(dashboard.campaignReview.safeguards.liveSend,false);
  assert.equal(dashboard.workspace.id,"sharp-cuts-business-workspace");assert.equal(dashboard.workspace.projectBoundary.legacyContextInjection,false);assert.equal(dashboard.workspace.controls.externalWrites,false);
  assert.match(dashboard.campaignReview.email.body,/SAME SHARP CUTS\. A WHOLE NEW EXPERIENCE/);assert.match(dashboard.campaignReview.email.body,/fresh new look/);assert.match(dashboard.campaignReview.email.body,/NOW IT'S YOUR TURN FOR A FRESH LOOK/);assert.doesNotMatch(dashboard.campaignReview.email.body,/20% OFF/);assert.equal((dashboard.campaignReview.email.html.match(/>20% OFF</g)||[]).length,1);
});

test("the full campaign dry run is idempotent, durable, and isolated from the legacy project",async()=>{
  const storage=createInMemoryStorage({clock:()=>AS_OF});await storage.initialize({owner:{id:OWNER,fullName:"Mohammad"},projects:[{id:"sharp-cuts",name:"Sharp Cuts"},{id:"sharp-cuts-web",name:"Sharp Cuts Web"}]});
  const service=createSharpCutsAutomationService({storage,ownerId:OWNER,clock:()=>AS_OF}),first=await service.runSyntheticCampaignDryRun(),second=await service.runSyntheticCampaignDryRun(),dashboard=await service.dashboard();
  assert.equal(first.created,true);assert.equal(second.created,false);assert.equal(dashboard.latestDryRun.runHash,first.dryRun.runHash);assert.equal(dashboard.latestDryRun.safeguards.externalCalls,0);assert.equal(dashboard.activity.filter(item=>item.action==="sharp_cuts_campaign_dry_run_completed").length,1);assert.equal((await storage.listActivity(OWNER,{projectId:"sharp-cuts"})).length,0);
});

test("dashboard performs only a redacted read-only Sender probe and never exposes credentials",async()=>{
  const storage=createInMemoryStorage({clock:()=>AS_OF});await storage.initialize({owner:{id:OWNER,fullName:"Mohammad"},projects:[{id:"sharp-cuts-web",name:"Sharp Cuts Web"}]});
  let probes=0;const service=createSharpCutsAutomationService({storage,ownerId:OWNER,clock:()=>AS_OF,senderConfig:{configured:true,apiToken:"private-sender-token"},senderClient:{async probe(){probes++;return{connected:true,provider:"Sender.net",groupCount:0,tokenExposed:false};}}}),dashboard=await service.dashboard();
  assert.equal(probes,1);assert.equal(dashboard.campaignReview.sender.connected,true);assert.equal(dashboard.campaignReview.sender.identity,"Sharp Cuts");assert.equal(dashboard.campaignReview.approval.approveEnabled,false);assert.equal(dashboard.campaignReview.safeguards.liveSend,false);assert.doesNotMatch(JSON.stringify(dashboard),/private-sender-token/);
});

test("the demonstration refuses to create or merge the missing Sharp Cuts Web project",async()=>{
  const storage=createInMemoryStorage();await storage.initialize({owner:{id:OWNER,fullName:"Mohammad"},projects:[{id:"sharp-cuts",name:"Sharp Cuts"}]});
  const service=createSharpCutsAutomationService({storage,ownerId:OWNER,clock:()=>AS_OF});
  await assert.rejects(()=>service.runSyntheticRetentionDemo(),error=>error.code==="sharp_cuts_project_required");
  assert.deepEqual((await storage.listProjects(OWNER)).map(item=>item.id),["sharp-cuts"]);
});

test("the n8n workflow export is inactive, fixture-only, and contains no provider or customer credential",async()=>{
  const workflow=JSON.parse(await readFile(new URL("../automations/n8n/sharp-cuts-retention-monitor.demo.json",import.meta.url),"utf8")),serialized=JSON.stringify(workflow);
  assert.equal(workflow.active,false);assert.equal(workflow.meta.fixtureOnly,true);assert.equal(workflow.meta.liveMessaging,false);assert.equal(workflow.meta.ownerApprovalRequired,true);assert.deepEqual(workflow.nodes.map(node=>node.type),["n8n-nodes-base.manualTrigger","n8n-nodes-base.code","n8n-nodes-base.code"]);assert.doesNotMatch(serialized,/api[_-]?key|authorization|phone|email|fresha\.com|twilio/i);
});
