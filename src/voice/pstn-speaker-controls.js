import { randomUUID } from "node:crypto";
import { callStartArguments } from "../phone/call-envelope.js";
import { PSTN_ENROLLMENT_CHANNEL } from "./pstn-speaker-enrollment.js";

export const PSTN_CONTROL_CONSENT_VERSION = "pstn-non-owner-calibration-control-v1";
export const PSTN_CONTROL_CODES = Object.freeze(["control-01", "control-02", "control-03"]);
export const PSTN_CONTROL_DISCLOSURE = "This optional call measures how a non-owner voice compares with Mohammad's Nova speaker recognition. Raw audio and temporary voice embeddings are processed ephemerally and discarded. No recognition profile is created. Only anonymous scalar scores, quality, consent and audit metadata remain. Press 1 to consent or 2 to refuse.";
const LANGUAGES = new Set(["arabic", "english", "mixed"]);
const CONDITIONS = Object.freeze(["normal_handset", "normal_handset", "speakerphone", "speakerphone"]);
const COST_CAP_USD = 5;
const PROMPTS = Object.freeze({
  arabic: "اليوم أتحدث بصوتي الطبيعي عبر الهاتف، وهذه جملة قصيرة وواضحة لاختبار جودة الصوت فقط.",
  english: "Today I am speaking naturally on this phone, using a clear short sentence only for audio calibration.",
  mixed: "اليوم بحكي بصوتي الطبيعي على phone call، وهذا sample فقط لمعايرة جودة speaker recognition.",
});

export class PstnControlError extends Error {
  constructor(message, { code = "pstn_control_error", statusCode = 400 } = {}) { super(message); this.name = "PstnControlError"; this.code = code; this.statusCode = statusCode; }
}

const rounded = (value) => Number.isFinite(value) ? Math.round(value * 10_000) / 10_000 : null;
const normalized = (values) => { const magnitude = Math.hypot(...values); if (!magnitude) throw new Error("invalid representation"); return values.map((value) => value / magnitude); };
const centroid = (vectors) => normalized(Array.from({ length: vectors[0].length }, (_, index) => vectors.reduce((sum, vector) => sum + normalized(vector)[index], 0) / vectors.length));
const summary = (values) => values.length ? Object.freeze({ minimum: rounded(Math.min(...values)), maximum: rounded(Math.max(...values)), mean: rounded(values.reduce((sum, value) => sum + value, 0) / values.length) }) : null;
const safeQuality = (result) => Object.freeze({ voicedDurationSeconds: Number(result.speechSeconds || result.durationSeconds || 0), silenceRatio: Number.isFinite(result.silenceRatio) ? result.silenceRatio : null, clippingRatio: Number.isFinite(result.clippingRatio) ? result.clippingRatio : null, peakToNoiseDb: Number.isFinite(result.peakToNoiseDb) ? result.peakToNoiseDb : null, preprocessingVersion: result.preprocessingVersion || null, extractorVersion: result.extractorVersion || null, accepted: result.sufficient === true && Number(result.speechSeconds || result.durationSeconds || 0) >= 6, reason: result.sufficient !== true ? String(result.reason || "quality_rejected").slice(0, 80) : Number(result.speechSeconds || result.durationSeconds || 0) < 6 ? "insufficient_voiced_duration" : null });
const publicSession = (session) => session && ({ ...session, destination: undefined, plan: session.plan.map(({ id, language, condition, text }) => ({ id, language, condition, text })) });

function validatePlan(languages) {
  if (!Array.isArray(languages) || languages.length !== 4 || languages.some((value) => !LANGUAGES.has(value))) throw new PstnControlError("Exactly four supported language categories are required.", { code: "pstn_control_language_plan_invalid" });
  return languages.map((language, index) => Object.freeze({ id: `control-prompt-${index + 1}-${language}`, language, condition: CONDITIONS[index], text: PROMPTS[language] }));
}

export function createPstnSpeakerControls({ storage, ownerId, phoneService, speakerExtractor, speakerIdentity, enabled = true, clock = () => new Date(), idFactory = randomUUID } = {}) {
  if (!storage || !ownerId || !phoneService || !speakerExtractor || !speakerIdentity) throw new Error("PSTN control dependencies are required.");
  const requireEnabled = () => { if (!enabled) throw new PstnControlError("PSTN calibration controls are available only in the authorized Preview.", { code: "pstn_control_preview_only", statusCode: 404 }); };
  const load = async (id) => { const session = await storage.getSpeakerControlSession(id, ownerId); if (!session) throw new PstnControlError("PSTN control session was not found.", { code: "pstn_control_session_not_found", statusCode: 404 }); return session; };
  const ownerTemplate = async () => {
    const sessions = (await storage.listSpeakerEnrollmentSessions(ownerId, { limit: 20 })).filter((item) => item.status === "completed" && [1, 2].includes(item.sessionNumber)).sort((left, right) => left.sessionNumber - right.sessionNumber);
    if (sessions.length !== 2) throw new PstnControlError("Mohammad's complete PSTN enrollment evidence is required.", { code: "pstn_control_owner_evidence_incomplete", statusCode: 409 });
    const samples = [];
    for (const session of sessions) for (const sample of await storage.listSpeakerEnrollmentSamples(ownerId, session.id, { includeRepresentation: true })) if (sample.status === "accepted") samples.push({ ...sample, sessionNumber: session.sessionNumber });
    const byKey = new Map(samples.map((item) => [`${item.sessionNumber}:${item.ordinal}`, item]));
    const selected = ["1:1", "1:2", "2:1", "2:2"].map((key) => byKey.get(key));
    if (samples.length !== 6 || selected.some((item) => !item?.encryptedRepresentation)) throw new PstnControlError("Mohammad's candidate PSTN representation is incomplete.", { code: "pstn_control_owner_evidence_incomplete", statusCode: 409 });
    const versions = new Set(samples.map((item) => item.representationVersion));
    if (versions.size !== 1) throw new PstnControlError("Mohammad's PSTN evidence uses incompatible model versions.", { code: "pstn_control_owner_model_mismatch", statusCode: 409 });
    const vectors = selected.map((item) => speakerIdentity.revealRepresentation(item.encryptedRepresentation));
    if (vectors.some((value) => !Array.isArray(value))) throw new PstnControlError("Mohammad's PSTN evidence could not be read safely.", { code: "pstn_control_owner_evidence_unavailable", statusCode: 503 });
    const vector = centroid(vectors);
    const heldout = [byKey.get("1:3"), byKey.get("2:3")].map((item) => rounded(speakerIdentity.similarity(vector, speakerIdentity.revealRepresentation(item.encryptedRepresentation))));
    return { vector, representationVersion: [...versions][0], enrollmentSampleCount: samples.length, genuineHeldoutScores: heldout };
  };

  const service = Object.freeze({
    async prepareSession({ participantCode, destination, languages, conversationId } = {}) {
      requireEnabled();
      if (!PSTN_CONTROL_CODES.includes(participantCode)) throw new PstnControlError("Anonymous participant code is invalid.", { code: "pstn_control_participant_invalid" });
      const existing = (await storage.listSpeakerControlSessions(ownerId, { limit: 20 })).find((item) => item.participantCode === participantCode && !["failed", "refused", "revoked"].includes(item.status));
      if (existing) return { session: publicSession(existing), call: existing.callIntentId ? callStartArguments(await storage.getPhoneCallIntent(existing.callIntentId, ownerId)) : null, approval: existing.approvalId ? await storage.getApproval(existing.approvalId, ownerId) : null, idempotent: true };
      const completed = (await storage.listSpeakerControlSessions(ownerId, { limit: 20 })).filter((item) => item.status === "completed");
      const expectedIndex = completed.length;
      if (PSTN_CONTROL_CODES[expectedIndex] !== participantCode) throw new PstnControlError("Control participants must be collected one at a time in order.", { code: "pstn_control_participant_order_invalid", statusCode: 409 });
      await ownerTemplate();
      const plan = validatePlan(languages), id = `speaker-control-${idFactory()}`, expiresAt = new Date(clock().getTime() + 24 * 60 * 60 * 1000).toISOString();
      if (participantCode === "control-03") {
        const aggregateLanguages = new Set([...completed.flatMap((item) => item.plan.map((entry) => entry.language)), ...plan.map((entry) => entry.language)]);
        if ([...LANGUAGES].some((language) => !aggregateLanguages.has(language))) throw new PstnControlError("The three-participant plan must cover Arabic, English, and mixed Arabic-English naturally.", { code: "pstn_control_aggregate_language_coverage_invalid", statusCode: 409 });
      }
      const conversation = await storage.ensureConversation({ id: conversationId || `speaker-control-conversation-${idFactory()}`, ownerId, title: `Anonymous PSTN calibration control — ${participantCode}` });
      let session = await storage.createSpeakerControlSession({ id, ownerId, participantCode, conversationId: conversation.id, plan, consentVersion: PSTN_CONTROL_CONSENT_VERSION, consentDisclosure: PSTN_CONTROL_DISCLOSURE, status: "prepared", costCapUsd: COST_CAP_USD, expiresAt });
      const run = await storage.createRun({ id: `speaker-control-run-${idFactory()}`, ownerId, conversationId: conversation.id, goal: `Prepare consent-gated anonymous PSTN calibration control ${participantCode}`, status: "waiting_for_approval" });
      const call = await phoneService.prepare({ destination, expectedParty: `Consenting adult ${participantCode}`, callerDisclosure: "Nova speaker-calibration control assistant. Participation is optional.", objective: `Read the participant disclosure, obtain DTMF consent, and only after consent collect exactly four anonymous non-owner comparison samples for ${participantCode}.`, approvedContext: `Control session ${id}. Samples 1-2 use a normal handset; samples 3-4 use speakerphone. No general conversation.`, permittedQuestions: plan.map((item) => `${item.condition} ${item.language}: ${item.text}`), permittedDisclosures: [PSTN_CONTROL_DISCLOSURE, "Press 1 to consent; press 2 to refuse. Refusal ends the call without collection.", "No permanent participant profile is created."], prohibitedDisclosures: ["Mohammad's private memories, projects, accounts, biometric vectors, or calibration threshold."], prohibitedActions: ["No tools, external actions, commitments, identity enrollment, or threshold activation."], languageStrategy: "Use the fixed natural-language control prompts selected for this participant.", maximumDurationMinutes: 10, maximumAttempts: 1, voicemailPolicy: "do_not_leave", recordingPolicy: "disabled", mediaProfile: "speaker_control_v1", controlSessionId: id, expiresAt }, { conversationId: conversation.id, runId: run.id });
      const approval = await storage.createApproval({ id: `speaker-control-approval-${idFactory()}`, ownerId, runId: run.id, tool: "phone_call_start", reason: `Place exactly one consent-gated calibration-control call for ${participantCode}; no voice collection occurs before the participant presses 1.`, riskLevel: "SENSITIVE", arguments: call });
      await phoneService.approvalRequired(call, approval, { conversationId: conversation.id, runId: run.id });
      const assistantMessageId = `speaker-control-message-${idFactory()}`;
      await storage.appendMessage({ id: assistantMessageId, conversationId: conversation.id, ownerId, role: "assistant", content: `${participantCode} is prepared for a participant-consent-gated calibration control. Review the formal Approval card; no call occurs unless you click Approve.` });
      await storage.updateRun(run.id, ownerId, { result: { assistantMessageId, sessionId: id, callIntentId: call.callIntentId, approvalId: approval.id } });
      session = await storage.updateSpeakerControlSession(id, ownerId, { status: "waiting_for_approval", callIntentId: call.callIntentId, approvalId: approval.id });
      await storage.appendActivity({ ownerId, runId: run.id, action: "pstn_speaker_control_prepared", tool: "phone_call_start", status: "waiting_for_approval", summary: `Prepared anonymous consent-gated PSTN control ${participantCode} without dialing.`, metadata: { sessionId: id, participantCode, callIntentId: call.callIntentId, approvalId: approval.id, expectedSamples: 4, costCapUsd: COST_CAP_USD, recording: false, permanentProfile: false } });
      return { session: publicSession(session), call, approval, idempotent: false };
    },
    async participantDecision({ sessionId, participantCode, decision, method } = {}) {
      requireEnabled();
      const session = await load(sessionId);
      if (session.participantCode !== participantCode || method !== "in_call_dtmf" || !["consent", "refuse"].includes(decision)) throw new PstnControlError("Participant consent decision is invalid.", { code: "pstn_control_consent_invalid", statusCode: 403 });
      if (!["awaiting_consent", "collecting", "refused"].includes(session.status)) throw new PstnControlError("Participant consent is not currently available.", { code: "pstn_control_consent_inactive", statusCode: 409 });
      if (session.consentStatus !== "pending") return { session: publicSession(session), idempotent: true };
      const timestamp = clock().toISOString(), granted = decision === "consent";
      const updated = await storage.updateSpeakerControlSession(session.id, ownerId, { status: granted ? "collecting" : "refused", consentStatus: granted ? "granted" : "refused", consentedAt: granted ? timestamp : null, refusedAt: granted ? null : timestamp, completedAt: granted ? null : timestamp });
      await storage.appendActivity({ ownerId, action: granted ? "pstn_speaker_control_consent_granted" : "pstn_speaker_control_consent_refused", status: granted ? "completed" : "refused", summary: granted ? "Recorded direct in-call DTMF consent for anonymous PSTN calibration control." : "Participant refused anonymous PSTN calibration control; no samples were collected.", metadata: { sessionId, participantCode, consentVersion: PSTN_CONTROL_CONSENT_VERSION, method: "in_call_dtmf", acceptedCount: updated.acceptedCount } });
      return { session: publicSession(updated), idempotent: false };
    },
    async submitSample({ sessionId, participantCode, submissionKey, ordinal, promptId, audioBase64, mimeType, durationSeconds }, { signal } = {}) {
      requireEnabled();
      const session = await load(sessionId);
      if (session.participantCode !== participantCode || session.status !== "collecting" || session.consentStatus !== "granted") throw new PstnControlError("Control sample collection is not consented and active.", { code: "pstn_control_consent_required", statusCode: 403 });
      if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 4 || session.plan[ordinal - 1]?.id !== promptId || !/^[A-Za-z0-9:_-]{8,180}$/.test(submissionKey || "")) throw new PstnControlError("Control sample binding is invalid.", { code: "pstn_control_sample_invalid" });
      const samples = await storage.listSpeakerControlSamples(ownerId, sessionId);
      const prior = samples.find((item) => item.submissionKey === submissionKey || (item.status === "accepted" && item.ordinal === ordinal));
      if (prior) return { idempotent: true, retry: prior.status !== "accepted", acceptedCount: session.acceptedCount, sample: prior };
      if (ordinal !== session.acceptedCount + 1) throw new PstnControlError("Control samples must be accepted in the approved order.", { code: "pstn_control_sample_order_invalid", statusCode: 409 });
      const result = await speakerExtractor.extract({ audioBase64, mimeType, durationSeconds }, { signal, requestId: `pstn-control-${idFactory()}` });
      const quality = safeQuality(result), status = quality.accepted ? "accepted" : "retry", item = session.plan[ordinal - 1];
      let score = null, representationVersion = null;
      if (status === "accepted") {
        const owner = await ownerTemplate();
        representationVersion = result.extractorVersion || null;
        if (!Array.isArray(result.representation) || representationVersion !== owner.representationVersion) throw new PstnControlError("Control sample model does not match Mohammad's PSTN evidence.", { code: "pstn_control_model_mismatch", statusCode: 409 });
        score = rounded(speakerIdentity.similarity(owner.vector, result.representation));
      }
      const recorded = await storage.recordSpeakerControlSample({ id: `speaker-control-sample-${idFactory()}`, ownerId, sessionId, participantCode, ordinal, submissionKey, promptId, language: item.language, conditionLabel: item.condition, status, quality, score, representationVersion, preprocessingVersion: quality.preprocessingVersion });
      const current = await load(sessionId);
      if (recorded.inserted && status === "accepted" && current.acceptedCount === 4) await storage.updateSpeakerControlSession(sessionId, ownerId, { status: "completed", completedAt: clock().toISOString() });
      await storage.appendActivity({ ownerId, action: status === "accepted" ? "pstn_speaker_control_sample_scored" : "pstn_speaker_control_sample_rejected", status: status === "accepted" ? "completed" : "failed", summary: status === "accepted" ? "Stored one anonymous scalar PSTN control score and discarded temporary audio and embedding." : "Rejected and discarded an insufficient PSTN control sample.", metadata: { sessionId, participantCode, ordinal, language: item.language, condition: item.condition, score, quality, representationVersion, rawAudioPersisted: false, embeddingPersisted: false } });
      const final = await load(sessionId);
      return { idempotent: !recorded.inserted, retry: status !== "accepted", acceptedCount: final.acceptedCount, completed: final.status === "completed", sample: recorded.sample };
    },
    async status() {
      const sessions = await storage.listSpeakerControlSessions(ownerId, { limit: 20 });
      return { enabled, targetParticipants: 3, targetSamples: 12, costCapUsd: COST_CAP_USD, sessions: sessions.map(publicSession), finalCalibrationCreated: false, ownerModeEnabled: false };
    },
    async diagnostics() {
      requireEnabled();
      const sessions = (await storage.listSpeakerControlSessions(ownerId, { limit: 20 })).filter((item) => item.status === "completed");
      const samples = [];
      for (const session of sessions) for (const sample of await storage.listSpeakerControlSamples(ownerId, session.id)) if (sample.status === "accepted") samples.push(sample);
      const values = samples.map((item) => Number(item.score)).filter(Number.isFinite), group = (predicate) => summary(samples.filter(predicate).map((item) => Number(item.score)).filter(Number.isFinite));
      const owner = await ownerTemplate(), ownerGenuineHeldout = summary(owner.genuineHeldoutScores);
      const perParticipant = Object.fromEntries(PSTN_CONTROL_CODES.map((code) => [code, group((item) => item.participantCode === code)]));
      const complete = sessions.length === 3 && values.length === 12 && PSTN_CONTROL_CODES.every((code) => samples.filter((item) => item.participantCode === code).length === 4);
      const maximumObservedNonOwnerScore = values.length ? rounded(Math.max(...values)) : null;
      return Object.freeze({ status: complete ? "evidence_complete" : "collecting", participantCount: sessions.length, sampleCount: values.length, overall: summary(values), handset: group((item) => item.conditionLabel === "normal_handset"), speakerphone: group((item) => item.conditionLabel === "speakerphone"), languages: Object.fromEntries([...LANGUAGES].map((language) => [language, group((item) => item.language === language)])), perParticipant, maximumObservedNonOwnerScore, ownerGenuineHeldout, availableSafetyGap: ownerGenuineHeldout && maximumObservedNonOwnerScore !== null ? rounded(ownerGenuineHeldout.minimum - maximumObservedNonOwnerScore) : null, thresholdSelected: false, calibrationCreated: false, ownerModeEnabled: false });
    },
  });
  return service;
}
