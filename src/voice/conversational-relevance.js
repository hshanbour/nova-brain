export const AUDIO_RELEVANCE = Object.freeze({
  ADDRESSED: "addressed_to_nova",
  CONTEXTUAL_REPLY: "contextual_reply_to_nova",
  INTERRUPTION: "relevant_interruption",
  BACKGROUND: "likely_background_speech",
  NON_SPEECH: "non_speech",
  UNCERTAIN: "uncertain"
});

export function classifyConversationalRelevance({ transcript, speaker, context = {} } = {}) {
  const text = String(transcript || "").trim();
  const decision = (category, accepted, reason, confidence) => Object.freeze({ category, accepted_as_turn: accepted, reason, confidence });
  if (!text) return decision(AUDIO_RELEVANCE.NON_SPEECH, false, "no_transcribed_speech", 1);
  const normalized = text.normalize("NFKD").replace(/[\u064B-\u065F\u0670]/gu, "").trim();
  const owner = speaker?.authenticated_identity === "owner" && speaker?.match_status === "confirmed";
  const explicitlyAddressed = /(?:^|[\s،,.!?؟])(?:nova(?:\s+brain)?|نوفا)(?:$|[\s،,.!?؟])/iu.test(normalized);
  const interruptionIntent = isInterruptionIntent(normalized);
  const directQuestion = isQuestion(normalized);
  const novaDirectedLanguage = /\b(?:you|your|can you|could you|would you|help me|tell me|show me|open|explain)\b|(?:انت|إنت|عندك|بتقدري|بتقدريش|ساعديني|احكيلي|خبريني|فرجيني|افتحي|اشرحي)/iu.test(normalized);
  const ownerNovaImperative = /^(?:open|show|tell|explain|check|run)(?:$|\s)|^(?:افتحي|فرجيني|احكيلي|خبريني|اشرحي|شغلي|افحصي)(?:$|[\s،,.!?؟])/iu.test(normalized);
  const addressRemainder = normalized.replace(/(?:^|[\s،,.!?؟])(?:nova(?:\s+brain)?|نوفا)(?=$|[\s،,.!?؟])/giu, " ").replace(/[\s،,.!?؟]+/gu, " ").trim();
  const substantiveDirectAddress = addressRemainder.split(/\s+/u).filter(Boolean).length >= 3;
  const strongDirectAddress = explicitlyAddressed && Boolean(addressRemainder) && (directQuestion || novaDirectedLanguage || interruptionIntent || ownerNovaImperative || (context.interruption !== true && substantiveDirectAddress));

  if (context.interruption === true && interruptionIntent) return decision(AUDIO_RELEVANCE.INTERRUPTION, true, "pause_resume_or_stop_during_playback", .99);
  if (strongDirectAddress) return decision(context.interruption === true ? AUDIO_RELEVANCE.INTERRUPTION : AUDIO_RELEVANCE.ADDRESSED, true, "structured_direct_nova_address", .94);
  if (explicitlyAddressed && context.interruption === true) return decision(AUDIO_RELEVANCE.BACKGROUND, false, "weak_name_only_during_playback", .88);
  if (explicitlyAddressed) return decision(AUDIO_RELEVANCE.UNCERTAIN, false, "weak_name_only_without_turn_intent", .7);
  if (context.awaiting_nova_reply === true) return decision(AUDIO_RELEVANCE.CONTEXTUAL_REPLY, true, "reply_during_expected_answer_window", .9);
  if (context.interruption === true && owner && (directQuestion || novaDirectedLanguage)) return decision(AUDIO_RELEVANCE.INTERRUPTION, true, "verified_owner_direct_interruption", .86);
  if (context.interruption === true) return decision(AUDIO_RELEVANCE.BACKGROUND, false, "speech_not_directed_to_nova_during_playback", .78);
  if (owner && directQuestion) return decision(AUDIO_RELEVANCE.ADDRESSED, true, "verified_owner_question_in_listening_window", .82);
  if (owner && context.voice_session_engaged === true && ownerNovaImperative) return decision(AUDIO_RELEVANCE.ADDRESSED, true, "verified_owner_nova_imperative_in_active_session", .8);
  if (owner) return decision(AUDIO_RELEVANCE.BACKGROUND, false, "owner_speech_not_addressed_to_nova", .76);
  if (directQuestion || novaDirectedLanguage) return decision(AUDIO_RELEVANCE.UNCERTAIN, false, "unverified_speech_without_nova_address_or_reply_context", .55);
  return decision(AUDIO_RELEVANCE.BACKGROUND, false, "ambient_or_third_party_speech", .82);
}

function isInterruptionIntent(text) {
  return /\b(?:wait|hold on|stop|pause|continue|resume|go on)\b|(?:^|[\s،,.!?؟])(?:استن(?:ي|ى)|لحظ[هة]|دقيق[هة]|وقفي?|وقف[هة]|خلاص|كملي?|كمل)(?:$|[\s،,.!?؟])/iu.test(text);
}

function isQuestion(text) {
  return /[?؟]\s*$/.test(text) || /^(?:who|what|when|where|why|how|which|can|could|would|will|do|does|did|are|is)(?:$|\s)|^(?:مين|من|شو|ماذا|متى|وين|اين|أين|ليش|كيف|هل|ايش|إيش)(?:$|[\s،,.!?؟])/iu.test(text);
}
