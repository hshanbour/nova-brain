import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { readConfig } from "../src/config/env.js";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";
import { createVoiceBenchmark, BenchmarkBudgetError, BenchmarkLockedError, BenchmarkUnavailableError } from "../src/benchmark/service.js";
import { blindLabels, scoreTranscript, validateRatings } from "../src/benchmark/scoring.js";
import { estimateFullBenchmark, PROVIDERS, STT_SAMPLES, TTS_SAMPLES } from "../src/benchmark/catalog.js";
import { createBenchmarkProviders, BenchmarkProviderError } from "../src/benchmark/providers.js";

function request({ method = "GET", url, body, headers = {} }) { const chunks = body === undefined ? [] : [Buffer.from(body)]; return { method, url, headers, async *[Symbol.asyncIterator]() { yield* chunks; } }; }
function response() { const headers = new Map(); return { statusCode: 0, setHeader(name, value) { headers.set(name.toLowerCase(), value); }, end(value = "") { this.body = String(value); }, headers }; }
async function api(app, options) { const res = response(); await app.handle(request(options), res); return { status: res.statusCode, body: JSON.parse(res.body), headers: res.headers }; }
function benchmarkConfig(environment = {}) { return readConfig({ NOVA_VOICE_BENCHMARK_PAID_CALLS_APPROVED: "true", OPENAI_API_KEY: "openai-secret", DEEPGRAM_API_KEY: "deepgram-secret", ELEVENLABS_API_KEY: "eleven-secret", ELEVENLABS_VOICE_ID: "voice-secret", AZURE_SPEECH_KEY: "azure-secret", AZURE_SPEECH_REGION: "uksouth", ...environment }); }
async function service({ config = benchmarkConfig(), providers, ownerId = "owner-a", clock } = {}) { const storage = createInMemoryStorage(); const implementation = providers || { async transcribe() { return { transcript: STT_SAMPLES[0].text, model: "test-stt" }; }, async synthesise() { return { audio: Buffer.from("audio"), mimeType: "audio/mpeg", model: "test-tts", voice: "test-voice" }; } }; const benchmark = createVoiceBenchmark({ config, storage, ownerId, providers: implementation, clock }); const session = await benchmark.createSession(); return { benchmark, storage, session }; }

test("readiness exposes fixed benchmark design and configured/missing status without leaking secrets", async () => {
  const app = createApp({ environment: { OPENAI_API_KEY: "sk-super-secret", OPENAI_MODEL: "gpt-test" } });
  const result = await api(app, { url: "/api/voice-benchmark/readiness" });
  assert.equal(result.status, 200); assert.equal(result.body.paidCallsApproved, false); assert.equal(result.body.budgetUsd, 2); assert.equal(result.body.sttSamples.length, 5); assert.equal(result.body.ttsSamples.length, 3);
  assert.equal(result.body.providers.stt.find(({ id }) => id === "openai").status, "Configured"); assert.equal(result.body.providers.stt.find(({ id }) => id === "deepgram").status, "Missing");
  const serialized = JSON.stringify(result.body); for (const secret of ["sk-super-secret", "openai-secret", "deepgram-secret", "azure-secret"]) assert.doesNotMatch(serialized, new RegExp(secret));
});

test("paid STT execution is blocked before any provider call until owner approval", async () => {
  let calls = 0; const config = readConfig({ OPENAI_API_KEY: "secret" }); const { benchmark, session } = await service({ config, providers: { async transcribe() { calls += 1; }, async synthesise() {} } });
  await assert.rejects(benchmark.runStt({ sessionId: session.id, providerId: "openai", sampleId: "stt-a", audioBase64: "YXVkaW8=", mimeType: "audio/webm", durationSeconds: 1 }), BenchmarkLockedError); assert.equal(calls, 0);
});

test("API reports unavailable providers without attempting a paid request", async () => {
  const app = createApp({ environment: { NOVA_VOICE_BENCHMARK_PAID_CALLS_APPROVED: "true" } }); const created = await api(app, { method: "POST", url: "/api/voice-benchmark/sessions" });
  const result = await api(app, { method: "POST", url: "/api/voice-benchmark/stt", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: created.body.session.id, providerId: "deepgram", sampleId: "stt-a", audioBase64: "YXVkaW8=", mimeType: "audio/webm", durationSeconds: 1 }) });
  assert.equal(result.status, 503); assert.equal(result.body.code, "BENCHMARK_PROVIDER_UNAVAILABLE"); assert.doesNotMatch(JSON.stringify(result.body), /secret|api[_-]?key/i);
});

test("hard budget cap includes durable reservations across sessions", async () => {
  const config = benchmarkConfig({ NOVA_VOICE_BENCHMARK_BUDGET_USD: "0.01" }); const { benchmark, storage, session } = await service({ config });
  await storage.createVoiceBenchmarkResult({ id: "prior", sessionId: session.id, ownerId: "owner-a", kind: "stt", providerId: "openai", sampleId: "stt-a", label: "prior", status: "completed", estimatedCostUsd: 0.009 });
  await assert.rejects(benchmark.runStt({ sessionId: session.id, providerId: "openai", sampleId: "stt-a", audioBase64: "YXVkaW8=", mimeType: "audio/webm", durationSeconds: 30 }), BenchmarkBudgetError);
  assert.throws(() => readConfig({ NOVA_VOICE_BENCHMARK_BUDGET_USD: "2.01" }), /no more than 2/);
});

test("simultaneous benchmark requests cannot race past the hard budget cap", async () => {
  let calls = 0; const config = benchmarkConfig({ NOVA_VOICE_BENCHMARK_BUDGET_USD: "0.01" });
  const { benchmark, session } = await service({ config, providers: { async transcribe() { calls += 1; return { transcript: STT_SAMPLES[0].text, model: "test-stt" }; }, async synthesise() {} } });
  const input = { sessionId: session.id, providerId: "openai", sampleId: "stt-a", audioBase64: "YXVkaW8=", mimeType: "audio/webm", durationSeconds: 30 };
  const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => benchmark.runStt(input)));
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 4);
  assert.equal(outcomes.filter(({ reason }) => reason instanceof BenchmarkBudgetError).length, 1);
  assert.equal(calls, 4);
});

test("storage persists benchmark metadata but strips raw audio and enforces owner isolation", async () => {
  const { storage, session } = await service();
  const result = await storage.createVoiceBenchmarkResult({ id: "result-1", sessionId: session.id, ownerId: "owner-a", kind: "stt", providerId: "openai", sampleId: "stt-a", label: "OpenAI", status: "running", estimatedCostUsd: 0.001, audio: Buffer.from("private"), audioBase64: "private", audioData: "private" });
  assert.equal(result.audio, undefined); assert.equal(result.audioBase64, undefined); assert.equal(result.audioData, undefined);
  assert.equal(await storage.getVoiceBenchmarkSession(session.id, "owner-b"), null); assert.deepEqual(await storage.listVoiceBenchmarkResults(session.id, "owner-b"), []); assert.equal(await storage.updateVoiceBenchmarkResult("result-1", "owner-b", { transcript: "stolen" }), null);
});

test("STT scoring covers words, names, numbers, script and code switching", () => {
  const perfect = scoreTranscript("محمد Sharp Cuts يوم 15", "محمد Sharp Cuts يوم 15"); assert.deepEqual(perfect, { similarity: 1, wordErrorRate: 0, properNameRecall: 1, numberRecall: 1, scriptMatch: true, codeSwitchPreserved: true });
  const partial = scoreTranscript("محمد Nova 15", "محمد نوفا 16"); assert.ok(partial.similarity < 1); assert.equal(partial.numberRecall, 0); assert.equal(partial.codeSwitchPreserved, false);
});

test("fixed provider mappings and total maximum estimate remain bounded", () => {
  assert.deepEqual(PROVIDERS.stt.map(({ id, model }) => [id, model]), [["openai", "gpt-transcribe"], ["deepgram", "nova-3"], ["azure", "ar-JO"]]);
  assert.deepEqual(PROVIDERS.tts.map(({ id, model }) => [id, model]), [["elevenlabs", "eleven_v3_conversational"], ["openai", "gpt-4o-mini-tts"], ["azure", "neural"]]);
  assert.equal(PROVIDERS.tts[2].voices["ar-JO"], "ar-JO-SanaNeural"); assert.ok(estimateFullBenchmark() > 0 && estimateFullBenchmark() < 0.25);
});

test("blind labels are deterministic, unique, and reveal only after valid ratings", async () => {
  const first = blindLabels(["openai", "azure", "elevenlabs"], "session:sample"); const second = blindLabels(["openai", "azure", "elevenlabs"], "session:sample"); assert.deepEqual(first, second); assert.deepEqual(new Set(first.map(({ label }) => label)).size, 3);
  const { benchmark, session } = await service(); const blind = await benchmark.runTts({ sessionId: session.id, providerId: "openai", sampleId: "tts-ar" }); assert.equal(blind.providerId, undefined); assert.match(blind.label, /^Voice [ABC]$/);
  await assert.rejects(benchmark.rate(blind.id, { naturalness: 6, humanLikeQuality: 4, clarity: 4, mixedLanguageQuality: 4 }), /naturalness/);
  const revealed = await benchmark.rate(blind.id, { naturalness: 5, humanLikeQuality: 4, clarity: 5, mixedLanguageQuality: 4, notes: "Natural" }); assert.equal(revealed.providerId, "openai"); assert.equal(revealed.ratings.naturalness, 5); assert.equal(revealed.revealed, true);
  assert.deepEqual(validateRatings({ naturalness: "1", humanLikeQuality: "2", clarity: "3", mixedLanguageQuality: "4" }).clarity, 3);
});

test("provider adapters use the intended endpoints and never include upstream secret bodies in errors", async () => {
  const calls = []; const fetchImpl = async (url, options) => { calls.push({ url: String(url), options }); if (String(url).includes("transcriptions")) return new Response(JSON.stringify({ text: "ok" }), { status: 200, headers: { "content-type": "application/json" } }); return new Response("upstream says key=secret", { status: 401 }); };
  const providers = createBenchmarkProviders({ config: benchmarkConfig().voiceBenchmark, fetchImpl }); await providers.transcribe("openai", { audio: Buffer.from("audio"), mimeType: "audio/webm", locale: "ar-JO" }); assert.match(calls[0].url, /\/v1\/audio\/transcriptions$/); assert.match(calls[0].options.headers.Authorization, /^Bearer /);
  await assert.rejects(providers.synthesise("openai", { text: "hello", locale: "en-GB" }), (error) => error instanceof BenchmarkProviderError && error.upstreamStatus === 401 && !error.message.includes("secret"));
});

