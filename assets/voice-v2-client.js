export class VoiceV2ApiError extends Error {
  constructor(message, status = 0, category) { super(message); this.name = "VoiceV2ApiError"; this.status = status; this.category = category; }
}

export function createVoiceV2Client({ fetchImpl = globalThis.fetch, now = () => globalThis.performance?.now?.() ?? Date.now() } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("Voice V2 requires a fetch implementation.");
  return Object.freeze({
    async readiness() { return requestJson(fetchImpl, "/api/voice/readiness"); },
    async transcribe({ audio, mimeType, durationSeconds, signal }) {
      const audioBase64 = bytesToBase64(new Uint8Array(await audio.arrayBuffer()));
      return requestJson(fetchImpl, "/api/voice/transcribe", { method: "POST", signal, body: JSON.stringify({ audioBase64, mimeType, durationSeconds }) });
    },
    async speech(text, { signal } = {}) {
      const requestStartedAt = now(); let response;
      try { response = await fetchImpl("/api/voice/speech", { method: "POST", headers: { "Content-Type": "application/json" }, signal, body: JSON.stringify({ text }) }); }
      catch (error) { if (error?.name === "AbortError") throw error; throw new VoiceV2ApiError("Nova voice could not reach ElevenLabs."); }
      if (!response.ok) throw await responseError(response, "Nova could not generate voice audio.");
      const responseHeadersAt = now();
      const iterator = speechEvents(response)[Symbol.asyncIterator]();
      const first = await nextAudio(iterator, response.status);
      const firstAudioByteAt = now();
      const audio = audioBlob(first, response.status);
      const firstPlayableAt = now();
      const stream = {
        async *[Symbol.asyncIterator]() {
          yield audio;
          while (true) {
            const item = await iterator.next();
            if (item.done) return;
            if (item.value.type === "end") return;
            if (item.value.type === "error") throw streamError(item.value, response.status);
            if (item.value.type === "audio") yield audioBlob(item.value, response.status);
          }
        }
      };
      return {
        audio,
        stream,
        model: response.headers.get("x-nova-voice-model") || "unknown",
        timing: { requestStartedAt, responseHeadersAt, firstAudioByteAt, firstPlayableAt }
      };
    }
  });
}

async function* speechEvents(response) {
  if (!response.body?.getReader) throw new VoiceV2ApiError("Nova received an unreadable voice stream.", response.status);
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = pending.split("\n"); pending = lines.pop() || "";
      for (const line of lines) if (line.trim()) yield parseSpeechEvent(line, response.status);
      if (done) break;
    }
    if (pending.trim()) yield parseSpeechEvent(pending, response.status);
  } finally { reader.releaseLock?.(); }
}

async function nextAudio(iterator, status) {
  while (true) {
    const item = await iterator.next();
    if (item.done || item.value.type === "end") throw new VoiceV2ApiError("Nova received empty voice audio.", status);
    if (item.value.type === "error") throw streamError(item.value, status);
    if (item.value.type === "audio") return item.value;
  }
}

function parseSpeechEvent(line, status) {
  try { return JSON.parse(line); }
  catch { throw new VoiceV2ApiError("Nova received an invalid voice stream.", status); }
}

function audioBlob(event, status) {
  if (typeof event.audioBase64 !== "string" || !event.audioBase64) throw new VoiceV2ApiError("Nova received empty voice audio.", status);
  const binary = atob(event.audioBase64); const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: event.mimeType || "audio/mpeg" });
}

function streamError(event, status) { return new VoiceV2ApiError("Nova's written reply is safe, but ElevenLabs audio stopped.", status, event.category || "unknown"); }

async function requestJson(fetchImpl, url, options = {}) {
  let response;
  try { response = await fetchImpl(url, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options }); }
  catch (error) { if (error?.name === "AbortError") throw error; throw new VoiceV2ApiError("Nova voice could not reach the server."); }
  let body; try { body = await response.json(); } catch { throw new VoiceV2ApiError("Nova voice received an unreadable response.", response.status); }
  if (!response.ok) throw new VoiceV2ApiError(typeof body?.error === "string" ? body.error : "Nova voice request failed.", response.status);
  return body;
}

async function responseError(response, fallback) {
  try { const body = await response.json(); return new VoiceV2ApiError(typeof body?.error === "string" ? body.error : fallback, response.status, body?.category); }
  catch { return new VoiceV2ApiError(fallback, response.status); }
}

function bytesToBase64(bytes) {
  let binary = ""; const size = 0x8000;
  for (let index = 0; index < bytes.length; index += size) binary += String.fromCharCode(...bytes.subarray(index, index + size));
  return btoa(binary);
}
