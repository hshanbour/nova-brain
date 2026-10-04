import { randomUUID } from "node:crypto";
import { classifyLiveAuthority, LIVE_AUTHORITY } from "../src/phone/gpt-live-round2.js";

const MAX_BUFFERED_AUDIO_BYTES = 2_000_000;
const MAX_TRANSCRIPT = 8_000;
const MAX_COMMENTARY_BYTES = 400;
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
  const audit = [];
  const record = (type, fields = {}) => audit.push(Object.freeze({ type, atMs: Math.round(clock()), ...fields }));
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
    acknowledgementAppendToAcknowledgedMs: elapsed(turn.milestones.ackCommentaryAppendedAt, turn.milestones.ackCommentaryAcknowledgedAt),
    novaRouteMs: elapsed(turn.milestones.novaRouteStartedAt, turn.milestones.novaRouteEndedAt),
    resultReadyToCommentaryAppendMs: elapsed(turn.milestones.novaRouteEndedAt, turn.milestones.resultCommentaryAppendedAt),
    commentaryAppendToAcknowledgedMs: elapsed(turn.milestones.resultCommentaryAppendedAt, turn.milestones.resultCommentaryAcknowledgedAt),
    resultReadyToFirstAuthoritativeProviderAudioMs: elapsed(turn.milestones.novaRouteEndedAt, turn.milestones.firstAuthoritativeAudioAt),
    resultReadyToFirstAuthoritativeReleasedAudioMs: elapsed(turn.milestones.novaRouteEndedAt, turn.milestones.firstAuthoritativeReleasedAudioAt),
    speechEndToTerminalMs: elapsed(turn.milestones.callerSpeechEndedAt, turn.milestones.terminalAt),
    interruptionToClearMs: elapsed(turn.milestones.interruptionAt, turn.milestones.clearCompletedAt),
  });

  function clearOutput(turn, reason) {
    onClearAudio();
    stamp(turn, "clearCompletedAt");
    record("output_cleared", { turnId: turn.turnId, reason });
  }

  function acceptAudio(turn, entry, kind) {
    const releasedAt = clock();
    onAudio(entry.audio);
    stamp(turn, "firstGateAcceptedAudioAt", entry.at);
    stamp(turn, "firstReleasedAudioAt", releasedAt);
    if (kind === "acknowledgement") {
      stamp(turn, "firstAcknowledgementAudioAt", entry.at);
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
    if (destination === "delivered") turn.deliveredText = value.slice(-MAX_TRANSCRIPT);
    else if (destination === "acknowledgement") turn.acknowledgementText = value.slice(-MAX_TRANSCRIPT);
    else turn.speculativeTranscript = value.slice(-MAX_TRANSCRIPT);
    return value;
  }

  async function supersede(reason = "caller_correction") {
    if (!current || current.terminal) return false;
    const turn = current;
    stamp(turn, "interruptionAt");
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
        deliveredText: turn.deliveredText,
        status: "superseded",
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
      turn.deliveredText = turn.speculativeTranscript.trim();
      return true;
    }
    turn.bufferedAudio = [];
    turn.bufferedTranscript = [];
    turn.bufferedBytes = 0;
    clearOutput(turn, "verified_result_ready");
    turn.phase = "verified_waiting_ack";
    turn.deliveredText = "";
    const chunks = commentaryChunks(result.message);
    turn.resultCommentaryEventIds = new Set();
    for (const content of chunks) {
      const eventId = idFactory();
      turn.resultCommentaryEventIds.add(eventId);
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
        deliveredText: turn.deliveredText,
        status: "truncated",
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
    turn.terminal = status;
    const delivered = turn.deliveredText.trim();
    await api.delivery({
      conversationId,
      turnId: turn.turnId,
      messageId: turn.messageId,
      intendedText: turn.intendedText,
      deliveredText: delivered || turn.intendedText,
      status,
    });
    stamp(turn, "terminalAt");
    turn.result = Object.freeze({
      status,
      turnId: turn.turnId,
      authority: turn.decision.authority,
      contextVersion,
      messageId: turn.messageId,
      intendedText: turn.intendedText,
      deliveredText: delivered || turn.intendedText,
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

    async callerSpeechStarted() {
      ensure();
      const didSupersede = await supersede();
      const turnId = idFactory();
      current = {
        turnId,
        generation: ++generation,
        transcript: "",
        speculativeTranscript: "",
        bufferedTranscript: [],
        bufferedAudio: [],
        bufferedBytes: 0,
        deliveredText: "",
        acknowledgementText: "",
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
        milestones: {
          callerSpeechEndedAt: null,
          endpointDecisionAt: null,
          classificationAt: null,
          firstProviderAudioAt: null,
          firstGateAcceptedAudioAt: null,
          firstReleasedAudioAt: null,
          firstAcknowledgementAudioAt: null,
          novaRouteStartedAt: null,
          novaRouteEndedAt: null,
          resultCommentaryAppendedAt: null,
          resultCommentaryAcknowledgedAt: null,
          ackCommentaryAppendedAt: null,
          ackCommentaryAcknowledgedAt: null,
          firstAuthoritativeAudioAt: null,
          firstAuthoritativeReleasedAudioAt: null,
          interruptionAt: null,
          clearCompletedAt: null,
          terminalAt: null,
        },
      };
      current.promise = new Promise((resolve) => {
        current.resolve = resolve;
      });
      if (!didSupersede) {
        onClearAudio();
        record("output_cleared", { turnId: current.turnId, reason: "caller_speech_started" });
      }
      record("caller_speech_started", { turnId });
      return turnId;
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
        current.deliveredText = `${current.deliveredText}${value}`.slice(-MAX_TRANSCRIPT);
      } else if (current.phase === "ack_streaming") {
        current.acknowledgementText = `${current.acknowledgementText}${value}`.slice(-MAX_TRANSCRIPT);
      } else if (current.phase === "authoritative_streaming") {
        current.deliveredText = `${current.deliveredText}${value}`.slice(-MAX_TRANSCRIPT);
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

    async callerSpeechEnded() {
      ensure();
      const turn = current;
      if (!turn || turn.terminal || !turn.transcript.trim()) return false;
      stamp(turn, "callerSpeechEndedAt");
      stamp(turn, "endpointDecisionAt");
      turn.decision = classifyLiveAuthority(turn.transcript);
      stamp(turn, "classificationAt");
      if (turn.decision.authority === LIVE_AUTHORITY.LOCAL_CONVERSATION) {
        turn.phase = "local_streaming";
        turn.deliveredText = turn.speculativeTranscript.trim();
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
      if (!turn || turn.terminal || !clientEventId) return false;
      const startMs = finite(event.start_ms);
      if (clientEventId === turn.acknowledgementEventId && turn.phase === "ack_waiting") {
        stamp(turn, "ackCommentaryAcknowledgedAt");
        turn.phase = "ack_streaming";
        releaseTranscript(turn, "acknowledgement", startMs);
        releaseBuffered(turn, "acknowledgement", startMs);
        record("information_acknowledgement_accepted", { turnId: turn.turnId });
        return true;
      }
      if (turn.resultCommentaryEventIds.has(clientEventId) && turn.phase === "verified_waiting_ack") {
        stamp(turn, "resultCommentaryAcknowledgedAt");
        turn.phase = "authoritative_streaming";
        releaseTranscript(turn, "delivered", startMs);
        releaseBuffered(turn, "authoritative", startMs);
        record("verified_commentary_accepted", { turnId: turn.turnId });
        return true;
      }
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
        audit: Object.freeze([...audit]),
      });
    },
  });
}
