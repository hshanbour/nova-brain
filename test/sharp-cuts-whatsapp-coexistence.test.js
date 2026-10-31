import test from "node:test";
import assert from "node:assert/strict";
import {readConfig} from "../src/config/env.js";
import {createInMemoryStorage} from "../src/storage/in-memory-storage.js";
import {createSharpCutsWhatsAppCoexistenceService} from "../src/whatsapp/sharp-cuts-coexistence.js";
import {createPersistentLocalWorker} from "../src/autonomy/persistent-local-worker.js";

const OWNER="owner-1",TOKEN="w".repeat(40),ENV={
  NOVA_SHARP_CUTS_WHATSAPP_PROVIDER:"360dialog_coexistence",
  NOVA_SHARP_CUTS_WHATSAPP_NUMBER:"+441582510565",
  NOVA_SHARP_CUTS_WHATSAPP_PROJECT_ID:"sharp-cuts-web",
  NOVA_SHARP_CUTS_WHATSAPP_PUBLIC_BASE_URL:"https://preview.example",
  NOVA_SHARP_CUTS_WHATSAPP_PHONE_NUMBER_ID:"123456789012345",
  NOVA_SHARP_CUTS_WHATSAPP_API_KEY:"api-"+"a".repeat(32),
  NOVA_SHARP_CUTS_WHATSAPP_WEBHOOK_TOKEN:TOKEN,
  NOVA_SHARP_CUTS_WHATSAPP_IDENTITY_KEY:Buffer.alloc(32,8).toString("base64"),
  NOVA_SHARP_CUTS_WHATSAPP_MODE:"draft_only",
};
const payload=(body="Can I book a haircut?",id="wamid.test-123456789")=>({object:"whatsapp_business_account",entry:[{id:"waba",changes:[{field:"messages",value:{messaging_product:"whatsapp",metadata:{display_phone_number:"441582510565",phone_number_id:ENV.NOVA_SHARP_CUTS_WHATSAPP_PHONE_NUMBER_ID},contacts:[{wa_id:"447700900111"}],messages:[{from:"447700900111",id,timestamp:"1793450000",type:"text",text:{body}}]}}]}]});

async function fixture(){
  const storage=createInMemoryStorage();await storage.initialize({owner:{id:OWNER,fullName:"Owner",preferences:{},facts:{}},projects:[{id:"sharp-cuts-web",name:"Sharp Cuts",description:""}],memories:[]});
  const calls=[],service=createSharpCutsWhatsAppCoexistenceService({config:readConfig(ENV),storage,ownerId:OWNER,async novaTurn(input){calls.push(input);await storage.appendMessage({id:input.assistantMessageId,conversationId:input.conversationId,ownerId:OWNER,role:"assistant",content:"You can book through the verified Sharp Cuts Fresha page."});return{id:input.assistantMessageId,runId:"run-wa",message:"You can book through the verified Sharp Cuts Fresha page."};},logger:{error(){}}});
  return{storage,service,calls};
}

test("Sharp Cuts Coexistence config is disabled by default and all-or-none",()=>{
  const disabled=readConfig({}).sharpCutsWhatsApp;assert.equal(disabled.configured,false);assert.equal(disabled.number,"+441582510565");assert.equal(disabled.sendEnabled,false);
  assert.throws(()=>readConfig({NOVA_SHARP_CUTS_WHATSAPP_PROVIDER:"360dialog_coexistence"}),/all eight/i);
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
  const{storage,service}=await fixture(),echoPayload={entry:[{changes:[{field:"messages",value:{messaging_product:"whatsapp",metadata:{phone_number_id:ENV.NOVA_SHARP_CUTS_WHATSAPP_PHONE_NUMBER_ID},message_echoes:[{id:"wamid.echo-123456789",from:"441582510565",to:"447700900111",type:"text",text:{body:"private staff reply"}}]}}]}]};
  const result=await service.receive(echoPayload,`Bearer ${TOKEN}`);assert.equal(result.echoes,1);const activity=await storage.listActivity(OWNER,{projectId:"sharp-cuts-web",limit:20});assert.doesNotMatch(JSON.stringify(activity),/private staff reply|447700900111/);
});

test("persistent worker polls the isolated Sharp Cuts WhatsApp queue",async()=>{
  const paths=[],worker=createPersistentLocalWorker({registry:{},branch:"codex/combined-nova-preview-d5b5-c5bd",client:Object.freeze({async request(path){paths.push(path);if(path==="/api/admin/worker/auto-dispatch/next")return{dispatched:false,channelPolling:["sharp_cuts_whatsapp"]};if(path==="/api/admin/worker/sharp-cuts/whatsapp/tick")return{worked:true,status:"awaiting_owner_review"};throw new Error("unexpected");}})}),result=await worker.runOnce();
  assert.equal(result.stepType,"sharp_cuts_whatsapp_inbound");assert.deepEqual(paths,["/api/admin/worker/auto-dispatch/next","/api/admin/worker/sharp-cuts/whatsapp/tick"]);
});
