import {createHash} from 'node:crypto';
import {welcomeEmailHtml,WELCOME_PROVIDER_PREPARATION} from './sharp-cuts-welcome-review.js';
import {SHARP_CUTS_WHATSAPP_URL} from '../email/sharp-cuts-welcome-creative.js';
import {withSenderRestriction} from '../email/sender-restriction.js';
export const WELCOME_TEST_RECIPIENT='hamodehshanbour@yahoo.com';
export const isWelcomeTestApproval=(approval,ownerId)=>approval?.ownerId===ownerId&&approval.status==='pending'&&['sharp_cuts_welcome_test_send','sharp_cuts_welcome_placement_test'].includes(approval.tool)&&Boolean(approval.runId)&&approval.arguments?.recipient===WELCOME_TEST_RECIPIENT&&Object.keys(approval.arguments).length===1;
const projectId='sharp-cuts-web';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createWelcomeTest({storage,ownerId,senderClient,welcome,connected=false,placementTest=false,clock=()=>new Date()}){
  // One authorisation, not one send per copy/version/conversation. A claimed
  // transport failure is never retried. A confirmed 429 rejection permits only
  // one later explicitly approved Nova invocation, after a conservative cooldown.
  const originalClaimId='welcome-test-'+hash([ownerId,'J6P5lD',WELCOME_TEST_RECIPIENT,'2026-11-20']).slice(0,32);
  // Separate explicit owner authorisation; never reset the original send receipt.
  const claimId=placementTest?originalClaimId+'-placement-review':originalClaimId;
  const tool=placementTest?'sharp_cuts_welcome_placement_test':'sharp_cuts_welcome_test_send';
  const readAttempt=async(id)=>{
    const receipt=await storage.getActivity(id+'-receipt',ownerId);
    if(receipt)return withSenderRestriction(receipt.metadata.receipt);
    return await storage.getActivity(id,ownerId)?{status:'outcome_unconfirmed',retryAllowed:false,recipient:WELCOME_TEST_RECIPIENT,delivered:null}:null;
  };
  const retryId=claimId+'-rate-recovery';
  // Explicit renewed owner instruction on 20 Nov permits one diagnostic recovery.
  // Keep all older claims/receipts; never loop after this bounded attempt.
  const diagnosticId=claimId+'-diagnosed-recovery';
  const read=async()=>await readAttempt(diagnosticId)||await readAttempt(retryId)||await readAttempt(claimId);
  return {read,async send(input,context={}){
    const run=context.runId?await storage.getRun(context.runId,ownerId):null;
    context={...context,conversationId:run?.conversationId};
    if(!connected||input.recipient!==WELCOME_TEST_RECIPIENT||!context.conversationId||!context.runId||!(await storage.listProjects(ownerId)).some(p=>p.id===projectId))throw Error('This one-recipient test requires the authorised connected Preview conversation.');
    const prior=await read();
    let attemptId=claimId;
    if(placementTest){
      if(prior)return {...prior,reused:true};
      const original=await readAttempt(originalClaimId+'-diagnosed-recovery')||await readAttempt(originalClaimId+'-rate-recovery')||await readAttempt(originalClaimId);
      if(original?.accepted!==true||!original.messageId)throw Error('Reconcile the first test before the separately authorised placement test.');
      if(clock().getTime()<Date.parse(original.checkedAt)+300000)throw Error('The five-minute provider safety cooldown has not elapsed.');
    }
    if(prior){
      const retryAt=Math.max(Date.parse(prior.checkedAt)+Math.max(300,Number(prior.retryAfterSeconds)||0)*1000,Date.parse(prior.restriction?.notBefore)||0);
      const eligible=!prior.restriction?.requiresProviderClarification&&prior.status==='rejected'&&prior.accepted===false&&prior.upstreamStatus===429&&!prior.messageId&&Number.isFinite(retryAt)&&clock().getTime()>=retryAt&&context.runId!==prior.runId&&!await readAttempt(diagnosticId);
      if(!eligible)return {...prior,reused:true};
      attemptId=await readAttempt(retryId)?diagnosticId:retryId;
    }
    const review=await welcome.readTestPreparation(),html=welcomeEmailHtml(review.copy);
    if(!review.review||review.review.creativeHash!==hash(html)||review.preparation?.provider?.ready!==true||review.preparation.provider.submitted!==0)throw Error('Save the current creative in Nova and synchronise the existing unsent Sender draft before testing.');
    if(prior?.creativeHash&&prior.creativeHash!==hash(html))throw Error('The recovered test must preserve the exact originally authorised creative.');
    const common={ownerId,projectId,runId:context.runId,tool};
    try{await storage.appendActivity({...common,id:attemptId,action:'sharp_cuts_welcome_test_claimed',status:'pending',summary:'Claimed the single owner-authorised campaign preview email; no audience send.',metadata:{conversationId:context.conversationId,recipient:input.recipient,reviewId:review.review.id,creativeHash:hash(html),idempotencyKey:claimId}});}catch(e){if(e.code==='23505')return {...await read(),reused:true};throw e;}
    let receipt;
    try{
      const text=review.copy.emailBody+'\n\nBook with the Sharp Cuts Team: '+review.copy.bookingUrl+'\n\nBook via WhatsApp: '+SHARP_CUTS_WHATSAPP_URL+'\nMessage the shop with your enquiry. Your booking is confirmed when agreed with the team.\n\nSharp Cuts Gents Barbers\n'+review.copy.address+'\ninfo@sharpcuts.uk\nUnsubscribe preview (owner test only; no preferences changed): https://campaign-statistics.com/unsubscribe_preview/en';
      receipt=await senderClient.sendWelcomeTest({recipient:input.recipient,subject:(placementTest?'[TEST 2] ':'[TEST] ')+review.copy.subject,html,text},{authority:{operation:'welcome_single_test',projectId,campaignId:WELCOME_PROVIDER_PREPARATION.campaignId,recipient:input.recipient,creativeHash:hash(html),idempotencyKey:claimId}});
    }catch(e){receipt={status:[400,401,403,422,429].includes(e.upstreamStatus)?'rejected':'outcome_unconfirmed',accepted:false,providerCode:e.code||'sender_outcome_unconfirmed',upstreamStatus:e.upstreamStatus||null,retryAfterSeconds:e.retryAfterSeconds??null,rateLimit:e.rateLimit??null,providerResponse:e.providerResponse??null,transport:e.transport??null,recipient:input.recipient};}
    receipt={...receipt,testPurpose:placementTest?'placement_review':'original',subject:(placementTest?'[TEST 2] ':'[TEST] ')+review.copy.subject,inboxPlacement:'unknown',campaignId:WELCOME_PROVIDER_PREPARATION.campaignId,reviewId:review.review.id,creativeHash:hash(html),conversationId:context.conversationId,runId:context.runId,attempt:attemptId===diagnosticId?3:attemptId===retryId?2:1,checkedAt:clock().toISOString(),delivered:null,retryAllowed:false,audienceMessages:0,note:'Single-recipient creative preview via Sender transactional API. Provider acceptance does not prove inbox delivery. The 1,240-person campaign remains unsent.'};
    await storage.appendActivity({...common,id:attemptId+'-receipt',action:'sharp_cuts_welcome_test_receipt',status:receipt.accepted?'completed':'blocked',summary:'Owner campaign test: '+receipt.status+'. Campaign audience not sent.',metadata:{receipt}});
    return withSenderRestriction(receipt);
  }};
}
