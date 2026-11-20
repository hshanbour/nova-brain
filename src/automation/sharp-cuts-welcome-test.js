import {createHash} from 'node:crypto';
import {welcomeEmailHtml,WELCOME_PROVIDER_PREPARATION} from './sharp-cuts-welcome-review.js';
export const WELCOME_TEST_RECIPIENT='hamodehshanbour@yahoo.com';
export const isWelcomeTestApproval=(approval,ownerId)=>approval?.ownerId===ownerId&&approval.status==='pending'&&approval.tool==='sharp_cuts_welcome_test_send'&&Boolean(approval.runId)&&approval.arguments?.recipient===WELCOME_TEST_RECIPIENT&&Object.keys(approval.arguments).length===1;
const projectId='sharp-cuts-web';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createWelcomeTest({storage,ownerId,senderClient,welcome,connected=false,clock=()=>new Date()}){
  // One authorisation, not one send per copy/version/conversation. A claimed
  // transport failure is never retried. A confirmed 429 rejection permits only
  // one later explicitly approved Nova invocation, after a conservative cooldown.
  const claimId='welcome-test-'+hash([ownerId,'J6P5lD',WELCOME_TEST_RECIPIENT,'2026-11-20']).slice(0,32);
  const readAttempt=async(id)=>{
    const receipt=await storage.getActivity(id+'-receipt',ownerId);
    if(receipt)return receipt.metadata.receipt;
    return await storage.getActivity(id,ownerId)?{status:'outcome_unconfirmed',retryAllowed:false,recipient:WELCOME_TEST_RECIPIENT,delivered:null}:null;
  };
  const retryId=claimId+'-rate-recovery';
  const read=async()=>await readAttempt(retryId)||await readAttempt(claimId);
  return {read,async send(input,context={}){
    const run=context.runId?await storage.getRun(context.runId,ownerId):null;
    context={...context,conversationId:run?.conversationId};
    if(!connected||input.recipient!==WELCOME_TEST_RECIPIENT||!context.conversationId||!context.runId||!(await storage.listProjects(ownerId)).some(p=>p.id===projectId))throw Error('This one-recipient test requires the authorised connected Preview conversation.');
    const prior=await read();
    let attemptId=claimId;
    if(prior){
      const retryAt=Date.parse(prior.checkedAt)+Math.max(300,Number(prior.retryAfterSeconds)||0)*1000;
      const eligible=prior.status==='rejected'&&prior.accepted===false&&prior.upstreamStatus===429&&!prior.messageId&&Number.isFinite(retryAt)&&clock().getTime()>=retryAt&&context.runId!==prior.runId&&!await readAttempt(retryId);
      if(!eligible)return {...prior,reused:true};
      attemptId=retryId;
    }
    const review=await welcome.readTestPreparation(),html=welcomeEmailHtml(review.copy);
    if(!review.review||review.review.creativeHash!==hash(html)||review.preparation?.provider?.ready!==true||review.preparation.provider.submitted!==0)throw Error('Save the current creative in Nova and synchronise the existing unsent Sender draft before testing.');
    const common={ownerId,projectId,runId:context.runId,tool:'sharp_cuts_welcome_test_send'};
    try{await storage.appendActivity({...common,id:attemptId,action:'sharp_cuts_welcome_test_claimed',status:'pending',summary:'Claimed the single owner-authorised campaign preview email; no audience send.',metadata:{conversationId:context.conversationId,recipient:input.recipient,reviewId:review.review.id,creativeHash:hash(html),idempotencyKey:claimId}});}catch(e){if(e.code==='23505')return {...await read(),reused:true};throw e;}
    let receipt;
    try{
      receipt=await senderClient.sendWelcomeTest({recipient:input.recipient,subject:'[TEST] '+review.copy.subject,html,text:review.copy.emailBody+'\n\nBook with the Sharp Cuts Team: '+review.copy.bookingUrl},{authority:{operation:'welcome_single_test',projectId,campaignId:WELCOME_PROVIDER_PREPARATION.campaignId,recipient:input.recipient,creativeHash:hash(html),idempotencyKey:claimId}});
    }catch(e){receipt={status:[400,401,403,422,429].includes(e.upstreamStatus)?'rejected':'outcome_unconfirmed',accepted:false,providerCode:e.code||'sender_outcome_unconfirmed',upstreamStatus:e.upstreamStatus||null,retryAfterSeconds:e.retryAfterSeconds??null,rateLimit:e.rateLimit??null,providerResponse:e.providerResponse??null,transport:e.transport??null,recipient:input.recipient};}
    receipt={...receipt,campaignId:WELCOME_PROVIDER_PREPARATION.campaignId,reviewId:review.review.id,creativeHash:hash(html),conversationId:context.conversationId,runId:context.runId,attempt:attemptId===retryId?2:1,checkedAt:clock().toISOString(),delivered:null,retryAllowed:false,audienceMessages:0,note:'Single-recipient creative preview via Sender transactional API. Provider acceptance does not prove inbox delivery. The 1,240-person campaign remains unsent.'};
    await storage.appendActivity({...common,id:attemptId+'-receipt',action:'sharp_cuts_welcome_test_receipt',status:receipt.accepted?'completed':'blocked',summary:'Owner campaign test: '+receipt.status+'. Campaign audience not sent.',metadata:{receipt}});
    return receipt;
  }};
}
