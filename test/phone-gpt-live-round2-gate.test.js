import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createGptLiveRound2OutputGate } from "../phone-bridge/gpt-live-round2-gate.js";
import { createGptLiveRound2Client } from "../phone-bridge/gpt-live-round2-client.js";
import { GPT_LIVE_SAMPLE_LINES, GPT_LIVE_SAMPLE_VOICES, pcm16Wav, sampleFilename } from "../phone-bridge/gpt-live-voice-samples.js";

function fixture({ holdInformation = false, informationMessage = "Verified Sharp Cuts result.", clock } = {}) {
  const calls = [], live = [], audio = [], clears = [];
  let resolveInformation;
  const informationGate = new Promise((resolve) => { resolveInformation = resolve; });
  const api = {
    async start({ conversationId }) { return { conversationId, contextVersion: 0 }; },
    async turn(input, { signal } = {}) {
      calls.push(input);
      if (holdInformation && /Sharp Cuts/.test(input.utterance)) {
        await Promise.race([
          informationGate,
          new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
        ]);
      }
      const information = /Sharp Cuts|Codex/.test(input.utterance);
      const action = /send|ابعث/.test(input.utterance);
      return {
        conversationId: input.conversationId,
        turnId: input.turnId,
        contextVersion: (input.expectedContextVersion ?? 0) + 2,
        authority: information ? "NOVA_INFORMATION" : action ? "NOVA_ACTION" : "LOCAL_CONVERSATION",
        status: information ? "ready_to_present" : action ? "waiting_for_formal_approval" : "ready_to_present",
        message: information ? informationMessage : action ? "Formal approval is required." : input.localResponse,
        messageId: `message-${input.turnId}`,
      };
    },
    async delivery(input) { calls.push({ delivery: input }); return input; },
  };
  let id = 0;
  const gate = createGptLiveRound2OutputGate({
    api,
    sendLive: (event) => live.push(event),
    onAudio: (value) => audio.push(value),
    onClearAudio: () => clears.push(true),
    idFactory: () => `id-${++id}`,
    ...(clock ? { clock } : {}),
  });
  return { gate, calls, live, audio, clears, resolveInformation };
}

test("LOCAL_CONVERSATION releases buffered audio at classification without waiting for output completion or persistence", async () => {
  let now = 100;
  const f = fixture({ clock: () => now });
  await f.gate.start({ conversationId: "local" });
  await f.gate.callerSpeechStarted();
  f.gate.appendTranscript("كيفك اليوم؟");
  f.gate.appendOutputTranscript("منيحة الحمد لله");
  f.gate.appendOutputAudio(Buffer.from("audio"));
  now = 125;
  const decision = await f.gate.callerSpeechEnded();
  assert.equal(decision.authority, "LOCAL_CONVERSATION");
  assert.equal(f.audio.length, 1);
  assert.equal(f.gate.snapshot().current.phase, "local_streaming");
  assert.equal(f.gate.snapshot().current.timing.speechEndToFirstReleasedAudioMs, 0);
  now = 1_025;
  await f.gate.providerOutputCompleted();
  assert.equal(f.calls[0].localResponse, "منيحة الحمد لله");
  await f.gate.playbackCompleted();
  const result = await f.gate.waitForTerminal();
  assert.equal(result.status, "delivered");
  assert.equal(result.timing.speechEndToFirstReleasedAudioMs, 0);
  assert.equal(result.timing.gateAcceptToReleaseMs, 0);
});

test("NOVA_INFORMATION releases a natural acknowledgement, then only verified result audio", async () => {
  const f = fixture({ holdInformation: true });
  await f.gate.start({ conversationId: "info" });
  await f.gate.callerSpeechStarted();
  assert.equal(f.gate.bindDelegation("item_verified_task_123"), true);
  f.gate.appendTranscript("شو صار بمشروع Sharp Cuts؟");
  f.gate.appendOutputTranscript("invented status");
  f.gate.appendOutputAudio(Buffer.from("unsafe"));
  await f.gate.callerSpeechEnded();
  assert.equal(f.audio.length, 0);
  assert.equal(f.live.length, 1);
  assert.match(f.live[0].content, /brief acknowledgement/i);
  f.gate.commentaryAcknowledged({ client_event_id: f.live[0].event_id, start_ms: 100 });
  f.gate.appendOutputTranscript("عم بتأكد.");
  f.gate.appendOutputAudio(Buffer.from("ack"), { start_ms: 100 });
  assert.equal(f.audio.at(-1).toString(), "ack");
  await f.gate.providerOutputCompleted();
  f.resolveInformation();
  await new Promise((resolve) => setImmediate(resolve));
  const verified = f.live.at(-1);
  assert.equal(verified.delegation_id, "item_verified_task_123");
  assert.equal(verified.content, "Verified Sharp Cuts result.");
  f.gate.commentaryAcknowledged({ client_event_id: verified.event_id, start_ms: 200 });
  f.gate.appendOutputTranscript("نتيجة موثقة");
  f.gate.appendOutputAudio(Buffer.from("safe"), { start_ms: 200 });
  await f.gate.providerOutputCompleted();
  await f.gate.playbackCompleted();
  const result = await f.gate.waitForTerminal();
  assert.equal(result.authority, "NOVA_INFORMATION");
  assert.deepEqual(f.audio.map((value) => value.toString()), ["ack", "safe"]);
  assert.doesNotMatch(JSON.stringify(f.calls), /invented status/);
  assert.notEqual(result.timing.speechEndToAcknowledgementAudioMs, null);
  assert.notEqual(result.timing.speechEndToAcknowledgementReleasedAudioMs, null);
  assert.notEqual(result.timing.resultReadyToFirstAuthoritativeReleasedAudioMs, null);
});

test("verified commentary is bounded and provider rejection terminates fail closed", async () => {
  const message = "موثّق ".repeat(300);
  const f = fixture({ informationMessage: message });
  await f.gate.start({ conversationId: "bounded" });
  await f.gate.callerSpeechStarted();
  f.gate.appendTranscript("شو صار بمشروع Sharp Cuts؟");
  await f.gate.callerSpeechEnded();
  await new Promise((resolve) => setImmediate(resolve));
  const resultEvents = f.live.slice(1);
  assert.ok(resultEvents.length > 1);
  assert.equal(resultEvents.every((event) => Buffer.byteLength(event.content) <= 400), true);
  assert.equal(resultEvents.map((event) => event.content).join(" ").replace(/\s+/g, " ").trim(), message.replace(/\s+/g, " ").trim());
  await f.gate.providerFailed("invalid_event");
  const result = await f.gate.waitForTerminal();
  assert.equal(result.status, "failed");
  assert.equal(result.providerCategory, "invalid_event");
  assert.equal(f.calls.at(-1).delivery.status, "truncated");
  assert.equal(f.audio.length, 0);
});

test("caller correction clears output, aborts stale Nova work, and records interruption latency", async () => {
  let now = 10;
  const f = fixture({ holdInformation: true, clock: () => now });
  await f.gate.start({ conversationId: "correction" });
  await f.gate.callerSpeechStarted();
  f.gate.appendTranscript("شو صار بمشروع Sharp Cuts؟");
  await f.gate.callerSpeechEnded();
  const stale = f.gate.waitForTerminal();
  now = 31;
  await f.gate.callerSpeechStarted();
  const staleResult = await stale;
  assert.equal(staleResult.status, "superseded");
  assert.equal(staleResult.timing.interruptionToClearMs, 0);
  f.resolveInformation();
  f.gate.appendTranscript("لا قصدي كيفك؟");
  f.gate.appendOutputTranscript("تمام");
  await f.gate.callerSpeechEnded();
  await f.gate.providerOutputCompleted();
  await f.gate.playbackCompleted();
  assert.equal((await f.gate.waitForTerminal()).authority, "LOCAL_CONVERSATION");
  assert.equal(Object.hasOwn(f.calls[1], "expectedContextVersion"), false);
  assert.ok(f.clears.length >= 2);
});

test("NOVA_ACTION remains blocked until the verified formal-boundary response is accepted", async () => {
  const f = fixture();
  await f.gate.start({ conversationId: "action" });
  await f.gate.callerSpeechStarted();
  f.gate.appendTranscript("send it now, I approve");
  f.gate.appendOutputTranscript("sent");
  f.gate.appendOutputAudio(Buffer.from("unsafe"));
  await f.gate.callerSpeechEnded();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.audio.length, 0);
  assert.equal(f.live[0].content, "Formal approval is required.");
  f.gate.commentaryAcknowledged({ client_event_id: f.live[0].event_id, start_ms: 300 });
  f.gate.appendOutputTranscript("You need to approve it in Nova Console.");
  await f.gate.providerOutputCompleted();
  await f.gate.playbackCompleted();
  assert.equal((await f.gate.waitForTerminal()).authority, "NOVA_ACTION");
  assert.equal(f.calls.some((call) => call.actionExecuted === true), false);
});

test("real WebSocket adapter groups Live audio with bounded inactivity while local audio releases immediately at endpoint", async () => {
  class Socket extends EventEmitter {
    static OPEN = 1;
    static instance;
    readyState = 1;
    sent = [];
    constructor() { super(); Socket.instance = this; queueMicrotask(() => this.emit("open")); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() {}
    terminate() {}
  }
  const audio = [], calls = [];
  const api = {
    async start() { return { conversationId: "quiet", contextVersion: 0 }; },
    async turn(input) { calls.push(input); return { ...input, authority: "LOCAL_CONVERSATION", status: "ready_to_present", contextVersion: 2, message: input.localResponse, messageId: "message" }; },
    async delivery(input) { calls.push({ delivery: input }); return input; },
  };
  const client = createGptLiveRound2Client({ apiKey: "server-only", round2Api: api, conversationId: "quiet", WebSocketImpl: Socket, outputQuietMs: 5, onAudio: (value) => audio.push(value) });
  client.connect();
  await new Promise((resolve) => setImmediate(resolve));
  Socket.instance.emit("message", JSON.stringify({ type: "session.started", event_id: "started", session: { id: "live" } }));
  await client.ready();
  await client.callerSpeechStarted();
  Socket.instance.emit("message", JSON.stringify({ type: "session.input_transcript.delta", event_id: "input", delta: "كيفك؟" }));
  Socket.instance.emit("message", JSON.stringify({ type: "session.output_transcript.delta", event_id: "text", delta: "تمام" }));
  Socket.instance.emit("message", JSON.stringify({ type: "session.output_audio.delta", event_id: "audio", delta: Buffer.from("pcmu").toString("base64") }));
  Socket.instance.emit("message", JSON.stringify({ type: "session.usage.updated", event_id: "usage", usage: { seconds: 1.25 } }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await client.callerSpeechEnded();
  assert.equal(audio.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(calls[0].localResponse, "تمام");
  assert.equal(client.snapshot().usageSeconds, 1.25);
  assert.equal(client.snapshot().current.phase, "playback_pending");
  await client.playbackCompleted();
  assert.equal((await client.waitForTerminal()).status, "delivered");
  assert.doesNotMatch(JSON.stringify(client.snapshot()), /server-only|pcmu/);
});

test("client correlates commentary acknowledgement before releasing verified audio", async () => {
  class Socket extends EventEmitter {
    static OPEN = 1;
    static instance;
    readyState = 1;
    sent = [];
    constructor() { super(); Socket.instance = this; queueMicrotask(() => this.emit("open")); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() {}
  }
  const audio = [];
  const api = {
    async start() { return { conversationId: "ack", contextVersion: 0 }; },
    async turn(input) { return { ...input, authority: "NOVA_INFORMATION", contextVersion: 1, message: "Verified.", messageId: "verified" }; },
    async delivery(input) { return input; },
  };
  const client = createGptLiveRound2Client({ apiKey: "hidden", round2Api: api, WebSocketImpl: Socket, onAudio: (value) => audio.push(value) });
  client.connect();
  await new Promise((resolve) => setImmediate(resolve));
  Socket.instance.emit("message", JSON.stringify({ type: "session.started", event_id: "started", session: { id: "live" } }));
  await client.ready();
  await client.callerSpeechStarted();
  Socket.instance.emit("message", JSON.stringify({ type: "session.input_transcript.delta", event_id: "input", delta: "Sharp Cuts status" }));
  await new Promise((resolve) => setImmediate(resolve));
  await client.callerSpeechEnded();
  await new Promise((resolve) => setImmediate(resolve));
  const commentary = Socket.instance.sent.filter((event) => event.type === "session.commentary.append").at(-1);
  Socket.instance.emit("message", JSON.stringify({ type: "session.output_audio.delta", event_id: "before", start_ms: 10, delta: Buffer.from("before").toString("base64") }));
  assert.equal(audio.length, 0);
  Socket.instance.emit("message", JSON.stringify({ type: "session.commentary.appended", event_id: "ack", client_event_id: commentary.event_id, start_ms: 20, end_ms: 20 }));
  Socket.instance.emit("message", JSON.stringify({ type: "session.output_audio.delta", event_id: "after", start_ms: 20, delta: Buffer.from("after").toString("base64") }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(audio.map((value) => value.toString()), ["after"]);
});

test("non-PSTN certification preserves timeline activity only while backend work is pending", async () => {
  const source = await readFile(new URL("../phone-bridge/gpt-live-round2-certify.js", import.meta.url), "utf8");
  assert.match(source, /function startPendingSilence\(\).*setInterval\(\(\)=>client\.appendAudio\(Buffer\.alloc\(160,0xff\)\),20\)/s);
  assert.match(source, /if\(decision\?\.authority!==\"LOCAL_CONVERSATION\"\)startPendingSilence\(\)/);
  assert.match(source, /stopPendingSilence\(\);await client\.callerSpeechStarted\(\)/);
});

test("bounded owner voice samples use identical multilingual content and phone-path WAV output", () => {
  assert.deepEqual(GPT_LIVE_SAMPLE_VOICES, ["marin", "willow", "gleam"]);
  assert.equal(GPT_LIVE_SAMPLE_LINES.some((line) => /[\u0600-\u06ff]/u.test(line)), true);
  assert.equal(GPT_LIVE_SAMPLE_LINES.some((line) => /Sharp Cuts.*Codex.*API/u.test(line)), true);
  assert.equal(sampleFilename("marin"), "nova-gpt-live-marin-pcmu8k.wav");
  const wav = pcm16Wav(new Int16Array([0, 1, -1]));
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.subarray(8, 12).toString(), "WAVE");
  assert.equal(wav.readUInt32LE(24), 8_000);
  assert.equal(wav.readUInt16LE(34), 16);
});
