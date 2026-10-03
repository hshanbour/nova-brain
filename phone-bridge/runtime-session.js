import { randomUUID } from "node:crypto";
import { createPhase0PhoneBridgeSession } from "../src/phone/phase0-bridge-session.js";
import { createTelephonyVad } from "../src/phone/server-vad.js";

export function createRuntimePhoneSession({ sendTwilio, hangup = () => {}, transcriber, tts, novaClient, sessionToken, authorization, callIntentId, maximumDurationSeconds, callSid, streamSid, clock = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let bridgeToken = authorization?.bridgeSessionToken; let closed = false; let hangupAfterMark = false; const startedAt = clock(); const vad = createTelephonyVad();
  const core = createPhase0PhoneBridgeSession({ sendTwilio, transcriber, tts, idFactory: randomUUID, bargeInOnMedia: false, onControl(control){if(control==="hangup")hangupAfterMark=true;}, async novaTurn({ transcript, turnId }) {
    return novaClient.turn({ callIntentId, callSid, streamSid, turnId, transcript }, bridgeToken);
  } });
  const timer = setTimer(() => stop("completed", "maximum_duration"), maximumDurationSeconds * 1000);
  async function stop(type = "completed", providerStatus = "disconnected", { hangupSocket = true } = {}) {
    if (closed) return false; closed = true; clearTimer(timer);
    core.handleTwilio({ event: "stop", streamSid });
    if (bridgeToken) await novaClient.event({ callIntentId, callSid, streamSid, eventId: `bridge-stop-${callIntentId}-${streamSid}`, type, providerStatus }, bridgeToken).catch(() => {});
    if (hangupSocket) hangup();
    return true;
  }
  return Object.freeze({
    async start(startMessage) {
      const authorized = authorization || await novaClient.start({ sessionToken, callSid, streamSid }); bridgeToken = authorized.bridgeSessionToken;
      core.handleTwilio(startMessage); return authorized;
    },
    handle(message) {
      if (closed) return { ignored: true };
      if (message.event === "stop") { const result = core.handleTwilio(message); closed = true; clearTimer(timer); if (bridgeToken) void novaClient.event({ callIntentId, callSid, streamSid, eventId: `bridge-stop-${callIntentId}-${streamSid}`, type: "completed", providerStatus: "disconnected" }, bridgeToken).catch(() => {}); return result; }
      const result = core.handleTwilio(message);
      if (message.event === "media") {
        const activity = vad.push(message.media.payload);
        if (activity.event === "speech_started") core.interrupt();
        if (activity.event === "speech_ended") queueMicrotask(() => core.finalizeInboundTurn().catch(() => stop("failed", "turn_failure")));
      }
      if(message.event==="mark"&&result.playbackCompleted&&hangupAfterMark)void stop("completed","scope_ended");
      return result;
    },
    stop,
    metrics() { return { ...core.metrics(), elapsedMs: clock() - startedAt, rawAudioPersisted: false }; },
  });
}
