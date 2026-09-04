import { chunkSpeechText, sanitiseSpeechText } from "./speech-text.js";
import { elevenLabsModelCandidates, elevenLabsRequestBody, selectElevenLabsModel } from "./elevenlabs-models.js";
import { createHash, randomUUID } from "node:crypto";

const OPENAI_TRANSCRIPTIONS = "https://api.openai.com/v1/audio/transcriptions";
const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1/text-to-speech";
const ELEVENLABS_MODELS = "https://api.elevenlabs.io/v1/models";
const ELEVENLABS_VOICES = "https://api.elevenlabs.io/v1/voices";
const ELEVENLABS_SUBSCRIPTION = "https://api.elevenlabs.io/v1/user/subscription";
const MIME_TYPES = new Set(["audio/webm", "audio/webm;codecs=opus", "audio/ogg", "audio/ogg;codecs=opus", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav"]);

export class VoiceValidationError extends Error { constructor(message) { super(message); this.name = "VoiceValidationError"; } }
export class VoiceUnavailableError extends Error { constructor(message) { super(message); this.name = "VoiceUnavailableError"; } }
export class VoiceTimeoutError extends Error { constructor(service) { super(`${service} timed out.`); this.name = "VoiceTimeoutError"; this.service = service; this.code = "VOICE_TIMEOUT"; } }
export class VoiceProviderError extends Error {
  constructor(service, message, upstreamStatus, category = "unknown", providerCode) { super(message); this.name = "VoiceProviderError"; this.service = service; this.upstreamStatus = upstreamStatus; this.category = category; this.providerCode = providerCode; this.code = "VOICE_PROVIDER_ERROR"; }
}

export function createVoiceService({ config, fetchImpl = fetch, schedule = setTimeout, cancelSchedule = clearTimeout }) {
  const voice = config.voiceV2;
  let capabilityPromise; let capabilityCheckedAt = 0; let quotaPromise; let quotaCheckedAt = 0;

  async function quota({ refresh = false } = {}) {
    const fresh = quotaPromise && Date.now() - quotaCheckedAt < voice.capabilityCacheMs;
    if (!refresh && fresh) return quotaPromise;
    quotaCheckedAt = Date.now();
    quotaPromise = readElevenLabsQuota({ voice, fetchImpl, schedule, cancelSchedule }).catch(() => ({ available: false, reason: "scoped-key-metadata-unavailable" }));
    return quotaPromise;
  }

  async function capabilities({ refresh = false } = {}) {
    if (!voice.elevenLabsApiKey || !voice.elevenLabsVoiceId) throw new VoiceUnavailableError("ElevenLabs speech is not configured.");
    const fresh = capabilityPromise && Date.now() - capabilityCheckedAt < voice.capabilityCacheMs;
    if (!refresh && fresh) return capabilityPromise;
    capabilityCheckedAt = Date.now();
    capabilityPromise = verifyElevenLabsCapabilities({ voice, fetchImpl, schedule, cancelSchedule }).catch((error) => {
      capabilityPromise = undefined; capabilityCheckedAt = 0; throw error;
    });
    return capabilityPromise;
  }

  async function* streamSpeech(input, { signal, onEvent = () => {} } = {}) {
    const capability = await capabilities();
    const text = sanitiseSpeechText(input?.text, voice.maxSpeechCharacters);
    if (!text) throw new VoiceValidationError("Nova's reply does not contain speakable owner-facing text.");
    const chunks = chunkSpeechText(text, {
      firstChunkCharacters: voice.firstSpeechChunkCharacters,
      nextChunkCharacters: voice.nextSpeechChunkCharacters,
      maxChunks: voice.maxSpeechChunks
    });
    let totalAudioBytes = 0; let generatedCharacters = 0; let providerAttempts = 0;
    const streamStartedAt = Date.now();
    const turnSeed = stableSpeechSeed(text); const turnId=`tts-${randomUUID()}`;const voiceFingerprint=createHash("sha256").update(voice.elevenLabsVoiceId).digest("hex").slice(0,12); const controller = new AbortController(); const unlink = linkAbort(signal, controller);
    const pending = new Map(); const lookahead = Math.max(1, Math.min(2, voice.speechLookahead || 2));
    const launch = (index) => {
      if (index >= chunks.length || pending.has(index) || controller.signal.aborted) return;
      const promise = synthesiseChunk(chunks[index], { voice, model: capability.model, fetchImpl, schedule, cancelSchedule, signal: controller.signal, onEvent, index, chunkCount: chunks.length, previousText: chunks[index - 1], nextText: chunks[index + 1], seed: turnSeed, turnId, voiceFingerprint })
        .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
      pending.set(index, promise);
    };
    for (let index = 0; index < Math.min(lookahead, chunks.length); index += 1) launch(index);
    try {
      for (let index = 0; index < chunks.length; index += 1) {
        if (controller.signal.aborted) throw cancelledProviderError();
        const settled = await pending.get(index); pending.delete(index);
        if (!settled.ok) { controller.abort(); throw settled.error; }
        const result = settled.value; providerAttempts += result.retryCount + 1; generatedCharacters += chunks[index].length;
        totalAudioBytes += result.audio.length;
        if (totalAudioBytes > voice.maxSpeechAudioBytes) { controller.abort(); throw new VoiceProviderError("elevenlabs", "ElevenLabs audio exceeded Nova's response limit.", undefined, "invalid_request"); }
        launch(index + lookahead);
        yield { ...result, index, chunkCount: chunks.length, spokenText: chunks[index] };
      }
      onEvent({ phase: "stream_complete", chunkCount: chunks.length, textCharacters: text.length, generatedCharacters, providerAttempts, audioBytes: totalAudioBytes, estimatedAudioDurationSeconds: estimatedMp3Seconds(totalAudioBytes), durationMs: Date.now() - streamStartedAt, model: capability.model.id, outputFormat: voice.ttsOutputFormat });
    } catch (error) {
      onEvent({ phase: "stream_failed", chunkCount: chunks.length, textCharacters: text.length, generatedCharacters, providerAttempts, audioBytes: totalAudioBytes, category: error?.category || "unknown", durationMs: Date.now() - streamStartedAt, model: capability.model.id, outputFormat: voice.ttsOutputFormat });
      throw error;
    } finally { controller.abort(); unlink(); }
  }

  return Object.freeze({
    async readiness(options) {
      let capability; let failure;
      if (voice.elevenLabsApiKey && voice.elevenLabsVoiceId) {
        try { capability = await capabilities(options); }
        catch (error) { failure = error; }
      }
      const quotaStatus = await quota(options);
      return {
        available: Boolean(voice.openAIApiKey && capability),
        rawAudioPolicy: "ephemeral-request-only",
        stt: { model: voice.sttModel, status: voice.openAIApiKey ? "Configured" : "Missing" },
        tts: {
          model: capability?.model.id || voice.ttsModel,
          preferredModel: voice.ttsModel,
          outputFormat: voice.ttsOutputFormat,
          voice: "Owner-selected ElevenLabs voice",
          status: capability ? "Verified" : voice.elevenLabsApiKey && voice.elevenLabsVoiceId ? "Unavailable" : "Missing",
          capability: capability?.verification,
          selection: capability?.model.reason,
          fallbackUsed: capability?.model.fallbackUsed || false,
          voiceCompatibility: capability?.voiceCompatibility,
          errorCategory: safeReadinessCategory(failure)
        },
        quota: quotaStatus,
        limits: { maxDurationSeconds: voice.maxDurationSeconds, maxAudioBytes: voice.maxAudioBytes, maxSpeechCharacters: voice.maxSpeechCharacters, maxSpeechChunks: voice.maxSpeechChunks, lookahead: voice.speechLookahead }
      };
    },
    capabilities,
    async transcribe(input) {
      if (!voice.openAIApiKey) throw new VoiceUnavailableError("OpenAI transcription is not configured.");
      const audio = decodeAudio(input?.audioBase64);
      const mimeType = validateMime(input?.mimeType);
      const durationSeconds = boundedNumber(input?.durationSeconds, voice.minDurationSeconds, voice.maxDurationSeconds, "durationSeconds");
      if (audio.length > voice.maxAudioBytes) throw new VoiceValidationError("Voice recording is too large.");
      const form = new FormData();
      form.append("model", voice.sttModel);
      form.append("prompt", "Nova Brain conversation. Preserve Arabic and English code-switching, names and terms including Mohammad, Luton, Sharp Cuts, Nova Brain, GitHub, API, booking, and missed-call recovery. Preserve short playback controls exactly, especially استني, استنى, وقفي, لحظة, دقيقة, شوي, كملي, كمّل, wait, stop, pause, hold on, continue, and resume. Preserve numbers exactly.");
      const fileName = `voice.${extension(mimeType)}`;
      form.append("file", new Blob([audio], { type: mimeType }), fileName);
      let data;
      try { data = await timedRequest(fetchImpl, OPENAI_TRANSCRIPTIONS, { method: "POST", headers: { Authorization: `Bearer ${voice.openAIApiKey}` }, body: form }, voice.requestTimeoutMs, "OpenAI transcription", schedule, cancelSchedule, (response) => safeJson(response, "OpenAI transcription")); }
      catch (error) { if (error instanceof VoiceProviderError) error.safeDetail = { operation: "transcribe", mimeType, fileName, audioBytes: audio.length, durationSeconds }; throw error; }
      const transcript = String(data?.text || "").trim();
      return { transcript, model: voice.sttModel, durationSeconds };
    },
    streamSpeech,
    async synthesise(input, options) {
      const parts = []; let result;
      for await (const chunk of streamSpeech(input, options)) { parts.push(chunk.audio); result = chunk; }
      if (!result || !parts.length) throw new VoiceProviderError("elevenlabs", "ElevenLabs returned empty audio.");
      return { audio: Buffer.concat(parts), mimeType: result.mimeType, model: result.model, spokenText: parts.length === 1 ? result.spokenText : sanitiseSpeechText(input?.text, voice.maxSpeechCharacters) };
    }
  });
}

async function synthesiseChunk(text, { voice, model, fetchImpl, schedule, cancelSchedule, signal, onEvent, index, chunkCount, previousText, nextText, seed, turnId, voiceFingerprint }) {
  const url = `${ELEVENLABS_BASE}/${encodeURIComponent(voice.elevenLabsVoiceId)}/stream?output_format=${encodeURIComponent(voice.ttsOutputFormat)}`;
  let attempt = 0;
  while (attempt < 2) {
    attempt += 1;
    const startedAt = Date.now();
    onEvent({ phase: "request_started", turnId, chunkIndex: index, chunkCount, textCharacters: text.length, attempt, voiceFingerprint, model: model.id, seed, voiceSettings:{stability:voice.ttsStability}, outputFormat: voice.ttsOutputFormat });
    try {
      const result = await consumeElevenLabsStream(fetchImpl, url, {
        method: "POST",
        headers: { "xi-api-key": voice.elevenLabsApiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify(elevenLabsRequestBody({ text, model, previousText, nextText, seed, stability: voice.ttsStability }))
      }, { voice, model, schedule, cancelSchedule, signal, onEvent, index, chunkCount, attempt, startedAt });
      return { audio: result.audio, mimeType: "audio/mpeg", model: model.id, retryCount: attempt - 1, timing: result.timing };
    } catch (error) {
      if (error instanceof VoiceProviderError) error.safeDetail = { operation: "synthesise", model: model.id, textCharacters: text.length, chunkIndex: index, chunkCount, attempt, retryCount: attempt - 1, providerRequestId: error.providerRequestId, phase: error.category };
      onEvent({ phase: "request_failed", chunkIndex: index, chunkCount, textCharacters: text.length, attempt, retryCount: attempt - 1, category: error?.category || "unknown", upstreamStatus: error?.upstreamStatus, durationMs: Date.now() - startedAt, model: model.id, outputFormat: voice.ttsOutputFormat });
      if (attempt === 1 && retryableTtsFailure(error) && !signal?.aborted) {
        const retryDelayMs = error.providerCode === "concurrent_limit_exceeded"
          ? Math.max(voice.ttsRetryDelayMs, voice.ttsConcurrencyRetryDelayMs || 0)
          : voice.ttsRetryDelayMs;
        await boundedDelay(schedule, cancelSchedule, retryDelayMs, signal); continue;
      }
      throw error;
    }
  }
}

async function consumeElevenLabsStream(fetchImpl, url, options, { voice, model, schedule, cancelSchedule, signal, onEvent, index, chunkCount, attempt, startedAt }) {
  const controller = new AbortController();
  const unlink = linkAbort(signal, controller);
  let timeoutCategory = "provider_timeout_first_byte";
  let timer = schedule(() => controller.abort(), voice.ttsFirstByteTimeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      cancelSchedule(timer);
      const failure = await classifyProviderFailure(response);
      const error = new VoiceProviderError("elevenlabs", "ElevenLabs speech request failed.", response.status, failure.category, failure.providerCode);
      error.providerRequestId = failure.providerRequestId;
      throw error;
    }
    onEvent({ phase: "upstream_connected", chunkIndex: index, chunkCount, attempt, durationMs: Date.now() - startedAt, model: model.id, outputFormat: voice.ttsOutputFormat });
    const announced = Number(response.headers.get("content-length") || 0);
    if (announced > voice.maxSpeechAudioBytes) throw new VoiceProviderError("elevenlabs", "ElevenLabs audio exceeded Nova's response limit.", undefined, "invalid_request");
    if (!response.body?.getReader) throw new VoiceProviderError("elevenlabs", "ElevenLabs returned an invalid audio stream.", undefined, "unknown");
    const reader = response.body.getReader();
    const parts = []; let bytes = 0; let firstByteAt; let totalTimer;
    totalTimer = schedule(() => { timeoutCategory = firstByteAt ? "provider_stream_stalled" : "provider_timeout_first_byte"; controller.abort(); }, voice.ttsChunkTimeoutMs);
    try {
      while (true) {
        const { done, value } = await reader.read();
        cancelSchedule(timer);
        if (done) break;
        if (!value?.byteLength) { timer = schedule(() => { timeoutCategory = firstByteAt ? "provider_stream_stalled" : "provider_timeout_first_byte"; controller.abort(); }, firstByteAt ? voice.ttsStreamStallTimeoutMs : voice.ttsFirstByteTimeoutMs); continue; }
        if (!firstByteAt) {
          firstByteAt = Date.now();
          onEvent({ phase: "first_upstream_byte", chunkIndex: index, chunkCount, attempt, durationMs: firstByteAt - startedAt, model: model.id, outputFormat: voice.ttsOutputFormat });
        }
        const part = Buffer.from(value); bytes += part.length;
        if (bytes > voice.maxSpeechAudioBytes) throw new VoiceProviderError("elevenlabs", "ElevenLabs audio exceeded Nova's response limit.", undefined, "invalid_request");
        parts.push(part);
        timeoutCategory = "provider_stream_stalled";
        timer = schedule(() => controller.abort(), voice.ttsStreamStallTimeoutMs);
      }
    } finally {
      cancelSchedule(timer); cancelSchedule(totalTimer);
      if (controller.signal.aborted) await reader.cancel().catch(() => {});
    }
    if (!bytes) throw new VoiceProviderError("elevenlabs", "ElevenLabs returned empty audio.", undefined, "unknown");
    const completedAt = Date.now();
    onEvent({ phase: "chunk_complete", chunkIndex: index, chunkCount, attempt, retryCount: attempt - 1, textCharacters: JSON.parse(options.body).text.length, audioBytes: bytes, firstByteMs: firstByteAt - startedAt, durationMs: completedAt - startedAt, model: model.id, outputFormat: voice.ttsOutputFormat });
    return { audio: Buffer.concat(parts), timing: { upstreamConnectedMs: undefined, firstByteMs: firstByteAt - startedAt, completeMs: completedAt - startedAt } };
  } catch (error) {
    if (error instanceof VoiceProviderError || error instanceof VoiceValidationError) throw error;
    if (signal?.aborted) throw cancelledProviderError();
    if (controller.signal.aborted || error?.name === "AbortError") throw new VoiceProviderError("elevenlabs", "ElevenLabs speech stream timed out.", undefined, timeoutCategory);
    throw new VoiceProviderError("elevenlabs", "ElevenLabs speech could not be reached.", undefined, "unknown");
  } finally {
    cancelSchedule(timer); unlink();
  }
}

async function timedRequest(fetchImpl, url, options, timeoutMs, service, schedule, cancelSchedule, consume) {
  const controller = new AbortController();
  const timer = schedule(() => controller.abort(), timeoutMs);
  try { const response = await fetchImpl(url, { ...options, signal: controller.signal }); return await consume(response); }
  catch (error) { if (error instanceof VoiceProviderError || error instanceof VoiceValidationError) throw error; if (controller.signal.aborted || error?.name === "AbortError") throw new VoiceTimeoutError(service); throw new VoiceProviderError(service.toLowerCase(), `${service} could not be reached.`); }
  finally { cancelSchedule(timer); }
}

async function verifyElevenLabsCapabilities({ voice, fetchImpl, schedule, cancelSchedule }) {
  const headers = { "xi-api-key": voice.elevenLabsApiKey, Accept: "application/json" };
  try {
    const [models, selectedVoice] = await Promise.all([
      timedRequest(fetchImpl, ELEVENLABS_MODELS, { headers }, voice.capabilityTimeoutMs, "ElevenLabs capabilities", schedule, cancelSchedule, (response) => safeJson(response, "ElevenLabs capabilities")),
      timedRequest(fetchImpl, `${ELEVENLABS_VOICES}/${encodeURIComponent(voice.elevenLabsVoiceId)}`, { headers }, voice.capabilityTimeoutMs, "ElevenLabs voice", schedule, cancelSchedule, (response) => safeJson(response, "ElevenLabs voice"))
    ]);
    const model = selectElevenLabsModel(models, voice.ttsModel);
    if (!model) throw new VoiceProviderError("elevenlabs", "No supported multilingual ElevenLabs speech model is available.", 400, "model", "unsupported_model");
    if (!selectedVoice || selectedVoice.voice_id !== voice.elevenLabsVoiceId) throw new VoiceProviderError("elevenlabs", "The selected ElevenLabs voice is unavailable.", 403, "voice_access", "voice_access_denied");
    const highQualityModels = Array.isArray(selectedVoice.high_quality_base_model_ids) ? selectedVoice.high_quality_base_model_ids : [];
    return Object.freeze({
      model,
      verification: "account-model-and-voice-access-verified",
      voiceCompatibility: highQualityModels.includes(model.id) ? "high-quality-model-listed" : "voice-access-verified"
    });
  } catch (error) {
    if (!(error instanceof VoiceProviderError) || !["authentication", "provider_rejected"].includes(error.category)) throw error;
  }

  for (const candidate of elevenLabsModelCandidates(voice.ttsModel)) {
    const model = Object.freeze({ ...candidate, fallbackUsed: candidate.id !== voice.ttsModel });
    try {
      await synthesiseChunk("Nova is ready.", { voice, model, fetchImpl, schedule, cancelSchedule, onEvent: () => {}, index: 0, chunkCount: 1 });
      return Object.freeze({ model, verification: "direct-speech-generation-verified", voiceCompatibility: "owner-voice-generation-verified" });
    } catch (error) {
      if (error instanceof VoiceProviderError && ["model", "invalid_request"].includes(error.category)) continue;
      throw error;
    }
  }
  throw new VoiceProviderError("elevenlabs", "No supported multilingual ElevenLabs speech model is available.", 400, "model", "unsupported_model");
}

async function safeJson(response, service) {
  if (!response.ok) {
    const failure = await classifyProviderFailure(response);
    const error = new VoiceProviderError(service.toLowerCase(), `${service} request failed.`, response.status, failure.category, failure.providerCode);
    error.providerRequestId = failure.providerRequestId; throw error;
  }
  try { return await response.json(); }
  catch { throw new VoiceProviderError(service.toLowerCase(), `${service} returned an invalid response.`); }
}

async function readElevenLabsQuota({ voice, fetchImpl, schedule, cancelSchedule }) {
  if (!voice.elevenLabsApiKey) return { available: false, reason: "not-configured" };
  const data = await timedRequest(fetchImpl, ELEVENLABS_SUBSCRIPTION, { headers: { "xi-api-key": voice.elevenLabsApiKey, Accept: "application/json" } }, voice.capabilityTimeoutMs, "ElevenLabs subscription", schedule, cancelSchedule, (response) => safeJson(response, "ElevenLabs subscription"));
  const used = finiteInteger(data?.character_count); const limit = finiteInteger(data?.character_limit);
  return { available: true, tier: safeLabel(data?.tier), status: safeLabel(data?.status), usedCredits: used, creditLimit: limit, remainingCredits: used !== undefined && limit !== undefined ? Math.max(0, limit - used) : undefined, nextResetUnix: finiteInteger(data?.next_character_count_reset_unix), refreshPeriod: safeLabel(data?.character_refresh_period), overageEnabled: data?.max_credit_limit_extension === "unlimited" || Number(data?.max_credit_limit_extension) > 0 };
}

function stableSpeechSeed(text) { let hash = 2166136261; for (const character of text) { hash ^= character.codePointAt(0); hash = Math.imul(hash, 16777619); } return hash >>> 0; }
function estimatedMp3Seconds(bytes) { return Math.round((bytes * 8 / 128000) * 10) / 10; }
function finiteInteger(value) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined; }
function safeLabel(value) { const label = typeof value === "string" ? value.trim() : ""; return /^[a-z0-9_.-]{1,64}$/i.test(label) ? label : undefined; }

async function classifyProviderFailure(response) {
  let body; try { body = await response.json(); } catch { body = null; }
  const detail = body?.detail && typeof body.detail === "object" ? body.detail : body?.error && typeof body.error === "object" ? body.error : body;
  const status = Number(response.status); const providerCode = safeProviderCode(detail?.code || detail?.status || body?.code);
  const providerRequestId = safeProviderRequestId(response.headers.get("request-id") || response.headers.get("x-request-id") || detail?.request_id || body?.request_id);
  const description = `${detail?.type || ""} ${detail?.message || ""} ${providerCode || ""}`.toLowerCase();
  const result = (category) => ({ category, providerCode, providerRequestId });
  if (status === 401) return result(/quota|billing|credit|limit exceeded/.test(description) ? "quota" : "authentication");
  if (status === 402) return result("quota");
  if (status === 403) return result(/voice|workspace_access|feature_not_available/.test(description) ? "voice_access" : "provider_rejected");
  if (/voice_not_found|voice_access_denied/.test(description)) return result("voice_access");
  if (status === 429) return result("rate_limit");
  if ((status === 400 || status === 415 || status === 422) && /audio|media|file|format|decode|codec|webm/.test(description)) return result("invalid_audio");
  if (status === 400 || status === 404 || status === 415 || status === 422) return result(/model/.test(description) ? "model" : "invalid_request");
  return result(status >= 500 ? "provider_5xx" : "provider_rejected");
}

function safeProviderCode(value) { const code = typeof value === "string" ? value.trim() : ""; return /^[a-z0-9_.-]{1,64}$/i.test(code) ? code : undefined; }
function safeProviderRequestId(value) { const id = typeof value === "string" ? value.trim() : ""; return /^[a-z0-9_.:-]{1,128}$/i.test(id) ? id : undefined; }
function safeReadinessCategory(error) {
  if (error instanceof VoiceTimeoutError) return "timeout";
  if (error instanceof VoiceProviderError && ["authentication", "quota", "voice_access", "model", "rate_limit", "provider_5xx", "provider_rejected", "unknown"].includes(error.category)) return error.category;
  return error ? "unavailable" : undefined;
}
function retryableTtsFailure(error) {
  return error instanceof VoiceProviderError && ["rate_limit", "provider_5xx", "provider_timeout_first_byte", "provider_stream_stalled"].includes(error.category);
}
function boundedDelay(schedule, cancelSchedule, delayMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelledProviderError()); return; }
    let timer;
    const abort = () => { cancelSchedule(timer); reject(cancelledProviderError()); };
    timer = schedule(() => { signal?.removeEventListener?.("abort", abort); resolve(); }, delayMs);
    signal?.addEventListener?.("abort", abort, { once: true });
  });
}
function linkAbort(signal, controller) {
  if (!signal?.addEventListener) return () => {};
  const abort = () => controller.abort();
  if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}
function cancelledProviderError() { return new VoiceProviderError("elevenlabs", "ElevenLabs speech request was cancelled.", undefined, "client_cancelled"); }

function decodeAudio(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new VoiceValidationError("A base64 voice recording is required.");
  const audio = Buffer.from(value, "base64"); if (!audio.length) throw new VoiceValidationError("Voice recording is empty."); return audio;
}
function validateMime(value) { const mime = String(value || "").toLowerCase().replace(/;\s*/, ";"); if (!MIME_TYPES.has(mime)) throw new VoiceValidationError("Unsupported voice recording format."); return mime; }
function boundedNumber(value, min, max, name) { const number = Number(value); if (!Number.isFinite(number) || number < min || number > max) throw new VoiceValidationError(`${name} must be between ${min} and ${max}.`); return number; }
function extension(type) { if (type.includes("wav")) return "wav"; if (type.includes("ogg")) return "ogg"; if (type.includes("mp4")) return "m4a"; if (type.includes("mpeg")) return "mp3"; return "webm"; }
