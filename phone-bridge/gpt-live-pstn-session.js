import { createTelephonyVad } from "../src/phone/server-vad.js";
import { twilioClear, twilioMark, twilioMedia } from "../src/phone/twilio-media-protocol.js";
import { createGptLiveRound2Client } from "./gpt-live-round2-client.js";
import { mulaw8kToWav } from "../src/phone/g711.js";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createGptLivePstnSession({ sendTwilio, hangup = () => {}, novaClient, authorization, callIntentId, maximumDurationSeconds, callSid, streamSid, apiKey, round2Api, createClient = createGptLiveRound2Client, diagnostic = () => {}, clock = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, endpointGraceMs = 900, drainTimeoutMs = 1_500 } = {}) {
  if (!authorization?.bridgeSessionToken || authorization.mediaProfile !== "gpt_live_round2_preview" || !authorization.callConversationId || !authorization.liveVoice) throw Object.assign(new Error("The GPT-Live call authorization is incomplete."), { code: "gpt_live_phone_authorization_invalid" });
  let closed = false, stopping = false, timer, endpointTimer, markSequence = 0, finalizeGeneration = 0, inputReady = Promise.resolve(), lastAudioMeta = null, checkpointBytes = 0, outputByteCursor = 0, checkpointByteStart = 0, outputIdentity = null, callerAudio = [], callerAudioBytes = 0;
  const pendingPlaybackMarks = new Map();
  const finalMarkTurns = new Set();
  const pendingFinalizers = new Set();
  const startedAt = clock();
  const vad = createTelephonyVad();
  const client = createClient({
    apiKey,
    round2Api,
    conversationId: authorization.callConversationId,
    callContext: { active: true, callIntentId, objective: authorization.objective || null, lifecycle: "in_progress", mediaProfile: authorization.mediaProfile, permittedActions: authorization.permittedActions || [], prohibitedActions: authorization.prohibitedActions || [], maximumDurationSeconds, speakerAuthenticated: false },
    voice: authorization.liveVoice,
    onAudio(audio, metadata = {}) { if (!closed && !stopping) {
      const identity = `${metadata.turnId || "turn"}:${metadata.outputKind || "final"}`;
      if (identity !== outputIdentity) { outputIdentity = identity; checkpointBytes = 0; outputByteCursor = 0; checkpointByteStart = 0; }
      const firstMediaAt = clock();
      sendTwilio(twilioMedia(streamSid, audio)); lastAudioMeta = { ...metadata, firstMediaAt }; checkpointBytes += audio.length; outputByteCursor += audio.length;
      try { diagnostic("assistant_media_emitted", { turnId: metadata.turnId || null, outputKind: metadata.outputKind || "final", bytes: audio.length, cumulativeBytes: outputByteCursor, cumulativeDurationMs: Math.round(outputByteCursor / 8), queueDepth: pendingPlaybackMarks.size }); } catch {}
      if (checkpointBytes >= 4_000) { const name = `nova-segment-${++markSequence}-${metadata.turnId || "turn"}`; const byteEnd = outputByteCursor; pendingPlaybackMarks.set(name, { ...lastAudioMeta, checkpointId: name, final: false, cleared: false, byteStart: checkpointByteStart, byteEnd, durationStartMs: Math.round(checkpointByteStart / 8), durationEndMs: Math.round(byteEnd / 8), sentAt: clock() }); checkpointByteStart = byteEnd; checkpointBytes = 0; sendTwilio(twilioMark(streamSid, name)); }
    } },
    onClearAudio() { if (!closed) { checkpointBytes = 0; checkpointByteStart = outputByteCursor; for (const value of pendingPlaybackMarks.values()) { value.cleared = true; value.clearedAt = clock(); } sendTwilio(twilioClear(streamSid)); } },
    onOutputCompleted({ turnId } = {}) { queueMicrotask(() => schedulePlaybackMark(turnId)); },
  });

  async function finalizeInboundTurn(generation) {
    await inputReady;
    for (let index = 0; index < 120 && !closed && generation === finalizeGeneration; index += 1) {
      if (client.snapshot().current?.transcriptCharacters > 0) {
        const mulaw = Buffer.concat(callerAudio); callerAudio = []; callerAudioBytes = 0;
        const durationSeconds = mulaw.length / 8_000;
        const speakerAudio = durationSeconds > 0.2 && durationSeconds <= 30 ? { audioBase64: mulaw8kToWav(mulaw).toString("base64"), mimeType: "audio/wav", durationSeconds } : null;
        await client.callerSpeechEnded({ speakerAudio }); return true;
      }
      await sleep(25);
    }
    return false;
  }
  function expectedTurnCancellation(error, generation) {
    return generation !== finalizeGeneration || error?.name === "AbortError" || error?.code === "gpt_live_round2_superseded";
  }
  async function handleFinalizeFailure(error, generation) {
    if (closed || expectedTurnCancellation(error, generation)) {
      try { diagnostic("turn_superseded", { category: "caller_speech_superseded_pending_turn" }); } catch {}
      return false;
    }
    const providerCode = String(error?.code || "");
    const category = /^[a-z0-9_]{1,64}$/i.test(providerCode) ? providerCode : "live_turn_failure";
    try { diagnostic("turn_finalize_failed", { category }); } catch {}
    await stop("failed", "live_turn_failure");
    return false;
  }
  function finalizeDetached(generation) {
    const pending = finalizeInboundTurn(generation).catch((error) => {
      void handleFinalizeFailure(error, generation).catch(() => {
        try { diagnostic("turn_finalize_cleanup_failed", { category: "live_turn_failure" }); } catch {}
      });
    });
    pendingFinalizers.add(pending);
    void pending.finally(() => pendingFinalizers.delete(pending));
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
        const byteEnd = outputByteCursor;
        pendingPlaybackMarks.set(name, { ...(lastAudioMeta || {}), turnId, outputKind: current.phase === "backend_pending" ? "acknowledgement" : "final", checkpointId: name, final: true, cleared: false, byteStart: checkpointByteStart, byteEnd, durationStartMs: Math.round(checkpointByteStart / 8), durationEndMs: Math.round(byteEnd / 8), sentAt: clock() });
        checkpointByteStart = byteEnd; checkpointBytes = 0;
        sendTwilio(twilioMark(streamSid, name));
        return true;
      }
      await sleep(25);
    }
    return false;
  }
  async function stop(type = "completed", providerStatus = "disconnected", { hangupSocket = true } = {}) {
    if (closed || stopping) return false;
    stopping = true; clearTimer(timer); clearTimer(endpointTimer); vad.reset();
    await Promise.race([Promise.allSettled([...pendingFinalizers]), sleep(drainTimeoutMs)]);
    await client.drain?.({ timeoutMs: drainTimeoutMs }).catch(() => null);
    closed = true; finalizeGeneration += 1;
    await client.close().catch(() => null);
    await novaClient.event({ callIntentId, callSid, streamSid, eventId: `bridge-stop-${callIntentId}-${streamSid}`, type, providerStatus }, authorization.bridgeSessionToken).catch(() => null);
    if (hangupSocket) hangup();
    return true;
  }
  return Object.freeze({
    async start() {
      client.connect();
      const started = await client.ready();
      await client.beginGreeting?.();
      timer = setTimer(() => { void stop("completed", "maximum_duration"); }, maximumDurationSeconds * 1_000);
      timer.unref?.();
      return { ...authorization, providerSessionId: started.providerSessionId || null };
    },
    handle(message) {
      if (closed || stopping) return { ignored: true };
      if (message.event === "media") {
        const activity = vad.push(message.media.payload);
        if (activity.event === "speech_started") {
          if (endpointTimer) {
            clearTimer(endpointTimer); endpointTimer = null; finalizeGeneration += 1;
            client.resumeCallerSpeech?.();
            try { diagnostic("endpoint_grace_cancelled", { reason: "speech_resumed" }); } catch {}
          } else {
            finalizeGeneration += 1;
            callerAudio = []; callerAudioBytes = 0;
            inputReady = client.callerSpeechStarted();
          }
        }
        const audio = Buffer.from(message.media.payload, "base64");
        if (client.snapshot().current?.phase === "capturing" && callerAudioBytes < 240_000) { callerAudio.push(audio); callerAudioBytes += audio.length; }
        void inputReady.then(() => { if (!closed && !stopping) client.appendAudio(audio); }).catch(() => { void stop("failed", "live_input_failure"); });
        if (activity.event === "speech_ended") {
          const generation = ++finalizeGeneration;
          clearTimer(endpointTimer);
          endpointTimer = setTimer(() => { endpointTimer = null; finalizeDetached(generation); }, endpointGraceMs);
          endpointTimer.unref?.();
          try { diagnostic("endpoint_grace_started", { graceMs: endpointGraceMs }); } catch {}
        }
        return { accepted: true };
      }
      if (message.event === "mark" && pendingPlaybackMarks.has(message.mark?.name)) {
        const checkpoint = pendingPlaybackMarks.get(message.mark.name); pendingPlaybackMarks.delete(message.mark.name); checkpoint.acknowledgedAt = clock();
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
