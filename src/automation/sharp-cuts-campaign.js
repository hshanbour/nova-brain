import {createHash} from "node:crypto";
import {senderReadiness} from "../email/sender-marketing.js";

export const SHARP_CUTS_BOOKING_URL="https://www.fresha.com/a/sharp-cuts-luton-uk-57-cheapside-p20zttw0";

export const SHARP_CUTS_STAGING_SNAPSHOT=Object.freeze({
  batchId:"4528ee98-976a-5183-b8a0-f4b4f286dc00",
  sourceSnapshotSha256:"71b8132097129df855a741ea8dc4b2a78011ffcec3d5162bf972530718fc6f42",
  branchId:"br-steep-truth-za3vyugo",
  database:"neondb",
  projectId:"sharp-cuts-web",
  profiles:1991,
  conservativeUniqueCustomers:1982,
  contact:Object.freeze({email:1571,phone:1649,both:1569,emailOnly:2,phoneOnly:80,missingBoth:340}),
  duplicates:Object.freeze({confirmedPairs:10,ambiguousPairs:1647,status:"pending_owner_review",mergedProfiles:0}),
  security:Object.freeze({profileStorage:"aes_256_gcm",matching:"hmac_sha256",rawContactsInActivity:false,productionAffected:false})
});

const DAY_MS=86_400_000;
const MONTHS=Object.freeze({Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11});
const hash=value=>createHash("sha256").update(String(value)).digest("hex");
const normalEmail=value=>String(value||"").trim().toLowerCase();
const normalPhone=value=>String(value||"").replace(/\D/g,"");

function freshaDate(value){
  const input=String(value||"").trim();if(!input)return null;
  const match=input.match(/^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})(?:,.*)?$/);
  if(!match||MONTHS[match[2]]===undefined)throw Object.assign(new Error("A Last appt. value is not in the expected Fresha format."),{code:"sharp_cuts_customer_data_invalid"});
  return new Date(Date.UTC(Number(match[3]),MONTHS[match[2]],Number(match[1])));
}

export function analyseSharpCutsWinbackAudience(rows,{asOf=new Date()}={}){
  if(!Array.isArray(rows))throw new TypeError("rows must be an array.");
  const now=new Date(asOf);if(Number.isNaN(now.getTime()))throw new TypeError("asOf is invalid.");
  const inactive=[],future=[],noHistory=[];
  for(const row of rows){
    const last=freshaDate(row?.["Last appt."]);if(!last){noHistory.push(row);continue;}
    const days=Math.floor((now-last)/DAY_MS);if(days<0){future.push(row);continue;}if(days>90)inactive.push(row);
  }
  const withEmail=inactive.filter(row=>normalEmail(row.Email)),withPhone=inactive.filter(row=>normalPhone(row["Mobile number"]));
  const emails=new Set(withEmail.map(row=>normalEmail(row.Email))),phones=new Set(withPhone.map(row=>normalPhone(row["Mobile number"])));
  const safe={
    version:1,asOf:now.toISOString(),sourceRows:rows.length,segment:"inactive_more_than_90_days",
    candidateProfiles:inactive.length,
    email:Object.freeze({profilesWithAddress:withEmail.length,uniqueRecipientCandidates:emails.size,duplicateAddressProfilesExcluded:withEmail.length-emails.size}),
    phone:Object.freeze({profilesWithNumber:withPhone.length,uniqueNumberCandidates:phones.size,duplicateNumberProfilesExcluded:withPhone.length-phones.size}),
    missingBoth:inactive.filter(row=>!normalEmail(row.Email)&&!normalPhone(row["Mobile number"])).length,
    futureDateProxyExcluded:future.length,noVisitHistoryExcluded:noHistory.length,
    verifiedEligibility:Object.freeze({email:0,sms:0,whatsapp:0}),
    evidence:Object.freeze({marketingConsent:"unavailable",suppression:"unavailable",deliveryReachability:"unavailable",futureBooking:"future_dated_last_appointment_proxy_only"}),
    sendAuthorised:false,rawIdentifiersRetained:false
  };
  return Object.freeze({...safe,audienceSnapshotHash:hash(JSON.stringify(safe))});
}

export function buildSharpCutsWinbackReview(audience,{sender={connected:false,identity:null,provider:null,verifiedDailyRecipientLimit:null}}={}){
  if(!audience||audience.rawIdentifiersRetained!==false||audience.segment!=="inactive_more_than_90_days")throw Object.assign(new Error("A privacy-safe 90+ audience audit is required."),{code:"sharp_cuts_campaign_audit_required"});
  const offer=Object.freeze({
    title:"Welcome back to the new-look Sharp Cuts",
    proposal:"£5 reopening credit on one haircut or haircut-and-beard appointment",
    termsStatus:"owner_confirmation_required",
    evidence:Object.freeze(["upgraded shop","new chairs","new décor","the Sharp Cuts team"]),
    bookingUrl:SHARP_CUTS_BOOKING_URL
  });
  const email=Object.freeze({
    subject:"Sharp Cuts has a fresh new look — come and see us",
    preheader:"New chairs, new décor and the same Sharp Cuts team ready to welcome you back.",
    body:[
      "We’ve refreshed Sharp Cuts with an upgraded shop, new chairs and new décor — and the team is ready to welcome you back.",
      "Our proposed reopening offer is £5 credit on one haircut or haircut-and-beard appointment. This offer will not become valid unless Mohammad approves the exact terms and campaign.",
      `Book when it suits you: ${SHARP_CUTS_BOOKING_URL}`,
      "You are receiving this only if Sharp Cuts can verify your marketing eligibility. You can opt out at any time."
    ].join("\n\n"),
    unsubscribeRequired:true,physicalBusinessIdentityRequired:true
  });
  const emailProvider=senderReadiness(sender.config);
  const blockedReasons=[];
  if(audience.verifiedEligibility.email!==audience.email.uniqueRecipientCandidates)blockedReasons.push("Marketing consent or a documented soft opt-in and the current suppression state are not available for the candidate recipients.");
  if(audience.evidence.futureBooking!=="authoritative")blockedReasons.push("The client export has no authoritative upcoming-booking field; the future-dated Last appt. proxy is not enough for a send.");
  if(!sender.connected)blockedReasons.push("No project-isolated Sharp Cuts business sender is connected.");
  if(!emailProvider.domain.status.startsWith("configured"))blockedReasons.push("sharpcuts.uk DNS is prepared; Sender.net account connection and provider-side domain verification are still required before info@sharpcuts.uk can send.");
  if(!sender.verifiedDailyRecipientLimit)blockedReasons.push("The provider's real daily recipient limit and sending cost have not been verified for the Sharp Cuts mailbox.");
  const approvalReady=blockedReasons.length===0;
  const immutable={projectId:"sharp-cuts-web",channel:"email",audienceSnapshotHash:audience.audienceSnapshotHash,copyHash:hash(JSON.stringify(email)),offerHash:hash(JSON.stringify(offer)),senderIdentity:sender.identity||null};
  return Object.freeze({
    version:1,projectId:"sharp-cuts-web",status:approvalReady?"waiting_for_owner_approval":"blocked_before_approval",campaignId:`sharp-cuts-winback-${hash(JSON.stringify(immutable)).slice(0,24)}`,
    audience:Object.freeze({candidateProfiles:audience.candidateProfiles,potentialUniqueEmailRecipients:audience.email.uniqueRecipientCandidates,verifiedSendableRecipients:approvalReady?audience.email.uniqueRecipientCandidates:0,duplicateAddressProfilesExcluded:audience.email.duplicateAddressProfilesExcluded,futureDateProxyExcluded:audience.futureDateProxyExcluded}),
    offer,email,emailProvider,
    social:Object.freeze({instagramCaption:"Sharp Cuts has had a fresh upgrade ✂️ New chairs, new décor and the team ready to welcome you back. Book your next visit through our Fresha link.",assetStatus:"awaiting_rights_verified_shop_footage",publishingEnabled:false}),
    whatsapp:Object.freeze({status:"later_manual_business_app_campaign",eligibilityIndependentFromEmail:true,paidApiRequired:false,sendEnabled:false}),
    deliveryCost:Object.freeze({currency:"GBP",amount:null,status:"unknown_until_sharp_cuts_sender_and_provider_limits_verified",newSubscriptionCost:0}),
    sender:Object.freeze({connected:sender.connected===true,identity:sender.identity||null,provider:sender.provider||null}),
    approval:Object.freeze({tool:"sharp_cuts_campaign_send",status:approvalReady?"ready_to_create":"not_created",approveEnabled:approvalReady,rejectEnabled:true,immutable,blockedReasons:Object.freeze(blockedReasons)}),
    safeguards:Object.freeze({liveSend:false,livePublishing:false,automaticRetry:false,exactAudienceDeduplication:true,suppressionRequired:true,optOutRequired:true,projectIsolated:true})
  });
}
