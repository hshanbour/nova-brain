import {createHash} from 'node:crypto';
import {welcomeEmailHtml,WELCOME_PROVIDER_PREPARATION} from './sharp-cuts-welcome-review.js';
export const WELCOME_TEST_RECIPIENT='hamodehshanbour@yahoo.com';
export const isWelcomeTestApproval=(approval,ownerId)=>approval?.ownerId===ownerId&&approval.status==='pending'&&approval.tool==='sharp_cuts_welcome_test_send'&&Boolean(approval.runId)&&approval.arguments?.recipient===WELCOME_TEST_RECIPIENT&&Object.keys(approval.arguments).length===1;
const projectId='sharp-cuts-web';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createWelcomeTest({storage,ownerId,senderClient,welcome,connected=false}){
  // One authorisation, not one send per copy/version/conversation. A claimed
  // request is never retried automatically, even after a transport failure.
  const claimId='welcome-test-'+hash([ownerId,'J6P5lD',WELCOME_TEST_RECIPIENT,'2026-11-20']).slice(0,32);
  const read=async()=>{
    const receipt=await storage.getActivity(claimId+'-receipt',ownerId);
    if(receipt)return receipt.metadata.receipt;
    return await storage.getActivity(claimId,ownerId)?{status:'outcome_unconfirmed',retryAllowed:false,recipient:WELCOME_TEST_RECIPIENT,delivered:null}:null;
  };
  return {read,async send(input,context={}){
    const run=context.runId?await storage.getRun(context.runId,ownerId):null;
    context={...context,conversationId:run?.conversationId};
    if(!connected||input.recipient!==WELCOME_TEST_RECIPIENT||!context.conversationId||!context.runId||!(await storage.listProjects(ownerId)).some(p=>p.id===projectId))throw Error('This one-recipient test requires the authorised connected Preview conversation.');
    const prior=await read();if(prior)return {...prior,reused:true};
    const review=await welcome.read(),html=welcomeEmailHtml(review.copy);
    if(!review.review||review.review.creativeHash!==hash(html)||review.preparation?.provider?.ready!==true||review.preparation.provider.submitted!==0)throw Error('Save the current creative in Nova and synchronise the existing unsent Sender draft before testing.');
    const common={ownerId,projectId,runId:context.runId,tool:'sharp_cuts_welcome_test_send'};
    try{await storage.appendActivity({...common,id:claimId,action:'sharp_cuts_welcome_test_claimed',status:'pending',summary:'Claimed the single owner-authorised campaign preview email; no audience send.',metadata:{conversationId:context.conversationId,recipient:input.recipient,reviewId:review.review.id,creativeHash:hash(html)}});}catch(e){if(e.code==='23505')return {...await read(),reused:true};throw e;}
    let receipt;
    try{
      receipt=await senderClient.sendWelcomeTest({recipient:input.recipient,subject:'[TEST] '+review.copy.subject,html,text:review.copy.emailBody+'\n\nBook with the Sharp Cuts Team: '+review.copy.bookingUrl},{authority:{operation:'welcome_single_test',projectId,campaignId:WELCOME_PROVIDER_PREPARATION.campaignId,recipient:input.recipient,creativeHash:hash(html)}});
    }catch(e){receipt={status:[400,401,403,422,429].includes(e.upstreamStatus)?'rejected':'outcome_unconfirmed',accepted:false,providerCode:e.code||'sender_outcome_unconfirmed',upstreamStatus:e.upstreamStatus||null,recipient:input.recipient};}
    receipt={...receipt,campaignId:WELCOME_PROVIDER_PREPARATION.campaignId,reviewId:review.review.id,creativeHash:hash(html),conversationId:context.conversationId,runId:context.runId,checkedAt:new Date().toISOString(),delivered:null,retryAllowed:false,audienceMessages:0,note:'Single-recipient creative preview via Sender transactional API. Provider acceptance does not prove inbox delivery. The 1,240-person campaign remains unsent.'};
    await storage.appendActivity({...common,id:claimId+'-receipt',action:'sharp_cuts_welcome_test_receipt',status:receipt.accepted?'completed':'blocked',summary:'Owner campaign test: '+receipt.status+'. Campaign audience not sent.',metadata:{receipt}});
    return receipt;
  }};
}
