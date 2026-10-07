import { createHash, randomUUID } from "node:crypto";
import { callEnvelopeHash, callStartArguments, immutableCallEnvelope } from "./call-envelope.js";
import { waitForBridgeReady } from "./bridge-readiness.js";
import { projectCallTimeline, summarizeCall } from "./call-projection.js";

export class PhoneError extends Error {
  constructor(message, { code = "phone_error", statusCode = 400, category = "safety" } = {}) { super(message); this.name = "PhoneError"; this.code = code; this.statusCode = statusCode; this.category = category; }
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const publicCall = (call) => ({ id: call.id, conversationId: call.conversationId, callConversationId: call.callConversationId, envelope: call.envelope, envelopeHash: call.envelopeHash, status: call.status, attemptCount: call.attemptCount, providerStatus: call.providerStatus, outcome: call.outcome, summary: call.summary, errorCode: call.errorCode, startedAt: call.startedAt, endedAt: call.endedAt, createdAt: call.createdAt, updatedAt: call.updatedAt, ...(call.assistantMessageId ? { assistantMessageId: call.assistantMessageId } : {}) });
const CONSEQUENTIAL_CALL_REQUEST=/\b(?:buy|purchase|pay|charge|sign|contract|agree to|commit to|place (?:the|an) order|send (?:an )?email|transfer money|share (?:a )?(?:password|code|account))\b|(?:اشتري|ادفع|وقّع|وقع|عقد|حوّل|حول|كلمة السر|رمز التحقق)/iu;
const CONSEQUENTIONAL_COMMITMENT=/\b(?:I|we)\s+(?:agree|accept|promise|commit|authorize|confirm (?:the|your) order|will (?:buy|purchase|pay|sign|send))\b|(?:أوافق|أتعهد|سأشتري|راح أشتري|سأدفع|راح أدفع|سأوقّع|راح أوقع)/iu;
const OWNER_CONFIRMATION_RESPONSE="I can't authorize that during this call. The owner must confirm it separately, so I'll end here safely.";

export function createPhoneService({ config, storage, ownerId, dialProvider, sessionAuth, novaTurn, ownerContactPolicy = null, prewarmSpeaker = null, fetchImpl = globalThis.fetch, clock = () => new Date(), idFactory = randomUUID }) {
  const phone = config.phone;
  const requireConfigured = () => { if (!phone.configured) throw new PhoneError("Phone V1 is not configured.", { code: "phone_not_configured", statusCode: 503, category: "configuration" }); };
  const load = async (id) => {
    const call = await storage.getPhoneCallIntent(id, ownerId);
    if (!call) throw new PhoneError("Phone call intent was not found.", { code: "phone_call_not_found", statusCode: 404 });
    return call;
  };
  async function validatedStart(input, context = {}) {
    const call = await load(input.callIntentId);
    if (context.conversationId && call.conversationId !== context.conversationId) throw new PhoneError("Phone call intent is not bound to this conversation.", { code: "phone_conversation_mismatch", statusCode: 403 });
    if (call.envelopeHash !== input.envelopeHash || callEnvelopeHash(input.envelope) !== call.envelopeHash)
      throw new PhoneError("Phone call authority no longer matches its immutable envelope.", { code: "phone_call_envelope_mismatch", statusCode: 409 });
    if (new Date(call.expiresAt) <= clock()) throw new PhoneError("Phone call authority has expired.", { code: "phone_call_expired", statusCode: 409 });
    const now=clock(),windowStart=new Date(call.envelope.callingWindow.startAt),windowEnd=new Date(call.envelope.callingWindow.endAt);
    if(now<windowStart||now>windowEnd)throw new PhoneError("The approved calling window is not currently open.",{code:"phone_calling_window_closed",statusCode:409});
    if(call.envelope.mediaProfile==="speaker_enrollment_v1"){
      const session=await storage.getSpeakerEnrollmentSession?.(call.envelope.enrollmentSessionId,ownerId),consent=session?await storage.getActiveSpeakerEnrollmentConsent?.(ownerId,{purpose:"pstn_speaker_recognition_owner_voice_enrollment",channel:"pstn_8khz_v1"}):null;
      if(!session||session.callIntentId&&session.callIntentId!==call.id||!consent||session.consentId!==consent.id||!['prepared','waiting_for_approval','approved'].includes(session.status))throw new PhoneError("The consented enrollment session is not active.",{code:"pstn_enrollment_session_inactive",statusCode:409});
    }
    return call;
  }

  return Object.freeze({
    configured: phone.configured,
    async prepare(input, context = {}) {
      requireConfigured();
      if (!context.conversationId) throw new PhoneError("A conversation is required for a phone call.", { code: "phone_conversation_required" });
      const immutable = immutableCallEnvelope(input, { now: clock() });
      const { envelopeHash, ...envelope } = immutable;
      const id = `phone_${idFactory().replaceAll("-", "")}`;
      const call = await storage.createPhoneCallIntent({ id, ownerId, conversationId: context.conversationId, preparedRunId: context.runId || null, callConversationId: `phone-session-${id}`, envelope, envelopeHash, expiresAt: envelope.expiresAt });
      await storage.appendActivity({ ownerId, projectId: context.projectId || null, runId: context.runId || null, action: "phone_call_prepared", tool: "phone_call_prepare", status: "completed", summary: "Prepared an immutable outbound call envelope.", metadata: { callIntentId: id, envelopeHash, maximumDurationMinutes: envelope.maximumDurationMinutes } });
      return callStartArguments(call);
    },
    async prepareOwnerContact(input, context = {}) {
      requireConfigured();
      if (!ownerContactPolicy) throw new PhoneError("Owner contact policy is unavailable.", { code: "owner_contact_policy_unavailable", statusCode: 503 });
      const grant = await ownerContactPolicy.authorize({ destination: phone.ownerNumber, reason: input.reason, sourceTaskId: input.sourceTaskId || context.runId || null });
      if (!grant.authorized) throw new PhoneError("Standing owner contact authority is not currently available.", { code: `owner_contact_policy_${grant.reason}`, statusCode: 403 });
      return this.prepare({
        destination: grant.destination, expectedParty: "Mohammad", callerDisclosure: "Nova, Mohammad's AI operating partner.", objective: input.objective,
        approvedContext: input.approvedContext || null, permittedQuestions: input.permittedQuestions || [], permittedDisclosures: input.permittedDisclosures || [], prohibitedDisclosures: input.prohibitedDisclosures || [], prohibitedActions: input.prohibitedActions || [],
        languageStrategy: input.languageStrategy || "Arabic first; match Mohammad's Arabic, English, or mixed Arabic-English naturally.", maximumDurationMinutes: input.maximumDurationMinutes || 10, maximumAttempts: 1,
        callingWindow: input.callingWindow, voicemailPolicy: "do_not_leave", recordingPolicy: "disabled", mediaProfile: "gpt_live_round2_preview", liveVoice: "gleam", expiresAt: grant.expiresAt,
        ownerContactReason: grant.reason, ownerContactPolicyVersion: grant.policyVersion, sourceTaskId: grant.sourceTaskId,
      }, context);
    },
    async current(_input, context = {}) {
      if (!context.conversationId) throw new PhoneError("A conversation is required.", { code: "phone_conversation_required" });
      const [call] = await storage.listConversationPhoneCalls(ownerId, context.conversationId, { limit: 1 });
      if (!call) throw new PhoneError("No prepared phone call exists in this conversation.", { code: "phone_call_not_found", statusCode: 404 });
      return callStartArguments(call);
    },
    validateStart: validatedStart,
    async authorizeStanding(input, context = {}) {
      if (!ownerContactPolicy) return { authorized: false };
      const call = await validatedStart(input, context);
      if(call.envelope.mediaProfile==="speaker_enrollment_v1")return {authorized:false};
      if (!call.envelope.ownerContactPolicyVersion || !call.envelope.ownerContactReason) return { authorized: false };
      const grant = await ownerContactPolicy.authorize({ destination: call.envelope.destination, reason: call.envelope.ownerContactReason, sourceTaskId: call.envelope.sourceTaskId });
      return grant.authorized && grant.policyVersion === call.envelope.ownerContactPolicyVersion ? grant : { authorized: false };
    },
    async approvalRequired(input, approval, context = {}) {
      const call = await validatedStart(input, context);
      const updated=await storage.bindPhoneCallApproval(call.id, ownerId, { approvalId: approval.id, status: "waiting_for_approval" });
      if(updated?.envelope?.mediaProfile==="speaker_enrollment_v1")await storage.updateSpeakerEnrollmentSession(updated.envelope.enrollmentSessionId,ownerId,{status:"waiting_for_approval",callIntentId:updated.id,approvalId:approval.id});
      return updated;
    },
    async approvalDecision(approval, decision) {
      if (approval?.tool !== "phone_call_start") return null;
      const call = await load(approval.arguments?.callIntentId);
      if (call.approvalId !== approval.id || call.envelopeHash !== approval.arguments?.envelopeHash) throw new PhoneError("Phone approval binding is invalid.", { code: "phone_approval_binding_invalid", statusCode: 409 });
      if (decision !== "rejected") return call;
      if (call.status === "waiting_for_approval") {
        const updated = await storage.updatePhoneCallIntent(call.id, ownerId, { status: "failed", outcome: "owner_rejected", errorCode: "phone_owner_rejected", endedAt: clock().toISOString() });
        if(call.envelope.mediaProfile==="speaker_enrollment_v1")await storage.updateSpeakerEnrollmentSession(call.envelope.enrollmentSessionId,ownerId,{status:"failed"});
        await storage.appendActivity({ ownerId, projectId: approval.projectId || null, runId: approval.runId || null, action: "phone_call_rejected", tool: "phone_call_start", status: "rejected", summary: "Owner rejected the prepared outbound call.", metadata: { callIntentId: call.id } });
        return updated;
      }
      return call;
    },
    async start(input, context = {}) {
      requireConfigured();
      let call = await validatedStart(input, context);
      const standing = context.standingPolicy?.authorized === true && context.standingPolicy.policyVersion === call.envelope.ownerContactPolicyVersion;
      if (!context.approvalId && !standing) throw new PhoneError("Formal owner approval or an active bounded owner-contact policy is required.", { code: "phone_approval_required", statusCode: 403 });
      if (!standing) call = await storage.approvePhoneCallIntent(call.id, ownerId, { approvalId: context.approvalId });
      if (!call) throw new PhoneError("The approved call could not be bound safely.", { code: "phone_approval_binding_invalid", statusCode: 409 });
      if(call.envelope.mediaProfile==="speaker_enrollment_v1"&&call.status==="approved")await storage.updateSpeakerEnrollmentSession(call.envelope.enrollmentSessionId,ownerId,{status:"approved"});
      if (["dialing", "in_progress", "completed"].includes(call.status)) return { callIntentId: call.id, status: call.status, idempotent: true, callSid: call.providerCallSid || null };
      if (["failed", "uncertain"].includes(call.status) || call.attemptCount >= call.envelope.maximumAttempts)
        throw new PhoneError("This call is terminal or has an uncertain outcome; Nova will not dial again automatically.", { code: "phone_call_not_retryable", statusCode: 409, category: "idempotency" });
      if (typeof prewarmSpeaker === "function") {
        const readiness = await prewarmSpeaker();
        if (readiness?.available !== true) throw new PhoneError("Speaker verification is not ready for the owner call.", { code: "phone_speaker_not_ready", statusCode: 503, category: "readiness" });
      }
      // Make the bridge the final readiness gate so Fly is awake immediately before
      // the exactly-once dial claim; a long-lived paid warm worker is unnecessary.
      await waitForBridgeReady({ healthUrl: `${phone.bridgeBaseUrl}/health/ready`, fetchImpl, attempts: phone.bridgeReadinessAttempts, delayMs: phone.bridgeReadinessDelayMs });
      if (standing) {
        await ownerContactPolicy.consume(context.standingPolicy.policyVersion);
        call = await storage.authorizePhoneCallByPolicy(call.id, ownerId, { policyVersion: context.standingPolicy.policyVersion });
        if (!call) throw new PhoneError("Standing owner-contact authority could not be bound safely.", { code: "owner_contact_policy_binding_failed", statusCode: 409 });
      }
      const sessionToken = sessionAuth.issueStart({ ownerId, callIntentId: call.id, envelopeHash: call.envelopeHash }, 300);
      const tokenHash = sessionAuth.tokenHash(sessionToken);
      const tokenExpiresAt = new Date(clock().getTime() + 300_000).toISOString();
      const submissionKey = `phone-dial-${sha256(`${call.id}:${call.envelopeHash}`).slice(0, 48)}`;
      let claim;
      try { claim = await storage.claimPhoneCallDial({ id: call.id, ownerId, approvalId: context.approvalId || null, policyVersion: standing ? context.standingPolicy.policyVersion : null, submissionKey, tokenHash, tokenExpiresAt }); }
      catch (error) {
        if (error?.code === "23505") throw new PhoneError("Another outbound call is already active.", { code: "phone_call_already_active", statusCode: 409, category: "concurrency" });
        throw error;
      }
      if (!claim?.claimed) {
        if (claim?.reason === "active_call") throw new PhoneError("Another outbound call is already active.", { code: "phone_call_already_active", statusCode: 409, category: "concurrency" });
        if (claim?.call && ["dialing", "in_progress", "completed"].includes(claim.call.status)) return { callIntentId: call.id, status: claim.call.status, idempotent: true, callSid: claim.call.providerCallSid || null };
        throw new PhoneError("This call cannot be dialed again.", { code: "phone_call_not_retryable", statusCode: 409, category: "idempotency" });
      }
      await storage.appendActivity({ ownerId, projectId: context.projectId || null, runId: context.runId || null, action: "phone_dial_claimed", tool: "phone_call_start", status: "running", summary: "Claimed the single approved outbound dial attempt.", metadata: { callIntentId: call.id, attempt: claim.call.attemptCount } });
      try {
        const result = await dialProvider.dial({ callIntentId: call.id, destination: call.envelope.destination, sessionToken, submissionKey, maximumDurationMinutes: call.envelope.maximumDurationMinutes });
        const updated = await storage.bindPhoneProviderCallSid(call.id, ownerId, { callSid: result.callSid, providerStatus: result.providerStatus || "queued" });
        if (!updated) throw Object.assign(new Error("Twilio Call SID conflicted with the approved dial."), { code: "phone_call_sid_mismatch", statusCode: 409, definitive: false });
        await storage.appendPhoneCallEvent({ id: `phone-event-${sha256(`${call.id}:dial-submitted`)}`, ownerId, callIntentId: call.id, eventKey: "dial-submitted", type: "dial_submitted", providerCallSid: result.callSid, metadata: { providerStatus: result.providerStatus || "queued" } });
        return { callIntentId: call.id, status: updated.status, callSid: result.callSid, idempotent: false };
      } catch (error) {
        const status = error?.definitive === true ? "failed" : "uncertain";
        await storage.updatePhoneCallIntent(call.id, ownerId, { status, errorCode: error?.code || "phone_dial_failed" });
        await storage.appendActivity({ ownerId, projectId: context.projectId || null, runId: context.runId || null, action: status === "uncertain" ? "phone_dial_uncertain" : "phone_dial_failed", tool: "phone_call_start", status, summary: status === "uncertain" ? "Dial submission outcome is uncertain; automatic redial is disabled." : "Dial request failed without retry.", metadata: { callIntentId: call.id } });
        throw error;
      }
    },
    async startBridgeSession({ sessionToken, callSid, streamSid }) {
      requireConfigured();
      if (!/^CA[a-fA-F0-9]{32}$/.test(callSid || "") || !/^MZ[a-fA-F0-9]{32}$/.test(streamSid || "")) throw new PhoneError("Twilio call or stream identity is invalid.", { code: "phone_bridge_identity_invalid" });
      const claims = sessionAuth.verifyStart(sessionToken);
      if (claims.ownerId !== ownerId) throw new PhoneError("Phone session owner mismatch.", { code: "phone_owner_mismatch", statusCode: 403 });
      const call = await storage.consumePhoneSessionToken(claims.callIntentId, ownerId, { tokenHash: sessionAuth.tokenHash(sessionToken), callSid, streamSid, consumedAt: clock().toISOString() });
      if (!call || call.envelopeHash !== claims.envelopeHash) throw new PhoneError("Phone session token was replayed or did not match the call.", { code: "phone_session_replay", statusCode: 409 });
      if(call.envelope.mediaProfile==="speaker_enrollment_v1")await storage.updateSpeakerEnrollmentSession(call.envelope.enrollmentSessionId,ownerId,{status:"collecting"});
      const ttlSeconds = Math.max(60, Math.min(call.envelope.maximumDurationMinutes * 60 + 120, 3_720));
      const bridgeSessionToken = sessionAuth.issueBridge({ ownerId, callIntentId: call.id, envelopeHash: call.envelopeHash, callSid, streamSid }, ttlSeconds);
      await storage.appendPhoneCallEvent({ id: `phone-event-${sha256(`${call.id}:${streamSid}:started`)}`, ownerId, callIntentId: call.id, eventKey: `stream:${streamSid}:started`, type: "stream_started", providerCallSid: callSid, providerStreamSid: streamSid, metadata: {} });
      await storage.appendActivity({ ownerId, projectId: null, runId: call.preparedRunId || null, action: "phone_call_started", tool: "phone_call_start", status: "in_progress", summary: "Approved outbound call media session started.", metadata: { callIntentId: call.id } });
      const enrollment=call.envelope.mediaProfile==="speaker_enrollment_v1"?await storage.getSpeakerEnrollmentSession(call.envelope.enrollmentSessionId,ownerId):null;
      return { bridgeSessionToken, callIntentId: call.id, callConversationId: call.callConversationId, objective: call.envelope.objective, permittedActions: [...call.envelope.permittedQuestions, ...call.envelope.permittedDisclosures], prohibitedActions: call.envelope.prohibitedActions, maximumDurationSeconds: call.envelope.maximumDurationMinutes * 60, languageStrategy: call.envelope.languageStrategy, mediaProfile: call.envelope.mediaProfile || "chained_v1", liveVoice: call.envelope.liveVoice || null, enrollment:enrollment?{sessionId:enrollment.id,sessionNumber:enrollment.sessionNumber,phrasePlan:enrollment.phrasePlan,expectedSamples:enrollment.expectedSamples,conditionLabel:enrollment.conditionLabel}:null };
    },
    async processBridgeTurn({ bridgeSessionToken, callIntentId, callSid, streamSid, turnId, transcript }) {
      requireConfigured();
      const claims = sessionAuth.verifyBridge(bridgeSessionToken);
      if (claims.ownerId !== ownerId || claims.callIntentId !== callIntentId || claims.callSid !== callSid || claims.streamSid !== streamSid)
        throw new PhoneError("Bridge turn identity does not match the authorized call.", { code: "phone_bridge_identity_mismatch", statusCode: 403 });
      const call = await load(callIntentId);
      if (call.providerCallSid !== callSid || call.providerStreamSid !== streamSid || !["dialing", "in_progress"].includes(call.status))
        throw new PhoneError("Bridge turn is not bound to an active call.", { code: "phone_bridge_call_inactive", statusCode: 409 });
      const cleanTranscript = String(transcript || "").trim();
      if (!cleanTranscript || cleanTranscript.length > 8_000 || !/^[A-Za-z0-9_-]{1,100}$/.test(turnId || "")) throw new PhoneError("Bridge transcript turn is invalid.", { code: "phone_bridge_turn_invalid" });
      const inputHash = sha256(`${call.id}:${turnId}:${cleanTranscript}`);
      const claim = await storage.claimPhoneCallTurn({ id: turnId, ownerId, callIntentId: call.id, inputHash, callerText: cleanTranscript });
      if (!claim.claimed) {
        if (claim.turn?.inputHash !== inputHash) throw new PhoneError("Bridge turn replay content changed.", { code: "phone_bridge_replay_mismatch", statusCode: 409 });
        if (claim.turn?.status === "completed") return { message: claim.turn.novaText, control: claim.turn.control, idempotent: true };
        throw new PhoneError("Bridge turn is already processing.", { code: "phone_bridge_turn_in_progress", statusCode: 409 });
      }
      try {
        const outsideScope=CONSEQUENTIAL_CALL_REQUEST.test(cleanTranscript);
        const result = outsideScope ? { message: OWNER_CONFIRMATION_RESPONSE, runId: null } : await novaTurn({ message: cleanTranscript, conversationId: call.callConversationId, context: { phoneCall: { profile: "bounded_outbound", callIntentId: call.id, envelope: call.envelope } } });
        let message = String(result?.message || "").trim().slice(0, 4_000),control=outsideScope?"hangup":"continue";
        if(CONSEQUENTIONAL_COMMITMENT.test(message)){message=OWNER_CONFIRMATION_RESPONSE;control="hangup";}
        await storage.completePhoneCallTurn(turnId, ownerId, { status: "completed", novaText: message, control, runId: result?.runId || null });
        await storage.updatePhoneCallIntent(call.id, ownerId, { status: "in_progress", startedAt: call.startedAt || clock().toISOString() });
        await storage.appendActivity({ ownerId, projectId: null, runId: result?.runId || null, action: "phone_turn_completed", tool: "phone_call_start", status: "completed", summary: "Completed one bounded in-call Nova turn.", metadata: { callIntentId: call.id, turnId } });
        return { message, control, idempotent: false };
      } catch (error) {
        await storage.completePhoneCallTurn(turnId, ownerId, { status: "failed", errorCode: error?.code || "phone_nova_turn_failed" });
        throw error;
      }
    },
    async authorizeEnrollmentSample({bridgeSessionToken,callIntentId,callSid,streamSid,sessionId}){
      requireConfigured();const claims=sessionAuth.verifyBridge(bridgeSessionToken);
      if(claims.ownerId!==ownerId||claims.callIntentId!==callIntentId||claims.callSid!==callSid||claims.streamSid!==streamSid)throw new PhoneError("Enrollment sample identity does not match the authorized call.",{code:"phone_bridge_identity_mismatch",statusCode:403});
      const call=await load(callIntentId);if(call.providerCallSid!==callSid||call.providerStreamSid!==streamSid||call.envelope.mediaProfile!=="speaker_enrollment_v1"||call.envelope.enrollmentSessionId!==sessionId||call.status!=="in_progress")throw new PhoneError("Enrollment sample is not bound to an active enrollment call.",{code:"pstn_enrollment_sample_unbound",statusCode:409});return true;
    },
    async recordBridgeEvent({ bridgeSessionToken, callIntentId, callSid, streamSid, eventId, type, providerStatus }) {
      requireConfigured();
      const claims = sessionAuth.verifyBridge(bridgeSessionToken);
      if (claims.ownerId !== ownerId || claims.callIntentId !== callIntentId || claims.callSid !== callSid || claims.streamSid !== streamSid)
        throw new PhoneError("Bridge event identity mismatch.", { code: "phone_bridge_identity_mismatch", statusCode: 403 });
      if (!/^[A-Za-z0-9:_-]{1,160}$/.test(eventId || "") || !new Set(["completed", "failed", "uncertain"]).has(type)) throw new PhoneError("Bridge event is invalid.", { code: "phone_bridge_event_invalid" });
      const event = await storage.appendPhoneCallEvent({ id: eventId, ownerId, callIntentId, eventKey: eventId, type, providerCallSid: callSid, providerStreamSid: streamSid, metadata: { providerStatus: providerStatus || null } });
      if (!event.inserted) return { accepted: true, idempotent: true };
      if (["completed", "failed", "uncertain"].includes(type)) {
        const call = await load(callIntentId);
        const canonicalEvents = call.callConversationId ? await storage.listConversationEvents(call.callConversationId, ownerId, { limit: 512 }) : [];
        const legacyTurns = canonicalEvents.length ? [] : await storage.listPhoneCallTurns(ownerId, callIntentId);
        const canonicalMessages = call.callConversationId ? await storage.listMessages(call.callConversationId, ownerId, { limit: 256 }) : [];
        await storage.updatePhoneCallIntent(callIntentId, ownerId, { status: type, outcome: providerStatus || type, summary: canonicalEvents.length ? summarizeCall(providerStatus || type, canonicalEvents, canonicalMessages).text : `${providerStatus || type}. ${legacyTurns.length} completed conversation turn${legacyTurns.length === 1 ? "" : "s"}.`, endedAt: clock().toISOString() });
        await storage.appendActivity({ ownerId, projectId: null, runId: null, action: `phone_call_${type}`, tool: "phone_call_start", status: type, summary: `Outbound call ended with ${providerStatus || type}.`, metadata: { callIntentId, turnCount: canonicalEvents.filter((item) => item.eventType === "authority_classified").length, canonicalLiveEvents: canonicalEvents.length } });
      }
      return { accepted: true, idempotent: false };
    },
    async providerStatus(callIntentId, { callSid, callStatus, streamSid = null }) {
      requireConfigured();
      const call = await load(callIntentId);
      if (call.providerCallSid && call.providerCallSid !== callSid) throw new PhoneError("Twilio Call SID does not match the call intent.", { code: "phone_call_sid_mismatch", statusCode: 409 });
      const map = { initiated: "dialing", queued: "dialing", ringing: "dialing", answered: "in_progress", "in-progress": "in_progress", completed: "completed", busy: "failed", failed: "failed", "no-answer": "failed", canceled: "failed" };
      const status = map[callStatus];
      if (!status) throw new PhoneError("Twilio call status is unsupported.", { code: "phone_provider_status_invalid" });
      if (["completed","failed","uncertain"].includes(call.status) || (call.status === "in_progress" && status === "dialing")) return call;
      const updated = await storage.updatePhoneCallIntent(call.id, ownerId, { status, providerCallSid: callSid, ...(streamSid ? { providerStreamSid: streamSid } : {}), providerStatus: callStatus, ...(status === "in_progress" ? { startedAt: call.startedAt || clock().toISOString() } : {}), ...(["completed", "failed"].includes(status) ? { endedAt: clock().toISOString(), outcome: callStatus } : {}) });
      await storage.appendPhoneCallEvent({ id: `phone-event-${sha256(`${call.id}:${callSid}:${callStatus}`)}`, ownerId, callIntentId: call.id, eventKey: `status:${callStatus}`, type: "provider_status", providerCallSid: callSid, providerStreamSid: streamSid, metadata: { providerStatus: callStatus } });
      return updated;
    },
    async listConversation(conversationId) { return (await storage.listConversationPhoneCalls(ownerId, conversationId, { limit: 20 })).map(publicCall); },
    async listCalls({ limit = 50 } = {}) { return (await storage.listPhoneCalls(ownerId, { limit })).map(publicCall); },
    async callDetail(id) {
      const call = await load(id);
      const [events, messages] = await Promise.all([
        storage.listConversationEvents(call.callConversationId, ownerId, { limit: 512 }),
        storage.listMessages(call.callConversationId, ownerId, { limit: 256 }),
      ]);
      return { call: publicCall(call), timeline: projectCallTimeline(messages, events), events: events.filter((item) => ["assistant_output_playback", "assistant_output_delivery", "backend_work_superseded", "live_session_started"].includes(item.eventType)) };
    },
    async reconcile(id) {
      const call = await load(id);
      const [events, messages] = await Promise.all([storage.listConversationEvents(call.callConversationId, ownerId, { limit: 512 }), storage.listMessages(call.callConversationId, ownerId, { limit: 256 })]);
      const summary = summarizeCall(call.outcome || call.providerStatus || call.status, events, messages).text;
      const updated = await storage.updatePhoneCallIntent(call.id, ownerId, { summary });
      return publicCall(updated);
    },
  });
}
