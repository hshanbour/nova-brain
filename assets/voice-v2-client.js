export class VoiceV2ApiError extends Error {
  constructor(message, status = 0) { super(message); this.name = "VoiceV2ApiError"; this.status = status; }
}

export function createVoiceV2Client({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("Voice V2 requires a fetch implementation.");
  return Object.freeze({
    async readiness() { return requestJson(fetchImpl, "/api/voice/readiness"); },
    async transcribe({ audio, mimeType, durationSeconds, signal }) {
      const audioBase64 = bytesToBase64(new Uint8Array(await audio.arrayBuffer()));
      return requestJson(fetchImpl, "/api/voice/transcribe", { method: "POST", signal, body: JSON.stringify({ audioBase64, mimeType, durationSeconds }) });
    },
    async speech(text, { signal } = {}) {
      let response;
      try { response = await fetchImpl("/api/voice/speech", { method: "POST", headers: { "Content-Type": "application/json" }, signal, body: JSON.stringify({ text }) }); }
      catch (error) { if (error?.name === "AbortError") throw error; throw new VoiceV2ApiError("Nova voice could not reach ElevenLabs."); }
      if (!response.ok) throw await responseError(response, "Nova could not generate voice audio.");
      const audio = await response.blob(); if (!audio.size) throw new VoiceV2ApiError("Nova received empty voice audio.", response.status);
      return { audio, model: response.headers.get("x-nova-voice-model") || "eleven_v3_conversational" };
    }
  });
}

async function requestJson(fetchImpl, url, options = {}) {
  let response;
  try { response = await fetchImpl(url, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options }); }
  catch (error) { if (error?.name === "AbortError") throw error; throw new VoiceV2ApiError("Nova voice could not reach the server."); }
  let body; try { body = await response.json(); } catch { throw new VoiceV2ApiError("Nova voice received an unreadable response.", response.status); }
  if (!response.ok) throw new VoiceV2ApiError(typeof body?.error === "string" ? body.error : "Nova voice request failed.", response.status);
  return body;
}

async function responseError(response, fallback) {
  try { const body = await response.json(); return new VoiceV2ApiError(typeof body?.error === "string" ? body.error : fallback, response.status); }
  catch { return new VoiceV2ApiError(fallback, response.status); }
}

function bytesToBase64(bytes) {
  let binary = ""; const size = 0x8000;
  for (let index = 0; index < bytes.length; index += size) binary += String.fromCharCode(...bytes.subarray(index, index + size));
  return btoa(binary);
}
