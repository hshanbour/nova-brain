import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceV2 } from "../assets/voice-v2.js";

function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

function setup({ connectError, connectGate, transcript = "مرحبا Nova، راجع Sharp Cuts API رقم 35", transcribeError, sendError, speechError, manualReady = false, transcribeGate, agentGate, speechGate, checkpointTtlMs } = {}) {
  const events = []; const timers = []; const timings = []; let handlers; let barge; let playbackCallbacks; let sends = 0; let speechCalls = 0; let clock = 0;
  const capture = {
    async connect() { events.push("connect"); if (connectGate) await connectGate.promise; if (connectError) throw connectError; },
    listen(next) { handlers = next; events.push("listen-arm"); if (!manualReady) { events.push("listen-ready"); next.onReady(); } },
    watchForBargeIn(callback) { barge = callback; events.push("watch-barge"); },
    stop() { events.push("capture-stop"); }, async destroy() { events.push("destroy"); }
  };
  const client = {
    async transcribe({ signal }) { events.push("transcribe"); assert.equal(signal instanceof AbortSignal, true); if (transcribeGate) await transcribeGate.promise; if (transcribeError) throw transcribeError; clock += 40; return { transcript }; },
    async speech(text, { signal }) { speechCalls += 1; events.push(`speech:${text}`); assert.equal(signal instanceof AbortSignal, true); if (speechGate) await speechGate.promise; if (speechError) throw speechError; clock += 80; return { audio: new Blob(["mp3"], { type: "audio/mpeg" }) }; }
  };
  let playing=false;let paused=false;const playback = { play(_audio, callbacks) { playbackCallbacks = callbacks;playing=true;paused=false; events.push("play"); }, stop() {playing=false;paused=false;events.push("playback-stop"); },pause(){if(!playing)return false;paused=true;events.push("playback-pause");return true;},resume(){if(!playing||!paused)return false;paused=false;events.push("playback-resume");return true;},checkpoint(){return playing?{currentTime:1,paused}:null;} };
  const states = []; const errors = []; const transcripts = [];
  const mode = createVoiceV2({ capture, client, playback,
    async sendTurn(text, { signal, prepareAssistant }) {
      sends += 1; events.push(`send:${text}`); assert.equal(signal instanceof AbortSignal, true); if (agentGate) await agentGate.promise; if (sendError) throw sendError; clock += 120;
      const result = { message: `Nova reply to ${text}`, conversationId: "conversation-1" }; let preparedAssistant; let preparationError;
      try { preparedAssistant = await prepareAssistant(result.message, result); } catch (error) { preparationError = error; }
      events.push("render-assistant"); events.push("refresh-recents-background");
      return { ...result, preparedAssistant, preparationError };
    },
    onTranscript: (text) => transcripts.push(text), onState: ({ state }) => states.push(state), onError: (message) => errors.push(message), onTiming: (value) => timings.push(value),
    now: () => clock, ...(checkpointTtlMs?{checkpointTtlMs}:{}),schedule(callback, delay) { const timer = { callback, delay, cancelled: false }; timers.push(timer); return timer; }, cancelSchedule(timer) { timer.cancelled = true; }
  });
  return {
    mode, events, states, errors, transcripts, timings, timers,
    ready: () => { events.push("listen-ready"); handlers.onReady(); },
    endpoint: (value) => handlers.onEndpoint(value),
    audio: (recording = { audio: new Blob(["audio"], { type: "audio/webm" }), mimeType: "audio/webm", durationSeconds: 1, endedAt: clock }) => { if (Number.isFinite(recording.endedAt)) clock = Math.max(clock, recording.endedAt); return handlers.onAudio(recording); },
    noSpeech: () => handlers.onNoSpeech(), barge: () => barge(),
    started: () => { clock += 5; playbackCallbacks.onStarted(); },
    ended: () => { clock += 500; playbackCallbacks.onEnded(); },
    playbackError: (error) => playbackCallbacks.onError(error),
    runTimer: (index = timers.length - 1) => { const timer = timers[index]; if (!timer.cancelled) timer.callback(); },
    counts: () => ({ sends, speechCalls }),advance:(milliseconds)=>{clock+=milliseconds;}
  };
}

test("Start Voice runs the authoritative Nova turn, starts TTS before rendering, then listens again", async () => {
  const flow = setup(); assert.equal(await flow.mode.start(), true); assert.equal(flow.mode.getState(), "listening");
  assert.equal(await flow.audio(), true); assert.equal(flow.mode.getState(), "speaking");
  assert.ok(flow.events.indexOf("speech:Nova reply to مرحبا Nova، راجع Sharp Cuts API رقم 35") < flow.events.indexOf("render-assistant"));
  assert.ok(flow.events.indexOf("render-assistant") < flow.events.indexOf("refresh-recents-background"));
  assert.equal(flow.counts().sends, 1); assert.equal(flow.counts().speechCalls, 1); assert.ok(flow.events.includes("play"));
  flow.started(); flow.ended(); assert.equal(flow.mode.getState(), "listening"); assert.equal(flow.events.filter((item) => item === "listen-arm").length, 2);
});

test("Listening is not published until MediaRecorder reports capture ready", async () => {
  const flow = setup({ manualReady: true }); await flow.mode.start(); assert.equal(flow.mode.getState(), "getting_ready"); assert.equal(flow.states.includes("listening"), false);
  flow.ready(); assert.equal(flow.mode.getState(), "listening");
});

test("timing diagnostics measure zero-overhead TTS dispatch and immediate handoff", async () => {
  const flow = setup(); await flow.mode.start(); await flow.audio({ audio: new Blob(["audio"], { type: "audio/webm" }), mimeType: "audio/webm", durationSeconds: 2, speechEndedAt: 0, endpointStartedAt: 50, endedAt: 1_350 }); flow.started(); flow.ended();
  const final = flow.timings.at(-1); assert.equal(final.stage, "listening-ready"); assert.deepEqual(final.measurements, { speechEndToEndpoint:1_350,endpointToStt:0,intentionalEndpointWait: 1_350, endpointGrace: 1_300, recordingFinalizeToSttStart: 0, stt: 40, transcriptToAgent: 0, agent: 120, assistantToTtsStart: 0, tts: 80, audioReadyToStart: 5, playback: 500, speechEndToPlayback: 1_595,totalSpeechEndToAudio:1_595, audioEndToListening: 0 });
});

test("endpoint grace remains Listening and resumed speech cancels the pending UI phase", async () => {
  const flow = setup(); await flow.mode.start(); flow.endpoint({ phase: "possible-end", graceMs: 1_350 }); assert.equal(flow.mode.getState(), "listening");
  flow.endpoint({ phase: "resumed", graceMs: 1_350 }); assert.equal(flow.mode.getState(), "listening"); assert.equal(flow.counts().sends, 0);
});

test("barge-in aborts stale TTS/playback and re-arms without duplicating a turn", async () => {
  const gate = deferred(); const flow = setup({ speechGate: gate }); await flow.mode.start(); const processing = flow.audio(); await Promise.resolve(); await Promise.resolve();
  assert.equal(flow.mode.getState(), "speaking"); const sends = flow.counts().sends; flow.barge(); assert.ok(flow.states.includes("interrupted")); assert.equal(flow.mode.getState(), "listening");
  gate.resolve(); await processing; assert.equal(flow.counts().sends, sends); assert.equal(flow.events.includes("play"), false); assert.ok(flow.events.slice(-6).includes("playback-stop"));
});

test("false barge-in followed by silence resumes the same assistant playback",async()=>{const flow=setup();await flow.mode.start();await flow.audio();flow.started();const sends=flow.counts().sends;flow.barge();assert.equal(flow.mode.getState(),"listening");flow.noSpeech();assert.equal(flow.mode.getState(),"speaking");assert.equal(flow.counts().sends,sends);assert.ok(flow.events.includes("playback-pause"));assert.ok(flow.events.includes("playback-resume"));});

test("explicit Arabic continue intent resumes a fresh interrupted checkpoint without a new agent turn",async()=>{const flow=setup({transcript:"كمّل"});await flow.mode.start();await flow.audio();flow.started();flow.barge();const sends=flow.counts().sends;assert.equal(await flow.audio(),true);assert.equal(flow.counts().sends,sends);assert.equal(flow.mode.getState(),"speaking");assert.ok(flow.events.includes("playback-resume"));});

test("stale interruption checkpoints expire instead of resuming unrelated audio",async()=>{const flow=setup({checkpointTtlMs:100});await flow.mode.start();await flow.audio();flow.started();flow.barge();flow.advance(101);flow.noSpeech();assert.equal(flow.mode.getState(),"retrying");assert.equal(flow.events.includes("playback-resume"),false);});

test("End Voice cancels pending transcription and prevents late completion", async () => {
  const gate = deferred(); const flow = setup({ transcribeGate: gate }); await flow.mode.start(); const process = flow.audio(); flow.mode.end(); gate.resolve(); await process;
  assert.equal(flow.mode.isActive(), false); assert.equal(flow.mode.getState(), "idle"); assert.equal(flow.counts().sends, 0); assert.ok(flow.events.includes("destroy"));
});

test("End Voice during connecting or capture arming closes late microphone resources", async () => {
  const connectGate = deferred(); const connecting = setup({ connectGate }); const start = connecting.mode.start(); connecting.mode.end(); connectGate.resolve(); assert.equal(await start, false); assert.equal(connecting.mode.getState(), "idle"); assert.equal(connecting.events.filter((item) => item === "destroy").length, 2);
  const arming = setup({ manualReady: true }); await arming.mode.start(); assert.equal(arming.mode.getState(), "getting_ready"); arming.mode.end(); arming.ready(); assert.equal(arming.mode.getState(), "idle");
});

test("End Voice cancels thinking and TTS states without stale playback", async () => {
  const agentGate = deferred(); const thinking = setup({ agentGate }); await thinking.mode.start(); const thinkingTurn = thinking.audio(); await Promise.resolve(); thinking.mode.end(); agentGate.resolve(); await thinkingTurn; assert.equal(thinking.events.includes("play"), false);
  const speechGate = deferred(); const speaking = setup({ speechGate }); await speaking.mode.start(); const speakingTurn = speaking.audio(); await Promise.resolve(); await Promise.resolve(); speaking.mode.end(); speechGate.resolve(); await speakingTurn; assert.equal(speaking.events.includes("play"), false);
});

test("End Voice during active playback ignores late audio completion", async () => {
  const flow = setup(); await flow.mode.start(); await flow.audio(); flow.started(); const listens = flow.events.filter((item) => item === "listen-arm").length; flow.mode.end(); flow.ended(); assert.equal(flow.mode.getState(), "idle"); assert.equal(flow.events.filter((item) => item === "listen-arm").length, listens);
});

test("duplicate recorder completion cannot create duplicate Nova turns during fast handoff", async () => {
  const flow = setup(); await flow.mode.start(); const first = flow.audio(); const duplicate = flow.audio(); assert.equal(await duplicate, false); await first; assert.equal(flow.counts().sends, 1);
});

test("no speech retries only after readiness and never sends a message", async () => {
  const flow = setup(); await flow.mode.start(); flow.noSpeech(); assert.equal(flow.mode.getState(), "retrying"); assert.equal(flow.timers.at(-1).delay, 900); flow.runTimer(); assert.equal(flow.mode.getState(), "listening"); assert.equal(flow.counts().sends, 0);
});

test("microphone permission failure ends safely in error", async () => {
  const flow = setup({ connectError: new Error("Microphone permission was denied.") }); assert.equal(await flow.mode.start(), false); assert.equal(flow.mode.isActive(), false); assert.equal(flow.mode.getState(), "error"); assert.match(flow.errors[0], /permission/);
});

test("STT failure recovers without sending or speaking", async () => {
  const flow = setup({ transcribeError: new Error("upstream") }); await flow.mode.start(); assert.equal(await flow.audio(), false); assert.ok(flow.states.includes("error")); assert.equal(flow.mode.getState(), "retrying"); assert.equal(flow.counts().sends, 0); assert.equal(flow.counts().speechCalls, 0);
});

test("TTS failure preserves the written Nova turn and never invokes browser speech", async () => {
  const flow = setup({ speechError: new Error("tts failed") }); await flow.mode.start(); assert.equal(await flow.audio(), false); assert.equal(flow.counts().sends, 1); assert.ok(flow.events.includes("render-assistant")); assert.equal(flow.mode.getState(), "retrying"); assert.match(flow.errors.at(-1), /written reply is safe/i); assert.equal(flow.events.includes("play"), false);
  assert.equal(flow.timers.at(-1).delay, 250); flow.runTimer(); assert.equal(flow.mode.getState(), "listening"); assert.equal(flow.counts().sends, 1);
});

test("a later streamed TTS failure clears active state and re-arms Listening without a duplicate turn", async () => {
  const flow = setup(); await flow.mode.start(); assert.equal(await flow.audio(), true); flow.started(); flow.playbackError();
  assert.equal(flow.mode.getState(), "retrying"); assert.equal(flow.counts().sends, 1); assert.ok(flow.events.slice(-6).includes("playback-stop")); assert.ok(flow.events.slice(-6).includes("capture-stop"));
  flow.runTimer(); assert.equal(flow.mode.getState(), "listening"); assert.equal(flow.counts().sends, 1);
});

test("provider quota exhaustion is never mislabeled as browser playback failure",async()=>{const flow=setup();await flow.mode.start();assert.equal(await flow.audio(),true);flow.started();const error=new Error("stream stopped");error.category="quota";flow.playbackError(error);assert.match(flow.errors.at(-1),/ElevenLabs credits are exhausted/i);assert.doesNotMatch(flow.errors.at(-1),/playback failed/i);assert.equal(flow.mode.getState(),"retrying");});

test("Arabic-English mixed transcripts pass unchanged into the existing Nova pipeline", async () => {
  const mixed = "محمد، check Nova Brain API وSharp Cuts booking رقم 079 123 4567"; const flow = setup({ transcript: mixed }); await flow.mode.start(); await flow.audio(); assert.deepEqual(flow.transcripts, [mixed]); assert.ok(flow.events.includes(`send:${mixed}`));
});
