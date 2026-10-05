import { createTelephonyVad } from "../src/phone/server-vad.js";
import { twilioClear, twilioMark, twilioMedia } from "../src/phone/twilio-media-protocol.js";
import { createGptLiveRound2Client } from "./gpt-live-round2-client.js";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createGptLivePstnSession({ sendTwilio, hangup = () => {}, novaClient, authorization, callIntentId, maximumDurationSeconds, callSid, streamSid, apiKey, round2Api, createClient = createGptLiveRound2Client, clock = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!authorization?.bridgeSessionToken || authorization.mediaProfile !== "gpt_live_round2_preview" || !authorization.callConversationId || !authorization.liveVoice) throw Object.assign(new Error("The GPT-Live call authorization is incomplete."), { code: "gpt_live_phone_authorization_invalid" });
  let closed = false, timer, pendingPlaybackMark = null, markSequence = 0, finalizeGeneration = 0, inputReady = Promise.resolve();
  const startedAt = clock();
  const vad = createTelephonyVad();
  const client = createClient({
    apiKey,
    round2Api,
    conversationId: authorization.callConversationId,
    voice: authorization.liveVoice,
    onAudio(audio) { if (!closed) sendTwilio(twilioMedia(streamSid, audio)); },
    onClearAudio() { if (!closed) sendTwilio(twilioClear(streamSid)); },
    onEvent(type) { if (["session.output_audio.done", "session.output.done", "session.response.done"].includes(type)) queueMicrotask(schedulePlaybackMark); },
  });

  async function finalizeInboundTurn(generation) {
    await inputReady;
    for (let index = 0; index < 120 && !closed && generation === finalizeGeneration; index += 1) {
      if (client.snapshot().current?.transcriptCharacters > 0) { await client.callerSpeechEnded(); return true; }
      await sleep(25);
    }
    return false;
  }
  async function schedulePlaybackMark() {
    const turnId = client.snapshot().current?.turnId;
    if (!turnId || pendingPlaybackMark) return false;
    for (let index = 0; index < 3_000 && !closed; index += 1) {
      const current = client.snapshot().current;
      if (!current || current.turnId !== turnId || current.terminal) return false;
      if (current.phase === "playback_pending") {
        pendingPlaybackMark = `nova-live-${++markSequence}-${turnId}`;
        sendTwilio(twilioMark(streamSid, pendingPlaybackMark));
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
          finalizeGeneration += 1; pendingPlaybackMark = null;
          inputReady = client.callerSpeechStarted();
        }
        const audio = Buffer.from(message.media.payload, "base64");
        void inputReady.then(() => { if (!closed) client.appendAudio(audio); }).catch(() => { void stop("failed", "live_input_failure"); });
        if (activity.event === "speech_ended") { const generation = ++finalizeGeneration; void finalizeInboundTurn(generation); }
        return { accepted: true };
      }
      if (message.event === "mark" && message.mark?.name === pendingPlaybackMark) {
        pendingPlaybackMark = null; void client.playbackCompleted(); return { playbackCompleted: true };
      }
      if (message.event === "stop") { void stop("completed", "disconnected", { hangupSocket: false }); return { ended: true }; }
      return { ignored: true };
    },
    stop,
    metrics() { return { architecture: "gpt_live_round2", voice: authorization.liveVoice, elapsedMs: clock() - startedAt, rawAudioPersisted: false, ...client.snapshot() }; },
  });
}
