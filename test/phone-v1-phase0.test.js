import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readConfig } from "../src/config/env.js";
import { createAgent } from "../src/agent/agent.js";
import { createMockModelProvider } from "../src/providers/mock-model-provider.js";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import { INITIAL_OWNER_PROFILE, OWNER_ID } from "../src/identity/initial-context.js";
import { decodeMulaw8k, twilioMulawToOpenAiPcm } from "../src/phone/g711.js";
import { createOpenAiStreamingTranscriber } from "../src/phone/openai-transcription-protocol.js";
import { createPhase0ElevenLabsTelephonyTts } from "../src/phone/elevenlabs-telephony.js";
import { createPhase0BridgeSessionRegistry, createPhase0PhoneBridgeSession } from "../src/phone/phase0-bridge-session.js";
import { createTranscriptionSessionRotator } from "../src/phone/transcription-session-rotator.js";
import { waitForBridgeReady } from "../src/phone/bridge-readiness.js";
import { parseTwilioMediaMessage, TWILIO_MEDIA_FORMAT } from "../src/phone/twilio-media-protocol.js";

const CALL_SID = `CA${"1".repeat(32)}`;
const STREAM_SID = `MZ${"2".repeat(32)}`;
const START = Object.freeze({ event: "start", streamSid: STREAM_SID, start: { callSid: CALL_SID, mediaFormat: TWILIO_MEDIA_FORMAT } });
const STOP = Object.freeze({ event: "stop", streamSid: STREAM_SID });
const TWENTY_MS_MULAW = Buffer.alloc(160, 0xff);
const MEDIA = Object.freeze({ event: "media", streamSid: STREAM_SID, media: { payload: TWENTY_MS_MULAW.toString("base64") } });

function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test("Twilio bidirectional boundary accepts only mono 8 kHz mu-law and constructs media, mark, clear flows", () => {
  assert.equal(parseTwilioMediaMessage(START).start.callSid, CALL_SID);
  assert.throws(() => parseTwilioMediaMessage({ ...START, start: { ...START.start, mediaFormat: { encoding: "audio/pcm", sampleRate: 8_000, channels: 1 } } }), /mu-law/);
  assert.throws(() => parseTwilioMediaMessage("not-json"), /valid JSON/);
});

test("mu-law 8 kHz decodes and resamples to complete little-endian PCM16 24 kHz frames", () => {
  assert.equal(decodeMulaw8k(Buffer.from([0xff]))[0], 0);
  const result = twilioMulawToOpenAiPcm(MEDIA.media.payload);
  assert.deepEqual({ inputSamples: result.inputSamples, outputSamples: result.outputSamples, bytes: result.pcm.length }, { inputSamples: 160, outputSamples: 480, bytes: 960 });
  for (let offset = 0; offset < result.pcm.length; offset += 2) assert.equal(result.pcm.readInt16LE(offset), 0);
});

test("OpenAI streaming STT shape uses PCM24k, client endpoint commits and item-id correlation", async () => {
  const sent = [];
  const transcriber = createOpenAiStreamingTranscriber({ sendJson: (message) => sent.push(message) });
  assert.equal(transcriber.start(), true);
  assert.equal(transcriber.start(), false);
  transcriber.appendMulaw(MEDIA.media.payload);
  const first = transcriber.commit({ turnId: "turn-en" });
  const second = transcriber.commit({ turnId: "turn-ar" });
  transcriber.handleServerEvent({ type: "input_audio_buffer.committed", item_id: "item-en" });
  transcriber.handleServerEvent({ type: "input_audio_buffer.committed", item_id: "item-ar" });
  transcriber.handleServerEvent({ type: "conversation.item.input_audio_transcription.completed", item_id: "item-ar", transcript: "مرحبا Nova" });
  transcriber.handleServerEvent({ type: "conversation.item.input_audio_transcription.completed", item_id: "item-en", transcript: "Hello Nova" });
  assert.deepEqual(await first, { transcript: "Hello Nova", itemId: "item-en", turnId: "turn-en" });
  assert.deepEqual(await second, { transcript: "مرحبا Nova", itemId: "item-ar", turnId: "turn-ar" });
  assert.deepEqual(sent[0].session.audio.input.format, { type: "audio/pcm", rate: 24_000 });
  assert.equal(sent[0].session.audio.input.transcription.model, "gpt-live-transcribe");
  assert.deepEqual(sent[0].session.audio.input.transcription.languages, ["en", "ar"]);
  assert.equal(sent[0].session.audio.input.turn_detection, null);
  assert.equal(Buffer.from(sent[1].audio, "base64").length, 960);
  assert.equal(sent.filter(({ type }) => type === "input_audio_buffer.commit").length, 2);
});

test("Nova's existing ElevenLabs voice/model is preserved in a mock-only ulaw_8000 request", async () => {
  const calls = [];
  const config = readConfig({ NOVA_BRAIN_MODEL_PROVIDER: "mock", ELEVENLABS_API_KEY: "never-live-secret", ELEVENLABS_VOICE_ID: "owner-selected-voice" });
  const tts = createPhase0ElevenLabsTelephonyTts({ config, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(TWENTY_MS_MULAW, { status: 200, headers: { "content-type": "application/octet-stream" } });
  } });
  const chunks = [];
  for await (const chunk of tts.stream("مرحبا **Mohammad** 😊")) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).length, 160);
  assert.match(calls[0].url, /owner-selected-voice\/stream\?output_format=ulaw_8000$/);
  assert.equal(calls[0].options.headers["xi-api-key"], "never-live-secret");
  assert.deepEqual(JSON.parse(calls[0].options.body), { text: "مرحبا Mohammad", model_id: "eleven_v3_conversational", voice_settings: { stability: 0.75 } });
  assert.deepEqual(tts.contract(), { provider: "elevenlabs", model: "eleven_v3_conversational", voice: "owner-selected", outputFormat: "ulaw_8000", rawAudioPolicy: "ephemeral-only" });
});

test("English, Arabic and mixed transcripts cross Twilio to the existing Nova agent and back as telephony audio", async () => {
  const storage = createInMemoryStorage();
  await storage.initialize({ owner: INITIAL_OWNER_PROFILE });
  const agent = createAgent({ storage, ownerId: OWNER_ID, toolRegistry: createToolRegistry(), modelProvider: createMockModelProvider() });
  for (const [index, transcript] of ["Hello Nova", "مرحبا نوفا، كيفك؟", "Nova، check Sharp Cuts booking رقم 0791234567"].entries()) {
    const sent = [];
    const transcriber = { start() {}, appendMulaw() {}, async commit({ turnId }) { return { transcript, turnId, itemId: `item-${index}` }; }, close() {} };
    const spoken = [];
    const session = createPhase0PhoneBridgeSession({
      sendTwilio: (message) => sent.push(message),
      transcriber,
      novaTurn: ({ transcript: text }) => agent.run({ message: text, conversationId: `phone-phase0-${index}` }),
      tts: { async *stream(text) { spoken.push(text); yield TWENTY_MS_MULAW; } },
      idFactory: () => `turn-${index}`,
    });
    session.handleTwilio(START);
    session.handleTwilio(MEDIA);
    assert.equal(await session.finalizeInboundTurn(), true);
    assert.match(spoken[0], new RegExp(transcript.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(sent[0].event, "media");
    assert.equal(Buffer.from(sent[0].media.payload, "base64").length, 160);
    assert.equal(sent[1].event, "mark");
    session.handleTwilio({ event: "mark", streamSid: START.streamSid, mark: { name: sent[1].mark.name } });
    assert.equal(session.state(), "listening");
  }
});

test("barge-in sends clear immediately and rejects stale TTS audio without duplicating the turn", async () => {
  const gate = deferred(); const sent = []; let novaTurns = 0;
  const session = createPhase0PhoneBridgeSession({
    sendTwilio: (message) => sent.push(message),
    transcriber: { start() {}, appendMulaw() {}, async commit() { return { transcript: "Hello", itemId: "item" }; }, close() {} },
    async novaTurn() { novaTurns += 1; return { message: "Long answer" }; },
    tts: { async *stream() { yield TWENTY_MS_MULAW; await gate.promise; yield TWENTY_MS_MULAW; } },
    idFactory: () => "turn-one",
  });
  session.handleTwilio(START); session.handleTwilio(MEDIA);
  const turn = session.finalizeInboundTurn();
  while (!sent.some(({ event }) => event === "media")) await Promise.resolve();
  session.handleTwilio(MEDIA);
  gate.resolve();
  assert.equal(await turn, false);
  assert.equal(sent.filter(({ event }) => event === "clear").length, 1);
  assert.equal(sent.filter(({ event }) => event === "media").length, 1);
  assert.equal(sent.filter(({ event }) => event === "mark").length, 0);
  assert.equal(novaTurns, 1);
  assert.equal(session.state(), "listening");
});

test("safe stop aborts playback, closes transcription and ignores all late media", async () => {
  const gate = deferred(); const sent = []; let closed = 0;
  const session = createPhase0PhoneBridgeSession({
    sendTwilio: (message) => sent.push(message),
    transcriber: { start() {}, appendMulaw() {}, async commit() { return { transcript: "Hello" }; }, close() { closed += 1; } },
    async novaTurn() { return { message: "Answer" }; },
    tts: { async *stream() { yield TWENTY_MS_MULAW; await gate.promise; yield TWENTY_MS_MULAW; } },
  });
  session.handleTwilio(START); session.handleTwilio(MEDIA);
  const turn = session.finalizeInboundTurn();
  while (!sent.length) await Promise.resolve();
  session.handleTwilio(STOP); gate.resolve();
  assert.equal(await turn, false);
  assert.equal(session.state(), "ended");
  assert.equal(closed, 1);
  assert.deepEqual(session.handleTwilio(MEDIA), { ignored: true });
});

test("duplicate start is idempotent and a session cannot be rebound to a different call", () => {
  let starts = 0;
  const session = createPhase0PhoneBridgeSession({ sendTwilio() {}, transcriber: { start() { starts += 1; }, appendMulaw() {}, close() {} }, async novaTurn() {}, tts: { async *stream() {} } });
  assert.equal(session.handleTwilio(START).started, true);
  assert.equal(session.handleTwilio(START).duplicate, true);
  assert.equal(starts, 1);
  assert.throws(() => session.handleTwilio({ ...START, streamSid: `MZ${"3".repeat(32)}`, start: { ...START.start, callSid: `CA${"4".repeat(32)}` } }), /cannot be rebound/);
});

test("no-audio and duplicate finalization cannot create duplicate Nova turns", async () => {
  let commits = 0; let novaTurns = 0;
  const session = createPhase0PhoneBridgeSession({
    sendTwilio() {},
    transcriber: { start() {}, appendMulaw() {}, async commit() { commits += 1; return { transcript: "Hello" }; }, close() {} },
    async novaTurn() { novaTurns += 1; return { message: "Hi" }; },
    tts: { async *stream() { yield TWENTY_MS_MULAW; } },
  });
  session.handleTwilio(START);
  assert.equal(await session.finalizeInboundTurn(), false);
  session.handleTwilio(MEDIA);
  assert.equal(await session.finalizeInboundTurn(), true);
  assert.equal(await session.finalizeInboundTurn(), false);
  assert.deepEqual({ commits, novaTurns }, { commits: 1, novaTurns: 1 });
});

test("bridge registry converges duplicate WebSocket starts on one call session and rejects identity conflicts", () => {
  let sessions = 0;
  const registry = createPhase0BridgeSessionRegistry({ createSession() {
    sessions += 1;
    return createPhase0PhoneBridgeSession({ sendTwilio() {}, transcriber: { start() {}, appendMulaw() {}, close() {} }, async novaTurn() {}, tts: { async *stream() {} } });
  } });
  const first = registry.open(START);
  const duplicate = registry.open(START);
  assert.equal(duplicate.reused, true);
  assert.equal(duplicate.session, first.session);
  assert.equal(sessions, 1);
  assert.equal(registry.size(), 1);
  assert.throws(() => registry.open({ ...START, streamSid: `MZ${"3".repeat(32)}` }), /another media stream/);
  assert.throws(() => registry.open({ ...START, start: { ...START.start, callSid: `CA${"4".repeat(32)}` } }), /another call/);
  assert.equal(registry.close(CALL_SID), true);
  assert.equal(registry.size(), 0);
});

test("60-minute synthetic 20 ms frame soak has no serverless timer and retains no raw audio", { timeout: 30_000 }, () => {
  let appended = 0; let convertedPcmBytes = 0;
  const session = createPhase0PhoneBridgeSession({ sendTwilio() {}, transcriber: { start() {}, appendMulaw(payload) { appended += 1; convertedPcmBytes += twilioMulawToOpenAiPcm(payload).pcm.length; }, close() {} }, async novaTurn() {}, tts: { async *stream() {} } });
  session.handleTwilio(START);
  const frames = 60 * 60 * 50;
  for (let index = 0; index < frames; index += 1) session.handleTwilio(MEDIA);
  assert.equal(appended, 180_000);
  assert.equal(convertedPcmBytes, 172_800_000);
  assert.equal(session.metrics().inboundFrames, 180_000);
  assert.equal(session.state(), "listening");
  assert.equal("audio" in session.metrics(), false);
  session.handleTwilio(STOP);
  assert.equal(session.state(), "ended");
});

test("OpenAI transcription rotates between turns before 60 minutes without ending the phone call", async () => {
  const sessions = [];
  const rotator = createTranscriptionSessionRotator({ rotateAfterSeconds: 55 * 60, createSession({ generation }) {
    const session = { generation, started: 0, closed: 0, frames: 0, start() { this.started += 1; }, appendMulaw() { this.frames += 1; }, async commit({ turnId }) { return { transcript: `turn ${turnId}`, turnId }; }, handleServerEvent() {}, close() { this.closed += 1; } };
    sessions.push(session);
    return session;
  } });
  rotator.start();
  for (let minute = 1; minute <= 60; minute += 1) {
    for (let frame = 0; frame < 3_000; frame += 1) rotator.appendMulaw(MEDIA.media.payload);
    if (minute % 5 === 0) await rotator.commit({ turnId: minute });
  }
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].closed, 1);
  assert.equal(sessions[1].started, 1);
  assert.equal(rotator.metrics().rotations, 1);
  assert.equal(rotator.metrics().closed, false);
  rotator.close();
  assert.equal(sessions[1].closed, 1);
});

test("Fly scale-to-zero design and pre-dial readiness prevent dialing before a cold bridge is healthy", async () => {
  const config = await readFile(new URL("../phone-bridge/fly.toml.example", import.meta.url), "utf8");
  assert.match(config, /primary_region = "lhr"/);
  assert.match(config, /auto_stop_machines = "stop"/);
  assert.match(config, /auto_start_machines = true/);
  assert.match(config, /min_machines_running = 0/);
  assert.match(config, /type = "connections"/);
  let probes = 0; let dialed = false;
  const readiness = await waitForBridgeReady({ healthUrl: "https://bridge.example/health/ready", delayMs: 0, schedule: (resolve) => resolve(), fetchImpl: async () => {
    probes += 1;
    if (probes < 3) return new Response(JSON.stringify({ ready: false, acceptingCalls: false }), { status: 503 });
    return new Response(JSON.stringify({ ready: true, acceptingCalls: true }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  assert.deepEqual(readiness, { ready: true, attempts: 3 });
  if (readiness.ready) dialed = true;
  assert.equal(dialed, true);
});

test("failed bridge readiness exits before a future dial adapter could run", async () => {
  let dialed = false;
  await assert.rejects(() => waitForBridgeReady({ healthUrl: "https://bridge.example/health/ready", attempts: 2, delayMs: 0, schedule: (resolve) => resolve(), fetchImpl: async () => new Response("not ready", { status: 503 }) }), /before dial/);
  assert.equal(dialed, false);
});
