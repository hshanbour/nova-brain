import {createHash} from 'node:crypto';
import {createSharpCutsWhatsAppCoexistenceService} from './sharp-cuts-coexistence.js';
const digest=value=>createHash('sha256').update(String(value)).digest('hex');
const PREFIX='whatsapp_sharp-cuts-web_';
const BRANCH='codex/combined-nova-preview-d5b5-c5bd';
const fail=()=>{throw Object.assign(new Error('The exact approved WhatsApp test is unavailable or expired.'),{statusCode:403,code:'controlled_test_not_authorised'});};

// A separate, explicit manual test authority. It never changes automation
// controls, worker dispatch, credentials, or the general recipient allowlist.
export function createControlledOwnerTest({environment,config,storage,ownerId,fetchImpl,clock=()=>Date.now()}) {
  let grant=null;try{grant=JSON.parse(environment.NOVA_SHARP_CUTS_WHATSAPP_CONTROLLED_TEST||'null');}catch{}
  const valid=()=>environment.VERCEL_ENV==='preview'&&environment.VERCEL_GIT_COMMIT_REF===BRANCH&&
    grant?.ownerId===ownerId&&grant?.appId===config.sharpCutsWhatsApp.appId&&grant?.fundingConfirmed===true&&
    config.sharpCutsWhatsApp.provider==='gupshup_coexistence'&&config.sharpCutsWhatsApp.configured===true&&
    /^\+44\d{10}$/.test(grant?.recipient||'')&&[grant?.recordRef,grant?.replyHash].every(v=>/^[a-f0-9]{64}$/.test(v||''))&&
    typeof grant?.messageSid==='string'&&grant.messageSid.length<=512&&digest(grant.messageSid)===grant.recordRef&&
    Number.isFinite(Date.parse(grant?.expiresAt))&&Date.parse(grant.expiresAt)>clock()&&
    Date.parse(grant.expiresAt)-clock()<=24*60*60*1000;
  async function selection(){
    if(!valid())fail();
    const row=await storage.getWhatsAppInbound(grant.messageSid,ownerId);
    const age=clock()-Date.parse(row?.createdAt);
    if(!row||!row.conversationId.startsWith(PREFIX)||!Number.isFinite(age)||age<0||age>=24*60*60*1000)fail();
    const draft=await storage.getWhatsAppMessage({ownerId,conversationId:`review_${PREFIX}${grant.recordRef.slice(0,32)}`,messageId:`review-whatsapp-assistant-${grant.recordRef.slice(0,40)}`});
    if(draft?.role!=='assistant'||digest(draft.content.trim())!==grant.replyHash)fail();
    const receipt=await storage.getWhatsAppOutbound(row.messageSid,ownerId);
    return{row,draft,receipt};
  }
  const projectService=createSharpCutsWhatsAppCoexistenceService({
    config:{...config,sharpCutsWhatsApp:{...config.sharpCutsWhatsApp,mode:'owner_test',executionEnabled:true,sendEnabled:true,testRecipients:[grant?.recipient]}},
    storage,ownerId,fetchImpl,
    automationControls:{async allows(project,channel){return project==='sharp-cuts-web'&&channel==='messaging'&&valid();}},
    // Only the already persisted, hash-approved draft may be used. No new model
    // generation, customer tool or substitute text is allowed on this path.
    novaTurn:async()=>{throw Error('Controlled test cannot generate a new reply.');},
  });
  return {
    async review(){
      const {row,draft,receipt}=await selection();
      return{recordRef:grant.recordRef,replyHash:grant.replyHash,recipient:grant.recipient,draft:draft.content,expiresAt:grant.expiresAt,
        receivedAt:row.createdAt,providerStatus:receipt?.status||'not_submitted',providerMessageId:receipt?.providerMessageSid||null,
        canSubmit:!receipt,automaticSendingEnabled:false,historicalQueueHeld:true};
    },
    async submit(input){
      if(input?.confirmation!=='send-one-approved-reply'||input.recordRef!==grant?.recordRef||input.replyHash!==grant?.replyHash)fail();
      const {receipt}=await selection();
      if(receipt)return{worked:false,duplicate:true,providerStatus:receipt.status,providerMessageId:receipt.providerMessageSid||null,delivered:['delivered','read'].includes(receipt.status),reconcileBeforeRetry:true};
      const result=await projectService.processNext({workerId:'explicit-single-owner-test',recordRef:grant.recordRef,approvedReplyHash:grant.replyHash});
      await storage.appendActivity({ownerId,projectId:'sharp-cuts-web',action:'sharp_cuts_manual_controlled_test',status:result.sent?'submitted':'blocked',summary:'One exact owner-approved reply attempt; automatic dispatch and historical queue remain held.',metadata:{recordRef:grant.recordRef,result}});
      return result;
    },
  };
}
