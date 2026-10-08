import test from "node:test";
import assert from "node:assert/strict";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";
import { createSpeakerIdentity } from "../src/voice/speaker-identity.js";
import { createPstnSpeakerControls, PSTN_CONTROL_CONSENT_VERSION, PSTN_CONTROL_DISCLOSURE } from "../src/voice/pstn-speaker-controls.js";
import { immutableCallEnvelope, callStartArguments } from "../src/phone/call-envelope.js";
import { approvalViewModel } from "../assets/approval-presenter.js";
import { createSpeakerControlSession } from "../phone-bridge/speaker-control-session.js";
import { parseTwilioMediaMessage } from "../src/phone/twilio-media-protocol.js";
import { SCHEMA_STATEMENTS, SCHEMA_VERSION } from "../src/storage/schema.js";

const OWNER = "owner";
const DESTINATION = "+447960672981";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const LANGUAGES = ["arabic", "english", "mixed", "arabic"];

async function fixture({ extract, enabled = true } = {}) {
  let nonce = 0;
  const idFactory = () => `00000000-0000-4000-8000-${String(++nonce).padStart(12, "0")}`;
  const storage = createInMemoryStorage({ clock: () => NOW });
  await storage.initialize({ owner: { id: OWNER, fullName: "Mohammad" } });
  const identity = createSpeakerIdentity({ storage, ownerId: OWNER, embeddingKey: "preview-control-test-key-with-more-than-32-bytes", requireEncryption: true });
  const conversation = await storage.ensureConversation({ id: "owner-enrollment", ownerId: OWNER, title: "Owner enrollment" });
  for (const sessionNumber of [1, 2]) {
    const session = await storage.createSpeakerEnrollmentSession({ id: `owner-session-${sessionNumber}`, ownerId: OWNER, consentId: "owner-consent", conversationId: conversation.id, sessionNumber, conditionLabel: sessionNumber === 1 ? "quiet_normal_handset" : "speakerphone", phrasePlan: [{ id: "a" }, { id: "e" }, { id: "m" }], status: "completed", expiresAt: "2026-10-08T12:00:00.000Z" });
    for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
      await storage.recordSpeakerEnrollmentSample({ id: `owner-sample-${sessionNumber}-${ordinal}`, ownerId: OWNER, sessionId: session.id, ordinal, submissionKey: `owner:${sessionNumber}:${ordinal}`, promptId: `owner-prompt-${ordinal}`, language: ["arabic", "english", "mixed"][ordinal - 1], conditionLabel: session.conditionLabel, status: "accepted", quality: { accepted: true }, encryptedRepresentation: identity.protectRepresentation([1, 0, 0]), representationVersion: "ecapa-v1" });
    }
  }
  let dialed = 0;
  const phoneService = {
    async prepare(input, context) {
      const immutable = immutableCallEnvelope(input, { now: NOW });
      const { envelopeHash, ...envelope } = immutable;
      const id = `phone_${String(++nonce).padStart(32, "0")}`;
      const call = await storage.createPhoneCallIntent({ id, ownerId: OWNER, conversationId: context.conversationId, preparedRunId: context.runId, callConversationId: `phone-session-${id}`, envelope, envelopeHash, expiresAt: envelope.expiresAt });
      return callStartArguments(call);
    },
    async approvalRequired(input, approval) { return storage.bindPhoneCallApproval(input.callIntentId, OWNER, { approvalId: approval.id, status: "waiting_for_approval" }); },
    async start() { dialed += 1; },
  };
  const extractor = { extract: extract || (async () => ({ sufficient: true, representation: [0.4, Math.sqrt(1 - 0.4 ** 2), 0], extractorVersion: "ecapa-v1", preprocessingVersion: "pstn-pcmu-v1", speechSeconds: 7, silenceRatio: 0.1, clippingRatio: 0, peakToNoiseDb: 18 })) };
  const service = createPstnSpeakerControls({ storage, ownerId: OWNER, phoneService, speakerExtractor: extractor, speakerIdentity: identity, enabled, clock: () => NOW, idFactory });
  return { storage, identity, service, get dialed() { return dialed; } };
}

async function prepare(f, participantCode = "control-01") {
  return f.service.prepareSession({ participantCode, destination: DESTINATION, languages: LANGUAGES });
}

async function activate(f, prepared, decision = "consent") {
  await f.storage.updateSpeakerControlSession(prepared.session.id, OWNER, { status: "awaiting_consent" });
  return f.service.participantDecision({ sessionId: prepared.session.id, participantCode: prepared.session.participantCode, decision, method: "in_call_dtmf" });
}

test("schema 19 adds bounded non-owner controls without raw audio, embeddings, or participant profiles", () => {
  assert.ok(SCHEMA_VERSION >= 19);
  const schema = SCHEMA_STATEMENTS.filter((statement) => statement.includes("nova_speaker_control_")).join("\n");
  assert.match(schema, /participant_code/);
  assert.match(schema, /score numeric/);
  assert.match(schema, /one_accepted_ordinal/);
  assert.doesNotMatch(schema, /raw_audio|audio_base64|encrypted_representation|voiceprint|participant_name/i);
});

test("the workflow is unavailable outside the explicitly authorized Preview runtime", async () => {
  const f = await fixture({ enabled: false });
  assert.equal((await f.service.status()).enabled, false);
  await assert.rejects(() => prepare(f), (error) => error.code === "pstn_control_preview_only" && error.statusCode === 404);
  assert.equal((await f.storage.listSpeakerControlSessions(OWNER)).length, 0);
});

test("preparation creates one immutable formal Approval and never dials", async () => {
  const f = await fixture();
  const first = await prepare(f), replay = await prepare(f);
  assert.equal(first.session.status, "waiting_for_approval");
  assert.equal(first.session.consentStatus, "pending");
  assert.equal(first.call.envelope.mediaProfile, "speaker_control_v1");
  assert.equal(first.call.envelope.recordingPolicy, "disabled");
  assert.equal(first.approval.status, "pending");
  assert.equal(replay.idempotent, true);
  assert.equal(replay.approval.id, first.approval.id);
  assert.equal((await f.storage.getPhoneCallIntent(first.call.callIntentId, OWNER)).attemptCount, 0);
  assert.equal(f.dialed, 0);
  const view = approvalViewModel(first.approval);
  assert.equal(view.title, "Approve consent-gated calibration control call");
  assert.match(JSON.stringify(view.fields), /Participant presses 1.*2 refuses/);
  assert.match(JSON.stringify(view.fields), /disabled \/ ephemeral/);
});

test("collection fails closed before direct participant DTMF consent and Mohammad cannot consent for another adult", async () => {
  const f = await fixture(), prepared = await prepare(f), item = prepared.session.plan[0];
  await f.storage.updateSpeakerControlSession(prepared.session.id, OWNER, { status: "awaiting_consent" });
  await assert.rejects(() => f.service.participantDecision({ sessionId: prepared.session.id, participantCode: "control-01", decision: "consent", method: "owner_assertion" }), (error) => error.code === "pstn_control_consent_invalid");
  await assert.rejects(() => f.service.submitSample({ sessionId: prepared.session.id, participantCode: "control-01", submissionKey: "before:consent:1", ordinal: 1, promptId: item.id, audioBase64: "AA==", mimeType: "audio/wav", durationSeconds: 5 }), (error) => error.code === "pstn_control_consent_required");
  assert.equal((await f.storage.listSpeakerControlSamples(OWNER, prepared.session.id)).length, 0);
});

test("participant refusal ends that call without samples and permits a fresh consent attempt for the anonymous slot", async () => {
  const f = await fixture(), prepared = await prepare(f);
  const refused = await activate(f, prepared, "refuse"), replacement = await prepare(f);
  assert.equal(refused.session.status, "refused");
  assert.equal(refused.session.consentStatus, "refused");
  assert.equal(replacement.idempotent, false);
  assert.notEqual(replacement.session.id, prepared.session.id);
  assert.equal((await f.storage.listSpeakerControlSamples(OWNER, prepared.session.id)).length, 0);
});

test("failed samples do not count; accepted ordinals are ordered, exactly-once, and stop at four", async () => {
  let calls = 0;
  const f = await fixture({ extract: async () => ++calls === 1 ? { sufficient: true, representation: [0.35, Math.sqrt(1 - 0.35 ** 2), 0], extractorVersion: "ecapa-v1", speechSeconds: 5 } : { sufficient: true, representation: [0.35, Math.sqrt(1 - 0.35 ** 2), 0], extractorVersion: "ecapa-v1", preprocessingVersion: "pstn-pcmu-v1", speechSeconds: 7, silenceRatio: 0.1, clippingRatio: 0, peakToNoiseDb: 18 } });
  const prepared = await prepare(f); await activate(f, prepared);
  const submit = (ordinal, submissionKey) => f.service.submitSample({ sessionId: prepared.session.id, participantCode: "control-01", submissionKey, ordinal, promptId: prepared.session.plan[ordinal - 1].id, audioBase64: "AA==", mimeType: "audio/wav", durationSeconds: 5 });
  const bad = await submit(1, "control:bad:0001");
  assert.equal(bad.retry, true); assert.equal(bad.acceptedCount, 0);
  await assert.rejects(() => submit(2, "control:early:0002"), (error) => error.code === "pstn_control_sample_order_invalid");
  const first = await submit(1, "control:good:0001"), duplicate = await submit(1, "control:duplicate:1");
  assert.equal(first.acceptedCount, 1); assert.equal(duplicate.idempotent, true); assert.equal(duplicate.acceptedCount, 1);
  for (let ordinal = 2; ordinal <= 4; ordinal += 1) await submit(ordinal, `control:good:000${ordinal}`);
  const session = await f.storage.getSpeakerControlSession(prepared.session.id, OWNER), samples = await f.storage.listSpeakerControlSamples(OWNER, prepared.session.id);
  assert.equal(session.status, "completed"); assert.equal(session.acceptedCount, 4);
  assert.equal(samples.filter((sample) => sample.status === "accepted").length, 4);
  assert.equal(samples.filter((sample) => sample.status === "retry").length, 1);
  assert.ok(samples.every((sample) => !("audioBase64" in sample) && !("representation" in sample) && !("encryptedRepresentation" in sample)));
  assert.equal((await f.storage.listSpeakerProfiles(OWNER)).length, 0);
  assert.equal(await f.storage.getSpeakerChannelCalibration(OWNER, "pstn_8khz_v1"), null);
  assert.equal((await f.storage.listSpeakerEnrollmentSessions(OWNER)).reduce((sum, ownerSession) => sum + ownerSession.acceptedCount, 0), 6);
});

test("three anonymous participants produce only non-reconstructive bounded diagnostics and never activate calibration", async () => {
  const f = await fixture();
  for (const code of ["control-01", "control-02", "control-03"]) {
    const prepared = await prepare(f, code); await activate(f, prepared);
    for (let ordinal = 1; ordinal <= 4; ordinal += 1) await f.service.submitSample({ sessionId: prepared.session.id, participantCode: code, submissionKey: `${code}:sample:${ordinal}`, ordinal, promptId: prepared.session.plan[ordinal - 1].id, audioBase64: "AA==", mimeType: "audio/wav", durationSeconds: 5 });
  }
  const result = await f.service.diagnostics();
  assert.equal(result.status, "evidence_complete"); assert.equal(result.participantCount, 3); assert.equal(result.sampleCount, 12);
  assert.equal(result.thresholdSelected, false); assert.equal(result.calibrationCreated, false); assert.equal(result.ownerModeEnabled, false);
  assert.deepEqual(result.ownerGenuineHeldout, { minimum: 1, maximum: 1, mean: 1 }); assert.equal(result.availableSafetyGap, 0.6);
  assert.equal(Object.keys(result.perParticipant).length, 3);
  assert.equal(JSON.stringify(result).includes("representation"), false);
  assert.equal(await f.storage.getSpeakerChannelCalibration(OWNER, "pstn_8khz_v1"), null);
});

test("bridge ignores all audio until DTMF consent, supports refusal, and retains no raw audio", async () => {
  const f = await fixture(), prepared = await prepare(f), sent = [], consentCalls = [], sampleCalls = [];
  await f.storage.updateSpeakerControlSession(prepared.session.id, OWNER, { status: "awaiting_consent" });
  const authorization = { bridgeSessionToken: "bridge", control: { sessionId: prepared.session.id, participantCode: "control-01", plan: prepared.session.plan } };
  const runtime = createSpeakerControlSession({ sendTwilio: (value) => sent.push(value), hangup() {}, tts: { async *stream() { yield Buffer.from([1, 2, 3]); } }, novaClient: { async controlConsent(input) { consentCalls.push(input); return { session: { status: "refused" } }; }, async controlSample(input) { sampleCalls.push(input); return { retry: false }; }, async event() {} }, authorization, callIntentId: prepared.call.callIntentId, callSid: `CA${"1".repeat(32)}`, streamSid: `MZ${"2".repeat(32)}`, maximumDurationSeconds: 600, setTimer: () => 1, clearTimer() {} });
  await runtime.start();
  await runtime.handle({ event: "media", media: { payload: Buffer.alloc(160).toString("base64") } });
  assert.equal(sampleCalls.length, 0); assert.equal(consentCalls.length, 0);
  await runtime.handle({ event: "dtmf", dtmf: { digit: "1" } });
  assert.equal(consentCalls.length, 0);
  const disclosureMark = sent.findLast((message) => message.event === "mark").mark.name;
  await runtime.handle({ event: "mark", mark: { name: disclosureMark } });
  await runtime.handle({ event: "dtmf", dtmf: { digit: "2" } });
  assert.equal(consentCalls.length, 1); assert.equal(consentCalls[0].decision, "refuse"); assert.equal(sampleCalls.length, 0);
  assert.equal(runtime.metrics().rawAudioPersisted, false); assert.equal(runtime.metrics().controlEmbeddingPersisted, false);
  assert.doesNotThrow(() => parseTwilioMediaMessage({ event: "dtmf", dtmf: { digit: "1" } }));
  assert.throws(() => parseTwilioMediaMessage({ event: "dtmf", dtmf: { digit: "A" } }), /DTMF/);
  await runtime.stop("completed", "test", { hangupSocket: false });
  assert.ok(sent.some((message) => message.event === "mark"));
});

test("the exact participant disclosure is versioned, optional, and explains retention", () => {
  assert.equal(PSTN_CONTROL_CONSENT_VERSION, "pstn-non-owner-calibration-control-v1");
  assert.match(PSTN_CONTROL_DISCLOSURE, /optional/i);
  assert.match(PSTN_CONTROL_DISCLOSURE, /Raw audio.*temporary voice embeddings.*discarded/i);
  assert.match(PSTN_CONTROL_DISCLOSURE, /No recognition profile/i);
  assert.match(PSTN_CONTROL_DISCLOSURE, /Press 1.*2 to refuse/i);
});
