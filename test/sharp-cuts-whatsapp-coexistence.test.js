import test from "node:test";
import assert from "node:assert/strict";
import {readConfig} from "../src/config/env.js";
import {createInMemoryStorage} from "../src/storage/in-memory-storage.js";
import {createSharpCutsWhatsAppCoexistenceService} from "../src/whatsapp/sharp-cuts-coexistence.js";
import {createPersistentLocalWorker} from "../src/autonomy/persistent-local-worker.js";
import {createProjectAutomationControls} from "../src/automation/project-automation-controls.js";
import {createAgent} from '../src/agent/agent.js';
import {createToolRegistry} from '../src/tools/tool-registry.js';

test('actual Brain produces a scoped WhatsApp draft and receipt without private owner context or send',async()=>{
 const storage=createInMemoryStorage();await storage.initialize({owner:{id:OWNER,facts:{secret:'PRIVATE OWNER FACT'},preferences:{}},projects:[{id:'sharp-cuts-web',name:'Sharp Cuts'},{id:'private',name:'PRIVATE PROJECT'}]});
 let inputSeen,sends=0;const agent=createAgent({storage,ownerId:OWNER,toolRegistry:createToolRegistry(),modelProvider:{name:'synthetic',async generate(input){inputSeen=input;return{type:'final',message:'Use the official Sharp Cuts team booking page.'};}}});
 const service=createSharpCutsWhatsAppCoexistenceService({config:readConfig(ENV),storage,ownerId:OWNER,automationControls:{async allows(){return true;}},novaTurn:input=>agent.run(input),fetchImpl:async()=>{sends++;throw Error('Forbidden send');}});
 await service.receive(payload('Where can I book?','wamid.synthetic-brain-123'),`Bearer ${TOKEN}`);const result=await service.processNext();
 assert.equal(result.sent,false);assert.equal(result.status,'awaiting_owner_review');assert.equal(sends,0);assert.deepEqual(inputSeen.tools,[]);assert.doesNotMatch(JSON.stringify(inputSeen),/PRIVATE OWNER FACT|PRIVATE PROJECT/);assert.match(JSON.stringify(inputSeen),/fresha/);
 const runs=await storage.listRuns(OWNER);assert.equal(runs[0].projectId,'sharp-cuts-web');assert.ok(runs[0].id);
});

test('actual worker tick holds a paused backlog and processes only an isolated fresh draft with no provider request',async()=>{
  const storage=createInMemoryStorage();await storage.initialize({owner:{id:OWNER},projects:[{id:'sharp-cuts-web',name:'Sharp Cuts'}]});
  const controls=createProjectAutomationControls({storage,ownerId:OWNER});let modelCalls=0,providerCalls=0;
  const service=createSharpCutsWhatsAppCoexistenceService({config:readConfig(ENV),storage,ownerId:OWNER,automationControls:controls,
    fetchImpl:async()=>{providerCalls++;throw Error('No network allowed');},
    novaTurn:async input=>{modelCalls++;await storage.appendMessage({id:input.assistantMessageId,ownerId:OWNER,conversationId:input.conversationId,role:'assistant',content:'Synthetic safe draft.'});return{id:input.assistantMessageId,message:'Synthetic safe draft.'};}});
  await service.receive(payload('Synthetic booking enquiry','wamid.synthetic-held-123'),`Bearer ${TOKEN}`);
  const worker=createPersistentLocalWorker({registry:{},branch:'codex/combined-nova-preview-d5b5-c5bd',client:{async request(path){
    if(path==='/api/admin/worker/auto-dispatch/next')return{dispatched:false,channelPolling:['sharp_cuts_whatsapp']};
    if(path==='/api/admin/worker/sharp-cuts/whatsapp/tick')return service.processNext({workerId:'synthetic-current-worker'});
    throw Error('Unexpected path '+path);
  }}});
  const before=await storage.getWhatsAppInbound('wamid.synthetic-held-123',OWNER);
  await worker.runOnce();assert.equal(modelCalls,0);assert.equal(providerCalls,0);
  assert.deepEqual(await storage.getWhatsAppInbound('wamid.synthetic-held-123',OWNER),before,'pause does not claim or mutate queued records');
  // Separate empty fixture, not replay of the held record.
  const fresh=await fixture();await fresh.service.receive(payload('Fresh synthetic enquiry','wamid.synthetic-fresh-123'),`Bearer ${TOKEN}`);
  const freshWorker=createPersistentLocalWorker({registry:{},branch:'codex/combined-nova-preview-d5b5-c5bd',client:{async request(path){
    if(path==='/api/admin/worker/auto-dispatch/next')return{dispatched:false,channelPolling:['sharp_cuts_whatsapp']};
    if(path==='/api/admin/worker/sharp-cuts/whatsapp/tick')return fresh.service.processNext({workerId:'fresh-synthetic-worker'});
    throw Error('Unexpected path');
  }}});
  await freshWorker.runOnce();assert.equal((await fresh.storage.getWhatsAppInbound('wamid.synthetic-fresh-123',OWNER)).status,'awaiting_owner_review');
  assert.equal((await storage.getWhatsAppInbound('wamid.synthetic-held-123',OWNER)).status,before.status);
  assert.equal(providerCalls,0);assert.equal(fresh.calls.length,1);
});

test('execution hold defaults closed and pausing during generation prevents outbound even in owner-test mode',async()=>{
  for(const mode of ['missing_controls','execution_held','pause_during_generation']){
    const storage=createInMemoryStorage();await storage.initialize({owner:{id:OWNER},projects:[{id:'sharp-cuts-web',name:'Sharp Cuts'}]});let allowed=true,generated=0,sends=0;
    const config=readConfig({...ENV,NOVA_SHARP_CUTS_WHATSAPP_MODE:'owner_test',NOVA_SHARP_CUTS_WHATSAPP_TEST_RECIPIENTS:'+447700900111',NOVA_SHARP_CUTS_WHATSAPP_OUTBOUND_ENABLED:'true',NOVA_SHARP_CUTS_WHATSAPP_EXECUTION_ENABLED:mode==='execution_held'?undefined:'true'});
    const service=createSharpCutsWhatsAppCoexistenceService({config,storage,ownerId:OWNER,automationControls:mode==='missing_controls'?null:{async allows(){return allowed;}},fetchImpl:async()=>{sends++;throw Error('No network allowed');},novaTurn:async input=>{generated++;allowed=false;return{id:input.assistantMessageId,message:'Synthetic reply'};}});
    await service.receive(payload(),`Bearer ${TOKEN}`);
    const result=await service.processNext();assert.equal(sends,0);assert.equal(result.sent,false);
    assert.equal(generated,mode==='pause_during_generation'?1:0);
    assert.equal((await service.status()).sendEnabled,false);
  }
  const config=readConfig({...ENV,NOVA_SHARP_CUTS_WHATSAPP_MODE:'owner_test',NOVA_SHARP_CUTS_WHATSAPP_TEST_RECIPIENTS:'+447700900111'});
  assert.equal(config.sharpCutsWhatsApp.sendEnabled,false,'owner_test alone is not permission to send');
});

const OWNER="owner-1",TOKEN="w".repeat(40),ENV={
  NOVA_SHARP_CUTS_WHATSAPP_PROVIDER:"gupshup_coexistence",
  NOVA_SHARP_CUTS_WHATSAPP_NUMBER:"+441582510565",
  NOVA_SHARP_CUTS_WHATSAPP_PROJECT_ID:"sharp-cuts-web",
  NOVA_SHARP_CUTS_WHATSAPP_PUBLIC_BASE_URL:"https://preview.example",
  NOVA_SHARP_CUTS_WHATSAPP_PHONE_NUMBER_ID:"123456789012345",
  NOVA_SHARP_CUTS_WHATSAPP_APP_ID:"4005ef9e-581e-41f4-9b04-e0797e0463d2",
  NOVA_SHARP_CUTS_WHATSAPP_APP_NAME:"SharpCutsNova",
  NOVA_SHARP_CUTS_WHATSAPP_API_KEY:"api-"+"a".repeat(32),
  NOVA_SHARP_CUTS_WHATSAPP_WEBHOOK_TOKEN:TOKEN,
  NOVA_SHARP_CUTS_WHATSAPP_IDENTITY_KEY:Buffer.alloc(32,8).toString("base64"),
  NOVA_SHARP_CUTS_WHATSAPP_EXECUTION_ENABLED:"true",
  NOVA_SHARP_CUTS_WHATSAPP_MODE:"draft_only",
};
const payload=(body="Can I book a haircut?",id="wamid.test-123456789")=>({gs_app_id:ENV.NOVA_SHARP_CUTS_WHATSAPP_APP_ID,object:"whatsapp_business_account",entry:[{id:"waba",changes:[{field:"messages",value:{messaging_product:"whatsapp",metadata:{display_phone_number:"441582510565",phone_number_id:ENV.NOVA_SHARP_CUTS_WHATSAPP_PHONE_NUMBER_ID},contacts:[{wa_id:"447700900111"}],messages:[{from:"447700900111",id,timestamp:"1793450000",type:"text",text:{body}}]}}]}]});

async function fixture(){
  const storage=createInMemoryStorage();await storage.initialize({owner:{id:OWNER,fullName:"Owner",preferences:{},facts:{}},projects:[{id:"sharp-cuts-web",name:"Sharp Cuts",description:""}],memories:[]});
  const calls=[],service=createSharpCutsWhatsAppCoexistenceService({automationControls:{async allows(){return true;}},config:readConfig(ENV),storage,ownerId:OWNER,async novaTurn(input){calls.push(input);await storage.appendMessage({id:input.assistantMessageId,conversationId:input.conversationId,ownerId:OWNER,role:"assistant",content:"You can book through the verified Sharp Cuts Fresha page."});return{id:input.assistantMessageId,runId:"run-wa",message:"You can book through the verified Sharp Cuts Fresha page."};},logger:{error(){}}});
  return{storage,service,calls};
}

test("Sharp Cuts Coexistence config is disabled by default and all-or-none",()=>{
  const disabled=readConfig({}).sharpCutsWhatsApp;assert.equal(disabled.configured,false);assert.equal(disabled.number,"+441582510565");assert.equal(disabled.sendEnabled,false);
  assert.throws(()=>readConfig({NOVA_SHARP_CUTS_WHATSAPP_PROVIDER:"gupshup_coexistence"}),/all eight/i);
  const configured=readConfig(ENV).sharpCutsWhatsApp;assert.equal(configured.configured,true);assert.equal(configured.mode,"draft_only");assert.equal(configured.sendEnabled,false);
  assert.throws(()=>readConfig({...ENV,NOVA_SHARP_CUTS_WHATSAPP_NUMBER:"+447700900999"}),/verified Sharp Cuts number/);
});

test("authenticated inbound messages produce project-scoped owner-review drafts without sending",async()=>{
  const{storage,service,calls}=await fixture();
  await assert.rejects(()=>service.receive(payload(),"Bearer wrong"),error=>error.code==="sharp_cuts_whatsapp_webhook_unauthorized");
  const accepted=await service.receive(payload(),`Bearer ${TOKEN}`);assert.equal(accepted.queued,1);
  const processed=await service.processNext({workerId:"worker-test"});assert.equal(processed.status,"awaiting_owner_review");assert.equal(processed.sent,false);assert.match(processed.conversationId,/^whatsapp_sharp-cuts-web_/);
  assert.equal(calls.length,1);assert.equal(calls[0].context.projectId,"sharp-cuts-web");assert.equal(calls[0].context.externalActionsAllowed,false);assert.equal(calls[0].context.verifiedBusinessProfile.bookingSystem,"Fresha");
  const inbound=await storage.getWhatsAppInbound("wamid.test-123456789",OWNER);assert.equal(inbound.status,"awaiting_owner_review");assert.doesNotMatch(JSON.stringify(await storage.listActivity(OWNER,{projectId:"sharp-cuts-web",limit:20})),/447700900111/);
});

test("authenticated Gupshup URL-validation probe is accepted without weakening event identity checks",async()=>{
  const{service}=await fixture(),probe={gs_app_id:ENV.NOVA_SHARP_CUTS_WHATSAPP_APP_ID,entry:[{changes:[{field:"messages",value:{messaging_product:"whatsapp",metadata:{phone_number_id:"provider-validation"}}}]}]};
  assert.deepEqual(await service.receive(probe,{sourceIp:"34.202.224.208"}),{accepted:true,queued:0,duplicates:0,ignored:0,echoes:0,verification:true,acknowledgedOnly:true});
  await assert.rejects(()=>service.receive(probe,{sourceIp:"203.0.113.10"}),error=>error.code==="sharp_cuts_whatsapp_webhook_unauthorized");
  const platformProbe={entry:[{changes:[{field:"platform-event",value:{type:"connectivity-check"}}]}]};
  assert.equal((await service.receive(platformProbe,{sourceIp:"34.202.224.208"})).acknowledgedOnly,true);
  const mockMessage={gs_app_id:ENV.NOVA_SHARP_CUTS_WHATSAPP_APP_ID,entry:[{changes:[{field:"messages",value:{messaging_product:"whatsapp",metadata:{phone_number_id:"provider-validation"},messages:[{id:"wamid.provider-validation",from:"447700900111",type:"text",text:{body:"probe"}}]}}]}]};
  const ignored=await service.receive(mockMessage,{sourceIp:"34.202.224.208"});assert.equal(ignored.queued,0);assert.equal(ignored.ignored,1);assert.equal(ignored.acknowledgedOnly,true);
  await assert.rejects(()=>service.receive(mockMessage,`Bearer ${TOKEN}`),error=>error.code==="sharp_cuts_whatsapp_target_mismatch");
});

test("Sharp Cuts worker cannot claim another WhatsApp project's queued message",async()=>{
  const{storage,service}=await fixture();
  await storage.claimWhatsAppInbound({messageSid:"SM"+"1".repeat(32),ownerId:OWNER,conversationId:"whatsapp_other_project",contactId:"other",contactCiphertext:"opaque",bodyHash:"b".repeat(64)});
  assert.deepEqual(await service.processNext({workerId:"worker-test"}),{worked:false});
});

test("STOP is captured without AI generation or outbound send",async()=>{
  const{storage,service,calls}=await fixture();await service.receive(payload("STOP","wamid.stop-123456789"),`Bearer ${TOKEN}`);
  const processed=await service.processNext({workerId:"worker-test"});assert.equal(processed.status,"opt_out_received");assert.equal(calls.length,0);assert.equal((await storage.getWhatsAppInbound("wamid.stop-123456789",OWNER)).status,"opt_out_received");
});

test("Business App echo is monitored without exposing message contents",async()=>{
  const{storage,service}=await fixture(),echoPayload={gs_app_id:ENV.NOVA_SHARP_CUTS_WHATSAPP_APP_ID,entry:[{changes:[{field:"smb_message_echoes",value:{messaging_product:"whatsapp",metadata:{phone_number_id:ENV.NOVA_SHARP_CUTS_WHATSAPP_PHONE_NUMBER_ID},message_echoes:[{id:"wamid.echo-123456789",from:"441582510565",to:"447700900111",type:"text",text:{body:"private staff reply"}}]}}]}]};
  const result=await service.receive(echoPayload,`Bearer ${TOKEN}`);assert.equal(result.echoes,1);const activity=await storage.listActivity(OWNER,{projectId:"sharp-cuts-web",limit:20});assert.doesNotMatch(JSON.stringify(activity),/private staff reply|447700900111/);
});

test("owner test sends only to the exact allowlisted number and records the provider result",async()=>{
  const sent=[];const storage=createInMemoryStorage();await storage.initialize({owner:{id:OWNER,fullName:"Owner",preferences:{},facts:{}},projects:[{id:"sharp-cuts-web",name:"Sharp Cuts",description:""}],memories:[]});
  const config=readConfig({...ENV,NOVA_SHARP_CUTS_WHATSAPP_OUTBOUND_ENABLED:"true",NOVA_SHARP_CUTS_WHATSAPP_MODE:"owner_test",NOVA_SHARP_CUTS_WHATSAPP_TEST_RECIPIENTS:"+447700900111"});
  const service=createSharpCutsWhatsAppCoexistenceService({automationControls:{async allows(){return true;}},config,storage,ownerId:OWNER,fetchImpl:async(url,options)=>{sent.push({url,options});return{ok:true,status:200,async json(){return{status:"submitted",messageId:"gs-test-message-123"};}};},async novaTurn(input){await storage.appendMessage({id:input.assistantMessageId,conversationId:input.conversationId,ownerId:OWNER,role:"assistant",content:"Book securely through the Sharp Cuts Fresha page."});return{id:input.assistantMessageId,runId:"run-owner-test",message:"Book securely through the Sharp Cuts Fresha page."};},logger:{error(){}}});
  await service.receive(payload(),{sourceIp:"34.202.224.208"});const result=await service.processNext({workerId:"worker-owner-test"});assert.equal(result.status,"replied");assert.equal(result.sent,true);assert.equal(sent.length,1);assert.equal(sent[0].url,"https://api.gupshup.io/wa/api/v1/msg");assert.equal(sent[0].options.headers.apikey,ENV.NOVA_SHARP_CUTS_WHATSAPP_API_KEY);assert.doesNotMatch(JSON.stringify(await storage.listActivity(OWNER,{projectId:"sharp-cuts-web",limit:20})),/447700900111/);
});

test("persistent worker polls the isolated Sharp Cuts WhatsApp queue",async()=>{
  const paths=[],worker=createPersistentLocalWorker({registry:{},branch:"codex/combined-nova-preview-d5b5-c5bd",client:Object.freeze({async request(path){paths.push(path);if(path==="/api/admin/worker/auto-dispatch/next")return{dispatched:false,channelPolling:["sharp_cuts_whatsapp"]};if(path==="/api/admin/worker/sharp-cuts/whatsapp/tick")return{worked:true,status:"awaiting_owner_review"};throw new Error("unexpected");}})}),result=await worker.runOnce();
  assert.equal(result.stepType,"sharp_cuts_whatsapp_inbound");assert.deepEqual(paths,["/api/admin/worker/auto-dispatch/next","/api/admin/worker/sharp-cuts/whatsapp/tick"]);
});


test('held reply review reuses Brain drafting without claiming, decrypting, sending or altering backlog',async()=>{
 const {storage,service,calls}=await fixture();const sid='wamid.review-held-test';
 await service.receive(payload('Where can I book?',sid),'Bearer '+TOKEN);
 const before=await storage.getWhatsAppInbound(sid,OWNER),inbox=await service.reviewHeld();
 assert.equal(inbox.records.length,1);assert.doesNotMatch(JSON.stringify(inbox),/447700900111|contactCiphertext/);
 const first=await service.prepareHeldDraft({recordRef:inbox.records[0].recordRef});assert.equal(first.sent,false);assert.equal(first.queueUnchanged,true);assert.equal(calls.length,1);
 assert.equal(calls[0].context.channel,'whatsapp');assert.equal(calls[0].context.externalActionsAllowed,false);assert.equal(calls[0].context.projectId,'sharp-cuts-web');
 assert.deepEqual(await storage.getWhatsAppInbound(sid,OWNER),before);
 const repeat=await service.prepareHeldDraft({recordRef:inbox.records[0].recordRef});assert.equal(repeat.duplicate,true);assert.equal(calls.length,1);
 await assert.rejects(service.prepareHeldDraft({recordRef:'0'.repeat(64)}));
});


test('deployed processing check exercises a fresh queue record and preserves every held record',async()=>{
 const f=await fixture();await f.service.receive(payload('Held original','wamid.historical-held-123'), 'Bearer '+TOKEN);
 const before=await f.service.reviewHeld();const result=await f.service.processingCheck();
 assert.equal(result.status,'awaiting_owner_review');assert.equal(result.attemptCount,1);assert.equal(result.sent,false);assert.equal(result.providerCalls,0);assert.equal(result.backlogUnchanged,true);assert.equal(result.liveWebhookTest,false);assert.equal(result.windowsDispatchTest,false);assert.ok(result.draft);
 assert.deepEqual(await f.service.reviewHeld(),before);
});
