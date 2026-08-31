import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readConfig } from "../src/config/env.js";
import { createApi } from "../src/http/api.js";
import { chunkSpeechText, sanitiseSpeechText } from "../src/voice/speech-text.js";
import { createVoiceService, VoiceProviderError } from "../src/voice/voice-service.js";
import { createVoiceV2Client } from "../assets/voice-v2-client.js";
import { createAudioPlayback } from "../assets/voice-capture.js";

const environment = { OPENAI_API_KEY: "openai-secret", ELEVENLABS_API_KEY: "eleven-secret", ELEVENLABS_VOICE_ID: "owner-voice" };
function withCapabilities(handler) { return async (url, options) => {
  if (url === "https://api.elevenlabs.io/v1/models") return new Response(JSON.stringify([{ model_id: "eleven_v3_conversational", can_do_text_to_speech: true }, { model_id: "eleven_flash_v2_5", can_do_text_to_speech: true }]), { status: 200, headers: { "content-type": "application/json" } });
  if (String(url).startsWith("https://api.elevenlabs.io/v1/voices/")) return new Response(JSON.stringify({ voice_id: environment.ELEVENLABS_VOICE_ID, high_quality_base_model_ids: ["eleven_v3_conversational"] }), { status: 200, headers: { "content-type": "application/json" } });
  return handler(url, options);
}; }
function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function config(overrides = {}) { const base = readConfig(environment); return { ...base, voiceV2: { ...base.voiceV2, ttsRetryDelayMs: 0, ...overrides } }; }

test("semantic speech chunks preserve exact Arabic-English order without skipped or duplicated text", () => {
  const text = sanitiseSpeechText("مرحباً محمد. سنراجع Sharp Cuts API رقم 35، ثم نكمل خطة missed-call recovery. وبعد ذلك نراجع الأرقام والتفاصيل بعناية؟ ".repeat(8));
  const chunks = chunkSpeechText(text, { firstChunkCharacters: 90, nextChunkCharacters: 150, maxChunks: 20 });
  assert.ok(chunks.length > 3); assert.ok(chunks[0].length <= 90);
  assert.equal(chunks.join(" "), text); assert.match(chunks.join(" "), /Sharp Cuts API رقم 35.*missed-call recovery/s);
  for (const chunk of chunks) { assert.equal(/^\s|\s$/.test(chunk), false); assert.equal(chunk.includes("  "), false); }
});

test("production first speech segment stays short, natural, and clause-safe",()=>{const chunks=chunkSpeechText("تمام محمد، خلينا نراجع Preview deployment أول، وبعدها نفحص API والنتائج بالتفصيل.",{firstChunkCharacters:60,nextChunkCharacters:360});assert.ok(chunks[0].length>=30&&chunks[0].length<=70);assert.match(chunks[0],/[،,:]$/u);assert.equal(chunks.join(" "),"تمام محمد، خلينا نراجع Preview deployment أول، وبعدها نفحص API والنتائج بالتفصيل.");});

test("first complete audio chunk is available before later ElevenLabs generation completes", async () => {
  const second = deferred(); const requests = [];
  const service = createVoiceService({ config: config({ firstSpeechChunkCharacters: 35, nextSpeechChunkCharacters: 45 }), fetchImpl: withCapabilities(async (_url, options) => {
    const text = JSON.parse(options.body).text; requests.push(text);
    if (requests.length === 2) await second.promise;
    return new Response(Buffer.from(`mp3:${text}`), { status: 200, headers: { "content-type": "audio/mpeg" } });
  }) });
  const iterator = service.streamSpeech({ text: "This first sentence begins now. This second sentence waits for generation. A third sentence follows." })[Symbol.asyncIterator]();
  const first = await iterator.next(); assert.equal(first.done, false); assert.equal(first.value.index, 0); assert.match(first.value.audio.toString(), /^mp3:This first sentence/);
  const later = iterator.next(); await Promise.resolve(); assert.equal(requests.length, 2);
  second.resolve(); const next = await later; assert.equal(next.value.index, 1);
});

test("browser client exposes first playable MP3 before the streamed response completes", async () => {
  let controller; const stream = new ReadableStream({ start(value) { controller = value; } }); let clock = 0;
  const client = createVoiceV2Client({ now: () => ++clock, fetchImpl: async () => new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson", "x-nova-voice-model": "eleven_v3_conversational" } }) });
  const pending = client.speech("hello");
  controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: "audio", index: 0, chunkCount: 2, mimeType: "audio/mpeg", audioBase64: Buffer.from("first").toString("base64") }) + "\n"));
  const speech = await pending; assert.equal(await speech.audio.text(), "first"); assert.equal(speech.timing.firstPlayableAt > speech.timing.requestStartedAt, true);
  const firstConsumed = deferred(); const received = []; const consuming = (async () => { for await (const audio of speech.stream) { received.push(await audio.text()); if (received.length === 1) firstConsumed.resolve(); } })();
  await firstConsumed.promise; assert.deepEqual(received, ["first"]);
  controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: "audio", index: 1, chunkCount: 2, mimeType: "audio/mpeg", audioBase64: Buffer.from("second").toString("base64") }) + "\n" + JSON.stringify({ type: "end" }) + "\n")); controller.close();
  await consuming; assert.deepEqual(received, ["first", "second"]);
});

test("HTTP speech route flushes its first audio event before later generation finishes", async () => {
  const later = deferred(); const firstWritten = deferred();
  const handler = createApi({ config: config(), agent: {}, storage: {}, initialize: async () => {}, ownerId: "owner", voiceBenchmark: {}, logger: { info() {}, error() {} }, voiceService: {
    async *streamSpeech() {
      yield { audio: Buffer.from("first"), mimeType: "audio/mpeg", model: "eleven_v3_conversational", index: 0, chunkCount: 2 };
      await later.promise;
      yield { audio: Buffer.from("second"), mimeType: "audio/mpeg", model: "eleven_v3_conversational", index: 1, chunkCount: 2 };
    }
  } });
  const request = new EventEmitter(); request.method = "POST"; request.url = "/api/voice/speech"; request.headers = { "content-type": "application/json" }; request[Symbol.asyncIterator] = async function* () { yield Buffer.from(JSON.stringify({ text: "A sufficiently long reply" })); };
  const response = new EventEmitter(); response.headers = new Map(); response.chunks = []; response.setHeader = (name, value) => response.headers.set(name.toLowerCase(), value); response.write = (value) => { response.chunks.push(String(value)); firstWritten.resolve(); return true; }; response.end = () => { response.writableEnded = true; };
  const handling = handler.handle(request, response); await firstWritten.promise;
  assert.equal(response.writableEnded, undefined); assert.match(response.chunks[0], /"index":0/); assert.doesNotMatch(response.chunks.join(""), /"index":1/);
  later.resolve(); await handling; assert.match(response.chunks.join(""), /"index":1/); assert.equal(response.writableEnded, true);
});

test("incremental playback preserves chunk order and prefetches while the current chunk plays", async () => {
  const players = []; const urls = new Map(); let urlSequence = 0; const requested = [];
  class AudioMock {
    constructor(url) { this.url = url; this.listeners = new Map(); players.push(this); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    play() { return Promise.resolve(); } pause() {} removeAttribute() {} load() {}
    end() { this.listeners.get("ended")?.(); }
  }
  const URL = { createObjectURL(blob) { const id = `blob:${++urlSequence}`; urls.set(id, blob); return id; }, revokeObjectURL() {} };
  const source = { async *[Symbol.asyncIterator]() { requested.push(1); yield new Blob(["one"]); requested.push(2); yield new Blob(["two"]); requested.push(3); } };
  const playback = createAudioPlayback({ Audio: AudioMock, URL }); let ended = 0;
  playback.play(source, { onEnded: () => { ended += 1; } }); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(requested, [1, 2]); assert.equal(await urls.get(players[0].url).text(), "one");
  players[0].end(); await Promise.resolve(); await Promise.resolve(); assert.equal(await urls.get(players[1].url).text(), "two");
  players[1].end(); await Promise.resolve(); await Promise.resolve(); assert.equal(ended, 1);
});

test("stopping incremental playback discards prefetched audio and stale chunks never resume", async () => {
  const players = [];
  class AudioMock { constructor() { this.listeners = new Map(); players.push(this); } addEventListener(name, callback) { this.listeners.set(name, callback); } play() { return Promise.resolve(); } pause() {} removeAttribute() {} load() {} end() { this.listeners.get("ended")?.(); } }
  const playback = createAudioPlayback({ Audio: AudioMock, URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} } }); let ended = 0;
  playback.play({ async *[Symbol.asyncIterator]() { yield new Blob(["one"]); yield new Blob(["two"]); } }, { onEnded: () => { ended += 1; } });
  await Promise.resolve(); await Promise.resolve(); playback.stop(); players[0].end(); await Promise.resolve(); await Promise.resolve();
  assert.equal(players.length, 1); assert.equal(ended, 0);
});

test("first-byte timeout retries once and reports its safe phase without retrying forever", async () => {
  let calls = 0;
  const service = createVoiceService({ config: config({ ttsFirstByteTimeoutMs: 5, ttsStreamStallTimeoutMs: 5, ttsChunkTimeoutMs: 20 }), fetchImpl: withCapabilities(async (_url, { signal }) => {
    calls += 1;
    const body = new ReadableStream({ start(controller) { signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true }); } });
    return new Response(body, { status: 200, headers: { "content-type": "audio/mpeg" } });
  }) });
  await assert.rejects(service.synthesise({ text: "Wait for first byte" }), (error) => error instanceof VoiceProviderError && error.category === "provider_timeout_first_byte");
  assert.equal(calls, 2);
});

test("a stalled ElevenLabs stream is distinct from first-byte timeout and retries only once", async () => {
  let calls = 0;
  const service = createVoiceService({ config: config({ ttsFirstByteTimeoutMs: 20, ttsStreamStallTimeoutMs: 5, ttsChunkTimeoutMs: 30 }), fetchImpl: withCapabilities(async (_url, { signal }) => {
    calls += 1;
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("mp3-start")); signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true }); } });
    return new Response(body, { status: 200, headers: { "content-type": "audio/mpeg" } });
  }) });
  await assert.rejects(service.synthesise({ text: "Detect a stalled stream" }), (error) => error instanceof VoiceProviderError && error.category === "provider_stream_stalled");
  assert.equal(calls, 2);
});

test("client cancellation aborts ElevenLabs generation and is never retried", async () => {
  let calls = 0; const controller = new AbortController();
  const service = createVoiceService({ config: config(), fetchImpl: withCapabilities(async (_url, { signal }) => {
    calls += 1;
    const body = new ReadableStream({ start(streamController) { signal.addEventListener("abort", () => streamController.error(new DOMException("aborted", "AbortError")), { once: true }); } });
    return new Response(body, { status: 200 });
  }) });
  await service.capabilities();
  const result = service.synthesise({ text: "Cancel this turn" }, { signal: controller.signal }); controller.abort();
  await assert.rejects(result, (error) => error instanceof VoiceProviderError && error.category === "client_cancelled"); assert.ok(calls <= 1);
});

test("v3 conversational multi-chunk requests omit incompatible continuity fields without changing Arabic-English order", async () => {
  const requests = [];
  const service = createVoiceService({ config: config({ firstSpeechChunkCharacters: 55, nextSpeechChunkCharacters: 70 }), fetchImpl: withCapabilities(async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    return new Response(Buffer.from(`mp3:${body.text}`), { status: 200, headers: { "content-type": "audio/mpeg" } });
  }) });
  const text = "الحمد لله وضعي تمام. أنا Nova مساعدك الرقمي. نراجع Sharp Cuts API ثم missed-call recovery خطوة بخطوة. ونكمل كل التفاصيل بدون حذف أو تكرار.";
  const result = await service.synthesise({ text });
  assert.ok(requests.length > 1); assert.equal(result.spokenText, text);
  for (const body of requests) { assert.equal(body.model_id, "eleven_v3_conversational"); assert.equal("previous_text" in body, false); assert.equal("next_text" in body, false); }
  assert.equal(requests.map(({ text: chunk }) => chunk).join(" "), text);
});

test("incremental playback reports a later stream failure once and clears stale playback", async () => {
  const players = []; let errors = 0; let ended = 0;
  class AudioMock { constructor() { this.listeners = new Map(); players.push(this); } addEventListener(name, callback) { this.listeners.set(name, callback); } play() { return Promise.resolve(); } pause() {} removeAttribute() {} load() {} end() { this.listeners.get("ended")?.(); } }
  const playback = createAudioPlayback({ Audio: AudioMock, URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} } });
  playback.play({ async *[Symbol.asyncIterator]() { yield new Blob(["first"]); throw new Error("later chunk failed"); } }, { onEnded: () => { ended += 1; }, onError: () => { errors += 1; } });
  await new Promise((resolve) => setImmediate(resolve)); players[0].end(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors, 1); assert.equal(ended, 0); assert.equal(players.length, 1);
});

