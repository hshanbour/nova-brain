import { createTelephonyVad } from "../src/phone/server-vad.js";
import { twilioClear, twilioMark, twilioMedia } from "../src/phone/twilio-media-protocol.js";
import { createGptLiveRound2Client } from "./gpt-live-round2-client.js";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createGptLivePstnSession({ sendTwilio, hangup = () => {}, novaClient, authorization, callIntentId, maximumDurationSeconds, callSid, streamSid, apiKey, round2Api, createClient = createGptLiveRound2Client, diagnostic = () => {}, clock = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!authorization?.bridgeSessionToken || authorization.mediaProfile !== "gpt_live_round2_preview" || !authorization.callConversationId || !authorization.liveVoice) throw Object.assign(new Error("The GPT-Live call authorization is incomplete."), { code: "gpt_live_phone_authorization_invalid" });
  let closed = false, timer, markSequence = 0, finalizeGeneration = 0, inputReady = Promise.resolve(), lastAudioMeta = null, checkpointBytes = 0;
  const pendingPlaybackMarks = new Map();
  const finalMarkTurns = new Set();
  const startedAt = clock();
  const vad = createTelephonyVad();
  const client = createClient({
    apiKey,
    round2Api,
    conversationId: authorization.callConversationId,
    callContext: { active: true, callIntentId, objective: authorization.objective || null, lifecycle: "in_progress", mediaProfile: authorization.mediaProfile, permittedActions: authorization.permittedActions || [], prohibitedActions: authorization.prohibitedActions || [], maximumDurationSeconds, speakerAuthenticated: false },
    voice: authorization.liveVoice,
    onAudio(audio, metadata = {}) { if (!closed) { sendTwilio(twilioMedia(streamSid, audio)); lastAudioMeta = metadata; checkpointBytes += audio.length; if (checkpointBytes >= 4_000) { checkpointBytes = 0; const name = `nova-segment-${++markSequence}-${metadata.turnId || "turn"}`; pendingPlaybackMarks.set(name, { ...metadata, checkpointId: name, final: false, cleared: false }); sendTwilio(twilioMark(streamSid, name)); } } },
    onClearAudio() { if (!closed) { checkpointBytes = 0; for (const value of pendingPlaybackMarks.values()) value.cleared = true; sendTwilio(twilioClear(streamSid)); } },
    onOutputCompleted({ turnId } = {}) { queueMicrotask(() => schedulePlaybackMark(turnId)); },
  });

  async function finalizeInboundTurn(generation) {
    await inputReady;
    for (let index = 0; index < 120 && !closed && generation === finalizeGeneration; index += 1) {
      if (client.snapshot().current?.transcriptCharacters > 0) { await client.callerSpeechEnded(); return true; }
      await sleep(25);
    }
    return false;
  }
  function expectedTurnCancellation(error, generation) {
    return generation !== finalizeGeneration || error?.name === "AbortError" || error?.code === "gpt_live_round2_superseded";
  }
  async function handleFinalizeFailure(error, generation) {
    if (closed || expectedTurnCancellation(error, generation)) {
      try { diagnostic("turn_superseded", { category: "caller_correction" }); } catch {}
      return false;
    }
    const providerCode = String(error?.code || "");
    const category = /^[a-z0-9_]{1,64}$/i.test(providerCode) ? providerCode : "live_turn_failure";
    try { diagnostic("turn_finalize_failed", { category }); } catch {}
    await stop("failed", "live_turn_failure");
    return false;
  }
  function finalizeDetached(generation) {
    void finalizeInboundTurn(generation).catch((error) => {
      void handleFinalizeFailure(error, generation).catch(() => {
        try { diagnostic("turn_finalize_cleanup_failed", { category: "live_turn_failure" }); } catch {}
      });
    });
  }
  async function schedulePlaybackMark(turnId) {
    if (!turnId || finalMarkTurns.has(turnId)) return false;
    for (let index = 0; index < 3_000 && !closed; index += 1) {
      const current = client.snapshot().current;
      if (!current || current.turnId !== turnId || current.terminal) return false;
      if (["playback_pending", "backend_pending"].includes(current.phase)) {
        if (finalMarkTurns.has(turnId)) return false;
        finalMarkTurns.add(turnId);
        const name = `nova-final-${++markSequence}-${turnId}`;
        pendingPlaybackMarks.set(name, { ...(lastAudioMeta || {}), turnId, outputKind: current.phase === "backend_pending" ? "acknowledgement" : "final", checkpointId: name, final: true, cleared: false });
        sendTwilio(twilioMark(streamSid, name));
        return true;
      }
      await sleep(25);
    }
    return false;
  }
  async function stop(type = "completed", providerStatus = "disconnected", { hangupSocket = true } = {}) {
    if (closed) return false;
    closed = true; finalizeGeneration += 1; clearTimer(timer); vad.reset();
    await client.close().catch(() => null);
    await novaClient.event({ callIntentId, callSid, streamSid, eventId: `bridge-stop-${callIntentId}-${streamSid}`, type, providerStatus }, authorization.bridgeSessionToken).catch(() => null);
    if (hangupSocket) hangup();
    return true;
  }
  return Object.freeze({
    async start() {
      client.connect();
      const started = await client.ready();
      timer = setTimer(() => { void stop("completed", "maximum_duration"); }, maximumDurationSeconds * 1_000);
      timer.unref?.();
      return { ...authorization, providerSessionId: started.providerSessionId || null };
    },
    handle(message) {
      if (closed) return { ignored: true };
      if (message.event === "media") {
        const activity = vad.push(message.media.payload);
        if (activity.event === "speech_started") {
          finalizeGeneration += 1;
          inputReady = client.callerSpeechStarted();
        }
        const audio = Buffer.from(message.media.payload, "base64");
        void inputReady.then(() => { if (!closed) client.appendAudio(audio); }).catch(() => { void stop("failed", "live_input_failure"); });
        if (activity.event === "speech_ended") { const generation = ++finalizeGeneration; finalizeDetached(generation); }
        return { accepted: true };
      }
      if (message.event === "mark" && pendingPlaybackMarks.has(message.mark?.name)) {
        const checkpoint = pendingPlaybackMarks.get(message.mark.name); pendingPlaybackMarks.delete(message.mark.name);
        const confirmation = typeof client.playbackCheckpoint === "function" ? client.playbackCheckpoint(checkpoint) : Promise.resolve(false);
        void confirmation.then(() => { if (checkpoint.final && !checkpoint.cleared && checkpoint.outputKind === "final") return client.playbackCompleted(); return null; });
        return { playbackCheckpoint: true, cleared: checkpoint.cleared, final: checkpoint.final };
      }
      if (message.event === "stop") { void stop("completed", "disconnected", { hangupSocket: false }); return { ended: true }; }
      return { ignored: true };
    },
    stop,
    metrics() { return { architecture: "gpt_live_round2", voice: authorization.liveVoice, elapsedMs: clock() - startedAt, rawAudioPersisted: false, ...client.snapshot() }; },
  });
}
