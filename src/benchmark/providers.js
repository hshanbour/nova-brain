const OPENAI_BASE = "https://api.openai.com/v1";

export class BenchmarkProviderError extends Error {
  constructor(message, { service, upstreamStatus } = {}) { super(message); this.name = "BenchmarkProviderError"; this.service = service; this.upstreamStatus = upstreamStatus; this.code = "BENCHMARK_PROVIDER_ERROR"; }
}

export function createBenchmarkProviders({ config, fetchImpl = fetch }) {
  const credentials = config.credentials;
  return Object.freeze({
    async transcribe(providerId, { audio, mimeType, locale }) {
      if (providerId === "openai") {
        const form = new FormData(); form.append("model", "gpt-transcribe"); form.append("language", locale.startsWith("ar") ? "ar" : "en"); form.append("file", new Blob([audio], { type: mimeType }), `sample.${extension(mimeType)}`);
        const response = await fetchImpl(`${OPENAI_BASE}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${credentials.openai}` }, body: form });
        const data = await safeJson(response, "openai"); return { transcript: data.text || "", model: "gpt-transcribe" };
      }
      if (providerId === "deepgram") {
        const url = new URL("https://api.deepgram.com/v1/listen"); url.searchParams.set("model", "nova-3"); url.searchParams.set("language", locale); url.searchParams.set("smart_format", "true");
        const response = await fetchImpl(url, { method: "POST", headers: { Authorization: `Token ${credentials.deepgram}`, "Content-Type": mimeType }, body: audio });
        const data = await safeJson(response, "deepgram"); return { transcript: data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "", model: "nova-3" };
      }
      if (providerId === "azure") {
        const url = `https://${encodeURIComponent(credentials.azureRegion)}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(locale)}&format=detailed`;
        const response = await fetchImpl(url, { method: "POST", headers: { "Ocp-Apim-Subscription-Key": credentials.azureKey, "Content-Type": mimeType, Accept: "application/json" }, body: audio });
        const data = await safeJson(response, "azure"); return { transcript: data.DisplayText || data.NBest?.[0]?.Display || "", model: locale };
      }
      throw new BenchmarkProviderError("Unknown STT provider.", { service: providerId });
    },
    async synthesise(providerId, { text, locale }) {
      if (providerId === "openai") {
        const response = await fetchImpl(`${OPENAI_BASE}/audio/speech`, { method: "POST", headers: { Authorization: `Bearer ${credentials.openai}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "marin", input: text, response_format: "mp3", instructions: locale.startsWith("ar") ? "Speak naturally in warm Jordanian Arabic. Preserve English terms." : "Speak in natural British English." }) });
        return { audio: await safeAudio(response, "openai"), mimeType: "audio/mpeg", model: "gpt-4o-mini-tts", voice: "marin" };
      }
      if (providerId === "elevenlabs") {
        const response = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(credentials.elevenlabsVoiceId)}?output_format=mp3_44100_128`, { method: "POST", headers: { "xi-api-key": credentials.elevenlabs, "Content-Type": "application/json", Accept: "audio/mpeg" }, body: JSON.stringify({ text, model_id: "eleven_v3_conversational" }) });
        return { audio: await safeAudio(response, "elevenlabs"), mimeType: "audio/mpeg", model: "eleven_v3_conversational", voice: credentials.elevenlabsVoiceId };
      }
      if (providerId === "azure") {
        const voice = locale.startsWith("ar") ? "ar-JO-SanaNeural" : "en-GB-SoniaNeural";
        const ssml = `<speak version="1.0" xml:lang="${locale}"><voice name="${voice}">${xml(text)}</voice></speak>`;
        const response = await fetchImpl(`https://${encodeURIComponent(credentials.azureRegion)}.tts.speech.microsoft.com/cognitiveservices/v1`, { method: "POST", headers: { "Ocp-Apim-Subscription-Key": credentials.azureKey, "Content-Type": "application/ssml+xml", "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3" }, body: ssml });
        return { audio: await safeAudio(response, "azure"), mimeType: "audio/mpeg", model: "neural", voice };
      }
      throw new BenchmarkProviderError("Unknown TTS provider.", { service: providerId });
    }
  });
}

async function safeJson(response, service) { if (!response.ok) throw new BenchmarkProviderError(`${service} request failed.`, { service, upstreamStatus: response.status }); try { return await response.json(); } catch { throw new BenchmarkProviderError(`${service} returned an invalid response.`, { service }); } }
async function safeAudio(response, service) { if (!response.ok) throw new BenchmarkProviderError(`${service} request failed.`, { service, upstreamStatus: response.status }); return Buffer.from(await response.arrayBuffer()); }
function extension(type) { if (type.includes("wav")) return "wav"; if (type.includes("ogg")) return "ogg"; if (type.includes("mp4")) return "m4a"; return "webm"; }
function xml(value) { return String(value).replace(/[<>&'\"]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[character]); }
