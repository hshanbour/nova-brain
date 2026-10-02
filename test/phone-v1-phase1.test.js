import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { readConfig } from "../src/config/env.js";
import { immutableCallEnvelope } from "../src/phone/call-envelope.js";
import { createPhoneSessionAuth } from "../src/phone/session-auth.js";
import { createPhoneService } from "../src/phone/phone-service.js";
import { registerPhoneTools } from "../src/phone/phone-tools.js";
import { createTwilioSignatureForTest, verifyTwilioSignature } from "../src/phone/twilio-signature.js";
import { createActionPolicy, ApprovalRequiredError } from "../src/policy/action-policy.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";
import { INITIAL_MEMORIES, INITIAL_OWNER_PROFILE, INITIAL_PROJECTS, OWNER_ID } from "../src/identity/initial-context.js";
import { SCHEMA_STATEMENTS, SCHEMA_VERSION } from "../src/storage/schema.js";
import { createAgent } from "../src/agent/agent.js";
import { approvalViewModel } from "../assets/approval-presenter.js";
import { createRuntimePhoneSession } from "../phone-bridge/runtime-session.js";
import { bridgeConfig } from "../phone-bridge/server.js";
import { createOpenAiWebSocketTranscriber } from "../phone-bridge/openai-transcriber.js";
import { TWILIO_MEDIA_FORMAT } from "../src/phone/twilio-media-protocol.js";

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
  constructor() { super(); FakeOpenAiSocket.last = this; }
  send() {}
  close() {}
}

test("OpenAI bridge surfaces only safe provider error categories", async () => {
  let surfaced;
  const client = createOpenAiWebSocketTranscriber({ WebSocketImpl: FakeOpenAiSocket, apiKey: "fixture", onError: (error) => { surfaced = error; } });
  client.start();
  const ready = client.ready();
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

async function fixture({ dial = async () => ({ callSid: CALL_SID, providerStatus: "queued" }), health = async () => new Response(JSON.stringify({ ready: true, acceptingCalls: true }), { status: 200 }), novaTurn = async () => ({ message: "Thanks. I will stay within the approved objective.", runId: "run-phone-turn" }) } = {}) {
  const config = readConfig(environment()); const storage = createInMemoryStorage({ clock: () => NOW });
  await storage.initialize({ owner: INITIAL_OWNER_PROFILE, projects: INITIAL_PROJECTS, memories: INITIAL_MEMORIES });
  await storage.ensureConversation({ id: CONVERSATION, ownerId: OWNER_ID, title: "Phone" });
  let nonce=0,callNonce=0;const auth = createPhoneSessionAuth({ key: config.phone.sessionSigningKeyBytes, clock: () => NOW, randomBytesImpl: () => Buffer.alloc(18, ++nonce) });
  const service = createPhoneService({ config, storage, ownerId: OWNER_ID, dialProvider: { configured: true, dial }, sessionAuth: auth, novaTurn, fetchImpl: health, clock: () => NOW, idFactory: () => `11111111-1111-4111-8111-${String(++callNonce).padStart(12,"0")}` });
  const registry = createToolRegistry({ policy: createActionPolicy({ storage, ownerId: OWNER_ID, approvedBranch: "preview" }) }); registerPhoneTools(registry, { service });
  const run = await storage.createRun({ ownerId: OWNER_ID, conversationId: CONVERSATION, goal: "Prepare call", status: "running" });
  const prepared = await registry.execute("phone_call_prepare", envelope(), { conversationId: CONVERSATION, runId: run.id });
  return { config, storage, auth, service, registry, run, prepared };
}

test("schema fourteen adds bounded durable phone authority, events, and transcript turns", async () => {
  assert.equal(SCHEMA_VERSION, 14);
  for (const table of ["nova_phone_call_intents", "nova_phone_call_events", "nova_phone_call_turns"]) assert.ok(SCHEMA_STATEMENTS.some((statement) => statement.includes(`CREATE TABLE IF NOT EXISTS ${table}`)));
  const migration = await readFile(new URL("../migrations/005_phone_v1.sql", import.meta.url), "utf8");
  assert.match(migration, /ON CONFLICT \(version\) DO NOTHING/); assert.match(migration, /attempt_count integer NOT NULL DEFAULT 0/); assert.doesNotMatch(migration, /raw_audio|recording_url|audio_blob/i);
});

test("immutable envelope hashing is deterministic and rejects non-UK, recording, redial, and excessive duration", () => {
  const first = immutableCallEnvelope(envelope(), { now: NOW }), second = immutableCallEnvelope({ ...envelope(), permittedQuestions: [...envelope().permittedQuestions] }, { now: NOW });
  assert.equal(first.envelopeHash, second.envelopeHash); assert.equal(first.maximumAttempts, 1); assert.equal(first.recordingPolicy, "disabled");
  for (const input of [envelope({ destination: "+12025550123" }), envelope({ maximumAttempts: 2 }), envelope({ recordingPolicy: "enabled" }), envelope({ maximumDurationMinutes: 20 })]) assert.throws(() => immutableCallEnvelope(input, { now: NOW }), /Phone V1|recording|duration|attempt/i);
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

test("approved execution claims exactly one dial and duplicate execution cannot redial", async () => {
  let dials = 0; const f = await fixture({ dial: async () => { dials += 1; return { callSid: CALL_SID, providerStatus: "queued" }; } }); const context = { conversationId: CONVERSATION, runId: f.run.id };
  let approval; await assert.rejects(() => f.registry.execute("phone_call_start", f.prepared, context), (error) => { approval = error.approval; return error instanceof ApprovalRequiredError; });
  await f.storage.decideApproval(approval.id, OWNER_ID, "approved");
  const first = await f.registry.execute("phone_call_start", f.prepared, { ...context, approvalId: approval.id }); const duplicate = await f.registry.execute("phone_call_start", f.prepared, { ...context, approvalId: approval.id });
  assert.equal(dials, 1); assert.equal(first.idempotent, false); assert.equal(duplicate.idempotent, true); assert.equal((await f.storage.getPhoneCallIntent(f.prepared.callIntentId, OWNER_ID)).attemptCount, 1);
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
  assert.match(consoleSource,/restorePhoneCalls\(conversationId\)/); assert.match(consoleSource,/data-phone-call-id/); assert.match(consoleSource,/ownerMemoryClient\.decideApproval/); assert.match(presenterSource,/phone_call_start/); assert.match(css,/phone-call-card/);
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
  const config=bridgeConfig({NOVA_PHONE_BRIDGE_PUBLIC_URL:"https://bridge.example",NOVA_PHONE_BASE_URL:"https://nova.example",OPENAI_API_KEY:"openai",ELEVENLABS_API_KEY:"eleven",ELEVENLABS_VOICE_ID:"owner-voice"});
  assert.equal(config.twilioAuthToken,null);assert.equal(config.voiceConfig.voiceV2.ttsModel,"eleven_v3_conversational");
});
