import {renderSharpCutsWelcome} from '../email/sharp-cuts-welcome-creative.js';
import {withSenderRestriction} from '../email/sender-restriction.js';
import {createHash} from 'node:crypto';
import {SHARP_CUTS_BOOKING_URL} from './sharp-cuts-campaign.js';
import {describeCampaignSource,SHARP_CUTS_EMAIL_SOURCE} from '../email/sharp-cuts-audience.js';

const projectId='sharp-cuts-web', action='sharp_cuts_welcome_review_saved';
// Owner authorised this exact audience transfer and an unsent provider draft
// on 20 November. Provider state is read live; this receipt is not send authority.
export const WELCOME_PROVIDER_PREPARATION=Object.freeze({campaignId:'J6P5lD',groupId:'b8xDkj',reviewId:'welcome-e5a812712805134bbf9cd4a3',imported:1240,updated:0,createdAt:'2026-11-20T13:51:03Z',automationTriggered:false,inventoryRetryAt:'2026-11-20T14:26:29Z',exportReceipt:{"checkedAt":"2026-11-20T14:15:21.395Z","source":"Authenticated Sender UI export of only group b8xDkj","count":1240,"unique":1240,"active":1240,"onlyApprovedGroup":true,"audienceHash":"f847215b4f330d5adb478e84e72274a92c0747ac22fc04dae60034546bdec6f7","exactMatch":true,"fileHash":"8e96b5468b3aa847a063efc04a2be1bec4f291a81dbca7935ac850cff1fd3cf8"}});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Aggregate-only evidence from the unchanged original export. No customer
// identifiers are bundled or inferred to have consent/reachability.
export const WELCOME_EVIDENCE=Object.freeze({
  checkedAt:'2026-11-20',exportDate:'2026-10-19',sourceHash:SHARP_CUTS_EMAIL_SOURCE.sourceSnapshotHash,
  sourceRows:1988,emailRows:1571,distinctEmails:1558,emailSyntaxInvalid:0,emailDuplicateRows:13,emailMissing:417,
  phoneRows:1649,phoneMissing:339,phoneInvalidRows:1,phoneValidRows:1648,phoneDuplicateRows:334,
  distinctValidPhones:1314,mobileCandidates:1312,nonMobile:2,
  validation:'libphonenumber-js 1.12.31 max metadata; international digits normalised to E.164; format/numbering-plan checks, not live reachability',
  mobileCountries:{GB:1304,LV:2,DE:1,IT:1,LC:1,AE:1,NZ:1,GH:1},
  fresha:{profiles:1999,upcomingBookingProfiles:52,winback90NoFutureBooking:1724,segmentId:'44230',
    note:'Read in the authenticated Fresha UI on 20 Nov. These are live segment totals, not a matched campaign recipient export. The frozen cohort is preserved; new clients are not added.'},
  sender:{plan:'Free Forever',subscriberLimit:2500,emailLimit:15000,activeSubscribers:1,emailsUsed:1,uniqueEmailed:1,renewsOn:'2026-12-02',monthlyCost:0,currency:'USD',brandingRequired:true,source:'Authenticated Sender Billing, 20 Nov 2026'},
  whatsapp:{walletUsd:9.993,minimumTopupUsd:10,limitPer24Hours:250,approvedMarketingTemplates:0,source:'Authenticated SharpCutsNova provider and wallet review, 20 Nov 2026'},
  emailReconciliation:{checkedAt:'2026-11-20T13:22:22.730Z',eligibleBeforeProvider:1240,marketingOptOut:254,blocked:22,sharedAddress:3,upcomingBooking:39,missingCurrent:0,unknownPreference:0,
    audienceHash:'f847215b4f330d5adb478e84e72274a92c0747ac22fc04dae60034546bdec6f7',
    exportHash:'c0decc411df9d3fb0b536f535df9b594d488ae9cf4e84aa5b8fb3d5368b54ee8',
    source:'Fresh Fresha client export with Accepts Marketing and Blocked fields; complete 52-client upcoming-appointments UI listing. Matched only to original email addresses, with shared addresses withheld. No recipient uploaded.',
    permissionGuide:'https://www.fresha.com/help-center/knowledge-base/privacy-and-security/101365-record-marketing-consent-for-clients'},
});
const rates={GB:.0635,LV:.086,DE:.1365,IT:.0795,LC:.0604,AE:.0576,NZ:.0842,GH:.0225};
const countryNames={GB:'United Kingdom',LV:'Latvia',DE:'Germany',IT:'Italy',LC:'Saint Lucia',AE:'United Arab Emirates',NZ:'New Zealand',GH:'Ghana'};
export function welcomeCosts(evidence=WELCOME_EVIDENCE){
  const destinations=Object.entries(evidence.mobileCountries).map(([country,count])=>({country,name:countryNames[country],count,metaMarketingUsd:rates[country],gupshupUsd:.001,totalUsd:count*(rates[country]+.001)}));
  const subtotal=destinations.reduce((n,row)=>n+row.totalUsd,0),balance=evidence.whatsapp.walletUsd;
  return {email:{totalUsd:0,recipientCeiling:evidence.distinctEmails,remainingEmails:evidence.sender.emailLimit-evidence.sender.emailsUsed,subscriptionUsd:0,topupUsd:0,
    qualification:'Estimated total for one email per distinct eligible address within the inspected Free Forever allowance. No new subscription or top-up. Recheck usage at launch; Sender branding remains.'},
    whatsapp:{destinations,category:'Marketing',messages:evidence.mobileCandidates,totalUsd:Number(subtotal.toFixed(4)),walletUsd:balance,
      additionalCreditUsd:Number(Math.max(0,subtotal-balance).toFixed(4)),suggestedTopupUsd:Math.max(10,Math.ceil(subtotal-balance)),subscriptionUsd:0,
      tax20ScenarioUsd:Number((subtotal*1.2).toFixed(2)),minimumBatches:Math.ceil(evidence.mobileCandidates/evidence.whatsapp.limitPer24Hours),
      qualification:'Planning ceiling: one marketing template per valid mobile candidate, not a sendable audience. Assumes every candidate is eligible and charged once. Taxes, exchange/card fees and provider invoice treatment are not verified; the 20% scenario is illustrative, not a tax determination. Top-up funds the message cost; do not add it again. No reachability probes or purchases made.'},
    sources:[{label:'Meta USD marketing rates effective 1 Oct 2026',url:'https://www.gupshup.ai/resources/wp-content/uploads/2026/11/USD_Oct2026.pdf'},
      {label:'Meta destination-country mapping (Saint Lucia: Other)',url:'https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing'},
      {label:'Gupshup self-serve pricing',url:'https://www.gupshup.io/channels/self-serve/whatsapp/pricing'},
      {label:'Sender Free Forever limits',url:'https://www.sender.net/pricing/free-plan/'}]};
}
export const DEFAULT_WELCOME_COPY=Object.freeze({
  subject:'Welcome back to Sharp Cuts — ready for a fresh look?',
  preheader:'Your next fresh cut starts here. Book with the Sharp Cuts team in Luton.',
  emailBody:'Ready for a fresh look?\n\nWe’d love to welcome you back to Sharp Cuts. Whether it’s a tidy-up, a new style or a beard refresh, choose your service and preferred barber on our team booking page.\n\nSee you in the chair,\nThe Sharp Cuts team',
  whatsappBody:'Hello from Sharp Cuts 👋 Ready for a fresh look? We’d love to welcome you back for your next haircut or beard refresh. Choose your service and preferred barber on our team booking page.',
  bookingUrl:SHARP_CUTS_BOOKING_URL,
  from:'Sharp Cuts <info@sharpcuts.uk>',replyTo:'info@sharpcuts.uk',address:'57 Cheapside, Luton, LU1 2HN',
  emailOptout:'{$unsubscribe_link}',whatsappOptout:'Reply STOP to opt out of Sharp Cuts WhatsApp marketing.'
});
export function welcomeEmailHtml(copy){return renderSharpCutsWelcome(copy,SHARP_CUTS_BOOKING_URL);}
function validateCopy(input){
  const copy={...DEFAULT_WELCOME_COPY};
  for(const [key,max] of [['subject',180],['preheader',200],['emailBody',6000],['whatsappBody',800]]){
    const value=input?.[key]??copy[key];if(typeof value!=='string'||!value.trim()||value.length>max)throw Object.assign(Error('A valid '+key+' is required.'),{statusCode:400});copy[key]=value.trim();
  }
  return copy;
}
export function createWelcomeReview({storage,ownerId,customerReader,senderClient,clock=()=>new Date()}){
  const events=()=>storage.listActivity(ownerId,{projectId,limit:200});
  const project=async()=>{if(!(await storage.listProjects(ownerId)).some(p=>p.id===projectId))throw Object.assign(Error('Sharp Cuts workspace access is unavailable.'),{statusCode:403});};
  async function read(){
    await project();
    const coolingDown=clock().getTime()<Date.parse(WELCOME_PROVIDER_PREPARATION.inventoryRetryAt);
    const [s,p,ev,sp]=await Promise.allSettled([customerReader?.snapshot(),senderClient?.inspectCampaignReadiness(),events(),coolingDown?Promise.resolve({checked:false,total:null,restricted:null,reason:'sender_rate_limited',retryAt:WELCOME_PROVIDER_PREPARATION.inventoryRetryAt,contactsChanged:0}):senderClient?.inspectSuppressionReadiness?.()]);
    const suppression=sp.status==='fulfilled'&&sp.value?sp.value:{checked:false,total:null,restricted:null};
    const source=s.status==='fulfilled'?s.value:null,provider=p.status==='fulfilled'&&p.value?p.value:{status:'unavailable',groups:[]};
    const saved=ev.status==='fulfilled'?ev.value.filter(e=>e.action===action&&e.metadata?.review?.projectId===projectId):[];
    const review=saved[0]?.metadata.review||null,copy=review?.copy||DEFAULT_WELCOME_COPY;
    let prepared={checked:false,campaignId:WELCOME_PROVIDER_PREPARATION.campaignId,ready:false};
    if(review&&senderClient?.inspectPreparedCampaign){
      try{prepared=await senderClient.inspectPreparedCampaign({campaignId:WELCOME_PROVIDER_PREPARATION.campaignId,copy,html:welcomeEmailHtml(copy)});}
      catch{prepared={...prepared,reason:'Provider draft validation currently unavailable'};}
    }
    const audienceMatched=suppression.checked===true&&suppression.groupId===WELCOME_PROVIDER_PREPARATION.groupId&&suppression.groupCount===1240&&suppression.groupRestricted===0&&suppression.audienceHash===WELCOME_EVIDENCE.emailReconciliation.audienceHash;
    const preparationReady=prepared.ready===true&&audienceMatched&&prepared.recipientCount===1240&&prepared.submitted===0;
    const reconciliation=describeCampaignSource(source?.emailSource,source?.channels?.email?.verifiedEligible,provider);
    const blockers=['Email: 1,240 addresses pass the fresh Fresha permission, blocked-client, duplicate and upcoming-booking checks. Recheck current provider suppressions and bookings immediately before any separately approved transfer or launch.',
      ...(audienceMatched?[]:['The imported Sender audience must match the approved 1,240-address fingerprint with no restricted group members. Current verification is incomplete or differs.']),
      ...(prepared.ready?[]:['The unsent Sender draft still needs matching copy, HTML, sender, group, disabled follow-up and successful provider validation.']),
      'WhatsApp requires channel-specific marketing permission and an approved marketing template; none is evidenced for this campaign.',
      'Exact eligible audience, schedule, channel and final cost require a separate launch approval. Sending and historical queues remain held.'];
    if(reconciliation.membershipStatus!=='matched')blockers.unshift('The live frozen cohort could not be confirmed. No audience changes or sends are permitted.');
    if(provider.status==='unavailable')blockers.unshift('Current Sender API readiness could not be read. Historical billing evidence is labelled separately.');
    return {projectId,campaignId:'sharp-cuts-welcome-back',title:'Welcome back / Fresh new look',status:review?'saved_for_review':'prepared_for_review',checkedAt:clock().toISOString(),
      ownerTest:withSenderRestriction(ev.status==='fulfilled'?ev.value.find(e=>e.action==='sharp_cuts_welcome_test_receipt')?.metadata?.receipt||null:null),
      evidence:WELCOME_EVIDENCE,reconciliation,provider,suppression,copy,emailHtml:welcomeEmailHtml(copy),costs:welcomeCosts(),
      preparation:{...WELCOME_PROVIDER_PREPARATION,audienceMatched,ready:preparationReady,provider:prepared},
      audience:{emailAddressCandidates:1558,emailFreshaEligible:1240,mobileCandidates:1312,whatsappReachability:'Not checked for this audience',emailLaunchEligible:null,whatsappLaunchEligible:null,
        note:'1,562 preserved staged email profiles are not 1,562 unique email addresses. No customer was removed or added. Counts describe the original export, not a live refreshed customer list.'},
      review:review?{id:review.id,hash:review.hash,savedAt:review.savedAt,channel:review.channel,proposedAt:review.proposedAt,creativeHash:review.creativeHash}:null,
      approval:{status:'not_requested',launchEnabled:false,sendAuthorised:false,blocks:blockers},
      results:{status:prepared.status||'unverified',submitted:prepared.checked?prepared.submitted??null:null,delivered:null,failed:null,unsubscribed:null,providerCampaignId:prepared.campaignId,
        note:'Sender draft '+WELCOME_PROVIDER_PREPARATION.campaignId+' is bound to this review. Submission counts are read from the provider; delivery is not inferred from sent records. No launch or schedule has been authorised.'},
      execution:{choice:'Existing Nova tools and worker',n8n:'Inactive synthetic workflow only; no live n8n binding in the inspected configuration.',
        reason:'Reuse project-scoped approvals, durable jobs, idempotency, suppression checks and provider receipts. An additional agent cannot establish consent or replace provider delivery evidence.',
        later:'A live n8n route would require hosting, scoped credentials, an authenticated Nova trigger, immutable approval envelope, idempotency, pause checks and signed status callbacks. It adds maintenance and does not remove the current audience requirements. Appointment follow-ups also need a supported fresh Fresha data feed.'}};
  }
  // A one-recipient creative test does not need customer inventory or campaign-list scans.
  async function readTestPreparation(){
    await project();
    const review=(await events()).find(e=>e.action===action&&e.metadata?.review?.projectId===projectId)?.metadata.review;
    if(!review)return {review:null};
    const copy=review.copy;
    const provider=await senderClient.inspectPreparedCampaign({campaignId:WELCOME_PROVIDER_PREPARATION.campaignId,copy,html:welcomeEmailHtml(copy)});
    return {copy,review,preparation:{provider}};
  }
  return {read,readTestPreparation,async save(input){
    const current=await read(),copy=validateCopy(input);
    if(!['email','whatsapp','compare'].includes(input.channel))throw Object.assign(Error('Select a campaign channel.'),{statusCode:400});
    const proposedAt=input.proposedAt||null;
    if(proposedAt&&(!Number.isFinite(Date.parse(proposedAt))||Date.parse(proposedAt)<=clock().getTime()))throw Object.assign(Error('Choose a future proposed time or leave it undecided.'),{statusCode:400});
    const envelope={projectId,copy,creativeHash:hash(welcomeEmailHtml(copy)),channel:input.channel,proposedAt,sourceHash:WELCOME_EVIDENCE.sourceHash,membershipHash:current.reconciliation.membershipHash,audienceEvidence:WELCOME_EVIDENCE.emailReconciliation,costs:current.costs,sendAuthorised:false};
    const digest=hash(envelope),existing=(await events()).find(e=>e.action===action&&e.metadata?.review?.hash===digest);
    if(existing)return {saved:true,reused:true,review:existing.metadata.review};
    const review={...envelope,id:'welcome-'+digest.slice(0,24),hash:digest,savedAt:clock().toISOString(),status:'saved_for_review'};
    await storage.appendActivity({ownerId,projectId,action,tool:'sharp_cuts_automation_welcome_review',status:'completed',summary:'Saved exact Welcome back copy, proposed timing, audience evidence and costs for owner review. Nothing scheduled or sent.',metadata:{review}});
    return {saved:true,review,contactsChanged:0,messagesSent:0};
  }};
}
