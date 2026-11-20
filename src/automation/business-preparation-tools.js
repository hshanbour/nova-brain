import {createWelcomeTest} from './sharp-cuts-welcome-test.js';
import {createHash} from 'node:crypto';
import {SHARP_CUTS_BOOKING_URL} from './sharp-cuts-campaign.js';
import {describeCampaignSource} from '../email/sharp-cuts-audience.js';
import {previewSenderCopy} from '../email/sender-marketing.js';
import {createWelcomeReview} from './sharp-cuts-welcome-review.js';
const projectId='sharp-cuts-web', digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const schema=properties=>({type:'object',properties,additionalProperties:false});

// Campaign preparation plus one explicitly approved, recipient-locked owner test.
// No audience send or contact upload; provider writes have durable one-shot claims.
export function registerBusinessPreparationTools(registry,{storage,ownerId,customerReader,senderClient,senderConfig,whatsapp,connected=false}){
  const common={category:'business_preparation',available:true,configurationStatus:'draft_only'};
  const welcome=createWelcomeReview({storage,ownerId,customerReader,senderClient});
  const ownerTest=createWelcomeTest({storage,ownerId,senderClient,welcome,connected});
  registry.register({...common,name:'sharp_cuts_welcome_test_send',description:'Send exactly ONE finished Sharp Cuts Welcome back campaign TEST to hamodehshanbour@yahoo.com only, through the existing Sender connection. Independent of the 1240 audience. Requires owner approval; durable duplicate protection; no launch/schedule. Returns actual acceptance receipt, never infers delivery.',riskLevel:'HIGH_IMPACT',approvalReason:'Send one finished campaign test to hamodehshanbour@yahoo.com only; keep audience campaign unsent.',inputSchema:{...schema({recipient:{type:'string',enum:['hamodehshanbour@yahoo.com']}}),required:['recipient']},execute:(input,context)=>ownerTest.send(input,context)});
  registry.register({...common,name:'sharp_cuts_welcome_test_diagnostic',description:'Read actual Sender transport status, error message and cooldown headers with one GET request. No email, audience inventory, contact change or retry. Read-only troubleshooting, not send authority.',riskLevel:'READ_ONLY',inputSchema:schema({}),async execute(){if(!(await storage.listProjects(ownerId)).some(p=>p.id===projectId))throw Error('Sharp Cuts workspace access required.');return senderClient.inspectTestTransport();}});
  registry.register({...common,name:'sharp_cuts_welcome_test_status',description:'Read the single owner campaign-test receipt; no send or retry. Accepted is not delivered.',riskLevel:'READ_ONLY',inputSchema:schema({}),execute:()=>ownerTest.read()});
  registry.register({...common,name:'sharp_cuts_welcome_review',description:'Read the complete Sharp Cuts Welcome back review: aggregate audience evidence, costs, copy, launch blockers and real results. No sends.',riskLevel:'READ_ONLY',inputSchema:schema({}),execute:()=>welcome.read()});
  registry.register({...common,name:'sharp_cuts_welcome_review_save',description:'Save exact campaign copy and proposed channel/time for review only. Does not approve, schedule, upload contacts or send.',riskLevel:'LOW_RISK_WRITE',autonomous:true,inputSchema:{...schema({subject:{type:'string'},preheader:{type:'string'},emailBody:{type:'string'},whatsappBody:{type:'string'},channel:{type:'string'},proposedAt:{type:'string'}}),required:['channel']},execute:input=>welcome.save(input)});
  registry.register({...common,name:'sharp_cuts_whatsapp_delivery_review',description:'Read Sharp Cuts outbound provider status, retained authenticated callback evidence and separately labelled owner-confirmed receipt. Never equate owner confirmation with provider delivery. No sends or queue release.',riskLevel:'READ_ONLY',inputSchema:schema({}),execute:()=>whatsapp.deliveryReview()});
  registry.register({...common,name:'sharp_cuts_whatsapp_delivery_reconcile',description:'Apply only already retained authenticated provider status receipts to one exact Sharp Cuts delivery recordRef. No provider calls, new messages or queue release. Cannot infer delivered from owner confirmation.',riskLevel:'LOW_RISK_WRITE',autonomous:true,inputSchema:{...schema({recordRef:{type:'string'}}),required:['recordRef']},execute:input=>whatsapp.reconcileDelivery(input)});
  const readiness=async()=>{
    let provider={connected:false,status:'not_configured'},audience={source:'unavailable',channels:null};
    if(senderClient)try{provider={...await senderClient.probe(),status:'connected'};}catch(e){provider={connected:false,status:e?.code||'probe_failed'};}
    if(customerReader)try{const s=await customerReader.snapshot();audience={source:s.source,channels:s.channels,emailSource:s.emailSource,uniqueProfiles:s.uniqueProfiles,identifiersExposed:false};}catch{audience={source:'unavailable',channels:null,status:'failed_closed'};}
    return{projectId,provider,senderIdentity:'Sharp Cuts <info@sharpcuts.uk>',dedicatedAudienceConfigured:Boolean(senderConfig?.groupId||await senderClient?.audienceBinding?.()),audience,contactUploadEnabled:false,sendingEnabled:false};
  };
  registry.register({...common,name:'sharp_cuts_email_group_prepare',description:'Create or reuse exactly one dedicated empty Sharp Cuts Sender campaign-review group and bind its verified receipt. No subscriber uploads, automations, campaigns or sends. Use only for the owner-requested dedicated group setup.',riskLevel:'LOW_RISK_WRITE',autonomous:true,inputSchema:schema({}),async execute(){
    if(!senderClient)throw Error('Existing Sender connection is unavailable.');
    return senderClient.prepareDedicatedGroup();
  }});
  registry.register({...common,name:'sharp_cuts_email_readiness',description:'Read current Sender API access and SELECT-only audience evidence. No contacts uploaded or messages sent.',riskLevel:'READ_ONLY',inputSchema:schema({}),execute:readiness});
  registry.register({...common,name:'sharp_cuts_email_provider_review',description:'Reconcile the frozen 1,562-profile Sharp Cuts cohort with its live staging membership, address deduplication, the configured Sender audience, campaigns and restrictions. Returns aggregate evidence only.',riskLevel:'READ_ONLY',inputSchema:schema({}),async execute(){
    const [provider,source]=await Promise.allSettled([senderClient?.inspectCampaignReadiness(),customerReader?.snapshot()]);
    const review=provider.status==='fulfilled'&&provider.value?provider.value:{status:senderClient?'provider_unavailable':'not_configured'};
    const data=source.status==='fulfilled'?source.value:null;
    return {...review,reconciliation:describeCampaignSource(data?.emailSource,data?.channels?.email?.verifiedEligible,review)};
  }});
  registry.register({...common,name:'sharp_cuts_email_campaign_tracking',description:'Read Sender sent totals, validation errors and warnings for a Sharp Cuts campaign ID. Reports delivery only when evidenced.',riskLevel:'READ_ONLY',inputSchema:{...schema({campaignId:{type:'string'}}),required:['campaignId']},async execute({campaignId}){
    return senderClient?senderClient.campaignStatus(campaignId):{status:'not_configured'};
  }});
  registry.register({...common,name:'sharp_cuts_email_drafts',description:'Retrieve saved Sharp Cuts campaign review drafts with exact subject/body, audience evidence, approval blocks and delivery status. These are Nova drafts, not sent provider campaigns.',riskLevel:'READ_ONLY',inputSchema:schema({}),async execute(){
    const events=await storage.listActivity(ownerId,{projectId,limit:200});
    const audienceGroupId=senderConfig?.groupId||await senderClient?.audienceBinding?.()||null;
    return{projectId,drafts:events.filter(e=>e.action==='sharp_cuts_email_review_draft_prepared'&&e.metadata?.draft?.projectId===projectId).slice(0,20).map(e=>{
      const draft=e.metadata.draft;
      const copy=draft.copy;
      return copy?.subject&&copy?.body&&copy.bookingUrl===SHARP_CUTS_BOOKING_URL&&copy.address
        ? {...draft,providerContentPreview:previewSenderCopy(copy)} : draft;
    }),currentAudienceBinding:{configured:Boolean(audienceGroupId),groupId:audienceGroupId},note:'Draft blocks and audience counts are historical snapshots. Use currentAudienceBinding for the current group connection and sharp_cuts_email_provider_review for live audience evidence. ProviderContentPreview resolves the booking placeholder for review only; original copy and approval hashes are unchanged.',sendingEnabled:false};
  }});
  registry.register({...common,name:'sharp_cuts_email_draft_prepare',description:'Save a reviewable Sharp Cuts email campaign draft inside Nova. Rechecks audience evidence; never uploads contacts, creates a provider campaign, schedules or sends. Include no invented discounts or availability.',riskLevel:'LOW_RISK_WRITE',autonomous:true,inputSchema:{...schema({subject:{type:'string'},body:{type:'string'}}),required:['subject','body']},async execute(input,context={}){
    if(typeof input.subject!=='string'||!input.subject.trim()||input.subject.length>200||typeof input.body!=='string'||!input.body.trim()||input.body.length>8000)throw new Error('A bounded subject and body are required.');
    const evidence=await readiness(),email=evidence.audience.channels?.email;
    const body=input.body.trim();
    const copy={subject:input.subject.trim(),body:body.includes(SHARP_CUTS_BOOKING_URL)?body:body+'\n\nBook with the Sharp Cuts team: '+SHARP_CUTS_BOOKING_URL,bookingUrl:SHARP_CUTS_BOOKING_URL,from:evidence.senderIdentity,address:'57 Cheapside, Luton, LU1 2HN',unsubscribe:'Required: provider-issued unsubscribe link must be validated before any send.',unsubscribeTag:'{$unsubscribe_link}'};
    const snapshot={...evidence.audience,reconciliation:describeCampaignSource(evidence.audience.emailSource,email?.verifiedEligible),capturedAt:new Date().toISOString()},copyHash=digest(copy),audienceSnapshotHash=digest(evidence.audience);
    const draft={id:`email-review-${digest([context.conversationId||null,copyHash,audienceSnapshotHash]).slice(0,24)}`,projectId,status:'draft_for_review',copy,copyHash,audienceSnapshotHash,audience:snapshot,verifiedEligible:email?.verifiedEligible??0,approval:{status:'not_requested',sendAuthorised:false,boundTo:['copyHash','audienceSnapshotHash','schedule','budget']},blocks:['Exact campaign approval and schedule required','Current suppression, unsubscribe and future-booking reconciliation required',...(email?.verifiedEligible?[]:['No verified eligible audience available']),...(!evidence.dedicatedAudienceConfigured?['Dedicated Sender audience binding required']:[])],delivery:{status:'not_sent',submitted:0,delivered:0,source:'no_provider_submission'},provider:evidence.provider,sendingEnabled:false,contactsUploaded:0};
    draft.providerContentPreview=previewSenderCopy(copy);
    await storage.appendActivity({ownerId,projectId,runId:context.runId||null,action:'sharp_cuts_email_review_draft_prepared',tool:'sharp_cuts_automation_email_review',status:'completed',summary:'Saved campaign copy and aggregate audience evidence for review; no provider write or send.',metadata:{draft,conversationId:context.conversationId||null}});
    return draft;
  }});
  registry.register({...common,name:'sharp_cuts_whatsapp_held_reviews',description:'List opaque references for the existing held Sharp Cuts inbound records. No contact identifiers, queue claims or sends.',riskLevel:'READ_ONLY',inputSchema:schema({}),execute:()=>whatsapp.reviewHeld()});
  registry.register({...common,name:'sharp_cuts_whatsapp_processing_check',description:'Run ONE fresh synthetic message through the deployed Sharp Cuts processing handler and real Brain, save an unsent draft receipt. Never claims the historical queue, sends, or tests provider webhook delivery.',riskLevel:'LOW_RISK_WRITE',autonomous:true,inputSchema:schema({}),execute:()=>whatsapp.processingCheck()});
  registry.register({...common,name:'sharp_cuts_whatsapp_reply_draft',description:'Prepare one UNSENT project-scoped reply for an exact recordRef from sharp_cuts_whatsapp_held_reviews. The original queue stays held. No recipient decryption or outbound action.',riskLevel:'LOW_RISK_WRITE',autonomous:true,inputSchema:{...schema({recordRef:{type:'string'}}),required:['recordRef']},execute:input=>whatsapp.prepareHeldDraft(input)});
}
