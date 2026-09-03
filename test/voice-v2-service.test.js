import test from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../src/config/env.js";
import { createVoiceService, VoiceProviderError, VoiceTimeoutError, VoiceValidationError } from "../src/voice/voice-service.js";
import { sanitiseSpeechText } from "../src/voice/speech-text.js";
import { createApp } from "../src/app.js";
import { createApi } from "../src/http/api.js";
import { createVoiceV2Client } from "../assets/voice-v2-client.js";

const environment = { OPENAI_API_KEY: "openai-super-secret", ELEVENLABS_API_KEY: "eleven-super-secret", ELEVENLABS_VOICE_ID: "owner-voice-id" };
const models = [{ model_id: "eleven_v3_conversational", can_do_text_to_speech: true, languages: [{ language_id: "ar", name: "Arabic" }, { language_id: "en", name: "English" }] }, { model_id: "eleven_flash_v2_5", can_do_text_to_speech: true }];
function withCapabilities(handler = async () => new Response(Buffer.from("mp3"), { status: 200, headers: { "content-type": "audio/mpeg" } }), { availableModels = models, voice = { voice_id: environment.ELEVENLABS_VOICE_ID, high_quality_base_model_ids: ["eleven_v3_conversational"] } } = {}) {
  return async (url, options) => {
    if (url === "https://api.elevenlabs.io/v1/models") return new Response(JSON.stringify(availableModels), { status: 200, headers: { "content-type": "application/json" } });
    if (String(url).startsWith("https://api.elevenlabs.io/v1/voices/")) return new Response(JSON.stringify(voice), { status: 200, headers: { "content-type": "application/json" } });
    if (url === "https://api.elevenlabs.io/v1/user/subscription") return new Response(JSON.stringify({ tier:"free",status:"active",character_count:1200,character_limit:10000,next_character_count_reset_unix:2000000000,character_refresh_period:"monthly_period",max_credit_limit_extension:0 }), { status: 200, headers: { "content-type": "application/json" } });
    return handler(url, options);
  };
}
function request({ method = "GET", url, body, headers = {} }) { const chunks = body === undefined ? [] : [Buffer.from(body)]; return { method, url, headers, async *[Symbol.asyncIterator]() { yield* chunks; } }; }
function response() { const headers = new Map(); return { statusCode: 0, chunks: [], setHeader(name, value) { headers.set(name.toLowerCase(), value); }, write(value = "") { this.chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value))); return true; }, end(value = "") { if (value) this.write(value); this.body = Buffer.concat(this.chunks); this.writableEnded = true; }, headers }; }
async function api(app, options) { const res = response(); await app.handle(request(options), res); return { status: res.statusCode, body: JSON.parse(res.body.toString()), headers: res.headers }; }

test("Voice V2 readiness exposes models and limits without exposing credentials or the voice id", async () => {
  const app = createApp({ environment, voiceFetchImpl: withCapabilities() }); const result = await api(app, { url: "/api/voice/readiness" }); assert.equal(result.status, 200); assert.equal(result.body.available, true);
  assert.equal(result.body.stt.model, "gpt-transcribe"); assert.equal(result.body.tts.model, "eleven_v3_conversational"); assert.equal(result.body.rawAudioPolicy, "ephemeral-request-only");
  assert.equal(result.body.tts.status, "Verified"); assert.equal(result.body.tts.capability, "account-model-and-voice-access-verified"); assert.equal(result.body.tts.fallbackUsed, false);
  const serialized = JSON.stringify(result.body); for (const secret of Object.values(environment)) assert.equal(serialized.includes(secret), false);
});

test("GPT-Transcribe request preserves mixed language by using hints without forcing one language", async () => {
  let call; const fetchImpl = async (url, options) => { call = { url, options }; return new Response(JSON.stringify({ text: "مرحبا Nova API رقم 35" }), { status: 200, headers: { "content-type": "application/json" } }); };
  const service = createVoiceService({ config: readConfig(environment), fetchImpl }); const result = await service.transcribe({ audioBase64: "YXVkaW8=", mimeType: "audio/webm;codecs=opus", durationSeconds: 1 });
  assert.equal(result.transcript, "مرحبا Nova API رقم 35"); assert.equal(call.url, "https://api.openai.com/v1/audio/transcriptions"); assert.match(call.options.headers.Authorization, /^Bearer /);
  assert.equal(call.options.body.get("model"), "gpt-transcribe"); assert.equal(call.options.body.has("language"), false); assert.match(call.options.body.get("prompt"), /Sharp Cuts.*API.*numbers/s);
});

test("multi-chunk WebM survives client base64 and server multipart decoding intact", async () => {
  const source = new Blob([
    new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
    new Uint8Array([0x01, 0x02]),
    new Uint8Array([0x03, 0x04]),
    new Uint8Array([0x05, 0x06])
  ], { type: "audio/webm;codecs=opus" });
  let clientPayload;
  const client = createVoiceV2Client({ fetchImpl: async (_url, options) => {
    clientPayload = JSON.parse(options.body);
    return new Response(JSON.stringify({ transcript: "complete container" }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  await client.transcribe({ audio: source, mimeType: source.type, durationSeconds: 1.2 });

  const original = new Uint8Array(await source.arrayBuffer());
  assert.deepEqual(new Uint8Array(Buffer.from(clientPayload.audioBase64, "base64")), original);
  assert.equal(clientPayload.mimeType, "audio/webm;codecs=opus");
  assert.equal(clientPayload.durationSeconds, 1.2);

  const service = createVoiceService({ config: readConfig(environment), fetchImpl: async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/audio/transcriptions");
    assert.equal(options.body.get("model"), "gpt-transcribe");
    const file = options.body.get("file");
    assert.equal(file.name, "voice.webm"); assert.equal(file.type, source.type); assert.equal(file.size, original.length);
    const uploaded = new Uint8Array(await file.arrayBuffer());
    assert.deepEqual(uploaded, original); assert.deepEqual([...uploaded.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
    return new Response(JSON.stringify({ text: "complete container" }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const result = await service.transcribe(clientPayload);
  assert.equal(result.transcript, "complete container");
});

test("Voice V2 validates mime type, duration and audio size before provider calls", async () => {
  let calls = 0; const service = createVoiceService({ config: readConfig(environment), fetchImpl: async () => { calls += 1; } });
  await assert.rejects(service.transcribe({ audioBase64: "YXVkaW8=", mimeType: "text/plain", durationSeconds: 1 }), VoiceValidationError);
  await assert.rejects(service.transcribe({ audioBase64: "YXVkaW8=", mimeType: "audio/webm", durationSeconds: 31 }), VoiceValidationError);
  await assert.rejects(service.transcribe({ audioBase64: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64"), mimeType: "audio/webm", durationSeconds: 1 }), VoiceValidationError); assert.equal(calls, 0);
});

test("ElevenLabs uses the owner-selected voice and conversational multilingual model with sanitised natural text", async () => {
  let call; const fetchImpl = async (url, options) => { call = { url, options }; return new Response(Buffer.from("mp3"), { status: 200, headers: { "content-type": "audio/mpeg" } }); };
  const service = createVoiceService({ config: readConfig(environment), fetchImpl: withCapabilities(fetchImpl) }); const result = await service.synthesise({ text: "## Hello 😊 [Mohammad](https://example.com)\n```json\n{\"tool\":true}\n```\nTool trace: hidden" });
  assert.match(call.url, /owner-voice-id\/stream/); assert.equal(call.options.headers["xi-api-key"], environment.ELEVENLABS_API_KEY);
  const payload = JSON.parse(call.options.body); assert.equal(payload.model_id, "eleven_v3_conversational"); assert.equal(payload.text, "Hello Mohammad"); assert.equal(result.spokenText, "Hello Mohammad");
});

test("capability preflight selects only an account-supported TTS model and exposes a visible fallback", async () => {
  const service = createVoiceService({ config: readConfig(environment), fetchImpl: withCapabilities(undefined, { availableModels: [{ model_id: "eleven_flash_v2_5", can_do_text_to_speech: true }] }) });
  const readiness = await service.readiness();
  assert.equal(readiness.available, true); assert.equal(readiness.tts.model, "eleven_flash_v2_5"); assert.equal(readiness.tts.fallbackUsed, true); assert.equal(readiness.tts.selection, "low-latency-multilingual-fallback");
});

test("scoped TTS keys verify the owner voice through a bounded direct speech probe when metadata reads are denied", async () => {
  const speechRequests = [];
  const service = createVoiceService({ config: readConfig(environment), fetchImpl: async (url, options) => {
    if (url === "https://api.elevenlabs.io/v1/models" || String(url).startsWith("https://api.elevenlabs.io/v1/voices/")) {
      return new Response(JSON.stringify({ detail: { status: "missing_permissions" } }), { status: 401, headers: { "content-type": "application/json" } });
    }
    speechRequests.push({ url, body: JSON.parse(options.body) });
    return new Response(Buffer.from("verified-mp3"), { status: 200, headers: { "content-type": "audio/mpeg" } });
  } });
  const readiness = await service.readiness();
  assert.equal(readiness.available, true); assert.equal(readiness.tts.model, "eleven_v3_conversational");
  assert.equal(readiness.tts.capability, "direct-speech-generation-verified"); assert.equal(readiness.tts.voiceCompatibility, "owner-voice-generation-verified");
  assert.equal(speechRequests.length, 1); assert.match(speechRequests[0].url, /owner-voice-id\/stream\?output_format=mp3_44100_128/);
  assert.deepEqual(speechRequests[0].body, { text: "Nova is ready.", model_id: "eleven_v3_conversational", voice_settings:{stability:0.75} });
});

test("capability preflight catches an unavailable model set before a paid speech request", async () => {
  let speechCalls = 0;
  const service = createVoiceService({ config: readConfig(environment), fetchImpl: withCapabilities(async () => { speechCalls += 1; return new Response(Buffer.from("unexpected")); }, { availableModels: [{ model_id: "image-only", can_do_text_to_speech: false }] }) });
  const readiness = await service.readiness();
  assert.equal(readiness.available, false); assert.equal(readiness.tts.status, "Unavailable"); assert.equal(readiness.tts.errorCategory, "model"); assert.equal(speechCalls, 0);
});

test("unsupported_model is classified, never retried, and does not expose the provider body", async () => {
  let calls = 0;
  const service = createVoiceService({ config: readConfig(environment), fetchImpl: withCapabilities(async () => {
    calls += 1; return new Response(JSON.stringify({ detail: { code: "unsupported_model", message: "secret provider explanation" } }), { status: 400, headers: { "content-type": "application/json", "request-id": "safe-model-request" } });
  }) });
  await assert.rejects(service.synthesise({ text: "Hello" }), (error) => {
    assert.ok(error instanceof VoiceProviderError); assert.equal(error.category, "model"); assert.equal(error.providerCode, "unsupported_model"); assert.equal(error.safeDetail.attempt, 1); assert.doesNotMatch(JSON.stringify(error), /secret provider explanation/); return true;
  });
  assert.equal(calls, 1);
});

test("speech sanitisation removes markdown, emoji, URLs, tool traces and JSON while bounding output", () => {
  assert.equal(sanitiseSpeechText("Hi 😊 **Mohammad** https://example.com\nMetadata: private"), "Hi Mohammad");
  assert.equal(sanitiseSpeechText('{"tool":"secret"}'), ""); assert.ok(sanitiseSpeechText("Sentence. ".repeat(500), 120).length <= 120);
});

test("ElevenLabs 401 is safely categorized and never retried", async () => {
  let calls = 0; const service = createVoiceService({ config: readConfig(environment), fetchImpl: withCapabilities(async () => { calls += 1; return new Response(JSON.stringify({ detail: { status: "invalid_api_key", message: "Invalid API key eleven-super-secret" } }), { status: 401, headers: { "content-type": "application/json", "request-id": "el-safe-request-1" } }); }) });
  await assert.rejects(service.synthesise({ text: "Hello" }), (error) => {
    assert.ok(error instanceof VoiceProviderError); assert.equal(error.upstreamStatus, 401); assert.equal(error.category, "authentication"); assert.equal(error.providerCode, "invalid_api_key");
    assert.deepEqual(error.safeDetail, { operation: "synthesise", model: "eleven_v3_conversational", textCharacters: 5, chunkIndex: 0, chunkCount: 1, attempt: 1, retryCount: 0, providerRequestId: "el-safe-request-1", phase: "authentication" });
    assert.doesNotMatch(JSON.stringify(error), /eleven-super-secret|Invalid API key/); return true;
  });
  assert.equal(calls, 1);
});

test("ElevenLabs quota-shaped 401 and voice access denial receive distinct safe categories", async () => {
  for (const [status, detail, category] of [
    [401, { status: "quota_exceeded", message: "This request exceeds your quota limit" }, "quota"],
    [403, { code: "voice_access_denied", type: "authorization_error", message: "Voice unavailable" }, "voice_access"]
  ]) {
    const service = createVoiceService({ config: readConfig(environment), fetchImpl: withCapabilities(async () => new Response(JSON.stringify({ detail }), { status, headers: { "content-type": "application/json" } })) });
    await assert.rejects(service.synthesise({ text: "Hello" }), (error) => error instanceof VoiceProviderError && error.category === category);
  }
});

test("ElevenLabs retries one retryable failure with a fresh request and returns one audio result", async () => {
  let calls = 0; const requests = []; const base = readConfig(environment); const config = { ...base, voiceV2: { ...base.voiceV2, ttsRetryDelayMs: 0 } };
  const service = createVoiceService({ config, fetchImpl: withCapabilities(async (_url, options) => {
    calls += 1; requests.push(options);
    if (calls === 1) return new Response(JSON.stringify({ detail: { code: "rate_limit_exceeded", type: "rate_limit_error", message: "Try later" } }), { status: 429, headers: { "content-type": "application/json", "request-id": "el-retry-1" } });
    return new Response(Buffer.from("one-final-mp3"), { status: 200, headers: { "content-type": "audio/mpeg" } });
  }) });
  const result = await service.synthesise({ text: "Hello once" }); assert.equal(result.audio.toString(), "one-final-mp3"); assert.equal(calls, 2);
  assert.notEqual(requests[0], requests[1]); assert.notEqual(requests[0].headers, requests[1].headers); assert.equal(requests[0].headers["xi-api-key"], environment.ELEVENLABS_API_KEY); assert.equal(requests[1].headers["xi-api-key"], environment.ELEVENLABS_API_KEY);
});

test("transcription failures retain only bounded safe diagnostic metadata", async () => {
  const service = createVoiceService({ config: readConfig(environment), fetchImpl: async () => new Response(JSON.stringify({ error: { code: "invalid_value", type: "invalid_request_error", message: "Invalid file format for audio/webm secret-provider-body" } }), { status: 400, headers: { "content-type": "application/json" } }) });
  await assert.rejects(service.transcribe({ audioBase64: "YXVkaW8=", mimeType: "audio/webm;codecs=opus", durationSeconds: 1.25 }), (error) => {
    assert.ok(error instanceof VoiceProviderError); assert.equal(error.upstreamStatus, 400); assert.equal(error.category, "invalid_audio"); assert.equal(error.providerCode, "invalid_value");
    assert.deepEqual(error.safeDetail, { operation: "transcribe", mimeType: "audio/webm;codecs=opus", fileName: "voice.webm", audioBytes: 5, durationSeconds: 1.25 });
    assert.doesNotMatch(JSON.stringify(error), /secret-provider-body|openai-super-secret/); return true;
  });
});

test("voice provider timeout remains bounded and reports no secret detail", async () => {
  const service = createVoiceService({ config: readConfig(environment), fetchImpl: async (_url, { signal }) => { assert.equal(signal.aborted, true); throw new DOMException("aborted", "AbortError"); }, schedule(callback) { callback(); return 1; }, cancelSchedule() {} });
  await assert.rejects(service.transcribe({ audioBase64: "YXVkaW8=", mimeType: "audio/webm", durationSeconds: 1 }), VoiceTimeoutError);
});

test("speech API streams no-store ordered playable chunks without exposing provider metadata", async () => {
  const handler = createApi({ config: readConfig({}), agent: {}, storage: {}, initialize: async () => {}, ownerId: "owner", voiceBenchmark: {}, voiceService: { async *streamSpeech() { yield { audio: Buffer.from("mp3"), mimeType: "audio/mpeg", model: "eleven_v3_conversational", index: 0, chunkCount: 1 }; } }, logger: { info() {}, error() {} } });
  const res = response(); await handler.handle(request({ method: "POST", url: "/api/voice/speech", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Hello" }) }), res);
  const events = res.body.toString().trim().split("\n").map(JSON.parse);
  assert.equal(res.statusCode, 200); assert.equal(Buffer.from(events[0].audioBase64, "base64").toString(), "mp3"); assert.equal(events[1].type, "end");
  assert.equal(res.headers.get("content-type"), "application/x-ndjson; charset=utf-8"); assert.equal(res.headers.get("cache-control"), "no-store"); assert.equal(res.headers.get("x-nova-voice-model"), "eleven_v3_conversational"); assert.equal(res.headers.get("x-nova-voice-protocol"), "semantic-audio-stream-v1");
});

test("Voice V2 API rejects invalid recordings with bounded safe errors", async () => {
  const app = createApp({ environment }); const result = await api(app, { method: "POST", url: "/api/voice/transcribe", headers: { "content-type": "application/json" }, body: JSON.stringify({ audioBase64: "YXVkaW8=", mimeType: "text/plain", durationSeconds: 1 }) });
  assert.equal(result.status, 400); assert.equal(result.body.code, "VOICE_VALIDATION"); assert.doesNotMatch(JSON.stringify(result.body), /super-secret|owner-voice-id/);
});

test("Voice V2 API logs safe provider category while keeping its 502 generic", async () => {
  const entries = []; const failure = new VoiceProviderError("openai transcription", "OpenAI transcription request failed.", 400, "invalid_audio", "invalid_value");
  failure.safeDetail = { operation: "transcribe", mimeType: "audio/webm", fileName: "voice.webm", audioBytes: 42, durationSeconds: 1 };
  const handler = createApi({ config: readConfig({}), agent: {}, storage: {}, initialize: async () => {}, ownerId: "owner", voiceBenchmark: {}, voiceService: { async transcribe() { throw failure; } }, logger: { error(...args) { entries.push(args); } } });
  const res = response(); await handler.handle(request({ method: "POST", url: "/api/voice/transcribe", headers: { "content-type": "application/json" }, body: JSON.stringify({ audioBase64: "YXVkaW8=", mimeType: "audio/webm", durationSeconds: 1 }) }), res);
  assert.equal(res.statusCode, 502); assert.deepEqual(JSON.parse(res.body), { error: "Voice provider request failed. Your written conversation is safe.", code: "VOICE_PROVIDER_ERROR", category: "invalid_audio" });
  assert.equal(entries[0][0], "Nova voice provider failed"); assert.equal(entries[0][1].category, "invalid_audio"); assert.equal(entries[0][1].upstreamStatus, 400); assert.deepEqual(entries[0][1].detail, failure.safeDetail);
  assert.doesNotMatch(JSON.stringify({ response: JSON.parse(res.body), entries }), /super-secret|owner-voice-id|secret-provider-body/);
});

test("real Voice transcribe invokes speaker extraction in parallel and returns a signed verified owner",async()=>{const entries=[];let extractorOptions;const handler=createApi({config:readConfig({}),agent:{},storage:{},initialize:async()=>{},ownerId:"owner",voiceBenchmark:{},voiceService:{async transcribe(){await Promise.resolve();return{transcript:"مرحبا Nova"};}},speakerExtractor:{configured:true,async extract(input,options){extractorOptions=options;assert.equal(input.durationSeconds,2.4);return{sufficient:true,representation:[1,0,0],extractorVersion:"ecapa-v1",latencyMs:37,totalDurationSeconds:2.4,speechSeconds:1.9,silenceRatio:.21,sampleRate:48000,channelCount:1,preprocessingVersion:"decode-mono-16k-rms-vad-v2",quality:"accepted"};}},speakerIdentity:{async recognize(){return{state:"confirmed",speakerProfileId:"owner-profile",relation:"owner",confidence:.913,candidateCount:1,threshold:.35,ambiguityMargin:.05,scoreMargin:null,bestCandidateCategory:"owner"};},async candidateCount(){return 1;}},speakerAssertions:{issue(speaker){return speaker.match_status==="confirmed"?"signed-owner":null;}},logger:{info(...args){entries.push(args);},error(...args){entries.push(args);}}});const result=await api(handler,{method:"POST",url:"/api/voice/transcribe",headers:{"content-type":"application/json"},body:JSON.stringify({audioBase64:"YXVkaW8=",mimeType:"audio/webm",durationSeconds:2.4})});assert.equal(result.status,200);assert.equal(result.body.transcript,"مرحبا Nova");assert.deepEqual(result.body.speaker,{speaker_profile_id:"owner-profile",speaker_label:"owner",confidence:.913,extractor_version:"ecapa-v1",match_status:"confirmed",authenticated_identity:"owner",speaker_familiarity:"none",anonymous_speaker_id:null,assertion:"signed-owner"});assert.match(extractorOptions.requestId,/^[0-9a-f-]{36}$/);assert.equal(entries.find(([message])=>message==="Nova speaker recognition started")[1].extractorConfigured,true);const completed=entries.find(([message])=>message==="Nova speaker recognition completed")[1];assert.equal(completed.candidateCount,1);assert.equal(completed.matchStatus,"confirmed");assert.equal(completed.recognizedProfileId,"owner-profile");assert.equal(completed.threshold,.35);assert.equal(completed.bestCandidateCategory,"owner");assert.equal(completed.voicedDurationSeconds,1.9);assert.equal(completed.silenceRatio,.21);assert.equal(completed.preprocessingVersion,"decode-mono-16k-rms-vad-v2");assert.equal(completed.qualityGateResult,"accepted");});

test("owner authentication always takes precedence over anonymous familiarity consent",async()=>{let familiarityCalls=0;const handler=createApi({config:readConfig({}),agent:{},storage:{},initialize:async()=>{},ownerId:"owner",voiceBenchmark:{},voiceService:{async transcribe(){return{transcript:"hello"};}},speakerExtractor:{configured:true,async extract(){return{sufficient:true,representation:[1,0,0],extractorVersion:"ecapa",latencyMs:10};}},speakerIdentity:{async recognize(){return{state:"confirmed",speakerProfileId:"owner-profile",relation:"owner",confidence:.9,candidateCount:1};},async rememberAnonymous(){familiarityCalls++;}},speakerAssertions:{issue(){return"signed";}},familiarityConsent:{verify(){return{consent_actor:"Guest"};}},logger:{info(){},error(){}}});const result=await api(handler,{method:"POST",url:"/api/voice/transcribe",headers:{"content-type":"application/json"},body:JSON.stringify({audioBase64:"YXVkaW8=",mimeType:"audio/webm",durationSeconds:2,familiarityConsent:"valid"})});assert.equal(result.status,200);assert.equal(result.body.speaker.authenticated_identity,"owner");assert.equal(result.body.speaker.speaker_familiarity,"none");assert.equal(familiarityCalls,0);});

test("unknown high-quality voice becomes familiar only with a valid explicit consent token",async()=>{let familiarityCalls=0;const make=(verify)=>createApi({config:readConfig({}),agent:{},storage:{},initialize:async()=>{},ownerId:"owner",voiceBenchmark:{},voiceService:{async transcribe(){return{transcript:"I'm Mohammad"};}},speakerExtractor:{configured:true,async extract(){return{sufficient:true,representation:[1,0,0],extractorVersion:"ecapa",latencyMs:10};}},speakerIdentity:{async recognize(){return{state:"unknown",confidence:.1,candidateCount:1};},async rememberAnonymous(){familiarityCalls++;return{state:"first_time_unknown",anonymousSpeakerId:"anonymous-1",candidateCount:0,confidence:0};}},speakerAssertions:{issue(speaker){return JSON.stringify({authenticated_identity:speaker.authenticated_identity,speaker_familiarity:speaker.speaker_familiarity,anonymous_speaker_id:speaker.anonymous_speaker_id});}},familiarityConsent:{verify},logger:{info(){},error(){}}});const input={method:"POST",url:"/api/voice/transcribe",headers:{"content-type":"application/json"},body:JSON.stringify({audioBase64:"YXVkaW8=",mimeType:"audio/webm",durationSeconds:2,familiarityConsent:"token"})};const without=await api(make(()=>null),input);assert.equal(without.body.speaker.speaker_familiarity,"none");assert.equal(familiarityCalls,0);const withConsent=await api(make(()=>({consent_actor:"Guest",self_reported_name:"Ahmad"})),input);assert.equal(withConsent.body.speaker.authenticated_identity,"none");assert.equal(withConsent.body.speaker.speaker_familiarity,"first_time_unknown");assert.equal(withConsent.body.speaker.anonymous_speaker_id,"anonymous-1");assert.equal(familiarityCalls,1);});

test("empty STT result discards the parallel embedding instead of producing a recognition decision",async()=>{let recognitionCalls=0;const handler=createApi({config:readConfig({}),agent:{},storage:{},initialize:async()=>{},ownerId:"owner",voiceBenchmark:{},voiceService:{async transcribe(){return{transcript:""};}},speakerExtractor:{configured:true,async extract(){return{sufficient:true,representation:[1,0,0],representationVariants:[{label:"vad_v3",representation:[1,0,0]}],extractorVersion:"ecapa",latencyMs:10,quality:"accepted"};}},speakerIdentity:{async recognizeMany(){recognitionCalls++;},async candidateCount(){return 1;}},speakerAssertions:{issue(){return"signed-unknown";}},logger:{info(){},error(){}}});const result=await api(handler,{method:"POST",url:"/api/voice/transcribe",headers:{"content-type":"application/json"},body:JSON.stringify({audioBase64:"YXVkaW8=",mimeType:"audio/webm",durationSeconds:4})});assert.equal(result.status,200);assert.equal(result.body.speaker.match_status,"non_speech");assert.equal(result.body.speaker.authenticated_identity,"none");assert.equal(recognitionCalls,0);});

