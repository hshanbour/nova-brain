import { randomUUID } from "node:crypto";
import { parseTwilioMediaMessage, twilioClear, twilioMark, twilioMedia } from "./twilio-media-protocol.js";

export function createPhase0PhoneBridgeSession({ sendTwilio, transcriber, novaTurn, tts, idFactory = randomUUID, bargeInOnMedia = true, onControl = () => {} }) {
  if (![sendTwilio, novaTurn].every((value) => typeof value === "function")) throw new TypeError("Bridge callbacks are required.");
  if (!transcriber || !tts) throw new TypeError("Bridge providers are required.");
  let state = "connecting";
  let callSid;
  let streamSid;
  let generation = 0;
  let inboundFrames = 0;
  let pendingInboundFrames = 0;
  let outboundFrames = 0;
  let completedTurns = 0;
  let activeTurn;
  let speechController;
  let pendingPlaybackMark;

  const send = (message) => sendTwilio(message);
  const interrupt = () => {
    if (state !== "speaking" && state !== "thinking" && state !== "transcribing") return false;
    generation += 1;
    speechController?.abort();
    speechController = undefined;
    activeTurn = undefined;
    pendingPlaybackMark = undefined;
    if (streamSid) send(twilioClear(streamSid));
    state = "listening";
    return true;
  };

  return Object.freeze({
    handleTwilio(raw) {
      const message = parseTwilioMediaMessage(raw);
      if (message.event === "start") {
        if (callSid) {
          if (callSid === message.start.callSid && streamSid === message.streamSid) return { duplicate: true };
          throw new Error("A bridge session cannot be rebound to another Twilio call.");
        }
        callSid = message.start.callSid;
        streamSid = message.streamSid;
        transcriber.start();
        state = "listening";
        return { started: true, callSid, streamSid };
      }
      if (message.event === "media") {
        if (!streamSid || message.streamSid !== streamSid || state === "ended") return { ignored: true };
        if (bargeInOnMedia && (state === "speaking" || state === "thinking" || state === "transcribing")) interrupt();
        transcriber.appendMulaw(message.media.payload);
        inboundFrames += 1;
        pendingInboundFrames += 1;
        return { accepted: true };
      }
      if (message.event === "mark" && message.mark?.name === pendingPlaybackMark) {
        pendingPlaybackMark = undefined;
        state = "listening";
        return { playbackCompleted: true };
      }
      if (message.event === "stop") {
        generation += 1;
        speechController?.abort();
        activeTurn = undefined;
        pendingPlaybackMark = undefined;
        transcriber.close();
        state = "ended";
        return { ended: true };
      }
      return { ignored: true };
    },
    async finalizeInboundTurn() {
      if (state !== "listening" || !callSid || activeTurn || pendingInboundFrames === 0) return false;
      pendingInboundFrames = 0;
      const turn = { id: idFactory(), generation };
      activeTurn = turn;
      state = "transcribing";
      try {
        const transcription = await transcriber.commit({ turnId: turn.id });
        if (state === "ended" || turn.generation !== generation || activeTurn !== turn) return false;
        if (!transcription?.transcript?.trim()) { state = "listening"; return false; }
        state = "thinking";
        const response = await novaTurn({ transcript: transcription.transcript, callSid, turnId: turn.id });
        if (state === "ended" || turn.generation !== generation || activeTurn !== turn) return false;
        const text = String(response?.message || response || "").trim();
        if (!text) { state = "listening"; return false; }
        state = "speaking";
        speechController = new AbortController();
        for await (const audio of tts.stream(text, { signal: speechController.signal })) {
          if (state === "ended" || turn.generation !== generation || activeTurn !== turn) return false;
          send(twilioMedia(streamSid, audio));
          outboundFrames += 1;
        }
        if (state === "ended" || turn.generation !== generation || activeTurn !== turn) return false;
        pendingPlaybackMark = `nova-turn-${turn.id}`;
        send(twilioMark(streamSid, pendingPlaybackMark));
        onControl(response?.control || "continue", { markName: pendingPlaybackMark, turnId: turn.id });
        completedTurns += 1;
        return true;
      } finally {
        if (activeTurn === turn) activeTurn = undefined;
        speechController = undefined;
      }
    },
    interrupt,
    state() { return state; },
    metrics() { return Object.freeze({ state, callSid, streamSid, generation, inboundFrames, pendingInboundFrames, outboundFrames, completedTurns, activeTurn: Boolean(activeTurn), pendingPlayback: Boolean(pendingPlaybackMark) }); },
  });
}

export function createPhase0BridgeSessionRegistry({ createSession }) {
  if (typeof createSession !== "function") throw new TypeError("createSession is required.");
  const byCallSid = new Map();
  const byStreamSid = new Map();
  return Object.freeze({
    open(rawStart) {
      const start = parseTwilioMediaMessage(rawStart);
      if (start.event !== "start") throw new Error("A Twilio start message is required.");
      const existing = byCallSid.get(start.start.callSid);
      if (existing) {
        if (existing.streamSid !== start.streamSid) throw new Error("Twilio call is already bound to another media stream.");
        return { session: existing.session, reused: true };
      }
      if (byStreamSid.has(start.streamSid)) throw new Error("Twilio media stream is already bound to another call.");
      const session = createSession({ callSid: start.start.callSid, streamSid: start.streamSid });
      session.handleTwilio(start);
      const record = { session, streamSid: start.streamSid };
      byCallSid.set(start.start.callSid, record);
      byStreamSid.set(start.streamSid, start.start.callSid);
      return { session, reused: false };
    },
    close(callSid) {
      const record = byCallSid.get(callSid);
      if (!record) return false;
      byCallSid.delete(callSid);
      byStreamSid.delete(record.streamSid);
      return true;
    },
    size() { return byCallSid.size; },
  });
}
