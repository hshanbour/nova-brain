import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {createInMemoryStorage} from '../src/storage/in-memory-storage.js';
import {createSharpCutsWhatsAppCoexistenceService} from '../src/whatsapp/sharp-cuts-coexistence.js';
import {createControlledOwnerTest} from '../src/whatsapp/controlled-owner-test.js';
const hash=v=>createHash('sha256').update(v).digest('hex');
const sid='wamid.controlled-synthetic-123',oldSid='wamid.historical-synthetic-123';
async function fixture({patch={},envPatch={},providerError=false}={}){
 const ownerId='synthetic-owner',storage=createInMemoryStorage();await storage.initialize({owner:{id:ownerId},projects:[{id:'sharp-cuts-web',name:'Synthetic Sharp Cuts'}]});
 const settings={configured:true,receiveEnabled:true,executionEnabled:false,sendEnabled:false,mode:'draft_only',provider:'gupshup_coexistence',number:'+441582510565',appId:'synthetic-app',appName:'SharpCutsNova',phoneNumberId:'12345',webhookToken:'synthetic-webhook',identityKeyBytes:randomBytes(32),apiKey:'synthetic-key',testRecipients:[]},config={sharpCutsWhatsApp:settings};
 const service=createSharpCutsWhatsAppCoexistenceService({config,storage,ownerId,novaTurn:async input=>{await storage.appendMessage({id:input.assistantMessageId,conversationId:input.conversationId,ownerId,role:'assistant',content:'Received, thank you.'});return{message:'Received, thank you.'};},automationControls:{async allows(){return false;}}});
 for(const messageSid of [oldSid,sid])await service.receive({gs_app_id:'synthetic-app',entry:[{changes:[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:'12345'},messages:[{id:messageSid,from:'447700900111',type:'text',text:{body:'Synthetic test acknowledgement'}}]}}]}]},'Bearer synthetic-webhook');
 const draft=await service.prepareHeldDraft({recordRef:hash(sid)}),before=await storage.getWhatsAppInbound(oldSid,ownerId);
 const grant={ownerId,appId:'synthetic-app',fundingConfirmed:true,recipient:'+447700900111',messageSid:sid,recordRef:hash(sid),replyHash:draft.replyHash,expiresAt:new Date(Date.now()+60_000).toISOString(),...patch};
 const environment={VERCEL_ENV:'preview',VERCEL_GIT_COMMIT_REF:'codex/combined-nova-preview-d5b5-c5bd',NOVA_SHARP_CUTS_WHATSAPP_CONTROLLED_TEST:JSON.stringify(grant),...envPatch};
 let calls=0;const controlled=createControlledOwnerTest({environment,config,storage,ownerId,fetchImpl:async(url,options)=>{calls++;assert.equal(url,'https://api.gupshup.io/wa/api/v1/msg');const body=new URLSearchParams(options.body);assert.equal(body.get('destination'),'447700900111');assert.equal(JSON.parse(body.get('message')).text,'Received, thank you.');if(providerError)throw Error('uncertain transport');return{ok:true,json:async()=>({status:'submitted',messageId:'provider-test-123'})};}});
 return{controlled,service,storage,ownerId,before,calls:()=>calls,input:{recordRef:grant.recordRef,replyHash:grant.replyHash,confirmation:'send-one-approved-reply'}};
}
test('manual exact-record test sends once, leaves historical rows and ordinary dispatch held, and retains receipt',async()=>{
 const f=await fixture();assert.equal((await f.controlled.review()).draft,'Received, thank you.');
 assert.equal((await f.service.processNext()).reason,'execution_held');
 const result=await f.controlled.submit(f.input);assert.equal(result.sent,true);assert.equal(result.delivered,false);assert.equal(f.calls(),1);
 assert.deepEqual(await f.storage.getWhatsAppInbound(oldSid,f.ownerId),f.before);
 assert.equal((await f.service.status()).sendEnabled,false);
 const review=await f.controlled.review();assert.equal(review.providerStatus,'submitted');assert.equal(review.canSubmit,false);
 assert.equal((await f.controlled.submit(f.input)).duplicate,true);assert.equal(f.calls(),1);
});
test('unfunded, expired, mismatched owner/app/hash and non-original environments cannot submit',async()=>{
 for(const options of [{patch:{fundingConfirmed:false}},{patch:{expiresAt:'2020-01-01'}},{patch:{ownerId:'other'}},{patch:{appId:'wrong'}},{patch:{recordRef:'f'.repeat(64)}},{patch:{replyHash:'e'.repeat(64)}},{envPatch:{VERCEL_ENV:'production'}},{envPatch:{VERCEL_GIT_COMMIT_REF:'another'}}]){
  const f=await fixture(options);await assert.rejects(()=>f.controlled.submit(f.input));assert.equal(f.calls(),0);
 }
});
test('exact recipient and explicit confirmation are required',async()=>{
 const f=await fixture({patch:{recipient:'+447700900222'}});assert.equal((await f.controlled.submit(f.input)).reason,'recipient_not_allowlisted');assert.equal(f.calls(),0);
 const g=await fixture();await assert.rejects(()=>g.controlled.submit({...g.input,confirmation:'yes'}));assert.equal(g.calls(),0);
});
test('uncertain provider outcome is persisted and cannot be resent',async()=>{
 const f=await fixture({providerError:true});await f.controlled.submit(f.input);assert.equal(f.calls(),1);
 assert.equal((await f.controlled.review()).providerStatus,'uncertain');assert.equal((await f.controlled.submit(f.input)).duplicate,true);assert.equal(f.calls(),1);
 assert.deepEqual(await f.storage.getWhatsAppInbound(oldSid,f.ownerId),f.before);
});
