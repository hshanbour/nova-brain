import { WebSocket } from "ws";
import { buildGptLivePrototypeSession } from "../src/phone/gpt-live-prototype.js";
import { buildRound2LiveInstructions } from "../src/phone/gpt-live-round2.js";
import { createGptLiveRound2OutputGate } from "./gpt-live-round2-gate.js";

const LIVE_URL = "wss://api.openai.com/v1/live/sessions";

export function createGptLiveRound2Client({ apiKey, round2Api, conversationId, callContext = null, voice = "marin", history = [], onAudio, onClearAudio, onEvent = () => {}, onOutputCompleted = () => {}, WebSocketImpl = WebSocket, timeoutMs = 20_000, outputQuietMs = 900 } = {}) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is required.");
  let socket, readyResolve, readyReject, closedResolve, closeTimer, outputQuietTimer, usageSeconds = 0;
  const readyPromise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const closedPromise = new Promise((resolve) => { closedResolve = resolve; });
  const sendLive = (event) => { if (!socket || socket.readyState !== WebSocketImpl.OPEN) throw Object.assign(new Error("GPT-Live socket is not ready."), { code: "gpt_live_socket_not_ready" }); socket.send(JSON.stringify(event)); };
  const gate = createGptLiveRound2OutputGate({ api: round2Api, sendLive, onAudio, onClearAudio });
  const seen = new Set();
  const completedTurns = new Set();
  let activeOutputTurnId = null;
  async function completeProviderOutput(source, expectedTurnId = activeOutputTurnId) {
    const before = gate.snapshot().current;
    if (!expectedTurnId || !before || before.turnId !== expectedTurnId || before.terminal || completedTurns.has(expectedTurnId)) return false;
    const transitioned = await gate.providerOutputCompleted();
    const after = gate.snapshot().current;
    if (!transitioned || !after || after.turnId !== expectedTurnId || after.terminal || completedTurns.has(expectedTurnId)) return false;
    completedTurns.add(expectedTurnId);
    onOutputCompleted(Object.freeze({ turnId: expectedTurnId, source }));
    return true;
  }
  const scheduleOutputCompletion = () => {
    clearTimeout(outputQuietTimer);
    const expectedTurnId = activeOutputTurnId;
    outputQuietTimer = setTimeout(() => { void completeProviderOutput("inactivity", expectedTurnId).catch(() => gate.providerFailed("gpt_live_output_completion_failed")); }, outputQuietMs);
    outputQuietTimer.unref?.();
  };

  async function handle(event) {
    if (!event?.type || (event.event_id && seen.has(event.event_id))) return false;
    if (event.event_id) seen.add(event.event_id);
    onEvent(event.type);
    if (event.type === "session.started") { const started = await gate.start({ conversationId, callContext }); readyResolve({ ...started, providerSessionId: event.session?.id || null }); return true; }
    if (event.type === "session.input_transcript.delta") return gate.appendTranscript(event.delta);
    if (event.type === "session.delegation.created") return gate.bindDelegation(event.delegation?.id);
    if (event.type === "session.output_transcript.delta") { const accepted=gate.appendOutputTranscript(event.delta,event);if(accepted){activeOutputTurnId=gate.snapshot().current?.turnId||null;scheduleOutputCompletion();}return accepted; }
    if (event.type === "session.output_audio.delta") { const accepted=gate.appendOutputAudio(Buffer.from(String(event.delta || ""), "base64"),event);if(accepted){activeOutputTurnId=gate.snapshot().current?.turnId||null;scheduleOutputCompletion();}return accepted; }
    if (event.type === "session.commentary.appended") return gate.commentaryAcknowledged(event);
    if (["session.output_audio.done", "session.output.done", "session.response.done"].includes(event.type)) { clearTimeout(outputQuietTimer);return completeProviderOutput("provider_event"); }
    if (event.type === "session.usage.updated") { usageSeconds = Math.max(usageSeconds, Number(event.usage?.seconds) || 0); return true; }
    if (event.type === "session.closed") { usageSeconds = Math.max(usageSeconds, Number(event.usage?.seconds) || 0); clearTimeout(closeTimer); closedResolve({ ...gate.snapshot(), usageSeconds }); socket.close(); return true; }
    if (event.type === "error") return gate.providerFailed(String(event.error?.code || event.error?.type || "unknown").slice(0, 80));
    return false;
  }

  return Object.freeze({
    connect() {
      if (socket) return false;
      socket = new WebSocketImpl(LIVE_URL, { headers: { Authorization: `Bearer ${apiKey}`, "OpenAI-Beta": "realtime=v1" } });
      const timer = setTimeout(() => readyReject(Object.assign(new Error("GPT-Live connection timed out."), { code: "gpt_live_connect_timeout" })), timeoutMs); timer.unref?.();
      socket.on("open", () => { const session = { ...buildGptLivePrototypeSession({ voice, history }), instructions: buildRound2LiveInstructions(callContext) }; sendLive({ type: "session.start", event_id: crypto.randomUUID(), session }); });
      socket.on("message", async (raw) => { try { const event = JSON.parse(String(raw)); await handle(event); if (event.type === "session.started") clearTimeout(timer); } catch (error) { clearTimeout(timer); await gate.providerFailed(error?.code || "gpt_live_event_failed"); readyReject(error); } });
      socket.on("error", async () => { await gate.providerFailed("gpt_live_transport_failed"); readyReject(Object.assign(new Error("GPT-Live transport failed."), { code: "gpt_live_transport_failed" })); });
      socket.on("close", () => closedResolve(gate.snapshot()));
      return true;
    },
    ready() { return readyPromise; },
    beginGreeting() { return gate.beginGreeting(); },
    async callerSpeechStarted() { clearTimeout(outputQuietTimer);activeOutputTurnId=null;return gate.callerSpeechStarted(); },
    resumeCallerSpeech() { clearTimeout(outputQuietTimer); return gate.resumeCallerSpeech(); },
    appendAudio(audio) { if (!socket || socket.readyState !== WebSocketImpl.OPEN || !Buffer.isBuffer(audio) || !audio.length) return false; sendLive({ type: "session.input_audio.append", event_id: crypto.randomUUID(), audio: audio.toString("base64") }); return true; },
    async callerSpeechEnded(input) { const result=await gate.callerSpeechEnded(input);if(result)scheduleOutputCompletion();return result; },
    providerOutputCompleted() { clearTimeout(outputQuietTimer);return completeProviderOutput("application"); },
    playbackCompleted() { return gate.playbackCompleted(); },
    playbackCheckpoint(input) { return gate.playbackCheckpoint(input); },
    waitForTerminal(options) { return gate.waitForTerminal(options); },
    supersede(reason) { return gate.supersede(reason); },
    async drain({ timeoutMs: drainTimeoutMs = 1_500 } = {}) {
      clearTimeout(outputQuietTimer);
      const snapshot = gate.snapshot();
      if (!snapshot.current || snapshot.current.terminal) return snapshot;
      if (snapshot.current.phase === "capturing" && snapshot.current.transcriptCharacters > 0) await gate.callerSpeechEnded().catch(() => false);
      await Promise.race([
        gate.waitForTerminal(),
        new Promise((resolve) => setTimeout(() => resolve(gate.snapshot()), drainTimeoutMs)),
      ]);
      const settled = gate.snapshot();
      if (settled.current && !settled.current.terminal) await gate.supersede("call_terminated").catch(() => false);
      return gate.snapshot();
    },
    close() { clearTimeout(outputQuietTimer);if (!socket || socket.readyState !== WebSocketImpl.OPEN) return closedPromise; sendLive({ type: "session.close", event_id: crypto.randomUUID() }); closeTimer = setTimeout(() => { socket?.terminate?.(); closedResolve(gate.snapshot()); }, timeoutMs); closeTimer.unref?.(); return closedPromise; },
    snapshot() { return Object.freeze({ ...gate.snapshot(), usageSeconds }); },
  });
}
