import { randomUUID } from "node:crypto";
import { classifyLiveAuthority, LIVE_AUTHORITY } from "../src/phone/gpt-live-round2.js";

const MAX_BUFFERED_AUDIO_BYTES = 2_000_000;
const MAX_TRANSCRIPT = 8_000;
const MAX_COMMENTARY_BYTES = 400;
const MAX_COMMENTARY_CORRELATIONS = 512;
const INFORMATION_ACKNOWLEDGEMENT = "Backend progress for natural spoken delivery: Nova is checking the requested information, and no verified result is available yet. Give one brief acknowledgement in the caller's language and conversational style without adding any fact, number, result, status, completion claim, or external action, then wait.";

function commentaryChunks(value) {
  const chunks = [];
  let current = "";
  const flush = () => {
    const chunk = current.trim();
    if (chunk) chunks.push(chunk);
    current = "";
  };
  for (const token of String(value || "").split(/(\s+)/u)) {
    if (!token) continue;
    if (Buffer.byteLength(current + token) <= MAX_COMMENTARY_BYTES) {
      current += token;
      continue;
    }
    flush();
    for (const character of token) {
      if (Buffer.byteLength(current + character) > MAX_COMMENTARY_BYTES) flush();
      current += character;
    }
  }
  flush();
  return chunks;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function elapsed(start, end) {
  return start === null || end === null ? null : Math.max(0, Math.round(end - start));
}

function afterTimeline(entry, startMs) {
  if (startMs === null || entry.startMs === null) return true;
  return entry.startMs >= startMs;
}

export function createGptLiveRound2OutputGate({
  api,
  sendLive,
  onAudio = () => {},
  onClearAudio = () => {},
  clock = () => performance.now(),
  idFactory = randomUUID,
} = {}) {
  if (!api || typeof sendLive !== "function") throw new TypeError("Round 2 API and Live sender are required.");
  let conversationId;
  let contextVersion = 0;
  let generation = 0;
  let current = null;
  let callerLifecycle = Object.freeze({ phase: "idle", turnId: null });
  let assistantLifecycle = Object.freeze({ phase: "idle", turnId: null, outputKind: null });
  const audit = [];
  const commentaryOwners = new Map();
  const record = (type, fields = {}) => audit.push(Object.freeze({ type, atMs: Math.round(clock()), ...fields }));
  const registerCommentary = (turn, eventId, category) => {
    if (commentaryOwners.size >= MAX_COMMENTARY_CORRELATIONS) commentaryOwners.delete(commentaryOwners.keys().next().value);
    commentaryOwners.set(eventId, Object.freeze({ turnId: turn.turnId, generation: turn.generation, category }));
    record("commentary_append_sent", { turnId: turn.turnId, generation: turn.generation, eventId, category });
  };
  const ensure = () => {
    if (!conversationId) throw new Error("Round 2 session has not started.");
  };
  const stamp = (turn, field, at = clock()) => {
    if (turn.milestones[field] === null) {
      turn.milestones[field] = at;
      record(field, { turnId: turn.turnId });
    }
    return turn.milestones[field];
  };
  const timing = (turn) => Object.freeze({
    speechEndToEndpointDecisionMs: elapsed(turn.milestones.callerSpeechEndedAt, turn.milestones.endpointDecisionAt),
    speechEndToClassificationMs: elapsed(turn.milestones.callerSpeechEndedAt, turn.milestones.classificationAt),
    speechEndToFirstProviderAudioMs: elapsed(turn.milestones.callerSpeechEndedAt, turn.milestones.firstProviderAudioAt),
    speechEndToFirstGateAcceptedAudioMs: elapsed(turn.milestones.callerSpeechEndedAt, turn.milestones.firstGateAcceptedAudioAt),
    speechEndToFirstReleasedAudioMs: elapsed(turn.milestones.callerSpeechEndedAt, turn.milestones.firstReleasedAudioAt),
    providerAudioToGateAcceptMs: elapsed(turn.milestones.firstProviderAudioAt, turn.milestones.firstGateAcceptedAudioAt),
    gateAcceptToReleaseMs: elapsed(turn.milestones.firstGateAcceptedAudioAt, turn.milestones.firstReleasedAudioAt),
    classificationToFirstReleasedAudioMs: elapsed(turn.milestones.classificationAt, turn.milestones.firstReleasedAudioAt),
    speechEndToAcknowledgementAudioMs: elapsed(turn.milestones.callerSpeechEndedAt, turn.milestones.firstAcknowledgementAudioAt),
    speechEndToAcknowledgementReleasedAudioMs: elapsed(turn.milestones.callerSpeechEndedAt, turn.milestones.firstAcknowledgementReleasedAt),
    acknowledgementAppendToAcknowledgedMs: elapsed(turn.milestones.ackCommentaryAppendedAt, turn.milestones.ackCommentaryAcknowledgedAt),
    novaRouteMs: elapsed(turn.milestones.novaRouteStartedAt, turn.milestones.novaRouteEndedAt),
    resultReadyToCommentaryAppendMs: elapsed(turn.milestones.novaRouteEndedAt, turn.milestones.resultCommentaryAppendedAt),
    commentaryAppendToAcknowledgedMs: elapsed(turn.milestones.resultCommentaryAppendedAt, turn.milestones.resultCommentaryAcknowledgedAt),
    resultReadyToFirstAuthoritativeProviderAudioMs: elapsed(turn.milestones.novaRouteEndedAt, turn.milestones.firstAuthoritativeAudioAt),
    resultReadyToFirstAuthoritativeReleasedAudioMs: elapsed(turn.milestones.novaRouteEndedAt, turn.milestones.firstAuthoritativeReleasedAudioAt),
    acknowledgementFirstMediaToConfirmedMs: elapsed(turn.milestones.firstAcknowledgementReleasedAt, turn.milestones.firstAcknowledgementConfirmedAt),
    authoritativeFirstMediaToConfirmedMs: elapsed(turn.milestones.firstAuthoritativeReleasedAudioAt, turn.milestones.firstAuthoritativeConfirmedAt),
    speechEndToTerminalMs: elapsed(turn.milestones.callerSpeechEndedAt, turn.milestones.terminalAt),
    interruptionToClearMs: elapsed(turn.milestones.interruptionAt, turn.milestones.clearCompletedAt),
  });
  const emptyMilestones = () => ({ callerSpeechEndedAt: null, callerSpeechStartedAt: null, endpointDecisionAt: null, classificationAt: null, firstProviderAudioAt: null, firstGateAcceptedAudioAt: null, firstReleasedAudioAt: null, firstAcknowledgementAudioAt: null, firstAcknowledgementReleasedAt: null, firstAcknowledgementConfirmedAt: null, novaRouteStartedAt: null, novaRouteEndedAt: null, resultCommentaryAppendedAt: null, resultCommentaryAcknowledgedAt: null, ackCommentaryAppendedAt: null, ackCommentaryAcknowledgedAt: null, firstAuthoritativeAudioAt: null, firstAuthoritativeReleasedAudioAt: null, firstAuthoritativeConfirmedAt: null, interruptionAt: null, clearCompletedAt: null, finalPlaybackAt: null, terminalAt: null });

  function clearOutput(turn, reason) {
    onClearAudio();
    if (turn && conversationId && typeof api.playback === "function") void api.playback({ conversationId, turnId: turn.turnId, stage: "cleared", outputKind: turn.phase === "ack_streaming" || turn.phase === "ack_waiting" || turn.phase === "backend_pending" ? "acknowledgement" : "final", cleared: true, reason }).catch(() => {});
    stamp(turn, "clearCompletedAt");
    assistantLifecycle = Object.freeze({ phase: "cleared", turnId: turn.turnId, outputKind: assistantLifecycle.outputKind });
    record("output_cleared", { turnId: turn.turnId, reason });
  }

  function acceptAudio(turn, entry, kind) {
    const acceptedAt = clock();
    stamp(turn, "firstGateAcceptedAudioAt", acceptedAt);
    const outputKind = kind === "acknowledgement" ? "acknowledgement" : "final";
    assistantLifecycle = Object.freeze({ phase: "playing", turnId: turn.turnId, outputKind });
    const textPrefix = outputKind === "acknowledgement"
      ? turn.acknowledgementGeneratedText
      : turn.generatedText;
    onAudio(entry.audio, {
      turnId: turn.turnId,
      outputKind,
      startMs: entry.startMs,
      endMs: entry.endMs,
      textPrefix: String(textPrefix || "").slice(0, MAX_TRANSCRIPT),
    });
    if (!turn.releasedKinds.has(outputKind)) { turn.releasedKinds.add(outputKind); if (typeof api.playback === "function") void api.playback({ conversationId, turnId: turn.turnId, stage: "released_to_playback", outputKind, endMs: entry.endMs }).catch(() => {}); }
    const releasedAt = clock();
    stamp(turn, "firstReleasedAudioAt", releasedAt);
    if (kind === "acknowledgement") {
      stamp(turn, "firstAcknowledgementAudioAt", entry.at);
      stamp(turn, "firstAcknowledgementReleasedAt", releasedAt);
    }
    if (kind === "authoritative") {
      stamp(turn, "firstAuthoritativeAudioAt", entry.at);
      stamp(turn, "firstAuthoritativeReleasedAudioAt", releasedAt);
    }
  }

  function releaseBuffered(turn, kind, startMs = null) {
    const selected = turn.bufferedAudio.filter((entry) => afterTimeline(entry, startMs));
    for (const entry of selected) acceptAudio(turn, entry, kind);
    turn.bufferedAudio = [];
    turn.bufferedBytes = 0;
    return selected.length;
  }

  function releaseTranscript(turn, destination, startMs = null) {
    const selected = turn.bufferedTranscript.filter((entry) => afterTimeline(entry, startMs));
    const value = selected.map((entry) => entry.value).join("");
    turn.bufferedTranscript = [];
    if (destination === "delivered") { turn.generatedText = value.slice(-MAX_TRANSCRIPT); turn.transcriptTimeline.final.push(...selected); }
    else if (destination === "acknowledgement") { turn.acknowledgementGeneratedText = value.slice(-MAX_TRANSCRIPT); turn.transcriptTimeline.acknowledgement.push(...selected); }
    else turn.speculativeTranscript = value.slice(-MAX_TRANSCRIPT);
    return value;
  }

  async function supersede(reason = "caller_correction") {
    if (!current || current.terminal) return false;
    const turn = current;
    stamp(turn, "interruptionAt");
    turn.milestones.clearCompletedAt = null;
    turn.abort.abort(new DOMException("Superseded by caller correction.", "AbortError"));
    turn.terminal = "superseded";
    clearOutput(turn, reason);
    stamp(turn, "terminalAt");
    if (turn.messageId && turn.intendedText) {
      await api.delivery({
        conversationId,
        turnId: turn.turnId,
        messageId: turn.messageId,
        intendedText: turn.intendedText,
        deliveredText: turn.confirmedText,
        status: turn.confirmedText.trim() ? "partially_delivered" : (turn.releasedKinds.size ? "cleared_unheard" : "superseded_before_generation"),
        outputKind: "final",
        checkpoints: turn.playbackCheckpoints,
        timing: timing(turn),
      }).catch(() => {});
    }
    turn.result = Object.freeze({ status: "superseded", turnId: turn.turnId, timing: timing(turn) });
    turn.resolve?.(turn.result);
    return true;
  }

  async function route(turn) {
    const input = {
      conversationId,
      turnId: turn.turnId,
      utterance: turn.transcript,
      decision: turn.decision,
      speaker: turn.speaker,
      ...(turn.expectedContextVersion === null ? {} : { expectedContextVersion: turn.expectedContextVersion }),
    };
    if ([LIVE_AUTHORITY.LOCAL_CONVERSATION, LIVE_AUTHORITY.CLARIFICATION_REQUIRED].includes(turn.decision.authority)) {
      input.localResponse = turn.speculativeTranscript.trim()
        || (turn.decision.authority === LIVE_AUTHORITY.CLARIFICATION_REQUIRED ? "Which exact item do you mean?" : "I’m listening.");
    }
    stamp(turn, "novaRouteStartedAt");
    let result;
    try {
      result = await api.turn(input, { signal: turn.abort.signal });
    } catch (error) {
      if (turn.abort.signal.aborted || turn !== current) return { status: "superseded", turnId: turn.turnId };
      throw error;
    } finally {
      stamp(turn, "novaRouteEndedAt");
    }
    if (turn !== current || turn.abort.signal.aborted || result.status === "superseded") return { status: "superseded", turnId: turn.turnId };
    contextVersion = result.contextVersion ?? contextVersion;
    turn.messageId = result.messageId;
    turn.intendedText = result.message;
    turn.routeLatencyMs = elapsed(turn.milestones.novaRouteStartedAt, turn.milestones.novaRouteEndedAt);
    record("authority_resolved", { turnId: turn.turnId, authority: result.authority, routeLatencyMs: turn.routeLatencyMs });
    if (result.authority === LIVE_AUTHORITY.LOCAL_CONVERSATION) {
      turn.phase = "playback_pending";
      turn.generatedText = turn.speculativeTranscript.trim();
      return true;
    }
    turn.bufferedAudio = [];
    turn.bufferedTranscript = [];
    turn.bufferedBytes = 0;
    clearOutput(turn, "verified_result_ready");
    turn.phase = "verified_waiting_ack";
    turn.generatedText = "";
    const chunks = commentaryChunks(result.message);
    turn.resultCommentaryEventIds = new Set();
    for (const content of chunks) {
      const eventId = idFactory();
      turn.resultCommentaryEventIds.add(eventId);
      registerCommentary(turn, eventId, "verified_result");
      sendLive(Object.freeze({ type: "session.commentary.append", event_id: eventId, delegation_id: turn.delegationId, content }));
      stamp(turn, "resultCommentaryAppendedAt");
    }
    record("verified_result_appended", { turnId: turn.turnId, authority: result.authority, chunks: chunks.length });
    return turn.promise;
  }

  async function providerFailed(category = "gpt_live_provider_error") {
    const turn = current;
    if (!turn || turn.terminal) return false;
    turn.terminal = "failed";
    clearOutput(turn, "provider_failed");
    stamp(turn, "terminalAt");
    if (turn.messageId && turn.intendedText) {
      await api.delivery({
        conversationId,
        turnId: turn.turnId,
        messageId: turn.messageId,
        intendedText: turn.intendedText,
        deliveredText: turn.confirmedText,
        status: turn.confirmedText.trim() ? "partially_delivered" : (turn.releasedKinds.size ? "cleared_unheard" : "generated_not_released"),
        outputKind: "final",
        checkpoints: turn.playbackCheckpoints,
        timing: timing(turn),
      }).catch(() => {});
    }
    turn.result = Object.freeze({
      status: "failed",
      turnId: turn.turnId,
      authority: turn.decision?.authority || null,
      providerCategory: String(category).slice(0, 80),
      timing: timing(turn),
    });
    turn.resolve?.(turn.result);
    record("provider_failed", { turnId: turn.turnId, category: turn.result.providerCategory });
    return true;
  }

  async function complete(turn, status = "delivered") {
    if (turn !== current || turn.terminal) return false;
    const delivered = turn.confirmedText.trim();
    await api.delivery({
      conversationId,
      turnId: turn.turnId,
      messageId: turn.messageId,
      intendedText: turn.intendedText,
      deliveredText: delivered,
      status: delivered && delivered === turn.generatedText.trim() ? "delivered" : delivered ? "partially_delivered" : (turn.releasedKinds.size ? "cleared_unheard" : "generated_not_released"),
      outputKind: "final",
      checkpoints: turn.playbackCheckpoints,
      timing: timing(turn),
    });
    turn.terminal = status;
    stamp(turn, "terminalAt");
    assistantLifecycle = Object.freeze({ phase: "completed", turnId: turn.turnId, outputKind: "final" });
    turn.result = Object.freeze({
      status,
      turnId: turn.turnId,
      authority: turn.decision.authority,
      contextVersion,
      messageId: turn.messageId,
      intendedText: turn.intendedText,
      deliveredText: delivered,
      routeLatencyMs: turn.routeLatencyMs,
      gateOverheadMs: turn.decision.authority === LIVE_AUTHORITY.LOCAL_CONVERSATION
        ? elapsed(turn.milestones.classificationAt, turn.milestones.firstReleasedAudioAt)
        : elapsed(turn.milestones.firstAuthoritativeAudioAt, turn.milestones.firstAuthoritativeReleasedAudioAt),
      timing: timing(turn),
    });
    turn.resolve?.(turn.result);
    record("turn_terminal", { turnId: turn.turnId, status });
    return true;
  }

  return Object.freeze({
    async start(input = {}) {
      const started = await api.start(input);
      conversationId = started.conversationId;
      contextVersion = started.contextVersion;
      record("session_started", { conversationId });
      return started;
    },

    async callerSpeechStarted({ reason } = {}) {
      ensure();
      reason ||= assistantLifecycle.phase === "playing" ? "caller_barge_in" : current && !current.terminal ? "caller_supersedes_pending_turn" : "ordinary_next_turn";
      const didSupersede = await supersede(reason);
      const turnId = idFactory();
      current = {
        turnId,
        generation: ++generation,
        transcript: "",
        speculativeTranscript: "",
        bufferedTranscript: [],
        bufferedAudio: [],
        bufferedBytes: 0,
        generatedText: "",
        confirmedText: "",
        acknowledgementGeneratedText: "",
        acknowledgementConfirmedText: "",
        transcriptTimeline: { acknowledgement: [], final: [] },
        playbackCheckpoints: [],
        releasedKinds: new Set(),
        acknowledgementRecorded: false,
        intendedText: "",
        messageId: null,
        delegationId: null,
        acknowledgementEventId: null,
        resultCommentaryEventIds: new Set(),
        decision: null,
        phase: "capturing",
        terminal: null,
        abort: new AbortController(),
        expectedContextVersion: didSupersede ? null : contextVersion,
        speaker: { authenticatedIdentity: "none", contactProvenance: "pstn", assertion: null },
        milestones: { ...emptyMilestones(), callerSpeechStartedAt: clock() },
      };
      current.promise = new Promise((resolve) => {
        current.resolve = resolve;
      });
      callerLifecycle = Object.freeze({ phase: "capturing", turnId });
      if (!didSupersede) {
        onClearAudio();
        record("output_cleared", { turnId: current.turnId, reason: "caller_speech_started" });
      }
      record("caller_speech_started", { turnId });
      return turnId;
    },

    async beginGreeting() {
      ensure();
      if (current && !current.terminal) return false;
      const result = await api.greeting({ conversationId });
      contextVersion = result.contextVersion ?? contextVersion;
      current = {
        turnId: result.turnId, generation: ++generation, transcript: "", speculativeTranscript: "", bufferedTranscript: [], bufferedAudio: [], bufferedBytes: 0,
        generatedText: "", confirmedText: "", acknowledgementGeneratedText: "", acknowledgementConfirmedText: "", transcriptTimeline: { acknowledgement: [], final: [] }, playbackCheckpoints: [], releasedKinds: new Set(), acknowledgementRecorded: false,
        intendedText: result.message, messageId: result.messageId, delegationId: null, acknowledgementEventId: null, resultCommentaryEventIds: new Set(),
        decision: { authority: LIVE_AUTHORITY.LOCAL_CONVERSATION, reason: "outbound_call_greeting" }, phase: "verified_waiting_ack", terminal: null, abort: new AbortController(), expectedContextVersion: contextVersion, milestones: emptyMilestones(),
      };
      current.promise = new Promise((resolve) => { current.resolve = resolve; });
      const eventId = idFactory(); current.resultCommentaryEventIds.add(eventId);
      registerCommentary(current, eventId, "initial_greeting");
      sendLive(Object.freeze({ type: "session.commentary.append", event_id: eventId, content: result.message }));
      stamp(current, "resultCommentaryAppendedAt");
      record("initial_greeting_appended", { turnId: current.turnId });
      return current.turnId;
    },

    bindDelegation(delegationId) {
      const value = String(delegationId || "");
      if (!current || current.terminal || !/^item_[A-Za-z0-9_-]{8,128}$/.test(value)) return false;
      current.delegationId = value;
      record("provider_delegation_bound", { turnId: current.turnId });
      return true;
    },

    appendTranscript(delta) {
      if (!current || current.terminal) return false;
      current.transcript = `${current.transcript}${String(delta || "")}`.slice(-MAX_TRANSCRIPT);
      return true;
    },

    appendOutputTranscript(delta, event = {}) {
      if (!current || current.terminal) return false;
      const value = String(delta || "");
      const entry = { value, startMs: finite(event.start_ms), endMs: finite(event.end_ms), at: clock() };
      if (["local_streaming", "local_persisting"].includes(current.phase)) {
        current.speculativeTranscript = `${current.speculativeTranscript}${value}`.slice(-MAX_TRANSCRIPT);
        current.generatedText = `${current.generatedText}${value}`.slice(-MAX_TRANSCRIPT);
        current.transcriptTimeline.final.push(entry);
      } else if (current.phase === "ack_streaming") {
        current.acknowledgementGeneratedText = `${current.acknowledgementGeneratedText}${value}`.slice(-MAX_TRANSCRIPT);
        current.transcriptTimeline.acknowledgement.push(entry);
      } else if (current.phase === "authoritative_streaming") {
        current.generatedText = `${current.generatedText}${value}`.slice(-MAX_TRANSCRIPT);
        current.transcriptTimeline.final.push(entry);
      } else {
        current.bufferedTranscript.push(entry);
        current.speculativeTranscript = `${current.speculativeTranscript}${value}`.slice(-MAX_TRANSCRIPT);
      }
      return true;
    },

    appendOutputAudio(audio, event = {}) {
      if (!current || current.terminal || !Buffer.isBuffer(audio) || !audio.length) return false;
      const entry = { audio, startMs: finite(event.start_ms), endMs: finite(event.end_ms), at: clock() };
      stamp(current, "firstProviderAudioAt", entry.at);
      if (["local_streaming", "local_persisting"].includes(current.phase)) {
        acceptAudio(current, entry, "local");
        return true;
      }
      if (current.phase === "ack_streaming") {
        acceptAudio(current, entry, "acknowledgement");
        return true;
      }
      if (current.phase === "authoritative_streaming") {
        acceptAudio(current, entry, "authoritative");
        return true;
      }
      if (current.bufferedBytes + audio.length > MAX_BUFFERED_AUDIO_BYTES) {
        throw Object.assign(new Error("Speculative Live audio exceeded the bounded gate."), { code: "gpt_live_output_gate_overflow" });
      }
      current.bufferedAudio.push(entry);
      current.bufferedBytes += audio.length;
      return true;
    },

    async callerSpeechEnded({ speakerAudio = null } = {}) {
      ensure();
      const turn = current;
      if (!turn || turn.terminal || !turn.transcript.trim()) return false;
      stamp(turn, "callerSpeechEndedAt");
      callerLifecycle = Object.freeze({ phase: "finalized", turnId: turn.turnId });
      stamp(turn, "endpointDecisionAt");
      const [decision, speaker] = await Promise.all([
        typeof api.classify === "function" ? api.classify({ conversationId, utterance: turn.transcript, speaker: turn.speaker }, { signal: turn.abort.signal }) : classifyLiveAuthority(turn.transcript),
        speakerAudio && typeof api.speaker === "function" ? api.speaker({ conversationId, turnId: turn.turnId, transcript: turn.transcript, ...speakerAudio }, { signal: turn.abort.signal }).catch(() => null) : Promise.resolve(null),
      ]);
      turn.decision = decision;
      if (speaker?.assertion) turn.speaker = { authenticatedIdentity: speaker.authenticated_identity || "none", claimedIdentity: null, contactProvenance: "pstn", assertion: speaker.assertion, matchStatus: speaker.match_status || "unknown" };
      stamp(turn, "classificationAt");
      if (turn.decision.authority === LIVE_AUTHORITY.LOCAL_CONVERSATION) {
        turn.phase = "local_streaming";
        releaseTranscript(turn, "delivered");
        turn.generatedText = turn.speculativeTranscript.trim();
        releaseBuffered(turn, "local");
        record("local_output_released", { turnId: turn.turnId });
      } else {
        turn.bufferedAudio = [];
        turn.bufferedTranscript = [];
        turn.bufferedBytes = 0;
        clearOutput(turn, "speculative_output_discarded");
        if (turn.decision.authority === LIVE_AUTHORITY.NOVA_INFORMATION) {
          turn.phase = "ack_waiting";
          turn.acknowledgementEventId = idFactory();
          registerCommentary(turn, turn.acknowledgementEventId, "progress_acknowledgement");
          sendLive(Object.freeze({
            type: "session.commentary.append",
            event_id: turn.acknowledgementEventId,
            delegation_id: turn.delegationId,
            content: INFORMATION_ACKNOWLEDGEMENT,
          }));
          stamp(turn, "ackCommentaryAppendedAt");
          record("information_acknowledgement_appended", { turnId: turn.turnId });
        } else {
          turn.phase = "blocked";
        }
        void route(turn);
      }
      return turn.decision;
    },

    commentaryAcknowledged(event = {}) {
      const turn = current;
      const clientEventId = String(event.client_event_id || "");
      const owner = commentaryOwners.get(clientEventId);
      if (!clientEventId) { record("commentary_ack_ignored", { reason: "missing_client_event_id" }); return false; }
      if (!owner) { record("commentary_ack_ignored", { eventId: clientEventId, reason: "unknown_event" }); return false; }
      if (!turn || turn.terminal) { record("commentary_ack_ignored", { ...owner, eventId: clientEventId, reason: "no_active_turn" }); return false; }
      if (owner.turnId !== turn.turnId || owner.generation !== turn.generation) {
        record("commentary_ack_ignored", { ...owner, eventId: clientEventId, currentTurnId: turn.turnId, currentGeneration: turn.generation, reason: "stale_generation" });
        return false;
      }
      const startMs = finite(event.start_ms);
      if (clientEventId === turn.acknowledgementEventId && turn.phase === "ack_waiting") {
        stamp(turn, "ackCommentaryAcknowledgedAt");
        turn.phase = "ack_streaming";
        releaseTranscript(turn, "acknowledgement", startMs);
        releaseBuffered(turn, "acknowledgement", startMs);
        record("commentary_ack_received", { ...owner, eventId: clientEventId });
        record("information_acknowledgement_accepted", { turnId: turn.turnId });
        return true;
      }
      if (turn.resultCommentaryEventIds.has(clientEventId) && turn.phase === "verified_waiting_ack") {
        stamp(turn, "resultCommentaryAcknowledgedAt");
        turn.phase = "authoritative_streaming";
        releaseTranscript(turn, "delivered", startMs);
        releaseBuffered(turn, "authoritative", startMs);
        record("commentary_ack_received", { ...owner, eventId: clientEventId });
        record("verified_commentary_accepted", { turnId: turn.turnId });
        return true;
      }
      record("commentary_ack_ignored", { ...owner, eventId: clientEventId, currentPhase: turn.phase, reason: "phase_mismatch" });
      return false;
    },

    async providerOutputCompleted() {
      const turn = current;
      if (!turn || turn.terminal) return false;
      if (turn.phase === "local_streaming") {
        turn.phase = "local_persisting";
        return route(turn);
      }
      if (turn.phase === "ack_streaming") {
        turn.phase = "backend_pending";
        return true;
      }
      if (turn.phase === "authoritative_streaming") {
        turn.phase = "playback_pending";
        return true;
      }
      return false;
    },

    async playbackCompleted() {
      const turn = current;
      if (!turn || turn.terminal || turn.phase !== "playback_pending") return false;
      return complete(turn, "delivered");
    },

    async playbackCheckpoint({ turnId, outputKind = "final", endMs = null, final = false, cleared = false, checkpointId = null, textPrefix = "", byteStart = null, byteEnd = null, durationStartMs = null, durationEndMs = null, sentAt = null, acknowledgedAt = null } = {}) {
      const turn = current;
      if (!turn || turn.terminal || turn.turnId !== turnId || cleared) return false;
      const kind = outputKind === "acknowledgement" ? "acknowledgement" : "final";
      const entries = turn.transcriptTimeline[kind];
      const boundary = finite(endMs);
      const timelineConfirmed = entries.filter((entry) => final || (boundary !== null && entry.endMs !== null && entry.endMs <= boundary)).map((entry) => entry.value).join("").slice(0, MAX_TRANSCRIPT);
      const suppliedPrefix = String(textPrefix || "").slice(0, MAX_TRANSCRIPT);
      const prior = kind === "acknowledgement" ? turn.acknowledgementConfirmedText : turn.confirmedText;
      const candidate = suppliedPrefix.length >= timelineConfirmed.length ? suppliedPrefix : timelineConfirmed;
      const confirmed = candidate.length >= prior.length ? candidate : prior;
      if (kind === "acknowledgement") turn.acknowledgementConfirmedText = confirmed;
      else turn.confirmedText = confirmed;
      if (kind === "acknowledgement") stamp(turn, "firstAcknowledgementConfirmedAt");
      else stamp(turn, "firstAuthoritativeConfirmedAt");
      if (final) stamp(turn, "finalPlaybackAt");
      const checkpoint = { id: checkpointId || null, outputKind: kind, endMs: boundary, final: final === true, byteStart: finite(byteStart), byteEnd: finite(byteEnd), durationStartMs: finite(durationStartMs), durationEndMs: finite(durationEndMs), textPrefix: confirmed, sentAt: finite(sentAt), acknowledgedAt: finite(acknowledgedAt), cleared: false };
      turn.playbackCheckpoints.push(checkpoint);
      if (typeof api.playback === "function") await api.playback({ conversationId, turnId, stage: "playback_checkpoint", outputKind: kind, checkpointId, endMs: boundary, cleared: false, ...checkpoint });
      record("playback_checkpoint_confirmed", { turnId, outputKind: kind, endMs: boundary, final: final === true });
      if (kind === "acknowledgement" && confirmed.trim()) {
        await api.delivery({ conversationId, turnId, messageId: `${turn.turnId}-ack`, intendedText: turn.acknowledgementGeneratedText || confirmed, deliveredText: confirmed, status: confirmed === (turn.acknowledgementGeneratedText || confirmed) ? "delivered" : "partially_delivered", outputKind: "acknowledgement", checkpoints: turn.playbackCheckpoints, timing: timing(turn) });
        if (final) turn.acknowledgementRecorded = true;
      }
      return true;
    },

    async waitForTerminal({ signal } = {}) {
      const turn = current;
      if (!turn) return null;
      if (turn.terminal) return turn.result || { status: turn.terminal, turnId: turn.turnId };
      if (!signal) return turn.promise;
      return Promise.race([
        turn.promise,
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
      ]);
    },

    providerFailed,
    supersede,
    resumeCallerSpeech() {
      if (!current || current.terminal || current.phase !== "capturing") return false;
      callerLifecycle = Object.freeze({ phase: "capturing", turnId: current.turnId });
      record("caller_speech_resumed", { turnId: current.turnId });
      return current.turnId;
    },
    snapshot() {
      return Object.freeze({
        conversationId,
        contextVersion,
        generation,
        current: current ? {
          turnId: current.turnId,
          phase: current.phase,
          terminal: current.terminal,
          authority: current.decision?.authority || null,
          bufferedBytes: current.bufferedBytes,
          transcriptCharacters: current.transcript.length,
          timing: timing(current),
        } : null,
        rawAudioPersisted: false,
        callerLifecycle,
        assistantLifecycle,
        audit: Object.freeze([...audit]),
      });
    },
  });
}
