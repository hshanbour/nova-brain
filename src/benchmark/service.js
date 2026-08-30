import { randomUUID } from "node:crypto";
import { estimateCost, estimateFullBenchmark, providerConfigured, PROVIDERS, STT_SAMPLES, TTS_SAMPLES } from "./catalog.js";
import { blindLabels, scoreTranscript, validateRatings } from "./scoring.js";

export class BenchmarkValidationError extends Error { constructor(message) { super(message); this.name = "BenchmarkValidationError"; } }
export class BenchmarkLockedError extends Error { constructor() { super("Paid benchmark calls are locked until the owner explicitly approves them."); this.name = "BenchmarkLockedError"; } }
export class BenchmarkUnavailableError extends Error { constructor(provider) { super(`${provider} is not configured for this Preview.`); this.name = "BenchmarkUnavailableError"; } }
export class BenchmarkBudgetError extends Error { constructor() { super("The Voice Benchmark hard budget cap would be exceeded."); this.name = "BenchmarkBudgetError"; } }

export function createVoiceBenchmark({ config, storage, ownerId, providers, clock = () => Date.now() }) {
  const benchmarkConfig = config.voiceBenchmark;
  const provider = (kind, id) => PROVIDERS[kind].find((item) => item.id === id);
  const sample = (kind, id) => (kind === "stt" ? STT_SAMPLES : TTS_SAMPLES).find((item) => item.id === id);
  const assertExecution = (kind, providerId) => {
    if (!benchmarkConfig.paidCallsApproved) throw new BenchmarkLockedError();
    const selected = provider(kind, providerId); if (!selected) throw new BenchmarkValidationError("Unknown benchmark provider.");
    if (!providerConfigured(benchmarkConfig, selected)) throw new BenchmarkUnavailableError(selected.name);
    return selected;
  };
  return Object.freeze({
    async readiness() {
      const spentUsd = await storage.sumVoiceBenchmarkCost(ownerId);
      const publicProvider = (item) => ({ id: item.id, name: item.name, model: item.model, ...(item.voice ? { voice: item.voice } : {}), ...(item.voices ? { voices: item.voices } : {}), ...(item.usdPerMinute ? { pricing: { basis: "audio minute", usd: item.usdPerMinute } } : { pricing: { basis: "1,000 characters", usd: item.usdPerThousandCharacters } }), status: providerConfigured(benchmarkConfig, item) ? "Configured" : "Missing", ...(item.pricingNote ? { pricingNote: item.pricingNote } : {}) });
      return { paidCallsApproved: benchmarkConfig.paidCallsApproved, budgetUsd: benchmarkConfig.budgetUsd, spentUsd, remainingUsd: Math.max(0, Math.round((benchmarkConfig.budgetUsd - spentUsd) * 1e6) / 1e6), estimatedFullBenchmarkUsd: estimateFullBenchmark(), rawAudioPolicy: "ephemeral-browser-and-request-only", latencyMeasurement: "batch request start to complete transcript or complete playable audio", sttSamples: STT_SAMPLES, ttsSamples: TTS_SAMPLES, providers: { stt: PROVIDERS.stt.map(publicProvider), tts: PROVIDERS.tts.map(publicProvider) } };
    },
    async createSession() { return storage.createVoiceBenchmarkSession({ id: randomUUID(), ownerId, budgetUsd: benchmarkConfig.budgetUsd, createdAt: new Date(clock()).toISOString() }); },
    async getSession(id) { const session = await storage.getVoiceBenchmarkSession(id, ownerId); return session && { ...session, results: (await storage.listVoiceBenchmarkResults(id, ownerId)).map(presentResult) }; },
    async runStt(input) {
      const selectedSample = sample("stt", input?.sampleId); if (!selectedSample) throw new BenchmarkValidationError("Unknown STT sample.");
      const audio = decodeAudio(input?.audioBase64); const durationSeconds = boundedNumber(input?.durationSeconds, 0.1, 30, "durationSeconds");
      if (audio.length > benchmarkConfig.maxAudioBytes) throw new BenchmarkValidationError("Audio sample is too large.");
      const selected = provider("stt", input?.providerId); const estimate = selected ? estimateCost({ kind: "stt", provider: selected, durationSeconds }) : 0;
      await assertSession(input?.sessionId); assertExecution("stt", input?.providerId);
      const resultId = randomUUID(); const started = clock();
      const reserved = await storage.reserveVoiceBenchmarkResult({ id: resultId, sessionId: input.sessionId, ownerId, kind: "stt", providerId: input.providerId, sampleId: selectedSample.id, label: selected.name, status: "running", estimatedCostUsd: estimate, metadata: { durationSeconds, mimeType: safeMime(input?.mimeType), pricingBasis: "audio minute" } }, benchmarkConfig.budgetUsd);
      if (!reserved) throw new BenchmarkBudgetError();
      try { const output = await providers.transcribe(input.providerId, { audio, mimeType: safeMime(input.mimeType), locale: selectedSample.locale }); const metrics = scoreTranscript(selectedSample.text, output.transcript); return storage.updateVoiceBenchmarkResult(resultId, ownerId, { status: "completed", latencyMs: clock() - started, transcript: output.transcript, metrics, model: output.model }); }
      catch (error) { await storage.updateVoiceBenchmarkResult(resultId, ownerId, { status: "failed", latencyMs: clock() - started, error: "Provider request failed." }); throw error; }
    },
    async runTts(input) {
      const selectedSample = sample("tts", input?.sampleId); if (!selectedSample) throw new BenchmarkValidationError("Unknown TTS sample.");
      const selected = provider("tts", input?.providerId); const estimate = selected ? estimateCost({ kind: "tts", provider: selected, text: selectedSample.text }) : 0;
      await assertSession(input?.sessionId); assertExecution("tts", input?.providerId);
      const assignments = blindLabels(PROVIDERS.tts.map((item) => item.id), `${input.sessionId}:${selectedSample.id}`); const label = assignments.find((item) => item.providerId === input.providerId)?.label;
      const resultId = randomUUID(); const started = clock();
      const reserved = await storage.reserveVoiceBenchmarkResult({ id: resultId, sessionId: input.sessionId, ownerId, kind: "tts", providerId: input.providerId, sampleId: selectedSample.id, label, status: "running", estimatedCostUsd: estimate, metadata: { locale: selectedSample.locale, characters: selectedSample.text.length, pricingBasis: "1,000 characters" } }, benchmarkConfig.budgetUsd);
      if (!reserved) throw new BenchmarkBudgetError();
      try { const output = await providers.synthesise(input.providerId, selectedSample); const result = await storage.updateVoiceBenchmarkResult(resultId, ownerId, { status: "completed", latencyMs: clock() - started, model: output.model, voice: output.voice }); return { ...presentResult(result), audioBase64: output.audio.toString("base64"), mimeType: output.mimeType }; }
      catch (error) { await storage.updateVoiceBenchmarkResult(resultId, ownerId, { status: "failed", latencyMs: clock() - started, error: "Provider request failed." }); throw error; }
    },
    async rate(resultId, input) { try { const ratings = validateRatings(input); const result = await storage.updateVoiceBenchmarkResult(resultId, ownerId, { ratings, revealed: true }); if (!result) throw new BenchmarkValidationError("Benchmark result not found."); return result; } catch (error) { if (error instanceof BenchmarkValidationError) throw error; throw new BenchmarkValidationError(error.message); } }
  });
  async function assertSession(id) { if (!id || !(await storage.getVoiceBenchmarkSession(id, ownerId))) throw new BenchmarkValidationError("Benchmark session not found."); }
}

function presentResult(result) { if (result.kind !== "tts" || result.revealed) return result; const { providerId, model, voice, ...blind } = result; return blind; }

function decodeAudio(value) { if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new BenchmarkValidationError("A base64 audio sample is required."); const audio = Buffer.from(value, "base64"); if (!audio.length) throw new BenchmarkValidationError("Audio sample is empty."); return audio; }
function boundedNumber(value, min, max, name) { const number = Number(value); if (!Number.isFinite(number) || number < min || number > max) throw new BenchmarkValidationError(`${name} must be between ${min} and ${max}.`); return number; }
function safeMime(value) { const mime = String(value || "").toLowerCase(); if (!/^audio\/(webm|wav|x-wav|ogg|mp4|mpeg)(;\s*codecs=[a-z0-9.-]+)?$/.test(mime)) throw new BenchmarkValidationError("Unsupported audio format."); return mime; }

