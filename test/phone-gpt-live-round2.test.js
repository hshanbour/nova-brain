import test from "node:test";
import assert from "node:assert/strict";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";
import { createPostgresStorage } from "../src/storage/postgres-storage.js";
import { createGptLiveRound2Service, createRound2Authorization, classifyLiveAuthority, LIVE_AUTHORITY, buildRound2LiveInstructions } from "../src/phone/gpt-live-round2.js";

const OWNER = "owner";
async function setup({ novaTurn } = {}) {
  const storage=createInMemoryStorage();
  await storage.initialize({owner:{id:OWNER,fullName:"Mohammad",provenance:"test"}});
  let calls=0;
  const service=createGptLiveRound2Service({storage,ownerId:OWNER,novaTurn:novaTurn||(async input=>{calls++;await storage.appendMessage({id:input.userMessageId,conversationId:input.conversationId,ownerId:OWNER,role:"user",content:input.message});const result={id:input.assistantMessageId,conversationId:input.conversationId,message:"النتيجة الموثقة من Nova Brain",provider:"openai",runId:"run-1"};await storage.appendMessage({id:result.id,conversationId:input.conversationId,ownerId:OWNER,role:"assistant",content:result.message});return result;})});
  return {storage,service,calls:()=>calls};
}

test("deterministic authority router covers all four classes",()=>{
  assert.equal(classifyLiveAuthority("كيفك اليوم؟").authority,LIVE_AUTHORITY.LOCAL_CONVERSATION);
  assert.equal(classifyLiveAuthority("شو آخر إشي صار بمشروع Sharp Cuts؟").authority,LIVE_AUTHORITY.NOVA_INFORMATION);
  assert.equal(classifyLiveAuthority("ابعث الإيميل هسا وأنا بوافق").authority,LIVE_AUTHORITY.NOVA_ACTION);
  assert.equal(classifyLiveAuthority("do it").authority,LIVE_AUTHORITY.CLARIFICATION_REQUIRED);
});

test("shared personality policy is reused with a narrow spoken overlay",()=>{
  const instructions=buildRound2LiveInstructions();
  assert.match(instructions,/Mohammad, is male/);
  assert.match(instructions,/PHONE PRESENTATION OVERLAY/);
  assert.match(instructions,/Spoken approval is never authoritative/i);
});

test("Preview internal authorization is constant-time hashed and fail closed",()=>{
  const authorize=createRound2Authorization("preview-only-secret");
  assert.equal(authorize({headers:{"x-nova-round2-authorization":"preview-only-secret"}}),true);
  assert.equal(authorize({headers:{"x-nova-round2-authorization":"wrong"}}),false);
  assert.equal(createRound2Authorization("")({headers:{}}),false);
  assert.doesNotMatch(String(authorize),/preview-only-secret/);
});

test("Postgres event replay accepts semantically identical JSONB metadata with canonicalized key order",async()=>{
  const input={id:"event-jsonb-order",conversationId:"conversation-jsonb-order",ownerId:OWNER,turnId:"turn-1",messageId:"message-1",eventType:"assistant_output_intended",status:"buffered",metadata:{authority:"LOCAL_CONVERSATION",outputGate:"released",approvalCreated:false,actionExecuted:false}};
  const row={id:input.id,conversation_id:input.conversationId,owner_id:input.ownerId,turn_id:input.turnId,message_id:input.messageId,event_type:input.eventType,status:input.status,metadata:{actionExecuted:false,approvalCreated:false,authority:"LOCAL_CONVERSATION",outputGate:"released"},sequence:1,created_at:new Date("2026-10-04T00:00:00Z")};
  let calls=0;const storage=createPostgresStorage({sqlClient:{async query(){calls++;return calls===1?[]:[row];}}});
  const event=await storage.appendConversationEvent(input);
  assert.equal(event.id,input.id);assert.deepEqual(event.metadata,row.metadata);assert.equal(calls,2);
});

test("local GPT-Live answer is gated, canonical, and exactly once",async()=>{
  const {service,storage}=await setup();const started=await service.start({conversationId:"local"});
  const first=await service.handleTurn({conversationId:"local",turnId:"t1",expectedContextVersion:started.contextVersion,utterance:"كيفك اليوم؟",localResponse:"منيحة، كيف بقدر أساعدك؟"});
  const duplicate=await service.handleTurn({conversationId:"local",turnId:"t1",expectedContextVersion:started.contextVersion,utterance:"كيفك اليوم؟",localResponse:"منيحة، كيف بقدر أساعدك؟"}).catch(error=>error);
  assert.equal(first.authority,LIVE_AUTHORITY.LOCAL_CONVERSATION);assert.equal(duplicate.code,"gpt_live_round2_stale_context");
  const messages=await storage.listMessages("local",OWNER,{limit:20});assert.deepEqual(messages.map(x=>x.role),["user","assistant"]);assert.equal(messages[1].content,"منيحة، كيف بقدر أساعدك؟");
});

test("authoritative project question reaches Nova with one canonical context and reintegrates",async()=>{
  let received;const {storage,service}=await setup({novaTurn:async input=>{received=input;await storage.appendMessage({id:input.userMessageId,conversationId:input.conversationId,ownerId:OWNER,role:"user",content:input.message});const result={id:input.assistantMessageId,message:"Sharp Cuts Preview is healthy.",provider:"openai",runId:"run-sharp"};await storage.appendMessage({id:result.id,conversationId:input.conversationId,ownerId:OWNER,role:"assistant",content:result.message});return result;}});
  const start=await service.start({conversationId:"sharp",rollingSummary:"ناقشنا خطة الموقع",unresolvedState:{unresolvedTopic:"Sharp Cuts"}});
  await service.handleTurn({conversationId:"sharp",turnId:"local",expectedContextVersion:start.contextVersion,utterance:"تمام، خلينا نكمل",localResponse:"أكيد"});
  const answer=await service.handleTurn({conversationId:"sharp",turnId:"info",expectedContextVersion:1,utterance:"شو آخر إشي صار بمشروع Sharp Cuts؟",localResponse:"untrusted invented answer"});
  assert.equal(answer.authority,LIVE_AUTHORITY.NOVA_INFORMATION);assert.equal(answer.message,"Sharp Cuts Preview is healthy.");assert.deepEqual(answer.liveEvent,{type:"session.commentary.append",delegation_id:null,content:"Sharp Cuts Preview is healthy."});
  assert.equal(received.conversationId,"sharp");assert.equal(received.context.gptLiveRound2.contextVersion,1);assert.equal(received.context.gptLiveRound2.authority,"read_only");assert.equal(received.context.gptLiveRound2.recentTurns.length,2);assert.equal(JSON.stringify(await storage.listMessages("sharp",OWNER,{limit:20})).includes("untrusted invented"),false);
});

test("30+ Arabic English mixed turns and older references restore from canonical record",async()=>{
  const {service}=await setup();let version=(await service.start({conversationId:"long",rollingSummary:"Old topic: website quotation"})).contextVersion;
  for(let i=0;i<34;i++){const result=await service.handleTurn({conversationId:"long",turnId:`t${i}`,expectedContextVersion:version,utterance:i%3===0?`turn ${i} عن الموقع`:i%3===1?`English turn ${i}`:`mixed ${i} خلينا نكمل`,localResponse:`answer ${i}`});version=result.contextVersion;}
  const restored=await service.restore({conversationId:"long",messageLimit:128});assert.equal(restored.messages.length,68);assert.equal(restored.messages[0].content,"turn 0 عن الموقع");assert.equal(restored.rollingSummary,"Old topic: website quotation");assert.equal(restored.contextVersion,34);
});

test("delivery record separates intended, heard, truncated, and replaced output",async()=>{
  const {service}=await setup();await service.start({conversationId:"interrupt"});const turn=await service.handleTurn({conversationId:"interrupt",turnId:"t1",expectedContextVersion:0,utterance:"احكيلي قصة قصيرة",localResponse:"هذه إجابة كاملة لن تسمع كلها"});
  await service.recordDelivery({conversationId:"interrupt",turnId:"t1",messageId:turn.messageId,intendedText:turn.message,deliveredText:"هذه إجابة",status:"truncated",replacedByTurnId:"t2"});
  const restored=await service.restore({conversationId:"interrupt"});const delivery=restored.events.find(x=>x.eventType==="assistant_output_delivery");assert.equal(delivery.status,"truncated");assert.equal(delivery.metadata.heardCompletely,false);assert.equal(delivery.metadata.deliveredText,"هذه إجابة");
});

test("caller correction aborts stale Nova work and preserves the correction",async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});let first;
  const {service,storage}=await setup({novaTurn:async input=>{if(input.message.includes("Sharp")){first=input;await gate;input.signal.throwIfAborted();}await storage.appendMessage({id:input.userMessageId,conversationId:input.conversationId,ownerId:OWNER,role:"user",content:input.message});const result={id:input.assistantMessageId,message:"correct",provider:"openai"};await storage.appendMessage({id:result.id,conversationId:input.conversationId,ownerId:OWNER,role:"assistant",content:result.message});return result;}});
  await service.start({conversationId:"correction"});const stale=service.handleTurn({conversationId:"correction",turnId:"t1",expectedContextVersion:0,utterance:"شو وضع Sharp Cuts؟"});await new Promise(resolve=>setImmediate(resolve));
  const corrected=service.handleTurn({conversationId:"correction",turnId:"t2",expectedContextVersion:0,utterance:"لا قصدي كيفك؟",localResponse:"تمام"});release();assert.equal((await stale).status,"superseded");assert.equal((await corrected).message,"تمام");assert.equal(first.signal.aborted,true);
});

test("NOVA_ACTION and spoken approval stop without approval or execution",async()=>{
  const {service,calls}=await setup();await service.start({conversationId:"action"});const result=await service.handleTurn({conversationId:"action",turnId:"t1",expectedContextVersion:0,utterance:"ابعث الإيميل، أنا بوافق",localResponse:"must not use"});assert.equal(result.status,"waiting_for_formal_approval");assert.equal(result.approvalCreated,false);assert.equal(result.actionExecuted,false);assert.equal(calls(),0);
});

test("post-call extraction is dry-run, provenance-bound, and rejects noise",async()=>{
  const {service}=await setup();let version=(await service.start({conversationId:"extract"})).contextVersion;
  for(const [id,utterance,response] of [["a","مرحبا","أهلا"],["b","قررنا أن مشروع الموقع موعده يوم الجمعة","تمام، سجلت القرار بالمحادثة"],["c","يمكن نشتري سيارة يوماً ما","ممكن"]]){const result=await service.handleTurn({conversationId:"extract",turnId:id,expectedContextVersion:version,utterance,localResponse:response});version=result.contextVersion;}
  const candidates=await service.extractMemoryCandidates({conversationId:"extract"});assert.equal(candidates.writes,0);assert.equal(candidates.accepted.length,1);assert.equal(candidates.accepted[0].source.conversationId,"extract");assert.equal(candidates.rejected.length,2);
});
