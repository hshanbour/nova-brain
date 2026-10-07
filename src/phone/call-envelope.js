import { createHash } from "node:crypto";

export const PHONE_CALL_DURATIONS = Object.freeze([5, 10, 15, 30, 60]);
export const PHONE_MEDIA_PROFILES = Object.freeze(["chained_v1", "gpt_live_round2_preview", "speaker_enrollment_v1"]);
export const GPT_LIVE_PHONE_VOICES = Object.freeze(["marin", "willow", "gleam"]);
const MAX_EXPIRY_MS = 24 * 60 * 60 * 1000;

function text(value, name, max, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === "")) return null;
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw Object.assign(new Error(`${name} is invalid.`), { code: "phone_call_envelope_invalid", statusCode: 400 });
  return value.trim();
}

function list(value, name, { maxItems = 12, maxLength = 500, optional = false } = {}) {
  if (optional && value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems)
    throw Object.assign(new Error(`${name} is invalid.`), { code: "phone_call_envelope_invalid", statusCode: 400 });
  return value.map((item, index) => text(item, `${name}[${index}]`, maxLength));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

export function callEnvelopeHash(envelope) {
  return createHash("sha256").update(JSON.stringify(stable(envelope))).digest("hex");
}

export function normalizeCallEnvelope(input, { now = new Date() } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Object.assign(new Error("A call envelope is required."), { code: "phone_call_envelope_invalid", statusCode: 400 });
  const destination = text(input.destination, "destination", 16);
  if (!/^\+44[1-9]\d{8,9}$/.test(destination))
    throw Object.assign(new Error("Phone V1 accepts only UK E.164 destinations."), { code: "phone_destination_not_allowed", statusCode: 400 });
  const maximumDurationMinutes = Number(input.maximumDurationMinutes ?? 10);
  if (!PHONE_CALL_DURATIONS.includes(maximumDurationMinutes))
    throw Object.assign(new Error("maximumDurationMinutes is not supported."), { code: "phone_call_envelope_invalid", statusCode: 400 });
  const expiresAt = new Date(input.expiresAt);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now || expiresAt.getTime() - now.getTime() > MAX_EXPIRY_MS)
    throw Object.assign(new Error("Call authority must expire within 24 hours."), { code: "phone_call_envelope_invalid", statusCode: 400 });
  const timezone = input.callingWindow?.timezone || "Europe/London";
  if (timezone !== "Europe/London")
    throw Object.assign(new Error("Phone V1 calling windows use Europe/London."), { code: "phone_call_envelope_invalid", statusCode: 400 });
  const startAt = input.callingWindow?.startAt ? new Date(input.callingWindow.startAt) : now;
  const endAt = input.callingWindow?.endAt ? new Date(input.callingWindow.endAt) : expiresAt;
  if (![startAt, endAt].every((value) => Number.isFinite(value.getTime())) || startAt >= endAt || endAt > expiresAt)
    throw Object.assign(new Error("The calling window is invalid."), { code: "phone_call_envelope_invalid", statusCode: 400 });
  if ((input.maximumAttempts ?? 1) !== 1)
    throw Object.assign(new Error("Phone V1 permits exactly one dial attempt."), { code: "phone_call_envelope_invalid", statusCode: 400 });
  if ((input.recordingPolicy ?? "disabled") !== "disabled")
    throw Object.assign(new Error("Phone V1 raw-audio recording must remain disabled."), { code: "phone_recording_forbidden", statusCode: 400 });
  const voicemailPolicy = input.voicemailPolicy ?? "do_not_leave";
  if (!new Set(["do_not_leave", "leave_approved_message"]).has(voicemailPolicy))
    throw Object.assign(new Error("The voicemail policy is invalid."), { code: "phone_call_envelope_invalid", statusCode: 400 });
  const mediaProfile = input.mediaProfile || "chained_v1";
  if (!PHONE_MEDIA_PROFILES.includes(mediaProfile))
    throw Object.assign(new Error("The phone media profile is invalid."), { code: "phone_call_envelope_invalid", statusCode: 400 });
  const liveVoice = mediaProfile === "gpt_live_round2_preview" ? text(input.liveVoice, "liveVoice", 64) : null;
  if (liveVoice && !GPT_LIVE_PHONE_VOICES.includes(liveVoice))
    throw Object.assign(new Error("The GPT-Live phone voice is invalid."), { code: "phone_call_envelope_invalid", statusCode: 400 });

  return Object.freeze({
    version: 1,
    mediaProfile,
    liveVoice,
    enrollmentSessionId: mediaProfile === "speaker_enrollment_v1" ? text(input.enrollmentSessionId, "enrollmentSessionId", 160) : null,
    destination,
    expectedParty: text(input.expectedParty, "expectedParty", 200),
    callerDisclosure: text(input.callerDisclosure, "callerDisclosure", 500),
    objective: text(input.objective, "objective", 1000),
    approvedContext: text(input.approvedContext, "approvedContext", 4000, { optional: true }),
    permittedQuestions: Object.freeze(list(input.permittedQuestions, "permittedQuestions", { optional: true })),
    permittedDisclosures: Object.freeze(list(input.permittedDisclosures, "permittedDisclosures", { optional: true })),
    prohibitedDisclosures: Object.freeze(list(input.prohibitedDisclosures, "prohibitedDisclosures", { optional: true })),
    prohibitedActions: Object.freeze(list(input.prohibitedActions, "prohibitedActions", { optional: true })),
    languageStrategy: text(input.languageStrategy || "Match the other party's English, Arabic, or mixed Arabic-English naturally.", "languageStrategy", 500),
    maximumDurationMinutes,
    maximumAttempts: 1,
    callingWindow: Object.freeze({ timezone, startAt: startAt.toISOString(), endAt: endAt.toISOString() }),
    voicemailPolicy,
    approvedVoicemailMessage: voicemailPolicy === "leave_approved_message" ? text(input.approvedVoicemailMessage, "approvedVoicemailMessage", 1000) : null,
    recordingPolicy: "disabled",
    transcriptRetentionPolicy: "owner_private_until_deleted",
    terminationBehavior: text(input.terminationBehavior || "State that owner confirmation is required for anything outside scope, return to scope once, then end safely if needed.", "terminationBehavior", 1000),
    ownerContactReason: input.ownerContactReason ? text(input.ownerContactReason, "ownerContactReason", 80) : null,
    ownerContactPolicyVersion: input.ownerContactPolicyVersion ? Number(input.ownerContactPolicyVersion) : null,
    sourceTaskId: input.sourceTaskId ? text(input.sourceTaskId, "sourceTaskId", 160) : null,
    expiresAt: expiresAt.toISOString(),
  });
}

export function immutableCallEnvelope(input, options) {
  const envelope = normalizeCallEnvelope(input, options);
  return Object.freeze({ ...envelope, envelopeHash: callEnvelopeHash(envelope) });
}

export function callStartArguments(call) {
  return Object.freeze({ callIntentId: call.id, envelopeHash: call.envelopeHash, envelope: call.envelope });
}
