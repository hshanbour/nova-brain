import { sanitiseSpeechText } from "./speech-text.js";

const OPENAI_TRANSCRIPTIONS = "https://api.openai.com/v1/audio/transcriptions";
const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1/text-to-speech";
const MIME_TYPES = new Set(["audio/webm", "audio/webm;codecs=opus", "audio/ogg", "audio/ogg;codecs=opus", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav"]);

export class VoiceValidationError extends Error { constructor(message) { super(message); this.name = "VoiceValidationError"; } }
export class VoiceUnavailableError extends Error { constructor(message) { super(message); this.name = "VoiceUnavailableError"; } }
export class VoiceTimeoutError extends Error { constructor(service) { super(`${service} timed out.`); this.name = "VoiceTimeoutError"; this.service = service; this.code = "VOICE_TIMEOUT"; } }
export class VoiceProviderError extends Error {
  constructor(service, message, upstreamStatus, category = "unknown", providerCode) { super(message); this.name = "VoiceProviderError"; this.service = service; this.upstreamStatus = upstreamStatus; this.category = category; this.providerCode = providerCode; this.code = "VOICE_PROVIDER_ERROR"; }
}

export function createVoiceService({ config, fetchImpl = fetch, schedule = setTimeout, cancelSchedule = clearTimeout }) {
  const voice = config.voiceV2;
  return Object.freeze({
    readiness() {
      return {
        available: Boolean(voice.openAIApiKey && voice.elevenLabsApiKey && voice.elevenLabsVoiceId),
        rawAudioPolicy: "ephemeral-request-only",
        stt: { model: voice.sttModel, status: voice.openAIApiKey ? "Configured" : "Missing" },
        tts: { model: voice.ttsModel, voice: "Owner-selected ElevenLabs voice", status: voice.elevenLabsApiKey && voice.elevenLabsVoiceId ? "Configured" : "Missing" },
        limits: { maxDurationSeconds: voice.maxDurationSeconds, maxAudioBytes: voice.maxAudioBytes, maxSpeechCharacters: voice.maxSpeechCharacters }
      };
    },
    async transcribe(input) {
      if (!voice.openAIApiKey) throw new VoiceUnavailableError("OpenAI transcription is not configured.");
      const audio = decodeAudio(input?.audioBase64);
      const mimeType = validateMime(input?.mimeType);
      const durationSeconds = boundedNumber(input?.durationSeconds, voice.minDurationSeconds, voice.maxDurationSeconds, "durationSeconds");
      if (audio.length > voice.maxAudioBytes) throw new VoiceValidationError("Voice recording is too large.");
      const form = new FormData();
      form.append("model", voice.sttModel);
      form.append("prompt", "Nova Brain conversation. Preserve Arabic and English code-switching, names and terms including Mohammad, Luton, Sharp Cuts, Nova Brain, GitHub, API, booking, and missed-call recovery. Preserve numbers exactly.");
      const fileName = `voice.${extension(mimeType)}`;
      form.append("file", new Blob([audio], { type: mimeType }), fileName);
      let data;
      try { data = await timedRequest(fetchImpl, OPENAI_TRANSCRIPTIONS, { method: "POST", headers: { Authorization: `Bearer ${voice.openAIApiKey}` }, body: form }, voice.requestTimeoutMs, "OpenAI transcription", schedule, cancelSchedule, (response) => safeJson(response, "OpenAI transcription")); }
      catch (error) { if (error instanceof VoiceProviderError) error.safeDetail = { operation: "transcribe", mimeType, fileName, audioBytes: audio.length, durationSeconds }; throw error; }
      const transcript = String(data?.text || "").trim();
      return { transcript, model: voice.sttModel, durationSeconds };
    },
    async synthesise(input) {
      if (!voice.elevenLabsApiKey || !voice.elevenLabsVoiceId) throw new VoiceUnavailableError("ElevenLabs speech is not configured.");
      const text = sanitiseSpeechText(input?.text, voice.maxSpeechCharacters);
      if (!text) throw new VoiceValidationError("Nova's reply does not contain speakable owner-facing text.");
      const url = `${ELEVENLABS_BASE}/${encodeURIComponent(voice.elevenLabsVoiceId)}/stream?output_format=mp3_44100_128`;
      let audio; let attempt = 0;
      while (attempt < 2) {
        attempt += 1;
        try {
          audio = await timedRequest(fetchImpl, url, {
            method: "POST",
            headers: { "xi-api-key": voice.elevenLabsApiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
            body: JSON.stringify({ text, model_id: voice.ttsModel })
          }, voice.requestTimeoutMs, "ElevenLabs speech", schedule, cancelSchedule, async (response) => {
            if (!response.ok) {
              const failure = await classifyProviderFailure(response);
              const error = new VoiceProviderError("elevenlabs", "ElevenLabs speech request failed.", response.status, failure.category, failure.providerCode);
              error.providerRequestId = failure.providerRequestId; throw error;
            }
            const announced = Number(response.headers.get("content-length") || 0); if (announced > voice.maxSpeechAudioBytes) throw new VoiceProviderError("elevenlabs", "ElevenLabs audio exceeded Nova's response limit.", undefined, "provider_rejected");
            const value = Buffer.from(await response.arrayBuffer()); if (value.length > voice.maxSpeechAudioBytes) throw new VoiceProviderError("elevenlabs", "ElevenLabs audio exceeded Nova's response limit.", undefined, "provider_rejected"); return value;
          });
          break;
        } catch (error) {
          if (error instanceof VoiceProviderError) error.safeDetail = { operation: "synthesise", model: voice.ttsModel, textCharacters: text.length, attempt, retryCount: attempt - 1, providerRequestId: error.providerRequestId };
          if (attempt === 1 && retryableTtsFailure(error)) { await boundedDelay(schedule, voice.ttsRetryDelayMs); continue; }
          throw error;
        }
      }
      if (!audio.length) throw new VoiceProviderError("elevenlabs", "ElevenLabs returned empty audio.");
      return { audio, mimeType: "audio/mpeg", model: voice.ttsModel, spokenText: text };
    }
  });
}

async function timedRequest(fetchImpl, url, options, timeoutMs, service, schedule, cancelSchedule, consume) {
  const controller = new AbortController();
  const timer = schedule(() => controller.abort(), timeoutMs);
  try { const response = await fetchImpl(url, { ...options, signal: controller.signal }); return await consume(response); }
  catch (error) { if (error instanceof VoiceProviderError || error instanceof VoiceValidationError) throw error; if (controller.signal.aborted || error?.name === "AbortError") throw new VoiceTimeoutError(service); throw new VoiceProviderError(service.toLowerCase(), `${service} could not be reached.`); }
  finally { cancelSchedule(timer); }
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
  return result(status >= 500 ? "unknown" : "provider_rejected");
}

function safeProviderCode(value) { const code = typeof value === "string" ? value.trim() : ""; return /^[a-z0-9_.-]{1,64}$/i.test(code) ? code : undefined; }
function safeProviderRequestId(value) { const id = typeof value === "string" ? value.trim() : ""; return /^[a-z0-9_.:-]{1,128}$/i.test(id) ? id : undefined; }
function retryableTtsFailure(error) { return error instanceof VoiceProviderError && (error.upstreamStatus === 429 || Number(error.upstreamStatus) >= 500); }
function boundedDelay(schedule, delayMs) { return new Promise((resolve) => schedule(resolve, delayMs)); }

function decodeAudio(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new VoiceValidationError("A base64 voice recording is required.");
  const audio = Buffer.from(value, "base64"); if (!audio.length) throw new VoiceValidationError("Voice recording is empty."); return audio;
}
function validateMime(value) { const mime = String(value || "").toLowerCase().replace(/;\s*/, ";"); if (!MIME_TYPES.has(mime)) throw new VoiceValidationError("Unsupported voice recording format."); return mime; }
function boundedNumber(value, min, max, name) { const number = Number(value); if (!Number.isFinite(number) || number < min || number > max) throw new VoiceValidationError(`${name} must be between ${min} and ${max}.`); return number; }
function extension(type) { if (type.includes("wav")) return "wav"; if (type.includes("ogg")) return "ogg"; if (type.includes("mp4")) return "m4a"; if (type.includes("mpeg")) return "mp3"; return "webm"; }
