export const ELEVENLABS_DEFAULT_TTS_MODEL = "eleven_v3_conversational";
export const ELEVENLABS_OUTPUT_FORMAT = "mp3_44100_128";

const MODEL_POLICY = Object.freeze([
  Object.freeze({ id: "eleven_v3_conversational", multilingual: true, continuityText: false, reason: "expressive-realtime" }),
  Object.freeze({ id: "eleven_flash_v2_5", multilingual: true, continuityText: true, reason: "low-latency-multilingual-fallback" }),
  Object.freeze({ id: "eleven_multilingual_v2", multilingual: true, continuityText: true, reason: "stable-multilingual-fallback" })
]);

export function elevenLabsModelCandidates(preferredModel = ELEVENLABS_DEFAULT_TTS_MODEL) {
  const ordered = [preferredModel, ...MODEL_POLICY.map((model) => model.id)].filter((id, index, values) => values.indexOf(id) === index);
  return ordered.map((id) => MODEL_POLICY.find((model) => model.id === id) || Object.freeze({ id, multilingual: false, continuityText: false, reason: "configured-account-model" }));
}

export function selectElevenLabsModel(models, preferredModel = ELEVENLABS_DEFAULT_TTS_MODEL) {
  const available = new Map((Array.isArray(models) ? models : [])
    .filter((model) => model && model.can_do_text_to_speech !== false)
    .map((model) => [model.model_id, model]));
  const id = elevenLabsModelCandidates(preferredModel).map((model) => model.id).find((candidate) => available.has(candidate));
  if (!id) return null;
  const policy = MODEL_POLICY.find((candidate) => candidate.id === id) || { id, multilingual: false, continuityText: false, reason: "configured-account-model" };
  return Object.freeze({
    ...policy,
    fallbackUsed: id !== preferredModel,
    accountModel: available.get(id)
  });
}

export function elevenLabsRequestBody({ text, model, previousText, nextText }) {
  return {
    text,
    model_id: model.id,
    ...(model.continuityText && previousText ? { previous_text: previousText } : {}),
    ...(model.continuityText && nextText ? { next_text: nextText } : {})
  };
}

export function elevenLabsModelPolicy(modelId) {
  return MODEL_POLICY.find((model) => model.id === modelId) || null;
}

