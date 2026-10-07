import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { WebSocket } from "ws";
import { readConfig } from "../src/config/env.js";
import { immutableCallEnvelope } from "../src/phone/call-envelope.js";
import { createPhoneSessionAuth } from "../src/phone/session-auth.js";
import { createPhoneService } from "../src/phone/phone-service.js";
import { registerPhoneTools } from "../src/phone/phone-tools.js";
import { assertTwilioWebSocketSignature, createTwilioSignatureForTest, verifyTwilioSignature } from "../src/phone/twilio-signature.js";
import { createActionPolicy, ApprovalRequiredError } from "../src/policy/action-policy.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";
import { INITIAL_MEMORIES, INITIAL_OWNER_PROFILE, INITIAL_PROJECTS, OWNER_ID } from "../src/identity/initial-context.js";
import { SCHEMA_STATEMENTS, SCHEMA_VERSION } from "../src/storage/schema.js";
import { createAgent } from "../src/agent/agent.js";
import { approvalViewModel } from "../assets/approval-presenter.js";
import { createRuntimePhoneSession } from "../phone-bridge/runtime-session.js";
import { createGptLivePstnSession } from "../phone-bridge/gpt-live-pstn-session.js";
import { bridgeConfig, createPhoneBridgeServer } from "../phone-bridge/server.js";
import { AUTHORIZED_NOVA_PREVIEW_BASE_URL, createNovaPhoneBridgeClient, protectionBypassHeadersFor } from "../phone-bridge/nova-client.js";
import { createOpenAiWebSocketTranscriber } from "../phone-bridge/openai-transcriber.js";
import { parseTwilioMediaMessage, TWILIO_MEDIA_FORMAT } from "../src/phone/twilio-media-protocol.js";

const NOW = new Date("2026-10-02T12:00:00.000Z");
const CALL_SID = `CA${"1".repeat(32)}`;
const STREAM_SID = `MZ${"2".repeat(32)}`;
const CONVERSATION = "phone-owner-conversation";
const START = { event: "start", streamSid: STREAM_SID, start: { callSid: CALL_SID, mediaFormat: TWILIO_MEDIA_FORMAT } };
const SILENCE = Buffer.alloc(160, 0xff).toString("base64");
const SPEECH = Buffer.alloc(160, 0x00).toString("base64");

class FakeOpenAiSocket extends EventEmitter {
  static OPEN = 1;
  static last;
  readyState = 1;
  constructor(url) { super(); this.url = url; FakeOpenAiSocket.last = this; }
  send() {}
  close() {}
}

test("OpenAI bridge surfaces only safe provider error categories", async () => {
  let surfaced;
  const client = createOpenAiWebSocketTranscriber({ WebSocketImpl: FakeOpenAiSocket, apiKey: "fixture", onError: (error) => { surfaced = error; } });
  client.start();
  const ready = client.ready();
  assert.equal(FakeOpenAiSocket.last.url, "wss://api.openai.com/v1/realtime?intent=transcription");
  // Exercise the real socket listener without exposing the provider body.
  FakeOpenAiSocket.last.emit("message", JSON.stringify({ type: "error", error: { type: "invalid_request_error", code: "invalid_value", param: "session.audio.input.transcription.model", message: "sensitive provider detail" } }));
  await assert.rejects(ready, /invalid_request_error:invalid_value/);
  assert.equal(surfaced?.message, "OpenAI streaming transcription provider error (invalid_request_error:invalid_value:session.audio.input.transcription.model).");
  assert.doesNotMatch(surfaced.message, /sensitive provider detail/);
});

function environment() {
  return { NOVA_BRAIN_MODEL_PROVIDER: "mock", TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`, TWILIO_AUTH_TOKEN: "fixture-auth", NOVA_PHONE_NUMBER: "+447700900123", NOVA_PHONE_BRIDGE_URL: "https://bridge.example", NOVA_PHONE_BRIDGE_WEBSOCKET_URL: "wss://bridge.example/media", NOVA_PHONE_PUBLIC_BASE_URL: "https://nova.example", NOVA_PHONE_SESSION_SIGNING_KEY: Buffer.alloc(32, 7).toString("base64") };
}

function envelope(overrides = {}) {
  return { destination: "+447700900456", expectedParty: "Example Business", callerDisclosure: "Hello, I am Nova, an AI assistant calling for Mohammad.", objective: "Ask whether the business accepts new website enquiries.", approvedContext: "Mohammad is evaluating a website project.", permittedQuestions: ["Do you accept new website enquiries?"], permittedDisclosures: ["Mohammad requested this exploratory call."], prohibitedDisclosures: ["Private account information"], prohibitedActions: ["No purchases, contracts, prices, or commitments"], languageStrategy: "Use English, Arabic, or mixed Arabic-English to match the other party.", maximumDurationMinutes: 10, maximumAttempts: 1, callingWindow: { timezone: "Europe/London", startAt: "2026-10-02T12:00:00.000Z", endAt: "2026-10-02T13:00:00.000Z" }, voicemailPolicy: "do_not_leave", recordingPolicy: "disabled", terminationBehavior: "Return to scope once, then end safely.", expiresAt: "2026-10-02T13:00:00.000Z", ...overrides };
}

async function fixture({ dial = async () => ({ callSid: CALL_SID, providerStatus: "queued" }), health = async () => new Response(JSON.stringify({ ready: true, acceptingCalls: true, providerCertificationReady: true }), { status: 200 }), prewarmSpeaker = null, novaTurn = async () => ({ message: "Thanks. I will stay within the approved objective.", runId: "run-phone-turn" }) } = {}) {
  const config = readConfig(environment()); const storage = createInMemoryStorage({ clock: () => NOW });
  await storage.initialize({ owner: INITIAL_OWNER_PROFILE, projects: INITIAL_PROJECTS, memories: INITIAL_MEMORIES });
  await storage.ensureConversation({ id: CONVERSATION, ownerId: OWNER_ID, title: "Phone" });
  let nonce=0,callNonce=0;const auth = createPhoneSessionAuth({ key: config.phone.sessionSigningKeyBytes, clock: () => NOW, randomBytesImpl: () => Buffer.alloc(18, ++nonce) });
  const service = createPhoneService({ config, storage, ownerId: OWNER_ID, dialProvider: { configured: true, dial }, sessionAuth: auth, novaTurn, prewarmSpeaker, fetchImpl: health, clock: () => NOW, idFactory: () => `11111111-1111-4111-8111-${String(++callNonce).padStart(12,"0")}` });
  const registry = createToolRegistry({ policy: createActionPolicy({ storage, ownerId: OWNER_ID, approvedBranch: "preview" }) }); registerPhoneTools(registry, { service });
  const run = await storage.createRun({ ownerId: OWNER_ID, conversationId: CONVERSATION, goal: "Prepare call", status: "running" });
  const prepared = await registry.execute("phone_call_prepare", envelope(), { conversationId: CONVERSATION, runId: run.id });
  return { config, storage, auth, service, registry, run, prepared };
}

test("schema seventeen preserves bounded durable phone authority, events, transcript turns, owner contact policy, callback eligibility, and PSTN calibration", async () => {
  assert.equal(SCHEMA_VERSION, 18);
  for (const table of ["nova_phone_call_intents", "nova_phone_call_events", "nova_phone_call_turns", "nova_owner_contact_policies", "nova_owner_callback_eligibilities", "nova_speaker_channel_calibrations"]) assert.ok(SCHEMA_STATEMENTS.some((statement) => statement.includes(`CREATE TABLE IF NOT EXISTS ${table}`)));
  const migration = await readFile(new URL("../migrations/005_phone_v1.sql", import.meta.url), "utf8");
  assert.match(migration, /ON CONFLICT \(version\) DO NOTHING/); assert.match(migration, /attempt_count integer NOT NULL DEFAULT 0/); assert.doesNotMatch(migration, /raw_audio|recording_url|audio_blob/i);
  const ownerExperienceMigration = await readFile(new URL("../migrations/007_phone_owner_experience.sql", import.meta.url), "utf8");
  assert.match(ownerExperienceMigration, /CREATE TABLE IF NOT EXISTS nova_owner_callback_eligibilities/);
  assert.match(ownerExperienceMigration, /PRIMARY KEY\(owner_id,task_id,terminal_state_version\)/);
  assert.doesNotMatch(ownerExperienceMigration, /\b(?:DROP|TRUNCATE)\b|\bDELETE\s+FROM\b/i);
});

test("immutable envelope hashing is deterministic and rejects non-UK, recording, redial, and excessive duration", () => {
  const first = immutableCallEnvelope(envelope(), { now: NOW }), second = immutableCallEnvelope({ ...envelope(), permittedQuestions: [...envelope().permittedQuestions] }, { now: NOW });
  assert.equal(first.envelopeHash, second.envelopeHash); assert.equal(first.maximumAttempts, 1); assert.equal(first.recordingPolicy, "disabled"); assert.equal(first.mediaProfile,"chained_v1"); assert.equal(first.liveVoice,null);
  const live=immutableCallEnvelope(envelope({mediaProfile:"gpt_live_round2_preview",liveVoice:"gleam"}),{now:NOW});assert.equal(live.mediaProfile,"gpt_live_round2_preview");assert.equal(live.liveVoice,"gleam");
  for (const input of [envelope({ destination: "+12025550123" }), envelope({ maximumAttempts: 2 }), envelope({ recordingPolicy: "enabled" }), envelope({ maximumDurationMinutes: 20 })]) assert.throws(() => immutableCallEnvelope(input, { now: NOW }), /Phone V1|recording|duration|attempt/i);
  for(const input of[envelope({mediaProfile:"gpt_live_round2_preview"}),envelope({mediaProfile:"gpt_live_round2_preview",liveVoice:"alloy"}),envelope({mediaProfile:"other",liveVoice:"gleam"})])assert.throws(()=>immutableCallEnvelope(input,{now:NOW}),/media profile|voice|liveVoice/i);
});

test("generic formal approval binds the exact envelope; typed approval is non-authoritative and deduplicated", async () => {
  const f = await fixture(); const context = { conversationId: CONVERSATION, runId: f.run.id };
  let pending;
  await assert.rejects(() => f.registry.execute("phone_call_start", f.prepared, context), (error) => { assert.ok(error instanceof ApprovalRequiredError); pending = error.approval; return true; });
  await assert.rejects(() => f.registry.execute("phone_call_start", f.prepared, { ...context, chatText: "I approve" }), (error) => error instanceof ApprovalRequiredError && error.approval.id === pending.id);
  assert.equal((await f.storage.listApprovals(OWNER_ID, { conversationId: CONVERSATION })).length, 1);
  const call = await f.storage.getPhoneCallIntent(f.prepared.callIntentId, OWNER_ID); assert.equal(call.status, "waiting_for_approval"); assert.equal(call.approvalId, pending.id);
  const view = approvalViewModel(pending); assert.equal(view.kind, "phone"); assert.ok(view.fields.some(([label, value]) => label === "Destination" && value === envelope().destination));
});

test("formal Approval visibly binds the exact Preview GPT-Live profile and gleam voice",async()=>{
  const f=await fixture(),context={conversationId:CONVERSATION,runId:f.run.id};
  const prepared=await f.registry.execute("phone_call_prepare",envelope({mediaProfile:"gpt_live_round2_preview",liveVoice:"gleam"}),context);let approval;
  await assert.rejects(()=>f.registry.execute("phone_call_start",prepared,context),error=>{approval=error.approval;return error instanceof ApprovalRequiredError;});
  const view=approvalViewModel(approval);assert.ok(view.fields.some(([label,value])=>label==="Conversation path"&&value==="gpt_live_round2_preview"));assert.ok(view.fields.some(([label,value])=>label==="GPT-Live voice"&&value==="gleam"));
  const call=await f.storage.getPhoneCallIntent(prepared.callIntentId,OWNER_ID);assert.equal(call.status,"waiting_for_approval");assert.equal(call.attemptCount,0);
});

test("approved execution claims exactly one dial and duplicate execution cannot redial", async () => {
  let dials = 0; const f = await fixture({ dial: async () => { dials += 1; return { callSid: CALL_SID, providerStatus: "queued" }; } }); const context = { conversationId: CONVERSATION, runId: f.run.id };
  let approval; await assert.rejects(() => f.registry.execute("phone_call_start", f.prepared, context), (error) => { approval = error.approval; return error instanceof ApprovalRequiredError; });
  await f.storage.decideApproval(approval.id, OWNER_ID, "approved");
  const first = await f.registry.execute("phone_call_start", f.prepared, { ...context, approvalId: approval.id }); const duplicate = await f.registry.execute("phone_call_start", f.prepared, { ...context, approvalId: approval.id });
  assert.equal(dials, 1); assert.equal(first.idempotent, false); assert.equal(duplicate.idempotent, true); assert.equal((await f.storage.getPhoneCallIntent(f.prepared.callIntentId, OWNER_ID)).attemptCount, 1);
});

test("speaker readiness runs before the final provider-certified bridge wake gate and dial", async () => {
  const order = [];
  const f = await fixture({
    prewarmSpeaker: async () => { order.push("speaker"); return { available: true }; },
    health: async () => { order.push("bridge"); return new Response(JSON.stringify({ ready: true, acceptingCalls: true, providerCertificationReady: true }), { status: 200 }); },
    dial: async () => { order.push("dial"); return { callSid: CALL_SID, providerStatus: "queued" }; },
  });
  const context = { conversationId: CONVERSATION, runId: f.run.id }; let approval;
  await assert.rejects(() => f.registry.execute("phone_call_start", f.prepared, context), (error) => { approval = error.approval; return true; });
  await f.storage.decideApproval(approval.id, OWNER_ID, "approved");
  await f.registry.execute("phone_call_start", f.prepared, { ...context, approvalId: approval.id });
  assert.deepEqual(order, ["speaker", "bridge", "dial"]);
});

test("concurrent duplicate execution atomically binds only the winning dial token",async()=>{
  let dials=0,dialToken;const f=await fixture({dial:async({sessionToken})=>{dials+=1;dialToken=sessionToken;return{callSid:CALL_SID,providerStatus:"queued"};}}),context={conversationId:CONVERSATION,runId:f.run.id};let approval;
  await assert.rejects(()=>f.registry.execute("phone_call_start",f.prepared,context),(error)=>{approval=error.approval;return true;});await f.storage.decideApproval(approval.id,OWNER_ID,"approved");
  const results=await Promise.all([f.registry.execute("phone_call_start",f.prepared,{...context,approvalId:approval.id}),f.registry.execute("phone_call_start",f.prepared,{...context,approvalId:approval.id})]);
  const call=await f.storage.getPhoneCallIntent(f.prepared.callIntentId,OWNER_ID);assert.equal(dials,1);assert.equal(results.filter(item=>item.idempotent===false).length,1);assert.equal(call.sessionTokenHash,f.auth.tokenHash(dialToken));
});

test("one active call per owner is enforced durably before a second provider dial",async()=>{
  let dials=0;const f=await fixture({dial:async()=>{dials+=1;return{callSid:CALL_SID,providerStatus:"queued"};}}),context={conversationId:CONVERSATION,runId:f.run.id};
  let firstApproval;await assert.rejects(()=>f.registry.execute("phone_call_start",f.prepared,context),(error)=>{firstApproval=error.approval;return true;});await f.storage.decideApproval(firstApproval.id,OWNER_ID,"approved");await f.registry.execute("phone_call_start",f.prepared,{...context,approvalId:firstApproval.id});
  const second=await f.registry.execute("phone_call_prepare",envelope({destination:"+447700900789",expectedParty:"Second Business"}),context);let secondApproval;
  await assert.rejects(()=>f.registry.execute("phone_call_start",second,context),(error)=>{secondApproval=error.approval;return true;});await f.storage.decideApproval(secondApproval.id,OWNER_ID,"approved");
  await assert.rejects(()=>f.registry.execute("phone_call_start",second,{...context,approvalId:secondApproval.id}),(error)=>error.code==="phone_call_already_active");
  assert.equal(dials,1);assert.equal((await f.storage.getPhoneCallIntent(second.callIntentId,OWNER_ID)).attemptCount,0);
  assert.ok(SCHEMA_STATEMENTS.some((statement)=>statement.includes("nova_phone_one_active_call_idx")&&statement.includes("UNIQUE INDEX")));
});

test("formal rejection updates the same call lifecycle and performs no dial", async () => {
  let dials=0;const f=await fixture({dial:async()=>{dials+=1;return{callSid:CALL_SID};}}),context={conversationId:CONVERSATION,runId:f.run.id};let approval;
  await assert.rejects(()=>f.registry.execute("phone_call_start",f.prepared,context),(error)=>{approval=error.approval;return true;});
  approval=await f.storage.decideApproval(approval.id,OWNER_ID,"rejected");await f.registry.handleApprovalDecision("phone_call_start",approval,"rejected");
  const call=await f.storage.getPhoneCallIntent(f.prepared.callIntentId,OWNER_ID);assert.equal(call.status,"failed");assert.equal(call.outcome,"owner_rejected");assert.equal(call.attemptCount,0);assert.equal(dials,0);
});

test("ambiguous provider timeout becomes uncertain and never redials", async () => {
  let dials = 0; const error = Object.assign(new Error("timeout"), { code: "phone_dial_uncertain", definitive: false }); const f = await fixture({ dial: async () => { dials += 1; throw error; } }); const context = { conversationId: CONVERSATION, runId: f.run.id };
  let approval; await assert.rejects(() => f.registry.execute("phone_call_start", f.prepared, context), (cause) => { approval = cause.approval; return true; }); await f.storage.decideApproval(approval.id, OWNER_ID, "approved");
  await assert.rejects(() => f.registry.execute("phone_call_start", f.prepared, { ...context, approvalId: approval.id }), /timeout/);
  await assert.rejects(() => f.registry.execute("phone_call_start", f.prepared, { ...context, approvalId: approval.id }), (cause) => cause.code === "phone_call_not_retryable");
  assert.equal(dials, 1); assert.equal((await f.storage.getPhoneCallIntent(f.prepared.callIntentId, OWNER_ID)).status, "uncertain");
});

test("owner and conversation isolation fail closed before approval or dial", async () => {
  const f = await fixture();
  await assert.rejects(() => f.registry.execute("phone_call_start", f.prepared, { conversationId: "other", runId: f.run.id }), (error) => error.code === "phone_conversation_mismatch");
  assert.equal(await f.storage.getPhoneCallIntent(f.prepared.callIntentId, "other-owner"), null);
});

test("single-use start token binds Call SID and Stream SID and rejects replay or mismatch", async () => {
  const f = await fixture(); const context = { conversationId: CONVERSATION, runId: f.run.id }; let approval;
  await assert.rejects(() => f.registry.execute("phone_call_start", f.prepared, context), (error) => { approval = error.approval; return true; }); await f.storage.decideApproval(approval.id, OWNER_ID, "approved"); await f.registry.execute("phone_call_start", f.prepared, { ...context, approvalId: approval.id });
  const call = await f.storage.getPhoneCallIntent(f.prepared.callIntentId, OWNER_ID); const startToken = f.auth.issueStart({ ownerId: OWNER_ID, callIntentId: call.id, envelopeHash: call.envelopeHash }, 300); await f.storage.savePhoneSessionToken(call.id, OWNER_ID, { tokenHash: f.auth.tokenHash(startToken), expiresAt: "2026-10-02T12:05:00.000Z" });
  await assert.rejects(() => f.service.startBridgeSession({ sessionToken: startToken, callSid: `CA${"3".repeat(32)}`, streamSid: STREAM_SID }), (error) => error.code === "phone_session_replay");
  const authorized = await f.service.startBridgeSession({ sessionToken: startToken, callSid: CALL_SID, streamSid: STREAM_SID }); assert.ok(authorized.bridgeSessionToken);
  await assert.rejects(() => f.service.startBridgeSession({ sessionToken: startToken, callSid: CALL_SID, streamSid: STREAM_SID }), (error) => error.code === "phone_session_replay");
});

test("bridge authorization returns only the immutable call-selected media profile, voice, and canonical conversation",async()=>{
  const f=await fixture(),context={conversationId:CONVERSATION,runId:f.run.id};const prepared=await f.registry.execute("phone_call_prepare",envelope({mediaProfile:"gpt_live_round2_preview",liveVoice:"gleam"}),context);let approval;
  await assert.rejects(()=>f.registry.execute("phone_call_start",prepared,context),error=>{approval=error.approval;return true;});await f.storage.decideApproval(approval.id,OWNER_ID,"approved");await f.registry.execute("phone_call_start",prepared,{...context,approvalId:approval.id});
  const call=await f.storage.getPhoneCallIntent(prepared.callIntentId,OWNER_ID),token=f.auth.issueStart({ownerId:OWNER_ID,callIntentId:call.id,envelopeHash:call.envelopeHash},300);await f.storage.savePhoneSessionToken(call.id,OWNER_ID,{tokenHash:f.auth.tokenHash(token),expiresAt:"2026-10-02T12:05:00.000Z"});
  const authorized=await f.service.startBridgeSession({sessionToken:token,callSid:CALL_SID,streamSid:STREAM_SID});assert.equal(authorized.mediaProfile,"gpt_live_round2_preview");assert.equal(authorized.liveVoice,"gleam");assert.equal(authorized.callConversationId,`phone-session-${call.id}`);
});

test("GPT-Live call summary and Console lookup use canonical conversation events instead of legacy turn rows",async()=>{
  const f=await fixture(),context={conversationId:CONVERSATION,runId:f.run.id};const prepared=await f.registry.execute("phone_call_prepare",envelope({mediaProfile:"gpt_live_round2_preview",liveVoice:"gleam"}),context);let approval;
  await assert.rejects(()=>f.registry.execute("phone_call_start",prepared,context),error=>{approval=error.approval;return true;});await f.storage.decideApproval(approval.id,OWNER_ID,"approved");await f.registry.execute("phone_call_start",prepared,{...context,approvalId:approval.id});
  const call=await f.storage.getPhoneCallIntent(prepared.callIntentId,OWNER_ID),token=f.auth.issueStart({ownerId:OWNER_ID,callIntentId:call.id,envelopeHash:call.envelopeHash},300);await f.storage.savePhoneSessionToken(call.id,OWNER_ID,{tokenHash:f.auth.tokenHash(token),expiresAt:"2026-10-02T12:05:00.000Z"});const authorized=await f.service.startBridgeSession({sessionToken:token,callSid:CALL_SID,streamSid:STREAM_SID});
  await f.storage.ensureConversation({id:call.callConversationId,ownerId:OWNER_ID,title:"Phone · GPT-Live"});
  for(const event of[
    {id:"canonical-caller",eventType:"authority_classified",status:"NOVA_INFORMATION",metadata:{}},
    {id:"canonical-ack",eventType:"assistant_output_delivery",status:"delivered",metadata:{outputKind:"acknowledgement",deliveredText:"Checking."}},
    {id:"canonical-partial",eventType:"assistant_output_delivery",status:"partially_delivered",metadata:{outputKind:"final",deliveredText:"Result"}},
    {id:"canonical-run",eventType:"nova_result_reintegrated",status:"generated",metadata:{runId:"run-live"}},
  ])await f.storage.appendConversationEvent({...event,conversationId:call.callConversationId,ownerId:OWNER_ID,turnId:"turn-1"});
  await f.service.recordBridgeEvent({bridgeSessionToken:authorized.bridgeSessionToken,callIntentId:call.id,callSid:CALL_SID,streamSid:STREAM_SID,eventId:"bridge-stop-canonical",type:"completed",providerStatus:"completed"});
  const updated=await f.storage.getPhoneCallIntent(call.id,OWNER_ID);assert.match(updated.summary,/1 caller turn/);assert.match(updated.summary,/1 acknowledgement/);assert.match(updated.summary,/1 partial\/interrupted/);assert.match(updated.summary,/1 Nova run/);
  const byCanonical=await f.service.listConversation(call.callConversationId);assert.equal(byCanonical[0].callConversationId,call.callConversationId);
});

test("bridge turn authentication is call-bound, idempotent, multilingual, and persists no audio", async () => {
  let turns = 0; const f = await fixture({ novaTurn: async ({ message, context }) => { turns += 1; assert.equal(context.phoneCall.profile, "bounded_outbound"); return { message: `سمعت: ${message}`, runId: "run-phone" }; } }); const context = { conversationId: CONVERSATION, runId: f.run.id }; let approval;
  await assert.rejects(() => f.registry.execute("phone_call_start", f.prepared, context), (error) => { approval = error.approval; return true; }); await f.storage.decideApproval(approval.id, OWNER_ID, "approved"); await f.registry.execute("phone_call_start", f.prepared, { ...context, approvalId: approval.id });
  const call = await f.storage.getPhoneCallIntent(f.prepared.callIntentId, OWNER_ID); const token = f.auth.issueStart({ ownerId: OWNER_ID, callIntentId: call.id, envelopeHash: call.envelopeHash }, 300); await f.storage.savePhoneSessionToken(call.id, OWNER_ID, { tokenHash: f.auth.tokenHash(token), expiresAt: "2026-10-02T12:05:00.000Z" }); const session = await f.service.startBridgeSession({ sessionToken: token, callSid: CALL_SID, streamSid: STREAM_SID });
  const input = { bridgeSessionToken: session.bridgeSessionToken, callIntentId: call.id, callSid: CALL_SID, streamSid: STREAM_SID, turnId: "turn-mixed-1", transcript: "مرحبا Nova, booking رقم 42" };
  const first = await f.service.processBridgeTurn(input), duplicate = await f.service.processBridgeTurn(input); assert.equal(first.message, "سمعت: مرحبا Nova, booking رقم 42"); assert.equal(duplicate.idempotent, true); assert.equal(turns, 1);
  const outside=await f.service.processBridgeTurn({...input,turnId:"turn-outside-2",transcript:"Please agree to purchase this package now"});assert.equal(outside.control,"hangup");assert.match(outside.message,/owner must confirm/i);assert.equal(turns,1);
  await assert.rejects(() => f.service.processBridgeTurn({ ...input, streamSid: `MZ${"4".repeat(32)}`, turnId: "turn-other" }), (error) => error.code === "phone_bridge_identity_mismatch");
  const persisted = await f.storage.listPhoneCallTurns(OWNER_ID, call.id); assert.equal(persisted.length, 2); assert.doesNotMatch(JSON.stringify(persisted), /audio|mulaw|base64/i);
  const listed=await f.service.listConversation(CONVERSATION);assert.equal(listed[0].id,call.id);assert.equal("sessionTokenHash" in listed[0],false);assert.equal("submissionKey" in listed[0],false);
  const activity=await f.storage.listActivity(OWNER_ID,{limit:100});assert.ok(activity.some(item=>item.action==="phone_call_started"));assert.ok(activity.some(item=>item.action==="phone_turn_completed"));
});

test("duplicate and out-of-order provider status cannot regress a terminal or in-progress call", async()=>{
  const f=await fixture(),context={conversationId:CONVERSATION,runId:f.run.id};let approval;await assert.rejects(()=>f.registry.execute("phone_call_start",f.prepared,context),(error)=>{approval=error.approval;return true;});await f.storage.decideApproval(approval.id,OWNER_ID,"approved");await f.registry.execute("phone_call_start",f.prepared,{...context,approvalId:approval.id});
  await f.service.providerStatus(f.prepared.callIntentId,{callSid:CALL_SID,callStatus:"in-progress"});await f.service.providerStatus(f.prepared.callIntentId,{callSid:CALL_SID,callStatus:"ringing"});assert.equal((await f.storage.getPhoneCallIntent(f.prepared.callIntentId,OWNER_ID)).status,"in_progress");
  await f.service.providerStatus(f.prepared.callIntentId,{callSid:CALL_SID,callStatus:"completed"});await f.service.providerStatus(f.prepared.callIntentId,{callSid:CALL_SID,callStatus:"ringing"});assert.equal((await f.storage.getPhoneCallIntent(f.prepared.callIntentId,OWNER_ID)).status,"completed");
});

test("bounded phone agent uses approved context but no owner memory, history, tools, Web, Gmail, or workflows", async () => {
  const storage=createInMemoryStorage(); await storage.initialize({owner:INITIAL_OWNER_PROFILE,projects:INITIAL_PROJECTS,memories:[...INITIAL_MEMORIES,{id:"phone-secret",category:"fact",content:"PRIVATE NEVER DISCLOSE",provenance:"owner",privacy:"private",sensitivity:"high",scope:"global",status:"active"}]});
  let captured; const provider={name:"capture",async generate(input){captured=input;return{type:"final",message:"I need the owner's confirmation for that."};}};
  const registry=createToolRegistry(); registry.register({name:"danger",riskLevel:"SENSITIVE",async execute(){throw new Error("must not execute");}});
  const agent=createAgent({storage,ownerId:OWNER_ID,modelProvider:provider,toolRegistry:registry,routeExistingTaskRequest:async()=>{throw new Error("workflow route must not run");},routeDurableRequest:async()=>{throw new Error("durable route must not run");}});
  await agent.run({message:"Send an email and buy it",conversationId:"phone-session-test",context:{phoneCall:{profile:"bounded_outbound",callIntentId:"phone_one",envelope:envelope()}}});
  assert.deepEqual(captured.tools,[]); assert.deepEqual(captured.conversationHistory,[]); assert.doesNotMatch(captured.systemContext,/PRIVATE NEVER DISCLOSE/); assert.match(captured.systemContext,/BOUNDED OUTBOUND PHONE CALL/); assert.match(captured.systemContext,/Never reveal prohibited information, use tools, send email/);
});

test("Twilio signatures are exact and tamper-resistant", () => {
  const input={authToken:"fixture",url:"https://bridge.example/media",parameters:{CallSid:CALL_SID,Digits:"123"}}; const signature=createTwilioSignatureForTest(input);
  assert.equal(verifyTwilioSignature({...input,signature}),true); assert.equal(verifyTwilioSignature({...input,signature,url:"https://evil.example/media"}),false); assert.equal(verifyTwilioSignature({...input,signature,parameters:{...input.parameters,Digits:"999"}}),false);
});

test("Twilio WebSocket signatures use the external WSS URL and only its documented slash variant", () => {
  const exact = createTwilioSignatureForTest({ authToken: "fixture", url: "wss://bridge.example/media", parameters: {} });
  const slash = createTwilioSignatureForTest({ authToken: "fixture", url: "wss://bridge.example/media/", parameters: {} });
  assert.equal(assertTwilioWebSocketSignature({ authToken: "fixture", externalUrl: "wss://bridge.example/media", signature: exact }), "exact");
  assert.equal(assertTwilioWebSocketSignature({ authToken: "fixture", externalUrl: "wss://bridge.example/media", signature: slash }), "documented_trailing_slash_variant");
  assert.throws(() => assertTwilioWebSocketSignature({ authToken: "fixture", externalUrl: "wss://bridge.example/media", signature: createTwilioSignatureForTest({ authToken: "fixture", url: "https://bridge.example/media", parameters: {} }) }), /invalid/i);
  assert.throws(() => assertTwilioWebSocketSignature({ authToken: "fixture", externalUrl: "https://bridge.example/media", signature: exact }), /WSS URL/);
});

test("Twilio connected and start identities reject malformed protocol and mismatched stream metadata", () => {
  assert.throws(() => parseTwilioMediaMessage({ event: "connected", protocol: "Unknown", version: "1.0.0" }), /protocol/i);
  assert.throws(() => parseTwilioMediaMessage({ ...START, start: { ...START.start, streamSid: `MZ${"9".repeat(32)}` } }), /does not match/i);
  assert.throws(() => parseTwilioMediaMessage({ event: "unsupported" }), /unsupported/i);
});

test("runtime VAD preserves one multilingual turn, barge-in clear, bounded hangup, and ephemeral audio", async () => {
  const sent=[]; const commits=[]; const events=[]; let timerCallback;
  const transcriber={start(){},appendMulaw(){},async commit({turnId}){commits.push(turnId);return{transcript:"مرحبا Nova, English كمان",turnId};},close(){}};
  const authorization={bridgeSessionToken:"bridge-token",callIntentId:"phone-runtime",maximumDurationSeconds:300};
  const runtime=createRuntimePhoneSession({sendTwilio:(value)=>sent.push(value),transcriber,tts:{async *stream(){yield Buffer.alloc(160,0xff);}},novaClient:{async turn(input){return{message:`reply ${input.transcript}`};},async event(input){events.push(input);}},authorization,callIntentId:"phone-runtime",maximumDurationSeconds:300,callSid:CALL_SID,streamSid:STREAM_SID,setTimer(callback){timerCallback=callback;return 1;},clearTimer(){}});
  await runtime.start(START); for(let i=0;i<3;i++)runtime.handle({event:"media",streamSid:STREAM_SID,media:{payload:SPEECH}}); for(let i=0;i<50;i++)runtime.handle({event:"media",streamSid:STREAM_SID,media:{payload:SILENCE}});
  for(let i=0;i<20&&!sent.some(item=>item.event==="mark");i++)await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(commits.length,1); assert.ok(sent.some(item=>item.event==="media")); assert.ok(sent.some(item=>item.event==="mark")); assert.equal(runtime.metrics().rawAudioPersisted,false);
  await timerCallback(); assert.equal(events.at(-1).providerStatus,"maximum_duration");
});

test("Console restoration and generic approval UI include phone state without a parallel approval path", async () => {
  const [consoleSource,presenterSource,css]=await Promise.all([readFile(new URL("../assets/console.js",import.meta.url),"utf8"),readFile(new URL("../assets/approval-presenter.js",import.meta.url),"utf8"),readFile(new URL("../assets/console.css",import.meta.url),"utf8")]);
  assert.match(consoleSource,/restorePhoneCalls\(conversationId\)/); assert.match(consoleSource,/data-phone-call-id/); assert.match(consoleSource,/ownerMemoryClient\.decideApproval/); assert.match(consoleSource,/delivery:stored\.delivery/); assert.match(consoleSource,/confirmed audible portion/); assert.match(consoleSource,/Phone \/ GPT-Live/); assert.match(presenterSource,/phone_call_start/); assert.match(css,/phone-call-card/); assert.match(css,/phone-delivery-state/);
});

test("Fly bridge remains scale-to-zero, one-call-at-a-time, transport-only, and outside Vercel", async () => {
  const [fly, deployedFly, server] = await Promise.all([
    readFile(new URL("../phone-bridge/fly.toml.example", import.meta.url), "utf8"),
    readFile(new URL("../phone-bridge/fly.toml", import.meta.url), "utf8"),
    readFile(new URL("../phone-bridge/server.js", import.meta.url), "utf8"),
  ]);
  assert.match(deployedFly, /dockerfile = "Dockerfile"/);
  assert.match(fly,/min_machines_running = 0/); assert.match(fly,/auto_start_machines = true/); assert.match(server,/sessions\.size === 0/); assert.match(server,/\/health\/ready/); assert.doesNotMatch(server,/memory|gmail|workflow|approval/i);
});

test("Preview certification bridge starts without fabricated Twilio credentials and keeps calls disabled", () => {
  const config=bridgeConfig({NOVA_PHONE_BRIDGE_PUBLIC_URL:"https://bridge.example",NOVA_PHONE_BASE_URL:AUTHORIZED_NOVA_PREVIEW_BASE_URL,OPENAI_API_KEY:"openai",ELEVENLABS_API_KEY:"eleven",ELEVENLABS_VOICE_ID:"owner-voice",VERCEL_AUTOMATION_BYPASS_SECRET:"preview-bypass"});
  assert.equal(config.twilioAuthToken,null);assert.equal(config.voiceConfig.voiceV2.ttsModel,"eleven_v3_conversational");assert.doesNotMatch(JSON.stringify(config),/preview-bypass/);
});

test("Fly bridge attaches the Vercel bypass only to the exact authorized Nova Preview and preserves Nova bearer auth", async () => {
  const secret = "preview-bypass-private"; const requests = [];
  const client = createNovaPhoneBridgeClient({ baseUrl: AUTHORIZED_NOVA_PREVIEW_BASE_URL, protectionBypassSecret: secret, fetchImpl: async (url, input) => { requests.push({ url, input }); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }); } });
  await client.turn({ transcript: "hello" }, "nova-session-token");
  assert.equal(requests.length, 1); assert.equal(requests[0].url, `${AUTHORIZED_NOVA_PREVIEW_BASE_URL}/api/phone/bridge/turn`);
  assert.equal(requests[0].input.headers["x-vercel-protection-bypass"], secret); assert.equal(requests[0].input.headers.Authorization, "Bearer nova-session-token");
});

test("bypass configuration fails safely when missing and rejects an unauthorized destination", () => {
  assert.throws(() => bridgeConfig({ NOVA_PHONE_BRIDGE_PUBLIC_URL: "https://bridge.example", NOVA_PHONE_BASE_URL: AUTHORIZED_NOVA_PREVIEW_BASE_URL, OPENAI_API_KEY: "openai", ELEVENLABS_API_KEY: "eleven", ELEVENLABS_VOICE_ID: "owner-voice" }), /VERCEL_AUTOMATION_BYPASS_SECRET is required/);
  assert.throws(() => createNovaPhoneBridgeClient({ baseUrl: "https://unrelated.example", protectionBypassSecret: "private" }), (error) => error.code === "nova_preview_destination_not_authorized" && !error.message.includes("private"));
  assert.deepEqual(protectionBypassHeadersFor({ destination: "https://unrelated.example/api/agent", secret: "private" }), {});
});

test("bypass secret is absent from safe errors, serialized client state, and unrelated request headers", async () => {
  const secret = "never-report-this-bypass";
  const client = createNovaPhoneBridgeClient({ baseUrl: AUTHORIZED_NOVA_PREVIEW_BASE_URL, protectionBypassSecret: secret, fetchImpl: async () => new Response(JSON.stringify({ error: "safe upstream failure", code: "safe_failure" }), { status: 503, headers: { "content-type": "application/json" } }) });
  await assert.rejects(() => client.start({ sessionToken: "fixture" }), (error) => error.code === "safe_failure" && !JSON.stringify(error).includes(secret));
  assert.doesNotMatch(JSON.stringify(client), new RegExp(secret));
  const unrelatedHeaders = { "content-type": "application/json", ...protectionBypassHeadersFor({ destination: "https://unrelated.example/api/agent", secret }) };
  assert.equal("x-vercel-protection-bypass" in unrelatedHeaders, false);
});

async function withBridge(run) {
  const bridgeEnvironment = { PORT: "0", NOVA_PHONE_BRIDGE_PUBLIC_URL: "https://bridge.example", NOVA_PHONE_BASE_URL: AUTHORIZED_NOVA_PREVIEW_BASE_URL, OPENAI_API_KEY: "openai", ELEVENLABS_API_KEY: "eleven", ELEVENLABS_VOICE_ID: "owner-voice", VERCEL_AUTOMATION_BYPASS_SECRET: "preview-bypass", TWILIO_AUTH_TOKEN: "twilio-auth" };
  const forwarded = [];
  const bridge = createPhoneBridgeServer({ environment: bridgeEnvironment, fetchImpl: async (url, input) => { forwarded.push({ url, input }); return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); } });
  const listener = bridge.listen();
  await new Promise((resolve) => listener.once("listening", resolve));
  try { return await run({ origin: `http://127.0.0.1:${listener.address().port}`, forwarded }); }
  finally { await bridge.close(); }
}

async function withMediaBridge(run) {
  const logs=[];let starts=0;let runtimeStarts=0;const handled=[];
  const environment={PORT:"0",NOVA_PHONE_BRIDGE_PUBLIC_URL:"https://bridge.example",NOVA_PHONE_BASE_URL:AUTHORIZED_NOVA_PREVIEW_BASE_URL,OPENAI_API_KEY:"openai",ELEVENLABS_API_KEY:"eleven",ELEVENLABS_VOICE_ID:"owner-voice",VERCEL_AUTOMATION_BYPASS_SECRET:"preview-bypass",TWILIO_AUTH_TOKEN:"twilio-auth"};
  const bridge=createPhoneBridgeServer({environment,WebSocketImpl:WebSocket,logger:{info(...items){logs.push(items);}},novaClient:{async start(input){starts++;assert.equal(input.sessionToken,"single-use-fixture");assert.equal(input.callSid,CALL_SID);assert.equal(input.streamSid,STREAM_SID);return{bridgeSessionToken:"bridge",callIntentId:"phone_fixture",maximumDurationSeconds:600};}},createTranscriber:()=>({}),createTts:()=>({}),createRuntime:()=>({async start(message){runtimeStarts++;handled.push(message.event);},handle(message){handled.push(message.event);},async stop(){}})});
  const listener=bridge.listen();await new Promise(resolve=>listener.once("listening",resolve));
  try{return await run({port:listener.address().port,logs,counts:()=>({starts,runtimeStarts}),handled});}
  finally{await bridge.close();}
}

function mediaSocket(port,{signatureUrl="wss://bridge.example/media",signature="valid"}={}) {
  const value=signature==="valid"?createTwilioSignatureForTest({authToken:"twilio-auth",url:signatureUrl,parameters:{}}):signature;
  return new WebSocket(`ws://127.0.0.1:${port}/media`,{headers:{"X-Twilio-Signature":value}});
}

function once(socket,event){return new Promise((resolve,reject)=>{socket.once(event,resolve);if(event!=="error")socket.once("error",reject);});}
function closeCode(socket){return new Promise((resolve)=>socket.once("close",resolve));}
function expectUpgradeFailure(socket){return new Promise((resolve,reject)=>{socket.once("open",()=>reject(new Error("Unexpected WebSocket acceptance.")));socket.once("error",resolve);socket.once("unexpected-response",resolve);});}

test("realistic connected then start waits to consume the token and binds one authorized session",async()=>withMediaBridge(async({port,logs,counts,handled})=>{
  const socket=mediaSocket(port);await once(socket,"open");
  socket.send(JSON.stringify({event:"connected",protocol:"Call",version:"1.0.0"}));await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(counts(),{starts:0,runtimeStarts:0});
  socket.send(JSON.stringify({...START,start:{...START.start,customParameters:{novaSessionToken:"single-use-fixture"}}}));
  for(let index=0;index<20&&counts().runtimeStarts===0;index++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.deepEqual(counts(),{starts:1,runtimeStarts:1});assert.deepEqual(handled,["start"]);
  socket.send(JSON.stringify({event:"media",streamSid:STREAM_SID,media:{payload:SPEECH}}));
  socket.send(JSON.stringify({event:"stop",streamSid:STREAM_SID,stop:{accountSid:`AC${"a".repeat(32)}`,callSid:CALL_SID}}));await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(handled,["start","media","stop"]);
  const events=logs.map(([,entry])=>entry.event);for(const event of ["websocket_upgrade_received","websocket_upgrade_accepted","connected_received","start_received","session_token_accepted","stream_bound","stt_started","stream_started","stream_stopped"])assert.ok(events.includes(event),event);
  assert.doesNotMatch(JSON.stringify(logs),/single-use-fixture|twilio-auth|preview-bypass/);socket.close();
}));

test("duplicate start and invalid ordering fail closed without replaying authorization",async()=>withMediaBridge(async({port,counts})=>{
  const socket=mediaSocket(port);await once(socket,"open");
  socket.send(JSON.stringify({event:"connected",protocol:"Call",version:"1.0.0"}));
  const start={...START,start:{...START.start,customParameters:{novaSessionToken:"single-use-fixture"}}};socket.send(JSON.stringify(start));
  for(let index=0;index<20&&counts().starts===0;index++)await new Promise(resolve=>setTimeout(resolve,5));
  socket.send(JSON.stringify(start));const code=await closeCode(socket);assert.equal(code,1008);assert.equal(counts().starts,1);
  const outOfOrder=mediaSocket(port);await once(outOfOrder,"open");outOfOrder.send(JSON.stringify(start));const badCode=await closeCode(outOfOrder);assert.equal(badCode,1008);assert.equal(counts().starts,1);
}));

test("WebSocket upgrade rejects tampered signatures and accepts the bounded slash variant",async()=>withMediaBridge(async({port,logs})=>{
  const invalid=mediaSocket(port,{signature:"invalid"});await expectUpgradeFailure(invalid);
  const slash=mediaSocket(port,{signatureUrl:"wss://bridge.example/media/"});await once(slash,"open");slash.close();
  const accepted=logs.find(([,entry])=>entry.event==="websocket_upgrade_accepted");assert.equal(accepted[1].signatureVariant,"documented_trailing_slash_variant");
  const rejected=logs.find(([,entry])=>entry.event==="websocket_upgrade_rejected");assert.equal(rejected[1].category,"phone_twilio_signature_invalid");
}));

const STATUS_INTENT = `phone_${"a".repeat(32)}`;
const STATUS_PATH = `/api/phone/twilio/status/${STATUS_INTENT}`;
const STATUS_BODY = new URLSearchParams({ CallSid: CALL_SID, CallStatus: "ringing" }).toString();

test("bounded Fly status relay validates Twilio and forwards only to the fixed protected Preview route", async () => withBridge(async ({ origin, forwarded }) => {
  const signature = createTwilioSignatureForTest({ authToken: "twilio-auth", url: `https://bridge.example${STATUS_PATH}`, parameters: Object.fromEntries(new URLSearchParams(STATUS_BODY)) });
  const response = await fetch(`${origin}${STATUS_PATH}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature }, body: STATUS_BODY });
  assert.equal(response.status, 204); assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].url, `${AUTHORIZED_NOVA_PREVIEW_BASE_URL}${STATUS_PATH}`);
  assert.equal(forwarded[0].input.body, STATUS_BODY);
  assert.equal(forwarded[0].input.headers["X-Twilio-Signature"], signature);
  assert.equal(forwarded[0].input.headers["x-vercel-protection-bypass"], "preview-bypass");
  assert.doesNotMatch(JSON.stringify(await response.text()), /twilio-auth|preview-bypass/);
}));

test("status relay rejects invalid signatures, unsupported content, oversized bodies, and malformed paths without forwarding", async () => withBridge(async ({ origin, forwarded }) => {
  const invalid = await fetch(`${origin}${STATUS_PATH}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "invalid" }, body: STATUS_BODY });
  assert.equal(invalid.status, 401);
  const unsupported = await fetch(`${origin}${STATUS_PATH}`, { method: "POST", headers: { "content-type": "application/json", "x-twilio-signature": "invalid" }, body: "{}" });
  assert.equal(unsupported.status, 415);
  const oversized = await fetch(`${origin}${STATUS_PATH}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "invalid" }, body: `CallSid=${"x".repeat(17 * 1024)}` });
  assert.equal(oversized.status, 413);
  const malformed = await fetch(`${origin}/api/phone/twilio/status/not-an-intent`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: STATUS_BODY });
  assert.equal(malformed.status, 404); assert.equal(forwarded.length, 0);
  for (const response of [invalid, unsupported, oversized]) assert.doesNotMatch(await response.text(), /twilio-auth|preview-bypass|CallSid/);
}));

test("Preview GPT-Live PSTN adapter keeps PCMU transport canonical, supports barge-in clear, and persists no raw audio",async()=>{
  const sent=[],events=[];let speechStarts=0,speechEnds=0,playbackCompleted=0,closed=0,phase="capturing",transcriptCharacters=20;
  const client={
    connect(){return true;},async ready(){return{providerSessionId:"live-fixture"};},
    async callerSpeechStarted(){speechStarts+=1;},appendAudio(audio){assert.ok(Buffer.isBuffer(audio));return true;},
    async callerSpeechEnded(){speechEnds+=1;phase="playback_pending";return{authority:"LOCAL_CONVERSATION"};},
    async playbackCheckpoint(){return true;},async playbackCompleted(){playbackCompleted+=1;phase="done";return true;},
    async close(){closed+=1;},
    snapshot(){return{current:{turnId:"turn-1",phase,terminal:null,transcriptCharacters},rawAudioPersisted:false};},
  };
  let callbacks;const runtime=createGptLivePstnSession({endpointGraceMs:5,sendTwilio:value=>sent.push(value),novaClient:{async event(value){events.push(value);}},authorization:{bridgeSessionToken:"bridge-token",callIntentId:"phone_fixture",callConversationId:"phone-session-phone_fixture",maximumDurationSeconds:600,mediaProfile:"gpt_live_round2_preview",liveVoice:"gleam"},callIntentId:"phone_fixture",maximumDurationSeconds:600,callSid:CALL_SID,streamSid:STREAM_SID,apiKey:"openai",round2Api:{},createClient(options){callbacks=options;return client;}});
  const started=await runtime.start();assert.equal(started.providerSessionId,"live-fixture");assert.equal(callbacks.voice,"gleam");assert.equal(callbacks.conversationId,"phone-session-phone_fixture");
  for(let index=0;index<3;index+=1)runtime.handle({event:"media",streamSid:STREAM_SID,media:{payload:SPEECH}});
  for(let index=0;index<50;index+=1)runtime.handle({event:"media",streamSid:STREAM_SID,media:{payload:SILENCE}});
  for(let index=0;index<20&&speechEnds===0;index+=1)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(speechStarts,1);assert.equal(speechEnds,1);
  callbacks.onAudio(Buffer.alloc(4000,1),{turnId:"turn-1",outputKind:"final",startMs:0,endMs:500});callbacks.onClearAudio();assert.equal(sent.some(item=>item.event==="media"),true);assert.equal(sent.some(item=>item.event==="clear"),true);
  const clearedMark=sent.find(item=>item.event==="mark");runtime.handle(clearedMark);assert.equal(playbackCompleted,0);
  callbacks.onAudio(Buffer.alloc(160,1),{turnId:"turn-1",outputKind:"final",startMs:21,endMs:40});callbacks.onOutputCompleted({turnId:"turn-1",source:"provider_event"});callbacks.onOutputCompleted({turnId:"turn-1",source:"inactivity"});for(let index=0;index<20&&!sent.some(item=>item.event==="mark"&&item.mark.name.includes("final"));index+=1)await new Promise(resolve=>setTimeout(resolve,5));const finalMarks=sent.filter(item=>item.event==="mark"&&item.mark.name.includes("final"));assert.equal(finalMarks.length,1);runtime.handle(finalMarks[0]);await new Promise(resolve=>setImmediate(resolve));assert.equal(playbackCompleted,1);
  await runtime.stop("completed","fixture",{hangupSocket:false});assert.equal(closed,1);assert.equal(events.length,1);assert.equal(runtime.metrics().rawAudioPersisted,false);assert.doesNotMatch(JSON.stringify(events),/audio|base64|payload/i);
});

test("PSTN adapter treats repeated caller correction as benign and completes the newest realistic PCMU turn",async()=>{
  const sent=[],events=[],diagnostics=[],pending=[];let speechStarts=0,speechEnds=0,playbackCompleted=0,closed=0,hangups=0,phase="capturing",turnId="turn-1",transcriptCharacters=20;
  const client={
    connect(){return true;},async ready(){return{providerSessionId:"live-overlap"};},
    async callerSpeechStarted(){
      speechStarts+=1;phase="capturing";turnId=`turn-${speechStarts}`;
      if(pending.length)pending.shift().reject(new DOMException("Superseded by caller correction.","AbortError"));
    },
    appendAudio(audio){assert.equal(audio.length,160);return true;},
    callerSpeechEnded(){
      speechEnds+=1;
      if(speechEnds<3)return new Promise((resolve,reject)=>pending.push({resolve,reject}));
      phase="playback_pending";return Promise.resolve({authority:"LOCAL_CONVERSATION"});
    },
    async playbackCheckpoint(){return true;},async playbackCompleted(){playbackCompleted+=1;phase="done";return true;},
    async close(){closed+=1;},snapshot(){return{current:{turnId,phase,terminal:null,transcriptCharacters},rawAudioPersisted:false};},
  };
  let callbacks;const runtime=createGptLivePstnSession({endpointGraceMs:5,sendTwilio:value=>sent.push(value),hangup(){hangups+=1;},diagnostic:(event,metadata)=>diagnostics.push({event,...metadata}),novaClient:{async event(value){events.push(value);}},authorization:{bridgeSessionToken:"bridge-token",callIntentId:"phone_overlap",callConversationId:"phone-session-phone_overlap",maximumDurationSeconds:600,mediaProfile:"gpt_live_round2_preview",liveVoice:"gleam"},callIntentId:"phone_overlap",maximumDurationSeconds:600,callSid:CALL_SID,streamSid:STREAM_SID,apiKey:"openai",round2Api:{},createClient(options){callbacks=options;return client;}});
  await runtime.start();
  const burst=()=>{for(let index=0;index<3;index+=1)runtime.handle({event:"media",streamSid:STREAM_SID,media:{payload:SPEECH}});for(let index=0;index<50;index+=1)runtime.handle({event:"media",streamSid:STREAM_SID,media:{payload:SILENCE}});};
  burst();for(let index=0;index<20&&speechEnds<1;index+=1)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(speechEnds,1);
  burst();for(let index=0;index<40&&speechEnds<2;index+=1)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(speechStarts,2);assert.equal(speechEnds,2);
  burst();for(let index=0;index<40&&speechEnds<3;index+=1)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(speechStarts,3);assert.equal(speechEnds,3);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,0);assert.equal(hangups,0);assert.equal(diagnostics.filter(item=>item.event==="turn_superseded").length,2);assert.equal(diagnostics.some(item=>item.event==="turn_finalize_failed"),false);
  callbacks.onOutputCompleted({turnId:"turn-1",source:"provider_event"});callbacks.onOutputCompleted({turnId:"turn-2",source:"inactivity"});await new Promise(resolve=>setImmediate(resolve));assert.equal(sent.some(item=>item.event==="mark"),false);
  callbacks.onAudio(Buffer.alloc(160,1),{turnId:"turn-3",outputKind:"final",startMs:0,endMs:20});callbacks.onOutputCompleted({turnId:"turn-3",source:"inactivity"});callbacks.onOutputCompleted({turnId:"turn-3",source:"provider_event"});
  for(let index=0;index<20&&!sent.some(item=>item.event==="mark");index+=1)await new Promise(resolve=>setTimeout(resolve,5));
  const mark=sent.find(item=>item.event==="mark");assert.ok(mark);runtime.handle(mark);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(playbackCompleted,1);assert.equal(sent.some(item=>item.event==="media"),true);assert.equal(events.length,0);assert.equal(runtime.metrics().rawAudioPersisted,false);
  await runtime.stop("completed","fixture",{hangupSocket:false});assert.equal(closed,1);
});

test("clearing a sent final mark prevents its late acknowledgement from completing delivery",async()=>{
  const sent=[];let playbackCompleted=0,phase="playback_pending";
  const client={connect(){},async ready(){return{};},async callerSpeechStarted(){},appendAudio(){},async callerSpeechEnded(){return true;},async playbackCheckpoint(){return true;},async playbackCompleted(){playbackCompleted+=1;return true;},async close(){},snapshot(){return{current:{turnId:"turn-clear",phase,terminal:null,transcriptCharacters:10},rawAudioPersisted:false};}};
  let callbacks;const runtime=createGptLivePstnSession({sendTwilio:value=>sent.push(value),novaClient:{async event(){}},authorization:{bridgeSessionToken:"bridge-token",callIntentId:"phone_clear",callConversationId:"phone-session-phone_clear",maximumDurationSeconds:600,mediaProfile:"gpt_live_round2_preview",liveVoice:"gleam"},callIntentId:"phone_clear",maximumDurationSeconds:600,callSid:CALL_SID,streamSid:STREAM_SID,apiKey:"openai",round2Api:{},createClient(options){callbacks=options;return client;}});
  await runtime.start();callbacks.onAudio(Buffer.alloc(160,1),{turnId:"turn-clear",outputKind:"final",startMs:0,endMs:20});callbacks.onOutputCompleted({turnId:"turn-clear",source:"inactivity"});
  for(let index=0;index<20&&!sent.some(item=>item.event==="mark"&&item.mark.name.includes("final"));index+=1)await new Promise(resolve=>setTimeout(resolve,5));
  const mark=sent.find(item=>item.event==="mark"&&item.mark.name.includes("final"));assert.ok(mark);callbacks.onClearAudio();runtime.handle(mark);await new Promise(resolve=>setImmediate(resolve));assert.equal(playbackCompleted,0);
  await runtime.stop("completed","fixture",{hangupSocket:false});
});

test("PSTN adapter converts unexpected detached finalization failure into exactly one controlled stop",async()=>{
  const events=[],diagnostics=[];let closed=0,hangups=0,speechEnds=0;
  const client={connect(){},async ready(){return{};},async callerSpeechStarted(){},appendAudio(){},async callerSpeechEnded(){speechEnds+=1;throw Object.assign(new Error("provider detail must stay private"),{code:"provider_turn_failed"});},async close(){closed+=1;},snapshot(){return{current:{turnId:"turn-1",phase:"capturing",terminal:null,transcriptCharacters:10},rawAudioPersisted:false};}};
  const runtime=createGptLivePstnSession({endpointGraceMs:5,sendTwilio(){},hangup(){hangups+=1;},diagnostic:(event,metadata)=>diagnostics.push({event,...metadata}),novaClient:{async event(value){events.push(value);}},authorization:{bridgeSessionToken:"bridge-token",callIntentId:"phone_failure",callConversationId:"phone-session-phone_failure",maximumDurationSeconds:600,mediaProfile:"gpt_live_round2_preview",liveVoice:"gleam"},callIntentId:"phone_failure",maximumDurationSeconds:600,callSid:CALL_SID,streamSid:STREAM_SID,apiKey:"openai",round2Api:{},createClient(){return client;}});
  await runtime.start();for(let index=0;index<3;index+=1)runtime.handle({event:"media",streamSid:STREAM_SID,media:{payload:SPEECH}});for(let index=0;index<50;index+=1)runtime.handle({event:"media",streamSid:STREAM_SID,media:{payload:SILENCE}});
  for(let index=0;index<30&&events.length===0;index+=1)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(speechEnds,1);assert.equal(closed,1);assert.equal(hangups,1);assert.equal(events.length,1);assert.equal(events[0].type,"failed");assert.equal(events[0].providerStatus,"live_turn_failure");
  assert.deepEqual(diagnostics.filter(item=>item.event==="turn_finalize_failed"),[{event:"turn_finalize_failed",category:"provider_turn_failed"}]);assert.doesNotMatch(JSON.stringify(diagnostics),/provider detail/);
  await runtime.stop("failed","duplicate");assert.equal(closed,1);assert.equal(hangups,1);assert.equal(events.length,1);
});

test("bridge selects GPT-Live only for an immutable authorized Preview profile and leaves chained runtime untouched",async()=>{
  const logs=[];let chained=0,live=0;
  const environment={PORT:"0",NOVA_PHONE_BRIDGE_PUBLIC_URL:"https://bridge.example",NOVA_PHONE_BASE_URL:AUTHORIZED_NOVA_PREVIEW_BASE_URL,OPENAI_API_KEY:"openai",ELEVENLABS_API_KEY:"eleven",ELEVENLABS_VOICE_ID:"owner-voice",VERCEL_AUTOMATION_BYPASS_SECRET:"preview-bypass",TWILIO_AUTH_TOKEN:"twilio-auth",NOVA_PHONE_GPT_LIVE_PREVIEW_ENABLED:"true"};
  const bridge=createPhoneBridgeServer({environment,WebSocketImpl:WebSocket,logger:{info(...items){logs.push(items);}},novaClient:{async start(){return{bridgeSessionToken:"bridge",callIntentId:"phone_fixture",callConversationId:"phone-session-phone_fixture",maximumDurationSeconds:600,mediaProfile:"gpt_live_round2_preview",liveVoice:"gleam"};}},createTranscriber:()=>({}),createTts:()=>({}),createRuntime:()=>{chained+=1;return{async start(){},handle(){},async stop(){}};},createGptLiveRuntime:()=>{live+=1;return{async start(){},handle(){},async stop(){}};}});
  const listener=bridge.listen();await new Promise(resolve=>listener.once("listening",resolve));
  try{const socket=mediaSocket(listener.address().port);await once(socket,"open");socket.send(JSON.stringify({event:"connected",protocol:"Call",version:"1.0.0"}));socket.send(JSON.stringify({...START,start:{...START.start,customParameters:{novaSessionToken:"single-use-fixture"}}}));for(let index=0;index<20&&live===0;index+=1)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(live,1);assert.equal(chained,0);socket.close();}
  finally{await bridge.close();}
  assert.ok(logs.some(([,entry])=>entry.event==="stream_bound"));
});
