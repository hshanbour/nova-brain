import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceV2 } from "../assets/voice-v2.js";

function setup({ connectError, transcript = "مرحبا Nova، راجع Sharp Cuts API رقم 35", transcribeError, sendError, speechError } = {}) {
  const events = []; const timers = []; let handlers; let barge; let playbackCallbacks; let sends = 0; let speechCalls = 0;
  const capture = {
    async connect() { events.push("connect"); if (connectError) throw connectError; },
    listen(next) { handlers = next; events.push("listen"); },
    watchForBargeIn(callback) { barge = callback; events.push("watch-barge"); },
    stop() { events.push("capture-stop"); }, async destroy() { events.push("destroy"); }
  };
  const client = {
    async transcribe({ signal }) { events.push("transcribe"); assert.equal(signal instanceof AbortSignal, true); if (transcribeError) throw transcribeError; return { transcript }; },
    async speech(text, { signal }) { speechCalls += 1; events.push(`speech:${text}`); assert.equal(signal instanceof AbortSignal, true); if (speechError) throw speechError; return { audio: new Blob(["mp3"], { type: "audio/mpeg" }) }; }
  };
  const playback = { play(_audio, callbacks) { playbackCallbacks = callbacks; events.push("play"); }, stop() { events.push("playback-stop"); } };
  const states = []; const errors = []; const transcripts = [];
  const mode = createVoiceV2({ capture, client, playback,
    async sendTurn(text) { sends += 1; events.push(`send:${text}`); if (sendError) throw sendError; return { message: `Nova reply to ${text}`, conversationId: "conversation-1" }; },
    onTranscript: (text) => transcripts.push(text), onState: ({ state }) => states.push(state), onError: (message) => errors.push(message),
    schedule(callback, delay) { const timer = { callback, delay, cancelled: false }; timers.push(timer); return timer; }, cancelSchedule(timer) { timer.cancelled = true; }
  });
  return {
    mode, events, states, errors, transcripts, timers,
    audio: (recording = { audio: new Blob(["audio"], { type: "audio/webm" }), mimeType: "audio/webm", durationSeconds: 1 }) => handlers.onAudio(recording),
    noSpeech: () => handlers.onNoSpeech(), barge: () => barge(), ended: () => playbackCallbacks.onEnded(), playbackError: () => playbackCallbacks.onError(),
    runTimer: (index = timers.length - 1) => { const timer = timers[index]; if (!timer.cancelled) timer.callback(); },
    counts: () => ({ sends, speechCalls })
  };
}

test("Start Voice continuously runs listen, transcribe, existing Nova turn, ElevenLabs audio, then listens again", async () => {
  const flow = setup(); assert.equal(await flow.mode.start(), true); assert.equal(flow.mode.getState(), "listening");
  assert.equal(await flow.audio(), true); assert.equal(flow.mode.getState(), "speaking"); assert.equal(flow.counts().sends, 1); assert.equal(flow.counts().speechCalls, 1);
  assert.deepEqual(flow.states.slice(0, 6), ["connecting", "listening", "transcribing", "thinking", "speaking"]); assert.ok(flow.events.includes("play"));
  flow.ended(); assert.equal(flow.mode.getState(), "listening"); assert.equal(flow.events.filter((item) => item === "listen").length, 2);
});

test("barge-in stops Nova playback and returns to listening without duplicating a turn", async () => {
  const flow = setup(); await flow.mode.start(); await flow.audio(); const sends = flow.counts().sends; flow.barge();
  assert.ok(flow.states.includes("interrupted")); assert.equal(flow.mode.getState(), "listening"); assert.equal(flow.counts().sends, sends); assert.ok(flow.events.slice(-5).includes("playback-stop"));
});

test("End Voice cancels capture, playback, retries, and prevents late completion", async () => {
  const flow = setup(); flow.mode.end(); await flow.mode.start();
  const process = flow.audio(); flow.mode.end(); await process;
  assert.equal(flow.mode.isActive(), false); assert.equal(flow.mode.getState(), "idle"); assert.equal(flow.counts().sends, 0); assert.ok(flow.events.includes("destroy"));
});

test("duplicate recorder completion cannot create duplicate Nova turns", async () => {
  const flow = setup(); await flow.mode.start(); const first = flow.audio(); const duplicate = flow.audio(); assert.equal(await duplicate, false); await first; assert.equal(flow.counts().sends, 1);
});

test("no speech retries listening without sending a message", async () => {
  const flow = setup(); await flow.mode.start(); flow.noSpeech(); assert.equal(flow.mode.getState(), "retrying"); assert.equal(flow.timers.at(-1).delay, 900); flow.runTimer(); assert.equal(flow.mode.getState(), "listening"); assert.equal(flow.counts().sends, 0);
});

test("microphone permission failure ends safely in error", async () => {
  const flow = setup({ connectError: new Error("Microphone permission was denied.") }); assert.equal(await flow.mode.start(), false); assert.equal(flow.mode.isActive(), false); assert.equal(flow.mode.getState(), "error"); assert.match(flow.errors[0], /permission/);
});

test("STT failure recovers without sending or speaking", async () => {
  const flow = setup({ transcribeError: new Error("upstream") }); await flow.mode.start(); assert.equal(await flow.audio(), false); assert.ok(flow.states.includes("error")); assert.equal(flow.mode.getState(), "retrying"); assert.equal(flow.counts().sends, 0); assert.equal(flow.counts().speechCalls, 0);
});

test("TTS failure preserves the written Nova turn and recovers without browser speech fallback", async () => {
  const flow = setup({ speechError: new Error("tts failed") }); await flow.mode.start(); assert.equal(await flow.audio(), false); assert.equal(flow.counts().sends, 1); assert.equal(flow.mode.getState(), "retrying"); assert.match(flow.errors.at(-1), /written reply is safe/i); assert.equal(flow.events.includes("play"), false);
});

test("Arabic-English mixed transcripts pass unchanged into the existing Nova send pipeline", async () => {
  const mixed = "محمد، check Nova Brain API وSharp Cuts booking رقم 079 123 4567"; const flow = setup({ transcript: mixed }); await flow.mode.start(); await flow.audio(); assert.deepEqual(flow.transcripts, [mixed]); assert.ok(flow.events.includes(`send:${mixed}`));
});
