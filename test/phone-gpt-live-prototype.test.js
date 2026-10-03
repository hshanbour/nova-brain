import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { buildGptLivePrototypeSession, createGptLivePrototypeController, GPT_LIVE_PROTOTYPE_CONTRACT } from "../src/phone/gpt-live-prototype.js";
import { createGptLivePrototypeClient } from "../phone-bridge/gpt-live-client.js";

function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }

test("prototype is isolated, PCMU-compatible, client-delegated, non-storing, and preserves bounded history", () => {
  const history = Array.from({ length: 24 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `turn ${index}` }));
  const session = buildGptLivePrototypeSession({ voice: "willow", history });
  assert.equal(session.model, "gpt-live-1");
  assert.deepEqual(session.audio.format, { type: "audio/pcmu", rate: 8_000 });
  assert.equal(session.audio.output.voice, "willow");
  assert.deepEqual(session.delegation, { type: "client" });
  assert.equal(session.store, false);
  assert.equal(session.input.length, 24);
  assert.deepEqual(GPT_LIVE_PROTOTYPE_CONTRACT, { model: "gpt-live-1", audioFormat: { type: "audio/pcmu", rate: 8_000 }, delegation: "client", store: false, authority: "nova_brain", rawAudioPersisted: false });
});

test("continuous 20+ turn history, correction, topic return, and interrupted output remain one session", async () => {
  const sent = []; const played = []; let clears = 0;
  const controller = createGptLivePrototypeController({ send: (event) => sent.push(event), delegate: async () => ({ message: "verified" }), onAudio: (audio) => played.push(audio), onClearAudio: () => { clears += 1; }, idFactory: (() => { let id = 0; return () => `event-${++id}`; })() });
  controller.start({ history: Array.from({ length: 22 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: index === 2 ? "Codex كان شغال على مشكلة الموقع" : `turn ${index}` })) });
  await controller.handleServerEvent({ type: "session.started", event_id: "started", session: { id: "live_fixture" } });
  for (const [index, text] of ["طيب شو صار فيها؟", "لا مش هذا قصدي", "طيب كمل", "النقطة اللي حكيت عنها قبل شوي"].entries()) {
    controller.callerSpeechStarted();
    await controller.handleServerEvent({ type: "session.input_transcript.delta", event_id: `input-${index}`, delta: text, start_ms: index * 1_000, end_ms: index * 1_000 + 500 });
    controller.callerSpeechEnded();
  }
  await controller.handleServerEvent({ type: "session.output_transcript.delta", event_id: "output-text", delta: "فاهم عليك" });
  await controller.handleServerEvent({ type: "session.output_audio.delta", event_id: "output-audio", delta: Buffer.alloc(160, 1).toString("base64") });
  controller.callerSpeechStarted();
  assert.equal(clears, 1);
  assert.equal(played.length, 1);
  assert.equal(controller.snapshot().callerInterruptions, 1);
  assert.equal(controller.snapshot().rawAudioPersisted, false);
  assert.match(controller.snapshot().inputTranscript, /شو صار فيها.*مش هذا قصدي.*كمل.*النقطة/u);
});

test("assistant conversational initiative is observable but yields immediately when caller resumes", async () => {
  const sent = []; let clears = 0;
  const controller = createGptLivePrototypeController({ send: (event) => sent.push(event), delegate: async () => ({ message: "verified" }), onClearAudio: () => { clears += 1; } });
  controller.start(); await controller.handleServerEvent({ type: "session.started", event_id: "started", session: { id: "live_fixture" } });
  controller.callerSpeechStarted();
  await controller.handleServerEvent({ type: "session.output_audio.delta", event_id: "initiative", delta: Buffer.alloc(160, 1).toString("base64") });
  assert.equal(controller.snapshot().assistantInterruptions, 1);
  controller.callerSpeechStarted();
  assert.equal(clears, 1);
  assert.equal(controller.snapshot().callerInterruptions, 1);
});

test("client delegation is idempotent, correlated, and returns only verified commentary", async () => {
  const sent = []; let delegated = 0;
  const controller = createGptLivePrototypeController({ send: (event) => sent.push(event), async delegate({ delegationId, transcript }) { delegated += 1; assert.equal(delegationId, "delegation-1"); assert.match(transcript, /Sharp Cuts/); return { message: "Sharp Cuts status is verified." }; }, idFactory: () => "result-event" });
  controller.start(); await controller.handleServerEvent({ type: "session.started", event_id: "started", session: { id: "live_fixture" } });
  await controller.handleServerEvent({ type: "session.input_transcript.delta", event_id: "input", delta: "شو صار بمشروع Sharp Cuts؟" });
  const event = { type: "session.delegation.created", event_id: "delegation-event", delegation: { id: "delegation-1", target: "client" } };
  assert.equal(await controller.handleServerEvent(event), true);
  assert.equal(await controller.handleServerEvent(event), false);
  assert.equal(delegated, 1);
  assert.deepEqual(sent.at(-1), { type: "session.commentary.append", event_id: "result-event", delegation_id: "delegation-1", content: "Sharp Cuts status is verified." });
  assert.equal(controller.snapshot().duplicates, 1);
});

test("consequential requests and spoken approval never reach a direct action executor", async () => {
  const sent = []; let delegated = 0;
  const controller = createGptLivePrototypeController({ send: (event) => sent.push(event), async delegate() { delegated += 1; return { message: "must not run" }; }, idFactory: () => "approval-boundary-event" });
  controller.start(); await controller.handleServerEvent({ type: "session.started", event_id: "started", session: { id: "live_fixture" } });
  await controller.handleServerEvent({ type: "session.input_transcript.delta", event_id: "input", delta: "ابعتي الإيميل هسا، أنا بوافق" });
  await controller.handleServerEvent({ type: "session.delegation.created", event_id: "delegate", delegation: { id: "delegation-sensitive" } });
  assert.equal(delegated, 0);
  assert.match(sent.at(-1).content, /formal approval/i);
  assert.equal(controller.snapshot().delegations[0].status, "waiting_for_approval");
});

test("caller speech automatically cancels a running delegation and discards its stale result", async () => {
  const gate = deferred(); const sent = [];
  const controller = createGptLivePrototypeController({ send: (event) => sent.push(event), async delegate() { await gate.promise; return { message: "stale result" }; } });
  controller.start(); await controller.handleServerEvent({ type: "session.started", event_id: "started", session: { id: "live_fixture" } });
  await controller.handleServerEvent({ type: "session.input_transcript.delta", event_id: "input", delta: "check project" });
  const task = controller.handleServerEvent({ type: "session.delegation.created", event_id: "delegate", delegation: { id: "delegation-stale" } });
  controller.callerSpeechEnded();
  controller.callerSpeechStarted();
  gate.resolve();
  assert.equal(await task, false);
  assert.equal(sent.some((event) => event.type === "session.commentary.append"), false);
  assert.equal(controller.snapshot().delegations[0].status, "cancelled");
  assert.equal(controller.snapshot().revision, 1);
});

test("caller barge-in clears queued audio synchronously and records no raw media", async () => {
  let now = 1_000; let clearedAt = null;
  const controller = createGptLivePrototypeController({
    send() {},
    delegate: async () => ({ message: "ok" }),
    clock: () => now,
    onClearAudio() { clearedAt = now; },
  });
  controller.start();
  await controller.handleServerEvent({ type: "session.started", event_id: "started", session: { id: "live_fixture" } });
  await controller.handleServerEvent({ type: "session.output_audio.delta", event_id: "audio", delta: Buffer.alloc(160, 1).toString("base64") });
  now = 1_025;
  controller.callerSpeechStarted();
  assert.equal(clearedAt, 1_025);
  assert.equal(controller.snapshot().callerInterruptions, 1);
  assert.equal(controller.snapshot().rawAudioPersisted, false);
});

test("provider errors expose only bounded categories and no raw body or credentials", async () => {
  const controller = createGptLivePrototypeController({ send() {}, delegate: async () => ({ message: "ok" }) });
  controller.start();
  await assert.rejects(() => controller.handleServerEvent({ type: "error", event_id: "error", error: { type: "invalid_request_error", code: "bad_audio", message: "secret raw provider body" } }), (error) => error.message === "GPT-Live provider error (invalid_request_error:bad_audio)." && !error.message.includes("secret raw"));
});

test("WebSocket adapter authenticates server-side, emits PCMU session config, and never serializes the API key", async () => {
  class FakeSocket extends EventEmitter {
    static OPEN = 1; static instance;
    readyState = 1; sent = [];
    constructor(url, options) { super(); this.url = url; this.options = options; FakeSocket.instance = this; queueMicrotask(() => this.emit("open")); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() {}
    terminate() {}
  }
  const client = createGptLivePrototypeClient({ apiKey: "never-expose-key", WebSocketImpl: FakeSocket, delegate: async () => ({ message: "ok" }) });
  client.connect(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(FakeSocket.instance.url, "wss://api.openai.com/v1/live/sessions");
  assert.equal(FakeSocket.instance.options.headers.Authorization, "Bearer never-expose-key");
  assert.equal(FakeSocket.instance.sent[0].session.audio.format.type, "audio/pcmu");
  FakeSocket.instance.emit("message", JSON.stringify({ type: "session.started", event_id: "started", session: { id: "live_fixture" } }));
  await client.ready();
  assert.doesNotMatch(JSON.stringify(client), /never-expose-key/);
  assert.equal(client.contract().secretExposed, false);
});

test("raw audio is forwarded ephemerally and excluded from snapshots and audit", async () => {
  const sent = [];
  const controller = createGptLivePrototypeController({ send: (event) => sent.push(event), delegate: async () => ({ message: "ok" }) });
  controller.start(); await controller.handleServerEvent({ type: "session.started", event_id: "started", session: { id: "live_fixture" } });
  assert.equal(controller.appendAudio(Buffer.alloc(160, 0xff)), true);
  assert.equal(Buffer.from(sent.at(-1).audio, "base64").length, 160);
  const snapshot = controller.snapshot();
  assert.equal(snapshot.rawAudioPersisted, false);
  assert.equal("audio" in snapshot, false);
  assert.doesNotMatch(JSON.stringify(snapshot.audit), /\/\/\/\//);
});
