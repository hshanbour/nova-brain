import {createHash} from "node:crypto";
import {senderReadiness} from "../email/sender-marketing.js";

export const SHARP_CUTS_BOOKING_URL="https://www.fresha.com/a/sharp-cuts-luton-uk-57-cheapside-p20zttw0";
export const SHARP_CUTS_SERVICE_SOURCE="https://sharp-cuts-6gxjhrcmm-hamodehshanbour-6196.vercel.app/#services";
export const SHARP_CUTS_VERIFIED_SERVICES=Object.freeze([
  Object.freeze({name:"Skin Fade",durationMinutes:30,priceGbp:23}),
  Object.freeze({name:"Skin Fade + Beard",durationMinutes:45,priceGbp:28}),
  Object.freeze({name:"Beard Shape Up",durationMinutes:20,priceGbp:12}),
  Object.freeze({name:"Shape Up + Taper",durationMinutes:30,priceGbp:18}),
  Object.freeze({name:"Kids Cut",durationMinutes:30,priceGbp:18}),
  Object.freeze({name:"Kids Skin Fade",durationMinutes:30,priceGbp:23})
]);

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
const money=value=>`£${Number(value).toFixed(2)}`;
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

function buildSharpCutsWinbackEmailHtml({offer}){
  const serviceRows=offer.eligibleServices.map(service=>`<tr><td style="padding:12px 0;border-bottom:1px solid #e7e0d5;color:#191714;font-size:15px;font-weight:700;">${service.name}</td><td style="padding:12px 0;border-bottom:1px solid #e7e0d5;color:#746b60;font-size:13px;text-align:right;"><span style="text-decoration:line-through;">${money(service.priceGbp)}</span>&nbsp;&nbsp;<strong style="color:#9b641c;font-size:17px;">${money(service.offerPriceGbp)}</strong></td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your Sharp Cuts comeback: 20% OFF</title></head><body style="margin:0;padding:0;background:#f0ede7;font-family:Arial,Helvetica,sans-serif;color:#191714;"><div style="display:none;max-height:0;overflow:hidden;opacity:0;">The shop has a fresh new look — and your selected adult cut is 20% off.</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:#f0ede7;"><tr><td align="center" style="padding:18px 10px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 8px 28px rgba(32,24,14,.09);"><tr><td style="padding:22px 24px;background:#171513;color:#fff;"><div style="font-size:12px;letter-spacing:3px;color:#d5a55c;font-weight:700;">SHARP CUTS · LUTON</div><div style="margin-top:7px;font-size:13px;color:#c8c0b6;">EST. 2010 · 57 Cheapside</div></td></tr><tr><td style="padding:0;"><div role="img" aria-label="Placeholder for owner-supplied photograph of the refurbished Sharp Cuts shop" style="min-height:230px;padding:24px;box-sizing:border-box;background:linear-gradient(135deg,#292521,#171513);color:#fff;text-align:center;"><div style="margin:42px auto 14px;width:54px;height:2px;background:#d5a55c;"></div><div style="font-size:12px;letter-spacing:2px;color:#d5a55c;">OWNER PHOTO PLACEHOLDER</div><div style="margin-top:13px;font-size:24px;line-height:1.25;font-weight:700;">New shop reveal<br>arrives tomorrow</div><div style="margin-top:12px;font-size:13px;color:#c8c0b6;">Only genuine Sharp Cuts imagery will replace this panel.</div></div></td></tr><tr><td style="padding:30px 24px 12px;"><div style="font-size:13px;letter-spacing:2px;color:#9b641c;font-weight:700;">YOUR SHARPEST COMEBACK</div><h1 style="margin:8px 0 12px;font-size:38px;line-height:1.05;letter-spacing:-1px;">20% OFF</h1><p style="margin:0;font-size:17px;line-height:1.55;color:#4d473f;">We’ve upgraded Sharp Cuts with new chairs and new décor. Come back to the team you know and take 20% off one selected adult cut.</p></td></tr><tr><td style="padding:8px 24px 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;">${serviceRows}</table><p style="margin:10px 0 0;color:#746b60;font-size:12px;">Best value: Skin Fade + Beard — save ${money(offer.heroPrice.savingGbp)}.</p></td></tr><tr><td align="center" style="padding:0 24px 30px;"><a href="${SHARP_CUTS_BOOKING_URL}" style="display:block;box-sizing:border-box;padding:16px 20px;border-radius:10px;background:#b77826;color:#fff;text-decoration:none;font-size:16px;font-weight:800;letter-spacing:1px;">BOOK NOW</a><p style="margin:12px 0 0;color:#746b60;font-size:12px;line-height:1.5;">Book through Fresha, then show this email before payment. The offer is applied in the shop.</p></td></tr><tr><td style="padding:22px 24px;background:#f7f4ef;border-top:1px solid #e7e0d5;"><p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:#625b52;"><strong>Draft terms:</strong> one use per eligible recipient on Skin Fade + Beard, Skin Fade, or Shape Up + Taper. Excludes Beard Shape Up, kids services and retail products. Cannot be combined with another offer. Owner must confirm the campaign end date before approval.</p><p style="margin:0;font-size:11px;line-height:1.55;color:#81786d;">Sharp Cuts Gents Barbers · 57 Cheapside, Luton, LU1 2HN<br><a href="#unsubscribe" style="color:#625b52;text-decoration:underline;">Unsubscribe from Sharp Cuts emails</a> · Sender.net must replace this preview link with its working unsubscribe URL before sending.</p></td></tr></table></td></tr></table></body></html>`;
}

export function buildSharpCutsWinbackReview(audience,{sender={connected:false,identity:null,provider:null,verifiedDailyRecipientLimit:null}}={}){
  if(!audience||audience.rawIdentifiersRetained!==false||audience.segment!=="inactive_more_than_90_days")throw Object.assign(new Error("A privacy-safe 90+ audience audit is required."),{code:"sharp_cuts_campaign_audit_required"});
  const eligibleServiceNames=["Skin Fade + Beard","Skin Fade","Shape Up + Taper"];
  const eligibleServices=Object.freeze(eligibleServiceNames.map(name=>SHARP_CUTS_VERIFIED_SERVICES.find(service=>service.name===name)).map(service=>Object.freeze({...service,discountPercent:20,offerPriceGbp:Number((service.priceGbp*.8).toFixed(2)),savingGbp:Number((service.priceGbp*.2).toFixed(2))})));
  const offer=Object.freeze({
    title:"Your sharpest comeback — 20% OFF",
    proposal:"20% off one selected adult cut for customers inactive more than 90 days",
    heroService:"Skin Fade + Beard",
    heroPrice:Object.freeze({usualGbp:28,offerGbp:22.4,savingGbp:5.6}),
    eligibleServices,
    excludedServices:Object.freeze(["Beard Shape Up","Kids Cut","Kids Skin Fade","retail products"]),
    redemptionTerms:Object.freeze([
      "Available only to the eligible recipient of this email after Sharp Cuts verifies their marketing eligibility.",
      "One redemption per customer on one eligible service: Skin Fade + Beard, Skin Fade, or Shape Up + Taper.",
      "Book through the Sharp Cuts Fresha page, then show this email before payment; the offer is applied in the shop.",
      "Cannot be combined with another offer and has no cash value.",
      "Campaign end date must be confirmed by the owner before approval or sending."
    ]),
    termsStatus:"owner_confirmation_required",
    evidence:Object.freeze(["upgraded shop","new chairs","new décor","the Sharp Cuts team","verified Sharp Cuts service names and prices"]),
    serviceSource:SHARP_CUTS_SERVICE_SOURCE,
    bookingUrl:SHARP_CUTS_BOOKING_URL
  });
  const serviceLines=eligibleServices.map(service=>`${service.name}: usually ${money(service.priceGbp)}, comeback price ${money(service.offerPriceGbp)} (save ${money(service.savingGbp)})`);
  const email=Object.freeze({
    subject:"Your Sharp Cuts comeback: 20% OFF",
    preheader:"The shop has a fresh new look — and your selected adult cut is 20% off.",
    body:[
      "It’s time for a sharper comeback.",
      "The upgraded shop has new chairs and new décor, the Sharp Cuts team is ready, and we’d love to welcome you back with 20% OFF one selected adult cut.",
      ...serviceLines,
      `Book now: ${SHARP_CUTS_BOOKING_URL}`,
      ...offer.redemptionTerms,
      "This offer is a draft and will not become valid unless Mohammad approves the exact terms, expiry date, audience and campaign.",
      "You are receiving this only if Sharp Cuts can verify your marketing eligibility. Every sent email must include a working unsubscribe link."
    ].join("\n\n"),
    html:buildSharpCutsWinbackEmailHtml({offer,serviceLines}),
    imageStatus:"owner_shop_photos_required",
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
    version:2,projectId:"sharp-cuts-web",status:approvalReady?"waiting_for_owner_approval":"blocked_before_approval",campaignId:`sharp-cuts-winback-${hash(JSON.stringify(immutable)).slice(0,24)}`,
    audience:Object.freeze({candidateProfiles:audience.candidateProfiles,potentialUniqueEmailRecipients:audience.email.uniqueRecipientCandidates,verifiedSendableRecipients:approvalReady?audience.email.uniqueRecipientCandidates:0,duplicateAddressProfilesExcluded:audience.email.duplicateAddressProfilesExcluded,futureDateProxyExcluded:audience.futureDateProxyExcluded}),
    offer,email,emailProvider,
    social:Object.freeze({
      instagramCaption:"Your sharpest comeback starts here ✂️ Sharp Cuts has a fresh new look — new chairs, new décor and the team ready to welcome you back. Eligible customers can get 20% OFF a Skin Fade + Beard, Skin Fade, or Shape Up + Taper. Terms apply. Book through our Fresha link.",
      assetStatus:"awaiting_owner_supplied_new_shop_photos",
      publishingEnabled:false,
      concepts:Object.freeze([
        Object.freeze({format:"Instagram Reel",title:"The comeback cut",durationSeconds:15,hook:"Luton — your sharpest comeback is 20% OFF.",shots:Object.freeze(["Placeholder: new shop exterior reveal","Placeholder: new chairs and décor","Placeholder: close-up Skin Fade + Beard result","20% OFF service-choice card","Fresha BOOK NOW end card"]),status:"image_placeholders_only"}),
        Object.freeze({format:"Instagram Story",title:"Pick your comeback",frames:Object.freeze(["Fresh new look at Sharp Cuts","Choose: Skin Fade + Beard £22.40 · Skin Fade £18.40 · Shape Up + Taper £14.40","20% OFF · terms apply · Fresha BOOK NOW"]),status:"image_placeholders_only"})
      ])
    }),
    whatsapp:Object.freeze({status:"later_manual_business_app_campaign",eligibilityIndependentFromEmail:true,paidApiRequired:false,sendEnabled:false}),
    deliveryCost:Object.freeze({currency:"GBP",amount:null,status:"unknown_until_sharp_cuts_sender_and_provider_limits_verified",newSubscriptionCost:0}),
    sender:Object.freeze({connected:sender.connected===true,identity:sender.identity||null,provider:sender.provider||null}),
    approval:Object.freeze({tool:"sharp_cuts_campaign_send",status:approvalReady?"ready_to_create":"not_created",approveEnabled:approvalReady,rejectEnabled:true,immutable,blockedReasons:Object.freeze(blockedReasons)}),
    safeguards:Object.freeze({liveSend:false,livePublishing:false,automaticRetry:false,exactAudienceDeduplication:true,suppressionRequired:true,optOutRequired:true,projectIsolated:true})
  });
}
