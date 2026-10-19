import {createHash} from "node:crypto";
import {senderReadiness} from "../email/sender-marketing.js";

export const SHARP_CUTS_BOOKING_URL="https://www.fresha.com/a/sharp-cuts-luton-uk-57-cheapside-p20zttw0";
export const SHARP_CUTS_SERVICE_SOURCE="https://partners.fresha.com/catalogue/services";
export const SHARP_CUTS_VERIFIED_SERVICES=Object.freeze([
  Object.freeze({name:"The premium package",category:"Packages",durationMinutes:50,serviceCount:3,priceGbp:37,pricePrefix:null}),
  Object.freeze({name:"Sharp cuts premium package",category:"Packages",durationMinutes:55,serviceCount:4,priceGbp:40,pricePrefix:"from"}),
  Object.freeze({name:"Hair wash and styling",category:"Other services",durationMinutes:10,priceGbp:6,pricePrefix:null}),
  Object.freeze({name:"Hot towel",category:"Other services",durationMinutes:5,priceGbp:6,pricePrefix:null}),
  Object.freeze({name:"Waxing",category:"Other services",durationMinutes:5,priceGbp:3,pricePrefix:"from"}),
  Object.freeze({name:"Shape up",category:"Hair cuts",durationMinutes:15,priceGbp:10,pricePrefix:null}),
  Object.freeze({name:"Kids cut",category:"Hair cuts",durationMinutes:20,priceGbp:15,pricePrefix:null}),
  Object.freeze({name:"Kids cut (skin fade)",category:"Hair cuts",durationMinutes:25,priceGbp:20,pricePrefix:null}),
  Object.freeze({name:"Haircut (no beard trim )",category:"Hair cuts",durationMinutes:25,priceGbp:20,pricePrefix:null}),
  Object.freeze({name:"Haircut and beard trim",category:"Hair cuts",durationMinutes:35,priceGbp:25,pricePrefix:null})
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
const priced=(value,prefix)=>`${prefix?`${prefix} `:""}${money(value)}`;
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
  const serviceRows=offer.eligibleServices.map(service=>`<tr><td style="padding:15px 0;border-bottom:1px solid #323232;color:#f5f1e9;font-size:15px;font-weight:700;line-height:1.35;">${service.name}</td><td style="padding:15px 0;border-bottom:1px solid #323232;color:#a9a39a;font-size:13px;text-align:right;white-space:nowrap;"><span style="text-decoration:line-through;">${priced(service.priceGbp,service.pricePrefix)}</span><br><strong style="color:#d9aa55;font-size:17px;">${priced(service.offerPriceGbp,service.pricePrefix)}</strong></td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Same Sharp Cuts. A whole new experience.</title></head><body style="margin:0;padding:0;background:#090909;font-family:Arial,Helvetica,sans-serif;color:#f5f1e9;"><div style="display:none;max-height:0;overflow:hidden;opacity:0;">It’s been a while — and a lot has changed. Enjoy 20% OFF your next selected adult haircut.</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:#090909;"><tr><td align="center" style="padding:18px 10px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#151515;border:1px solid #2d2a24;border-radius:18px;overflow:hidden;"><tr><td style="padding:23px 24px;background:#101010;color:#fff;border-bottom:1px solid #2d2a24;"><div style="font-size:13px;letter-spacing:3px;color:#d9aa55;font-weight:800;">SHARP CUTS · LUTON</div><div style="margin-top:7px;font-size:12px;letter-spacing:1px;color:#8d8982;">PREMIUM GROOMING · 57 CHEAPSIDE</div></td></tr><tr><td style="padding:0;"><div role="img" aria-label="Placeholder for an owner-supplied photograph of the refurbished Sharp Cuts shop" style="min-height:245px;padding:28px;box-sizing:border-box;background:linear-gradient(145deg,#2b2925,#0d0d0d 70%);color:#fff;text-align:center;"><div style="margin:45px auto 16px;width:60px;height:2px;background:#d9aa55;"></div><div style="font-size:11px;letter-spacing:2.5px;color:#d9aa55;font-weight:700;">GENUINE SHOP PHOTO PLACEHOLDER</div><div style="margin-top:15px;font-size:26px;line-height:1.2;font-weight:800;">The new Sharp Cuts<br>reveal goes here</div><div style="margin-top:12px;font-size:13px;color:#aaa59d;">No stock imagery — awaiting the owner’s real shop photos.</div></div></td></tr><tr><td style="padding:34px 24px 14px;text-align:center;"><div style="font-size:12px;letter-spacing:2px;color:#d9aa55;font-weight:800;">SAME SHARP CUTS.</div><h1 style="margin:7px 0 18px;font-size:36px;line-height:1.04;letter-spacing:-1px;color:#fff;">A WHOLE NEW<br>EXPERIENCE. 💈</h1><p style="margin:0 0 14px;font-size:17px;line-height:1.55;color:#d5d0c7;">It's been a while — and a lot has changed!</p><p style="margin:0;font-size:16px;line-height:1.6;color:#aaa59d;">Sharp Cuts has a fresh new look, and we're ready to welcome you back for an even better experience.</p></td></tr><tr><td style="padding:18px 24px 6px;text-align:center;"><div style="padding:23px 16px;border:1px solid #4c3d26;background:#1d1a16;border-radius:12px;"><div style="font-size:12px;letter-spacing:2px;color:#d9aa55;font-weight:800;">NOW IT'S YOUR TURN FOR A FRESH LOOK.</div><div style="margin-top:8px;font-size:42px;line-height:1;color:#fff;font-weight:900;">20% OFF</div><div style="margin-top:9px;font-size:16px;color:#d5d0c7;">your next selected adult haircut</div></div></td></tr><tr><td style="padding:18px 24px 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;">${serviceRows}</table><p style="margin:13px 0 0;color:#8d8982;font-size:12px;line-height:1.5;">Prices verified from the live Sharp Cuts Fresha catalogue. “From” prices may vary by selection.</p></td></tr><tr><td style="padding:2px 24px 25px;text-align:center;"><p style="margin:0 0 19px;color:#f5f1e9;font-size:17px;line-height:1.5;">Your style. Your choice.<br><strong>The Sharp Cuts experience.</strong></p><a href="${SHARP_CUTS_BOOKING_URL}" style="display:block;box-sizing:border-box;padding:17px 20px;border-radius:8px;background:#d9aa55;color:#111;text-decoration:none;font-size:16px;font-weight:900;letter-spacing:1px;">BOOK YOUR NEXT CUT →</a><p style="margin:13px 0 0;color:#8d8982;font-size:12px;line-height:1.5;">Book through Fresha, then show this email before payment. The discount is applied in the shop.</p></td></tr><tr><td style="padding:22px 24px;background:#0f0f0f;border-top:1px solid #2d2a24;"><p style="margin:0 0 10px;text-align:center;font-size:14px;font-weight:800;color:#d9aa55;">57 Cheapside, Luton.</p><p style="margin:0 0 9px;font-size:11px;line-height:1.6;color:#827d75;"><strong>Draft terms:</strong> one use per eligible recipient on one listed adult haircut or package. Excludes shape-up, kids services and standalone add-ons. Cannot be combined with another offer and has no cash value. Owner must confirm the campaign end date before approval.</p><p style="margin:0;font-size:11px;line-height:1.55;color:#827d75;">Sharp Cuts Gents Barbers · 57 Cheapside, Luton, LU1 2HN<br><a href="#unsubscribe" style="color:#b9b2a7;text-decoration:underline;">Unsubscribe from Sharp Cuts emails</a> · Sender.net must replace this preview link with its working unsubscribe URL before sending.</p></td></tr></table></td></tr></table></body></html>`;
}

export function buildSharpCutsWinbackReview(audience,{sender={connected:false,identity:null,provider:null,verifiedDailyRecipientLimit:null}}={}){
  if(!audience||audience.rawIdentifiersRetained!==false||audience.segment!=="inactive_more_than_90_days")throw Object.assign(new Error("A privacy-safe 90+ audience audit is required."),{code:"sharp_cuts_campaign_audit_required"});
  const eligibleServiceNames=["Sharp cuts premium package","The premium package","Haircut and beard trim","Haircut (no beard trim )"];
  const eligibleServices=Object.freeze(eligibleServiceNames.map(name=>SHARP_CUTS_VERIFIED_SERVICES.find(service=>service.name===name)).map(service=>Object.freeze({...service,discountPercent:20,offerPriceGbp:Number((service.priceGbp*.8).toFixed(2)),savingGbp:Number((service.priceGbp*.2).toFixed(2))})));
  const offer=Object.freeze({
    title:"Same Sharp Cuts. A whole new experience. — 20% OFF",
    proposal:"20% off one selected adult cut for customers inactive more than 90 days",
    heroService:"Sharp cuts premium package",
    heroPrice:Object.freeze({usualGbp:40,offerGbp:32,savingGbp:8,pricePrefix:"from"}),
    eligibleServices,
    excludedServices:Object.freeze(["Shape up","Kids cut","Kids cut (skin fade)","Hair wash and styling","Hot towel","Waxing","retail products"]),
    redemptionTerms:Object.freeze([
      "Available only to the eligible recipient of this email after Sharp Cuts verifies their marketing eligibility.",
      "One redemption per customer on one listed eligible adult haircut or package.",
      "Book through the Sharp Cuts Fresha page, then show this email before payment; the offer is applied in the shop.",
      "Cannot be combined with another offer and has no cash value.",
      "Campaign end date must be confirmed by the owner before approval or sending."
    ]),
    termsStatus:"owner_confirmation_required",
    evidence:Object.freeze(["fresh new shop look","verified live Fresha service names and prices"]),
    serviceSource:SHARP_CUTS_SERVICE_SOURCE,
    bookingUrl:SHARP_CUTS_BOOKING_URL
  });
  const serviceLines=eligibleServices.map(service=>`${service.name}: usually ${priced(service.priceGbp,service.pricePrefix)}, comeback price ${priced(service.offerPriceGbp,service.pricePrefix)} (save ${service.pricePrefix?"from ":""}${money(service.savingGbp)})`);
  const email=Object.freeze({
    subject:"Same Sharp Cuts. A whole new experience. — 20% OFF",
    preheader:"It’s been a while — and a lot has changed. Enjoy 20% OFF your next selected adult haircut.",
    body:[
      "SAME SHARP CUTS. A WHOLE NEW EXPERIENCE. 💈",
      "It's been a while — and a lot has changed!",
      "Sharp Cuts has a fresh new look, and we're ready to welcome you back for an even better experience.",
      "NOW IT'S YOUR TURN FOR A FRESH LOOK.",
      "Enjoy 20% OFF your next selected adult haircut.",
      "Your style. Your choice. The Sharp Cuts experience.",
      ...serviceLines,
      `BOOK YOUR NEXT CUT → ${SHARP_CUTS_BOOKING_URL}`,
      "57 Cheapside, Luton.",
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
    version:3,projectId:"sharp-cuts-web",status:approvalReady?"waiting_for_owner_approval":"blocked_before_approval",campaignId:`sharp-cuts-winback-${hash(JSON.stringify(immutable)).slice(0,24)}`,
    audience:Object.freeze({candidateProfiles:audience.candidateProfiles,potentialUniqueEmailRecipients:audience.email.uniqueRecipientCandidates,verifiedSendableRecipients:approvalReady?audience.email.uniqueRecipientCandidates:0,duplicateAddressProfilesExcluded:audience.email.duplicateAddressProfilesExcluded,futureDateProxyExcluded:audience.futureDateProxyExcluded}),
    offer,email,emailProvider,
    social:Object.freeze({
      instagramCaption:"SAME SHARP CUTS. A WHOLE NEW EXPERIENCE. 💈 It’s been a while — and a lot has changed. Now it’s your turn for a fresh look. Enjoy 20% OFF your next selected adult haircut or package. Your style. Your choice. The Sharp Cuts experience. Terms apply. Book through our Fresha link.",
      assetStatus:"awaiting_owner_supplied_new_shop_photos",
      publishingEnabled:false,
      concepts:Object.freeze([
        Object.freeze({format:"Instagram Reel",title:"A whole new Sharp Cuts experience",durationSeconds:15,hook:"SAME SHARP CUTS. A WHOLE NEW EXPERIENCE. 💈",shots:Object.freeze(["Genuine photo/video placeholder: Sharp Cuts exterior and sign","Genuine photo/video placeholder: refurbished interior reveal","Genuine photo/video placeholder: chairs, décor and team detail","20% OFF service-choice card: from £32 · £29.60 · £20 · £16","BOOK YOUR NEXT CUT → Fresha end card"]),status:"image_placeholders_only"}),
        Object.freeze({format:"Instagram Story",title:"Your turn for a fresh look",frames:Object.freeze(["SAME SHARP CUTS. A WHOLE NEW EXPERIENCE. 💈 — genuine shop photo placeholder","20% OFF selected adult cuts: packages from £32 · haircut + beard £20 · haircut £16","Your style. Your choice. BOOK YOUR NEXT CUT → Fresha"]),status:"image_placeholders_only"})
      ])
    }),
    whatsapp:Object.freeze({status:"later_manual_business_app_campaign",eligibilityIndependentFromEmail:true,paidApiRequired:false,sendEnabled:false}),
    deliveryCost:Object.freeze({currency:"GBP",amount:null,status:"unknown_until_sharp_cuts_sender_and_provider_limits_verified",newSubscriptionCost:0}),
    sender:Object.freeze({connected:sender.connected===true,identity:sender.identity||null,provider:sender.provider||null}),
    approval:Object.freeze({tool:"sharp_cuts_campaign_send",status:approvalReady?"ready_to_create":"not_created",approveEnabled:approvalReady,rejectEnabled:true,immutable,blockedReasons:Object.freeze(blockedReasons)}),
    safeguards:Object.freeze({liveSend:false,livePublishing:false,automaticRetry:false,exactAudienceDeduplication:true,suppressionRequired:true,optOutRequired:true,projectIsolated:true})
  });
}
