import {createHash} from "node:crypto";
import {buildSharpCutsWinbackReview,SHARP_CUTS_STAGING_SNAPSHOT} from "./sharp-cuts-campaign.js";
import {buildSharpCutsWorkspaceManifest} from "./sharp-cuts-workspace.js";

export const SHARP_CUTS_WEB_PROJECT_ID="sharp-cuts-web";
export const SHARP_CUTS_RETENTION_DEMO_ID="sharp-cuts-growth-demo-v3";

export const SHARP_CUTS_REAL_WINBACK_AUDIT=Object.freeze({
  version:1,asOf:"2026-10-19T00:00:00.000Z",sourceRows:1988,segment:"inactive_more_than_90_days",candidateProfiles:1530,
  email:Object.freeze({profilesWithAddress:1168,uniqueRecipientCandidates:1161,duplicateAddressProfilesExcluded:7}),
  phone:Object.freeze({profilesWithNumber:1228,uniqueNumberCandidates:986,duplicateNumberProfilesExcluded:242}),
  missingBoth:302,futureDateProxyExcluded:55,noVisitHistoryExcluded:194,
  verifiedEligibility:Object.freeze({email:0,sms:0,whatsapp:0}),
  evidence:Object.freeze({marketingConsent:"unavailable",suppression:"unavailable",deliveryReachability:"unavailable",futureBooking:"future_dated_last_appointment_proxy_only"}),
  sendAuthorised:false,rawIdentifiersRetained:false,audienceSnapshotHash:"9ae79f1a0457d56d5ccd3e03f2ffc326f659d1a89fdd81dd4d8a62b012ceea70"
});

export const FRESHA_UK_COMMUNICATION_PRICES=Object.freeze({
  marketingEmailPence:2,
  marketingSmsPence:8,
  automatedSmsPence:6,
  automatedWhatsappPenceRange:Object.freeze([5,10]),
  vatRate:0.2
});

const DAY_MS=24*60*60*1000;
const hash=value=>createHash("sha256").update(String(value)).digest("hex");
const iso=value=>{const parsed=new Date(value);if(Number.isNaN(parsed.getTime()))throw new SharpCutsAutomationError("A fixture date is invalid.",{code:"sharp_cuts_fixture_invalid"});return parsed.toISOString();};

export class SharpCutsAutomationError extends Error{
  constructor(message,{code="sharp_cuts_automation_error",statusCode=400}={}){super(message);this.name="SharpCutsAutomationError";this.code=code;this.statusCode=statusCode;}
}

export function classifyRetentionRecords(records,{asOf=new Date()}={}){
  const now=new Date(asOf);if(Number.isNaN(now.getTime()))throw new SharpCutsAutomationError("asOf is invalid.",{code:"sharp_cuts_fixture_invalid"});
  const output=[],counts={inactive30:0,inactive45:0,inactive60:0,inactive90:0,notDue:0,alreadyBooked:0,blocked:0,eligibleForOwnerReview:0};
  for(const record of records){
    const customerRef=String(record?.customerRef||"").trim();if(!/^demo-customer-\d{3}$/.test(customerRef))throw new SharpCutsAutomationError("Synthetic customer reference is invalid.",{code:"sharp_cuts_fixture_invalid"});
    const lastVisitAt=iso(record.lastVisitAt),daysInactive=Math.max(0,Math.floor((now.getTime()-new Date(lastVisitAt).getTime())/DAY_MS));
    const nextBookingAt=record.nextBookingAt?iso(record.nextBookingAt):null,suppressed=record.suppressed===true,marketingBasis=String(record.marketingBasis||"unknown");
    let segment="not_due",recommendedAction="none",eligible=false,reason="Customer is below the first inactivity threshold.";
    if(nextBookingAt&&new Date(nextBookingAt)>=now){segment="already_booked";reason="A future booking already exists; no retention contact is recommended.";}
    else if(daysInactive>=90){segment="inactive_90";recommendedAction="prepare_rebooking_recommendation";reason="No future booking and at least 90 inactive days.";}
    else if(daysInactive>=60){segment="inactive_60";recommendedAction="prepare_rebooking_recommendation";reason="No future booking and at least 60 inactive days.";}
    else if(daysInactive>=45){segment="inactive_45";recommendedAction="prepare_rebooking_recommendation";reason="No future booking and at least 45 inactive days.";}
    else if(daysInactive>=30){segment="inactive_30";recommendedAction="prepare_rebooking_recommendation";reason="No future booking and at least 30 inactive days.";}
    const retentionCandidate=segment.startsWith("inactive_");
    if(retentionCandidate&&suppressed){recommendedAction="blocked";reason="Suppression preference blocks promotional follow-up.";}
    else if(retentionCandidate&&!new Set(["consent","soft_opt_in_verified"]).has(marketingBasis)){recommendedAction="blocked";reason="No verified electronic-marketing basis is present.";}
    else if(retentionCandidate){eligible=true;reason+=" Sending still requires owner approval.";}
    if(segment==="inactive_30")counts.inactive30+=1;else if(segment==="inactive_45")counts.inactive45+=1;else if(segment==="inactive_60")counts.inactive60+=1;else if(segment==="inactive_90")counts.inactive90+=1;else if(segment==="already_booked")counts.alreadyBooked+=1;else counts.notDue+=1;
    if(retentionCandidate&&!eligible)counts.blocked+=1;if(eligible)counts.eligibleForOwnerReview+=1;
    output.push({customerRef,lastVisitAt,nextBookingAt,daysInactive,segment,marketingBasis,suppressed,recommendedAction,eligibleForOwnerReview:eligible,reason});
  }
  return{asOf:now.toISOString(),counts,records:output};
}

export function syntheticRetentionFixture(asOf=new Date("2026-10-17T09:00:00.000Z")){
  const at=days=>new Date(new Date(asOf).getTime()-days*DAY_MS).toISOString(),future=days=>new Date(new Date(asOf).getTime()+days*DAY_MS).toISOString();
  return[
    {customerRef:"demo-customer-001",lastVisitAt:at(31),marketingBasis:"consent",suppressed:false},
    {customerRef:"demo-customer-002",lastVisitAt:at(47),marketingBasis:"soft_opt_in_verified",suppressed:false},
    {customerRef:"demo-customer-003",lastVisitAt:at(67),marketingBasis:"unknown",suppressed:false},
    {customerRef:"demo-customer-004",lastVisitAt:at(72),marketingBasis:"consent",suppressed:true},
    {customerRef:"demo-customer-005",lastVisitAt:at(61),nextBookingAt:future(3),marketingBasis:"consent",suppressed:false},
    {customerRef:"demo-customer-006",lastVisitAt:at(12),marketingBasis:"consent",suppressed:false},
    {customerRef:"demo-customer-007",lastVisitAt:at(95),marketingBasis:"consent",suppressed:false},
  ];
}

export function estimateCampaignCost({recipientCount,channel,freeAllowanceRemaining=0}={}){
  const count=Number(recipientCount),allowance=Number(freeAllowanceRemaining);
  if(!Number.isInteger(count)||count<0||!Number.isInteger(allowance)||allowance<0)throw new SharpCutsAutomationError("Campaign counts must be non-negative integers.",{code:"sharp_cuts_campaign_invalid"});
  const prices={email:FRESHA_UK_COMMUNICATION_PRICES.marketingEmailPence,sms:FRESHA_UK_COMMUNICATION_PRICES.marketingSmsPence};
  if(!Object.hasOwn(prices,channel))throw new SharpCutsAutomationError("Only Fresha marketing email or SMS can be estimated.",{code:"sharp_cuts_campaign_invalid"});
  const chargeable=Math.max(0,count-allowance),subtotalPence=chargeable*prices[channel],totalPence=Math.round(subtotalPence*(1+FRESHA_UK_COMMUNICATION_PRICES.vatRate));
  return{channel,recipientCount:count,freeAllowanceRemaining:allowance,chargeableCount:chargeable,unitPricePenceExVat:prices[channel],subtotalPenceExVat:subtotalPence,totalPenceIncVat:totalPence,currency:"GBP",estimateOnly:true};
}

export function buildWinbackProposal(analysis,{emailAllowanceRemaining=0}={}){
  const eligible=analysis.records.filter(item=>item.eligibleForOwnerReview);
  const audienceRefs=eligible.map(item=>item.profileKey||item.customerRef).sort(),audienceSnapshotHash=hash(JSON.stringify(audienceRefs));
  const envelope={projectId:SHARP_CUTS_WEB_PROJECT_ID,audienceSnapshotHash,audienceCount:eligible.length,channel:"email",messageDraft:"It may be time for your next Sharp Cuts appointment. Book only if it suits you; you can opt out of marketing at any time."};
  return Object.freeze({
    status:"waiting_for_owner_review",
    audienceCount:eligible.length,
    audienceSnapshotHash,
    proposalHash:hash(JSON.stringify(envelope)),
    approvalTool:"sharp_cuts_campaign_send",
    segments:Object.freeze([...new Set(eligible.map(item=>item.segment))].sort()),
    recommendedChannel:"email",
    emailCost:estimateCampaignCost({recipientCount:eligible.length,channel:"email",freeAllowanceRemaining:emailAllowanceRemaining}),
    smsAlternativeCost:estimateCampaignCost({recipientCount:eligible.length,channel:"sms"}),
    exclusions:Object.freeze({alreadyBooked:analysis.counts.alreadyBooked,blockedForConsentOrSuppression:analysis.counts.blocked}),
    messageDraft:envelope.messageDraft,
    safeguards:Object.freeze({exactAudienceApprovalRequired:true,exactCopyApprovalRequired:true,automaticSend:false,duplicateReminder:false})
  });
}

export function analyseCalendarCapacity(records,{longWalkInMinutes=90}={}){
  if(!Number.isInteger(longWalkInMinutes)||longWalkInMinutes<30)throw new SharpCutsAutomationError("longWalkInMinutes is invalid.",{code:"sharp_cuts_capacity_invalid"});
  const output=[];
  for(const record of records){
    const barberRef=String(record?.barberRef||"").trim();if(!/^demo-barber-\d{2}$/.test(barberRef))throw new SharpCutsAutomationError("Synthetic barber reference is invalid.",{code:"sharp_cuts_fixture_invalid"});
    const shiftStart=Number(record.shiftStartMinute),shiftEnd=Number(record.shiftEndMinute);if(!Number.isInteger(shiftStart)||!Number.isInteger(shiftEnd)||shiftStart<0||shiftEnd<=shiftStart||shiftEnd>1440)throw new SharpCutsAutomationError("Shift values are invalid.",{code:"sharp_cuts_capacity_invalid"});
    let serviceMinutes=0,blockedMinutes=0,ambiguousWalkInMinutes=0;
    const intervals=(record.intervals||[]).map((item,index)=>{const start=Number(item.startMinute),end=Number(item.endMinute),minutes=end-start,label=String(item.label||"").trim(),kind=String(item.kind||"").trim();if(!Number.isInteger(start)||!Number.isInteger(end)||start<shiftStart||end>shiftEnd||end<=start)throw new SharpCutsAutomationError(`Calendar interval ${index+1} is invalid.`,{code:"sharp_cuts_capacity_invalid"});let classification="blocked_time",reason="Explicit non-bookable block.";if(kind==="service"&&item.customerBound===true&&item.serviceBound===true){classification="customer_service";reason="Customer and service evidence are both present.";serviceMinutes+=minutes;}else if(kind==="walk_in"&&(!item.customerBound||!item.serviceBound||minutes>=longWalkInMinutes)){classification="ambiguous_walk_in_block";reason="Walk-in label lacks customer/service evidence or is long enough to represent unavailability.";ambiguousWalkInMinutes+=minutes;}else if(kind==="walk_in"){classification="customer_service";reason="Short walk-in has customer and service evidence.";serviceMinutes+=minutes;}else blockedMinutes+=minutes;return{startMinute:start,endMinute:end,minutes,label,classification,reason};});
    const ordered=[...intervals].sort((a,b)=>a.startMinute-b.startMinute);for(let i=1;i<ordered.length;i++)if(ordered[i].startMinute<ordered[i-1].endMinute)throw new SharpCutsAutomationError("Calendar intervals overlap.",{code:"sharp_cuts_capacity_overlap",statusCode:409});
    const shiftMinutes=shiftEnd-shiftStart,knownBookableMinutes=shiftMinutes-blockedMinutes-ambiguousWalkInMinutes,genuinelyAvailableMinutes=Math.max(0,knownBookableMinutes-serviceMinutes),occupancyPercent=knownBookableMinutes?Math.round(serviceMinutes/knownBookableMinutes*100):null,matchingWaitlistCount=Number(record.matchingWaitlistCount||0);if(!Number.isInteger(matchingWaitlistCount)||matchingWaitlistCount<0)throw new SharpCutsAutomationError("matchingWaitlistCount is invalid.",{code:"sharp_cuts_capacity_invalid"});
    const offerSafe=ambiguousWalkInMinutes===0,strategy=!offerSafe?"resolve_calendar_ambiguity":matchingWaitlistCount>0&&genuinelyAvailableMinutes>0?"prepare_waitlist_offer":occupancyPercent!==null&&occupancyPercent<60?"prepare_last_minute_offer":"monitor_only",ownerReviewRequired=strategy!=="monitor_only";
    output.push({barberRef,date:iso(record.date),shiftMinutes,serviceMinutes,blockedMinutes,ambiguousWalkInMinutes,knownBookableMinutes,genuinelyAvailableMinutes,occupancyPercent,matchingWaitlistCount,strategy,intervals:ordered,offerSafe,ownerReviewRequired,reason:ambiguousWalkInMinutes>0?"Resolve ambiguous Walk-in blocks before offering slots.":"Only uncovered working time is considered available."});
  }
  return{records:output,counts:{ownerReview:output.filter(item=>item.ownerReviewRequired).length,offerSafe:output.filter(item=>item.offerSafe).length,waitlistMatches:output.reduce((sum,item)=>sum+item.matchingWaitlistCount,0),ambiguousWalkInMinutes:output.reduce((sum,item)=>sum+item.ambiguousWalkInMinutes,0),genuinelyAvailableMinutes:output.reduce((sum,item)=>sum+item.genuinelyAvailableMinutes,0)}};
}

export function syntheticCalendarCapacityFixture(asOf=new Date("2026-10-17T09:00:00.000Z")){
  const date=days=>new Date(new Date(asOf).getTime()+days*DAY_MS).toISOString();
  return[
    {barberRef:"demo-barber-01",date:date(1),shiftStartMinute:540,shiftEndMinute:1020,matchingWaitlistCount:2,intervals:[{startMinute:540,endMinute:720,kind:"service",label:"Verified services",customerBound:true,serviceBound:true}]},
    {barberRef:"demo-barber-02",date:date(1),shiftStartMinute:540,shiftEndMinute:1020,matchingWaitlistCount:0,intervals:[{startMinute:540,endMinute:660,kind:"service",label:"Verified services",customerBound:true,serviceBound:true},{startMinute:660,endMinute:900,kind:"walk_in",label:"Walk-in",customerBound:false,serviceBound:false},{startMinute:900,endMinute:930,kind:"blocked",label:"Unavailable"}]},
    {barberRef:"demo-barber-03",date:date(1),shiftStartMinute:540,shiftEndMinute:1020,matchingWaitlistCount:0,intervals:[{startMinute:540,endMinute:960,kind:"service",label:"Verified services",customerBound:true,serviceBound:true}]}
  ];
}

export const LOYALTY_RECOMMENDATION=Object.freeze({
  status:"owner_decision_required",
  recommendedPilot:"qr_wallet_stamp_card",
  rewardRule:"One verified stamp per completed paid visit; reward only after the configured threshold.",
  fraudControls:Object.freeze(["staff-authenticated stamping","one stamp per completed appointment","immutable stamp ledger","owner-only void or correction","no self-service QR stamping"]),
  preferredProviderProfile:"Apple and Google Wallet support, QR enrolment, staff stamper roles, export/revoke controls, and no POS change",
  liveProgrammeCreated:false
});

const WINBACK_SEGMENTS=Object.freeze([
  Object.freeze({id:"inactive_90",label:"90+ days",priority:1,objective:"Re-introduce Sharp Cuts and invite a voluntary rebooking."}),
  Object.freeze({id:"inactive_60",label:"60–89 days",priority:2,objective:"Offer a timely reminder to rebook."}),
  Object.freeze({id:"inactive_45",label:"45–59 days",priority:3,objective:"Prompt a routine follow-up without discount pressure."}),
  Object.freeze({id:"inactive_30",label:"30–44 days",priority:4,objective:"Provide a light-touch rebooking reminder."})
]);

const safeAudit=audit=>{
  if(!audit||audit.rawContactDataRetained!==false||audit.identifiers!=="hmac_sha256"||!Array.isArray(audit.profiles)||typeof audit.auditHash!=="string")throw new SharpCutsAutomationError("A privacy-safe customer audit is required.",{code:"sharp_cuts_customer_audit_required",statusCode:409});
  return audit;
};

export function buildMigrationReadySourceManifest(audit){
  const value=safeAudit(audit),counts=value.counts||{};
  return Object.freeze({
    version:1,projectId:SHARP_CUTS_WEB_PROJECT_ID,sourceSystem:"fresha_export",sourceAuditHash:value.auditHash,asOf:value.asOf,
    profileCount:Number(counts.profiles||0),pseudonymousProfileCount:value.profiles.length,identifierScheme:"hmac_sha256",rawContactsRetained:false,
    targetStatus:"existing_neon_relationship_requires_owner_confirmation",recordImportStatus:"not_authorised",
    requiredBeforeImport:Object.freeze(["confirm Sharp Cuts Web to Neon binding","approve encrypted target schema and retention","approve the exact record-level import","test on an isolated database branch"])
  });
}

export function buildWinbackProgramme(audit){
  const value=safeAudit(audit),profiles=value.profiles.filter(item=>!item.hasUpcomingBooking),groups=[];
  for(const definition of WINBACK_SEGMENTS){
    const members=profiles.filter(item=>item.inactivitySegment===definition.id),unknownBasis=members.filter(item=>item.marketingBasis==="unknown").length,suppressed=members.filter(item=>item.suppressed).length;
    const email=members.filter(item=>item.emailEligible),sms=members.filter(item=>item.smsEligible),emailRefs=email.map(item=>item.profileKey).sort(),smsRefs=sms.map(item=>item.profileKey).sort();
    groups.push(Object.freeze({...definition,total:members.length,unknownBasis,suppressed,
      email:Object.freeze({eligible:email.length,audienceSnapshotHash:hash(JSON.stringify(emailRefs)),status:email.length?"ready_for_copy_and_owner_review":"blocked_marketing_eligibility"}),
      sms:Object.freeze({eligible:sms.length,audienceSnapshotHash:hash(JSON.stringify(smsRefs)),status:sms.length?"ready_for_copy_and_owner_review":"blocked_marketing_eligibility"}),
      whatsapp:Object.freeze({eligible:0,status:"manual_app_only_no_automation",reason:"No paid WhatsApp API or automated sender is authorised."}),
      approvalRequired:true,automaticSend:false
    }));
  }
  const eligible=groups.reduce((sum,item)=>sum+item.email.eligible+item.sms.eligible,0),unknown=groups.reduce((sum,item)=>sum+item.unknownBasis,0);
  return Object.freeze({
    version:1,projectId:SHARP_CUTS_WEB_PROJECT_ID,status:eligible?"prepared_for_owner_review":"blocked_marketing_eligibility",priorityOrder:groups.map(item=>item.id),segments:Object.freeze(groups),
    eligibility:Object.freeze({verifiedChannelCandidates:eligible,unknownMarketingBasis:unknown,sendPermissionInferred:false,suppressionRequired:true,deliveryReachabilityRequired:true}),
    channels:Object.freeze({email:"prepared_not_connected",sms:"prepared_not_connected",whatsapp:"manual_app_only_no_paid_api"}),
    safeguards:Object.freeze({ownerApprovalPerCampaign:true,exactAudienceAndCopyBound:true,noAutomaticRetry:true,noFreshaReminderDuplication:true,liveSend:false})
  });
}

export function buildSharpCutsSocialWorkflow({mediaAssets=[]}={}){
  if(!Array.isArray(mediaAssets))throw new SharpCutsAutomationError("mediaAssets must be an array.",{code:"sharp_cuts_social_invalid"});
  const assets=mediaAssets.map((asset,index)=>{
    const id=String(asset?.id||"").trim(),rights=String(asset?.rights||"unknown").trim(),kind=String(asset?.kind||"").trim();
    if(!id||!kind)throw new SharpCutsAutomationError(`Media asset ${index+1} is incomplete.`,{code:"sharp_cuts_social_invalid"});
    const rightsVerified=new Set(["owned","licensed"]).has(rights);
    return Object.freeze({id,kind,rights,rightsVerified,reusableThisMonth:rightsVerified&&asset.reusableThisMonth===true});
  });
  const usable=assets.filter(item=>item.rightsVerified),reusable=usable.filter(item=>item.reusableThisMonth);
  return Object.freeze({
    version:1,projectId:SHARP_CUTS_WEB_PROJECT_ID,status:usable.length?"draft_production_ready":"blocked_awaiting_owned_footage",assets:Object.freeze(assets),
    platforms:Object.freeze({instagram:"draft_only_not_connected",facebook:"draft_only_not_connected",tiktok:"draft_only_not_connected"}),
    formats:Object.freeze(["9:16 reel","9:16 story","offer cut-down"]),
    monthlyReuse:Object.freeze({eligibleClipCount:reusable.length,rule:"A rights-verified clip may be recut with a new hook, edit and caption; the same final post must not be duplicated."}),
    workflow:Object.freeze(["ingest owned or licensed footage","create project-scoped edit and caption","owner reviews playable final asset","bind immutable asset version to formal approval","schedule only after a separate publishing authorization"]),
    safeguards:Object.freeze({ownerApprovalRequired:true,livePublishing:false,unattendedPublishing:false,crossProjectReuse:false,rightsDeclarationRequired:true})
  });
}

export const SHARP_CUTS_FUTURE_AUTOMATION=Object.freeze({
  emptySlotPromotions:Object.freeze({status:"blocked_until_availability_is_certified",reason:"Ambiguous Walk-in blocks cannot be treated as available time.",ownerApprovalRequired:true}),
  loyalty:Object.freeze({...LOYALTY_RECOMMENDATION,budgetStatus:"blocked_by_zero_subscription_budget"}),
  measurement:Object.freeze({status:"schema_ready",metrics:Object.freeze(["audience_size","sent","delivered","failed","opt_outs","bookings","attributed_revenue","reel_views","reach","engagement"]),rules:Object.freeze(["provider evidence only","campaign and project scoped","no inferred delivery","no inferred attribution"])}),
  channels:Object.freeze({email:Object.freeze({status:"prepared_not_connected",cost:"provider-dependent"}),sms:Object.freeze({status:"prepared_not_connected",cost:"provider-dependent"}),whatsapp:Object.freeze({status:"manual_app_only",cost:"no paid API authorised"})})
});

export const SHARP_CUTS_CAMPAIGN_DRY_RUN_ID="sharp-cuts-campaign-dry-run-v1";
export const SHARP_CUTS_OPERATIONAL_REHEARSAL_ID="sharp-cuts-operational-rehearsal-v1";

const ELECTRONIC_CHANNELS=new Set(["email","sms"]);

export function evaluateSharpCutsChannelEligibility(record,channel){
  if(!new Set(["email","sms","whatsapp"]).has(channel))throw new SharpCutsAutomationError("The requested marketing channel is unsupported.",{code:"sharp_cuts_channel_invalid"});
  const reasons=[];
  if(record?.duplicateRecipient===true)reasons.push("duplicate_recipient");
  if(record?.hasFutureBooking===true)reasons.push("future_booking");
  if(record?.suppressed===true||record?.optedOut===true)reasons.push("suppressed_or_opted_out");
  if(record?.reachable!==true)reasons.push("reachability_unverified");
  let basis="none";
  if(record?.explicitConsent===true&&record?.consentChannel===channel)basis="explicit_consent";
  else if(ELECTRONIC_CHANNELS.has(channel)&&record?.softOptIn?.collectedDirectly===true&&record?.softOptIn?.saleOrNegotiation===true&&record?.softOptIn?.similarServices===true&&record?.softOptIn?.optOutOfferedAtCollection===true&&record?.softOptIn?.optOutInEveryMessage===true)basis="soft_opt_in_verified";
  if(channel==="whatsapp"&&record?.explicitConsent!==true)reasons.push("whatsapp_opt_in_unverified");
  else if(basis==="none")reasons.push("marketing_basis_unverified");
  const eligible=reasons.length===0;
  return Object.freeze({channel,eligible,basis:eligible?basis:"none",reasons:Object.freeze(reasons),sendAuthorised:false,ownerApprovalRequired:true});
}

export function buildSharpCutsOperationalReadiness({metaConnection=null,senderProbe=null}={}){
  const instagramReady=metaConnection?.instagram?.connected===true&&metaConnection.instagram.username==="sharpcuts.uk";
  const facebookReady=metaConnection?.facebook?.connected===true&&metaConnection.facebook.pageId==="1707389769348747";
  const senderReady=senderProbe?.connected===true;
  return Object.freeze({
    version:1,projectId:SHARP_CUTS_WEB_PROJECT_ID,status:"external_activation_required",
    customerData:Object.freeze({source:"existing_encrypted_fresha_staging",profiles:SHARP_CUTS_STAGING_SNAPSHOT.profiles,recordLevelAdapter:"not_configured_in_nova_preview",deduplicationPreserved:true,futureBookingExclusionRequired:true,universalPermissionAssumed:false,universalProhibitionAssumed:false}),
    email:Object.freeze({provider:"Sender.net",identity:"Sharp Cuts <info@sharpcuts.uk>",connected:senderReady,audienceGroupConfigured:false,contactUploadAuthorised:false,suppressionReconciliation:"required_before_upload",unsubscribe:"required_in_every_campaign",deliveryImport:"provider_status_polling_required",liveSend:false}),
    whatsapp:Object.freeze({number:"+44 1582 510565",provider:"gupshup_coexistence",businessAppPreserved:true,coexistenceEligibility:"requires_official_embedded_signup_preflight",cloudApiConnected:false,inboundAutomation:false,replyMode:"draft_then_owner_test_allowlist",stopHandling:"implemented_not_connected",staffHandoff:"business_app_remains_authoritative",projectIsolation:"sharp-cuts-web",migrationAuthorised:false,paidServiceAuthorised:false}),
    sms:Object.freeze({provider:null,status:"optional_provider_not_selected",stopHandling:"required",approvedSpendGbp:0,estimatedUnitCostGbpIncVat:0.096,liveSend:false}),
    social:Object.freeze({instagram:Object.freeze({connected:instagramReady,publishingPermission:false,insights:instagramReady}),facebook:Object.freeze({connected:facebookReady,publishingPermission:false,insights:facebookReady}),approvalBoundScheduling:true,livePublishing:false}),
    calendar:Object.freeze({days:90,proposalGeneration:true,immutableApprovalBinding:true,durableWorker:true,externalExecution:false}),
    media:Object.freeze({localUpload:true,localPreview:true,calendarAssignment:true,r2OnlyAfterExactApproval:true,aiEditingOptional:true}),
    safeguards:Object.freeze({projectIsolation:true,realCustomerContact:false,publicPublishing:false,spendAuthorisedGbp:0,productionChanged:false})
  });
}

export function buildSharpCutsOperationalRehearsal({asOf=new Date()}={}){
  const consent={collectedDirectly:true,saleOrNegotiation:true,similarServices:true,optOutOfferedAtCollection:true,optOutInEveryMessage:true};
  const records=[
    {id:"test-001",reachable:true,softOptIn:consent},
    {id:"test-002",reachable:true,explicitConsent:true,consentChannel:"email"},
    {id:"test-003",reachable:true,softOptIn:consent,duplicateRecipient:true},
    {id:"test-004",reachable:true,softOptIn:consent,hasFutureBooking:true},
    {id:"test-005",reachable:true,softOptIn:consent,optedOut:true},
    {id:"test-006",reachable:false,softOptIn:consent},
  ];
  const evaluated=records.map(record=>({id:record.id,...evaluateSharpCutsChannelEligibility(record,"email")})),eligible=evaluated.filter(item=>item.eligible);
  const audienceSnapshotHash=hash(JSON.stringify(eligible.map(item=>item.id).sort())),copyHash=hash("Sharp Cuts operational rehearsal copy v1"),idempotencyKey=hash(`${SHARP_CUTS_WEB_PROJECT_ID}:${audienceSnapshotHash}:${copyHash}`);
  return Object.freeze({version:1,mode:"synthetic_test_sink",projectId:SHARP_CUTS_WEB_PROJECT_ID,createdAt:new Date(asOf).toISOString(),audience:Object.freeze({evaluated:evaluated.length,eligible:eligible.length,excluded:evaluated.length-eligible.length,audienceSnapshotHash,identifiersExposed:false}),eligibility:Object.freeze(evaluated),approval:Object.freeze({status:"simulated_test_authority",realApprovalCreated:false,boundTo:Object.freeze({audienceSnapshotHash,copyHash})}),schedule:Object.freeze({status:"simulated",idempotencyKey,retryPolicy:"transient_only_bounded",duplicateExecutions:0}),execution:Object.freeze({testSinkDeliveries:eligible.length,externalCalls:0,providerWrites:0,customerContacts:0,publications:0,costGbp:0}),monitoring:Object.freeze({delivered:eligible.length,failed:0,optOuts:0,bookings:0,revenueGbp:0,weeklySummaryPrepared:true}),safeguards:Object.freeze({liveSend:false,livePublishing:false,productionChanged:false,ownerApprovalRequiredForRealExecution:true})});
}

export function buildSharpCutsChannelReadiness({metaConnection=null,senderProbe=null}={}){
  const instagram=metaConnection?.instagram?.connected===true&&metaConnection.instagram.username==="sharpcuts.uk";
  const facebook=metaConnection?.facebook?.connected===true&&metaConnection.facebook.pageId==="1707389769348747";
  const sender=senderProbe?.connected===true;
  return Object.freeze([
    Object.freeze({id:"instagram",label:"Instagram @sharpcuts.uk",status:instagram?"connected_read_only":"authentication_required",capabilities:Object.freeze(["identity","organic_insights","draft_preparation"]),blocked:Object.freeze(["publishing","messaging","advertising"]),cost:"£0 for current organic read-only connection"}),
    Object.freeze({id:"facebook",label:"Facebook · Sharp Cuts Gents Barbers",status:facebook?"connected_read_only":"authentication_required",capabilities:Object.freeze(["page_identity","organic_insights","draft_preparation"]),blocked:Object.freeze(["publishing","messaging","advertising"]),cost:"£0 for current organic read-only connection"}),
    Object.freeze({id:"email",label:"Email · Sharp Cuts <info@sharpcuts.uk>",status:sender?"provider_connected_draft_only":"provider_connection_required",capabilities:Object.freeze(sender?["provider_probe","draft_preparation","suppression_check_required"]:["local_preview"]),blocked:Object.freeze(["contact_upload","send"]),cost:"Sender.net Free Forever target: £0/month, 2,500 subscribers, 15,000 emails/month; real daily limit remains unverified"}),
    Object.freeze({id:"whatsapp",label:"WhatsApp Business · +44 1582 510565",status:"coexistence_prepared_eligibility_required",capabilities:Object.freeze(["manual_business_app_contact","ip_allowlisted_inbound_webhook_prepared","project_scoped_ai_drafts","owner_test_allowlist","business_app_echo_monitoring","opt_out_capture"]),blocked:Object.freeze(["provider_onboarding","bulk_marketing","unrestricted_auto_reply"]),cost:"Gupshup self-serve has no monthly subscription. Meta message charges and any required wallet top-up remain disabled until owner approval."}),
    Object.freeze({id:"sms",label:"SMS",status:"no_project_scoped_provider",capabilities:Object.freeze(["copy_preparation","audience_estimation"]),blocked:Object.freeze(["contact_upload","send"]),cost:"Verified Fresha marketing SMS reference: £0.08 ex VAT per recipient; no external SMS provider is connected"}),
    Object.freeze({id:"fresha",label:"Fresha",status:"live_source_manual_export_only",capabilities:Object.freeze(["approved_export_analysis","service_catalogue","booking_link"]),blocked:Object.freeze(["booking_changes","customer_changes","automated_sync"]),cost:"No additional Nova integration cost; supported API access is not verified"})
  ]);
}

export function buildSharpCutsCampaignDryRun({asOf=new Date()}={}){
  const fixture=syntheticRetentionFixture(asOf),analysis=classifyRetentionRecords(fixture,{asOf}),proposal=buildWinbackProposal(analysis),eligible=analysis.records.filter(item=>item.eligibleForOwnerReview),failed=Math.min(1,eligible.length),delivered=Math.max(0,eligible.length-failed);
  const runHash=hash(JSON.stringify({asOf:new Date(asOf).toISOString(),audienceSnapshotHash:proposal.audienceSnapshotHash,proposalHash:proposal.proposalHash}));
  return Object.freeze({
    mode:"synthetic_test_sink",projectId:SHARP_CUTS_WEB_PROJECT_ID,runHash,audience:Object.freeze({sourceProfiles:fixture.length,eligible:eligible.length,excludedBooked:analysis.counts.alreadyBooked,excludedConsentOrSuppression:analysis.counts.blocked,identifiersExposed:false}),
    stages:Object.freeze([
      Object.freeze({id:"identify",status:"completed",summary:"Detected synthetic 30/45/60/90-day retention opportunities."}),
      Object.freeze({id:"prepare",status:"completed",summary:"Prepared immutable audience and copy hashes with duplicate and suppression safeguards."}),
      Object.freeze({id:"approve",status:"simulated_test_authority",summary:"Applied test-only authority to the immutable synthetic campaign; no owner or customer identity was used."}),
      Object.freeze({id:"schedule",status:"completed",summary:"Scheduled the synthetic campaign in the in-process test sink."}),
      Object.freeze({id:"execute",status:"completed",summary:"Delivered only to a synthetic sink; no provider or customer was contacted."}),
      Object.freeze({id:"monitor",status:"completed",summary:"Recorded deterministic delivery evidence and prepared the next recommendation."})
    ]),
    result:Object.freeze({attempted:eligible.length,delivered,failed,optOuts:0,bookings:0,attributedRevenueGbp:0,duplicateSends:0,nextRecommendation:"Resolve authoritative consent, suppression, reachability and future-booking evidence before creating any real approval."}),
    safeguards:Object.freeze({externalCalls:0,liveMessagesSent:false,livePostsPublished:false,customerDataUsed:false,ownerApprovalBypassed:false,automaticRetry:false})
  });
}

export function createSharpCutsAutomationService({storage,ownerId,clock=()=>new Date(),senderConfig=null,senderClient=null,instagramOAuth=null,customerReader=null}={}){
  if(!storage||!ownerId)throw new TypeError("Sharp Cuts automation dependencies are required.");
  const project=async()=>{const value=(await storage.listProjects(ownerId)).find(item=>item.id===SHARP_CUTS_WEB_PROJECT_ID);if(!value)throw new SharpCutsAutomationError("Import Sharp Cuts Web through Project Onboarding before running its automation demo.",{code:"sharp_cuts_project_required",statusCode:409});return value;};
  const activity=async()=> (await storage.listActivity(ownerId,{projectId:SHARP_CUTS_WEB_PROJECT_ID,limit:100})).filter(item=>item.tool?.startsWith("sharp_cuts_automation"));
  return Object.freeze({
    async dashboard(){
      const exists=(await storage.listProjects(ownerId)).some(item=>item.id===SHARP_CUTS_WEB_PROJECT_ID),events=exists?await activity():[],latest=events.find(item=>item.action==="sharp_cuts_retention_demo_completed")||null,metaConnection=instagramOAuth?await instagramOAuth.status(SHARP_CUTS_WEB_PROJECT_ID):null,metaMetrics=exists?(await storage.listSocialMetricSnapshots(ownerId,{projectId:SHARP_CUTS_WEB_PROJECT_ID,limit:1}))[0]||null:null;
      let senderProbe={connected:false,provider:"Sender.net",status:senderConfig?.configured?"probe_failed":"not_configured",tokenExposed:false};
      if(senderClient){try{senderProbe={...await senderClient.probe(),status:"connected"};}catch(error){senderProbe={...senderProbe,status:error?.code||"probe_failed"};}}
      let customerAggregate=null,customerAccess={configured:Boolean(customerReader),healthy:false,status:customerReader?"connection_failed":"not_configured"};if(customerReader)try{customerAggregate=await customerReader.snapshot();customerAccess={configured:true,healthy:true,status:"select_only_aggregate_verified",branchId:customerAggregate.branchId,branchName:customerAggregate.branchName,database:customerAggregate.database,role:customerAggregate.role,view:customerAggregate.view,readOnlyEnforced:customerAggregate.readOnlyEnforced,identifiersExposed:false};}catch{customerAccess={configured:true,healthy:false,status:"connection_failed_closed",identifiersExposed:false};}
      const campaignReview=buildSharpCutsWinbackReview(SHARP_CUTS_REAL_WINBACK_AUDIT,{sender:{connected:senderProbe.connected===true,identity:"Sharp Cuts",provider:"Sender.net",verifiedDailyRecipientLimit:null,config:senderConfig}}),channels=buildSharpCutsChannelReadiness({metaConnection,senderProbe}),latestDryRun=events.find(item=>item.action==="sharp_cuts_campaign_dry_run_completed")||null;
      const workspace=buildSharpCutsWorkspaceManifest({projectReady:exists,senderConnected:senderProbe.connected===true,metaConnection});
      const meta={configured:metaConnection?.configured===true,connected:metaConnection?.connected===true,provider:metaConnection?.provider||null,instagram:{connected:metaConnection?.instagram?.connected===true,accountId:metaConnection?.instagram?.accountId||null,username:metaConnection?.instagram?.username||null,scopes:metaConnection?.instagram?.scopes||[]},facebook:{connected:metaConnection?.facebook?.connected===true,pageId:metaConnection?.facebook?.pageId||null,pageName:metaConnection?.facebook?.pageName||null,scopes:metaConnection?.facebook?.scopes||[]},scopes:metaConnection?.scopes||[],connectionUpdatedAt:metaConnection?.updatedAt||null,metricsCapturedAt:metaMetrics?.capturedAt||null,metrics:metaMetrics?.metrics||null,livePublishing:false};
      const operationalReadiness=buildSharpCutsOperationalReadiness({metaConnection,senderProbe}),latestOperationalRehearsal=events.find(item=>item.action==="sharp_cuts_operational_rehearsal_completed")||null;
      const stagingSnapshot=customerAggregate?{...SHARP_CUTS_STAGING_SNAPSHOT,profiles:customerAggregate.sourceProfiles,conservativeUniqueProfiles:customerAggregate.uniqueProfiles,contact:{email:customerAggregate.emailCandidates,phone:customerAggregate.mobileCandidates,both:customerAggregate.bothCandidates,emailOnly:customerAggregate.emailOnly,phoneOnly:customerAggregate.mobileOnly,missingBoth:customerAggregate.missingContact}}:SHARP_CUTS_STAGING_SNAPSHOT;
      return{projectId:SHARP_CUTS_WEB_PROJECT_ID,projectReady:exists,liveEnabled:false,workspace,meta,channels,operationalReadiness,customerAccess,customerEligibility:customerAggregate?.channels||null,source:{system:"Fresha + isolated Neon staging",mode:customerAggregate?"live_select_only_aggregate":"encrypted_staging_read_only_summary",lastRefresh:customerAggregate?new Date(clock()).toISOString():"2026-10-19T16:55:40.000Z",dataClass:"privacy_safe_aggregate",publicApiAssumed:false},sections:{bookings:{status:"future_booking_evidence_required",count:null},customers:{status:customerAggregate?"select_only_aggregate_verified":"encrypted_staging_verified",count:stagingSnapshot.profiles},retention:{status:"real_90_plus_candidate_pool_verified",count:SHARP_CUTS_REAL_WINBACK_AUDIT.candidateProfiles},capacity:{status:"paused_until_campaign_requires_it",count:0},noShows:{status:"planned",count:null},campaigns:{status:"blocked_before_approval",count:0},followUps:{status:"contact_candidates_not_marketing_eligible",count:customerAggregate?.emailCandidates??campaignReview.audience.potentialUniqueEmailRecipients??SHARP_CUTS_REAL_WINBACK_AUDIT.email.profilesWithAddress},loyalty:{status:"blocked_by_zero_subscription_budget",count:0},socialMedia:{status:metaConnection?.connected?"read_only_metrics_connected_publishing_disabled":"oauth_required",count:1},automationActivity:{status:events.length?"available":"empty",count:events.length},pendingApprovals:{status:"none",count:0}},stagingSnapshot,campaignReview,latestDemo:latest?{id:latest.id,status:latest.status,createdAt:latest.createdAt,counts:latest.metadata?.counts,sourceHash:latest.metadata?.sourceHash,proposal:latest.metadata?.proposal,winbackProgramme:latest.metadata?.winbackProgramme,customerSource:latest.metadata?.customerSource,socialWorkflow:latest.metadata?.socialWorkflow,capacity:latest.metadata?.capacity,loyalty:latest.metadata?.loyalty,futureAutomation:latest.metadata?.futureAutomation}:null,latestDryRun:latestDryRun?latestDryRun.metadata?.dryRun||null: null,latestOperationalRehearsal:latestOperationalRehearsal?.metadata?.rehearsal||null,activity:events.slice(0,20),safeguards:{promotionalSend:"owner_approval_required",liveMessagesSent:false,rawCustomerDataStored:false,suppressionRequired:true,marketingBasisRequired:true,duplicateFreshaReminders:false,livePublishing:false,paidWhatsappApi:false}};
    },
    async runSyntheticRetentionDemo(){
      await project();const existing=(await activity()).find(item=>item.id===SHARP_CUTS_RETENTION_DEMO_ID);if(existing)return{created:false,event:existing,analysis:existing.metadata?.analysis||null};
      const asOf=clock(),fixture=syntheticRetentionFixture(asOf),analysis=classifyRetentionRecords(fixture,{asOf}),capacity=analyseCalendarCapacity(syntheticCalendarCapacityFixture(asOf)),proposal=buildWinbackProposal(analysis,{emailAllowanceRemaining:0}),sourceHash=hash(JSON.stringify({fixture,capacity}));
      const safeSyntheticAudit={rawContactDataRetained:false,identifiers:"hmac_sha256",auditHash:sourceHash,asOf:new Date(asOf).toISOString(),counts:{profiles:analysis.records.length},profiles:analysis.records.map(item=>({profileKey:hash(`profile:${item.customerRef}`),inactivitySegment:item.segment,hasUpcomingBooking:item.segment==="already_booked",marketingBasis:item.marketingBasis,suppressed:item.suppressed,emailEligible:item.eligibleForOwnerReview,smsEligible:item.eligibleForOwnerReview}))};
      const winbackProgramme=buildWinbackProgramme(safeSyntheticAudit),customerSource=buildMigrationReadySourceManifest(safeSyntheticAudit),socialWorkflow=buildSharpCutsSocialWorkflow();
      const event=await storage.appendActivity({id:SHARP_CUTS_RETENTION_DEMO_ID,ownerId,projectId:SHARP_CUTS_WEB_PROJECT_ID,action:"sharp_cuts_retention_demo_completed",tool:"sharp_cuts_automation_retention_monitor",status:"completed",summary:"Processed synthetic retention and capacity fixtures; no customer data was imported and no message, post, booking, price, or schedule was changed.",metadata:{version:3,source:"synthetic_fixture",sourceHash,recordCount:fixture.length,counts:analysis.counts,analysis,proposal,winbackProgramme,customerSource,socialWorkflow,capacity,loyalty:LOYALTY_RECOMMENDATION,futureAutomation:SHARP_CUTS_FUTURE_AUTOMATION,liveMessagesSent:false,livePostsPublished:false,rawCustomerDataStored:false,ownerApprovalRequired:true}});
      return{created:true,event,analysis,proposal,winbackProgramme,customerSource,socialWorkflow,capacity,loyalty:LOYALTY_RECOMMENDATION,futureAutomation:SHARP_CUTS_FUTURE_AUTOMATION};
    },
    async runSyntheticCampaignDryRun(){
      await project();const existing=(await activity()).find(item=>item.id===SHARP_CUTS_CAMPAIGN_DRY_RUN_ID);if(existing)return{created:false,event:existing,dryRun:existing.metadata?.dryRun||null};
      const dryRun=buildSharpCutsCampaignDryRun({asOf:clock()}),event=await storage.appendActivity({id:SHARP_CUTS_CAMPAIGN_DRY_RUN_ID,ownerId,projectId:SHARP_CUTS_WEB_PROJECT_ID,action:"sharp_cuts_campaign_dry_run_completed",tool:"sharp_cuts_automation_campaign_orchestrator",status:"completed",summary:"Completed the full Sharp Cuts campaign lifecycle against a synthetic test sink; no provider, customer, post, booking or payment was touched.",metadata:{version:1,source:"synthetic_test_sink",dryRun,liveMessagesSent:false,livePostsPublished:false,ownerApprovalRequiredForRealExecution:true}});
      return{created:true,event,dryRun};
    },
    async runOperationalRehearsal(){
      await project();const existing=(await activity()).find(item=>item.id===SHARP_CUTS_OPERATIONAL_REHEARSAL_ID);if(existing)return{created:false,event:existing,rehearsal:existing.metadata?.rehearsal||null};
      const rehearsal=buildSharpCutsOperationalRehearsal({asOf:clock()}),event=await storage.appendActivity({id:SHARP_CUTS_OPERATIONAL_REHEARSAL_ID,ownerId,projectId:SHARP_CUTS_WEB_PROJECT_ID,action:"sharp_cuts_operational_rehearsal_completed",tool:"sharp_cuts_automation_operational_orchestrator",status:"completed",summary:"Rehearsed eligibility, immutable approval binding, scheduling, idempotent execution and reporting against a synthetic sink; no provider or customer was contacted.",metadata:{version:1,source:"synthetic_test_sink",rehearsal,liveMessagesSent:false,livePostsPublished:false,providerWrites:0,ownerApprovalRequiredForRealExecution:true}});
      return{created:true,event,rehearsal};
    }
  });
}
