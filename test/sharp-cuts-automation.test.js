import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createInMemoryStorage} from "../src/storage/in-memory-storage.js";
import {analyseCalendarCapacity,buildMigrationReadySourceManifest,buildSharpCutsSocialWorkflow,buildWinbackProgramme,buildWinbackProposal,classifyRetentionRecords,createSharpCutsAutomationService,estimateCampaignCost,SHARP_CUTS_FUTURE_AUTOMATION,syntheticRetentionFixture} from "../src/automation/sharp-cuts-automation.js";

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
  assert.match(dashboard.campaignReview.email.body,/SAME SHARP CUTS\. A WHOLE NEW EXPERIENCE/);assert.match(dashboard.campaignReview.email.body,/fresh new look/);assert.match(dashboard.campaignReview.email.body,/NOW IT'S YOUR TURN FOR A FRESH LOOK/);assert.doesNotMatch(dashboard.campaignReview.email.body,/20% OFF/);assert.equal((dashboard.campaignReview.email.html.match(/>20% OFF</g)||[]).length,1);
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
