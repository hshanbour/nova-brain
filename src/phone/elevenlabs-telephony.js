import { elevenLabsModelPolicy, elevenLabsRequestBody } from "../voice/elevenlabs-models.js";
import { sanitiseSpeechText } from "../voice/speech-text.js";

export const ELEVENLABS_TELEPHONY_OUTPUT_FORMAT = "ulaw_8000";

export function createPhase0ElevenLabsTelephonyTts({ config, fetchImpl }) {
  if (typeof fetchImpl !== "function") throw new TypeError("Phase 0 requires an injected provider mock.");
  const voice = config?.voiceV2;
  if (!voice?.elevenLabsApiKey || !voice?.elevenLabsVoiceId) throw new Error("Nova's ElevenLabs voice configuration is required.");
  const model = elevenLabsModelPolicy(voice.ttsModel) || Object.freeze({ id: voice.ttsModel, continuityText: false });

  return Object.freeze({
    async *stream(text, { signal } = {}) {
      const spokenText = sanitiseSpeechText(text, voice.maxSpeechCharacters);
      if (!spokenText) throw new Error("Nova's reply has no speakable text.");
      const response = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice.elevenLabsVoiceId)}/stream?output_format=${ELEVENLABS_TELEPHONY_OUTPUT_FORMAT}`, {
        method: "POST",
        headers: { "xi-api-key": voice.elevenLabsApiKey, "Content-Type": "application/json", Accept: "application/octet-stream" },
        body: JSON.stringify(elevenLabsRequestBody({ text: spokenText, model, stability: voice.ttsStability })),
        signal,
      });
      if (!response.ok) throw new Error(`ElevenLabs telephony mock failed with status ${response.status}.`);
      if (!response.body?.getReader) throw new Error("ElevenLabs telephony response is not streamable.");
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.byteLength) yield Buffer.from(value);
      }
    },
    contract() {
      return Object.freeze({
        provider: "elevenlabs",
        model: model.id,
        voice: "owner-selected",
        outputFormat: ELEVENLABS_TELEPHONY_OUTPUT_FORMAT,
        rawAudioPolicy: "ephemeral-only",
      });
    },
  });
}
