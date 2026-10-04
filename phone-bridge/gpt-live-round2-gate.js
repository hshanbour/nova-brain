import { randomUUID } from "node:crypto";
import { classifyLiveAuthority, LIVE_AUTHORITY } from "../src/phone/gpt-live-round2.js";

const MAX_BUFFERED_AUDIO_BYTES = 2_000_000;
const MAX_TRANSCRIPT = 8_000;
const MAX_COMMENTARY_BYTES = 400;

function commentaryChunks(value) {
  const chunks = [];
  let current = "";
  const flush = () => { const chunk = current.trim(); if (chunk) chunks.push(chunk); current = ""; };
  for (const token of String(value || "").split(/(\s+)/u)) {
    if (!token) continue;
    if (Buffer.byteLength(current + token) <= MAX_COMMENTARY_BYTES) { current += token; continue; }
    flush();
    for (const character of token) {
      if (Buffer.byteLength(current + character) > MAX_COMMENTARY_BYTES) flush();
      current += character;
    }
  }
  flush();
  return chunks;
}

export function createGptLiveRound2OutputGate({ api, sendLive, onAudio = () => {}, onClearAudio = () => {}, clock = () => performance.now(), idFactory = randomUUID } = {}) {
  if (!api || typeof sendLive !== "function") throw new TypeError("Round 2 API and Live sender are required.");
  let conversationId, contextVersion = 0, generation = 0, current = null;
  const audit = [];
  const record = (type, fields = {}) => audit.push(Object.freeze({ type, atMs: Math.round(clock()), ...fields }));
  const ensure = () => { if (!conversationId) throw new Error("Round 2 session has not started."); };

  async function supersede(reason = "caller_correction") {
    if (!current || current.terminal) return false;
    current.abort.abort(new DOMException("Superseded by caller correction.", "AbortError"));
    current.terminal = "superseded";
    onClearAudio();
    record("output_cleared", { turnId: current.turnId, reason });
    if (current.messageId && current.intendedText) await api.delivery({ conversationId, turnId: current.turnId, messageId: current.messageId, intendedText: current.intendedText, deliveredText: current.deliveredText, status: "superseded" }).catch(() => {});
    current.resolve?.({ status: "superseded", turnId: current.turnId });
    return true;
  }

  async function route(turn) {
    const input = { conversationId, turnId: turn.turnId, utterance: turn.transcript, ...(turn.expectedContextVersion === null ? {} : { expectedContextVersion: turn.expectedContextVersion }) };
    if (turn.decision.authority === LIVE_AUTHORITY.LOCAL_CONVERSATION || turn.decision.authority === LIVE_AUTHORITY.CLARIFICATION_REQUIRED) input.localResponse = turn.speculativeTranscript.trim() || (turn.decision.authority === LIVE_AUTHORITY.CLARIFICATION_REQUIRED ? "Which exact item do you mean?" : "I’m listening.");
    const startedAt = clock();
    let result;
    try { result = await api.turn(input, { signal: turn.abort.signal }); }
    catch (error) { if (turn.abort.signal.aborted || turn !== current) return { status: "superseded", turnId: turn.turnId }; throw error; }
    if (turn !== current || turn.abort.signal.aborted || result.status === "superseded") return { status: "superseded", turnId: turn.turnId };
    contextVersion = result.contextVersion ?? contextVersion;
    turn.messageId = result.messageId;
    turn.intendedText = result.message;
    turn.routeLatencyMs = Math.round(clock() - startedAt);
    record("authority_resolved", { turnId: turn.turnId, authority: result.authority, routeLatencyMs: turn.routeLatencyMs });
    if (result.authority === LIVE_AUTHORITY.LOCAL_CONVERSATION) {
      turn.phase = "playback_pending";
      for (const audio of turn.speculativeAudio) onAudio(audio);
      turn.deliveredText = turn.speculativeTranscript.trim();
      return true;
    }
    turn.speculativeAudio = [];
    turn.bufferedBytes = 0;
    turn.phase = "verified_output";
    turn.deliveredText = "";
    const chunks = commentaryChunks(result.message);
    for (const content of chunks) sendLive(Object.freeze({ type: "session.commentary.append", event_id: idFactory(), delegation_id: turn.delegationId, content }));
    record("verified_result_appended", { turnId: turn.turnId, authority: result.authority, chunks: chunks.length });
    return turn.promise;
  }

  async function providerFailed(category = "gpt_live_provider_error") {
    const turn = current;
    if (!turn || turn.terminal) return false;
    turn.terminal = "failed";
    onClearAudio();
    if (turn.messageId && turn.intendedText) await api.delivery({ conversationId, turnId: turn.turnId, messageId: turn.messageId, intendedText: turn.intendedText, deliveredText: turn.deliveredText, status: "truncated" }).catch(() => {});
    turn.result = Object.freeze({ status: "failed", turnId: turn.turnId, authority: turn.decision?.authority || null, providerCategory: String(category).slice(0, 80) });
    turn.resolve?.(turn.result);
    record("provider_failed", { turnId: turn.turnId, category: turn.result.providerCategory });
    return true;
  }

  async function complete(turn, status = "delivered") {
    if (turn !== current || turn.terminal) return false;
    turn.terminal = status;
    const delivered = turn.deliveredText.trim();
    await api.delivery({ conversationId, turnId: turn.turnId, messageId: turn.messageId, intendedText: turn.intendedText, deliveredText: delivered || turn.intendedText, status });
    turn.result = Object.freeze({ status, turnId: turn.turnId, authority: turn.decision.authority, contextVersion, messageId: turn.messageId, intendedText: turn.intendedText, deliveredText: delivered || turn.intendedText, routeLatencyMs: turn.routeLatencyMs, gateOverheadMs: Math.max(0, Math.round(clock() - turn.inputEndedAt - (turn.routeLatencyMs || 0))) });
    turn.resolve?.(turn.result);
    record("turn_terminal", { turnId: turn.turnId, status });
    return true;
  }

  return Object.freeze({
    async start(input = {}) { const started = await api.start(input); conversationId = started.conversationId; contextVersion = started.contextVersion; record("session_started", { conversationId }); return started; },
    async callerSpeechStarted() { ensure(); const didSupersede=await supersede(); if(!didSupersede){onClearAudio();record("output_cleared",{reason:"caller_barge_in"});} const turnId = idFactory(); current = { turnId, generation: ++generation, transcript: "", speculativeTranscript: "", speculativeAudio: [], bufferedBytes: 0, deliveredText: "", intendedText: "", messageId: null, delegationId: null, decision: null, phase: "capturing", terminal: null, abort: new AbortController(), expectedContextVersion: didSupersede ? null : contextVersion, inputEndedAt: null }; current.promise = new Promise((resolve) => { current.resolve = resolve; }); record("caller_speech_started", { turnId }); return turnId; },
    bindDelegation(delegationId) { const value=String(delegationId||"");if(!current||current.terminal||!/^item_[A-Za-z0-9_-]{8,128}$/.test(value))return false;current.delegationId=value;record("provider_delegation_bound",{turnId:current.turnId});return true; },
    appendTranscript(delta) { if (!current || current.terminal) return false; current.transcript = `${current.transcript}${String(delta || "")}`.slice(-MAX_TRANSCRIPT); return true; },
    appendOutputTranscript(delta) { if (!current || current.terminal) return false; const value = String(delta || ""); if (current.phase === "verified_output") current.deliveredText = `${current.deliveredText}${value}`.slice(-MAX_TRANSCRIPT); else current.speculativeTranscript = `${current.speculativeTranscript}${value}`.slice(-MAX_TRANSCRIPT); return true; },
    appendOutputAudio(audio) { if (!current || current.terminal || !Buffer.isBuffer(audio) || !audio.length) return false; if (current.phase === "verified_output") { onAudio(audio); return true; } if (current.phase === "released") { onAudio(audio); return true; } if (current.bufferedBytes + audio.length > MAX_BUFFERED_AUDIO_BYTES) throw Object.assign(new Error("Speculative Live audio exceeded the bounded gate."), { code: "gpt_live_output_gate_overflow" }); current.speculativeAudio.push(audio); current.bufferedBytes += audio.length; return true; },
    async callerSpeechEnded() { ensure(); const turn = current; if (!turn || turn.terminal || !turn.transcript.trim()) return false; turn.inputEndedAt = clock(); turn.decision = classifyLiveAuthority(turn.transcript); turn.phase = turn.decision.authority === LIVE_AUTHORITY.LOCAL_CONVERSATION ? "local_buffering" : "blocked"; if (turn.phase === "blocked") { turn.speculativeAudio = []; turn.bufferedBytes = 0; onClearAudio(); record("speculative_output_discarded", { turnId: turn.turnId, authority: turn.decision.authority }); void route(turn); } return turn.decision; },
    async providerOutputCompleted() { const turn = current; if (!turn || turn.terminal) return false; if (turn.phase === "local_buffering") return route(turn); if (turn.phase === "verified_output") { turn.phase="playback_pending"; return true; } return false; },
    async playbackCompleted() { const turn=current;if(!turn||turn.terminal||turn.phase!=="playback_pending")return false;return complete(turn,"delivered"); },
    async waitForTerminal({ signal } = {}) { const turn = current; if (!turn) return null; if (turn.terminal) return turn.result || { status: turn.terminal, turnId: turn.turnId }; if (!signal) return turn.promise; return Promise.race([turn.promise, new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]); },
    providerFailed,
    supersede,
    snapshot() { return Object.freeze({ conversationId, contextVersion, generation, current: current ? { turnId: current.turnId, phase: current.phase, terminal: current.terminal, authority: current.decision?.authority || null, bufferedBytes: current.bufferedBytes, transcriptCharacters:current.transcript.length } : null, rawAudioPersisted: false, audit: Object.freeze([...audit]) }); },
  });
}
