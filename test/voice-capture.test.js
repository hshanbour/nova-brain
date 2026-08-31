import test from "node:test";
import assert from "node:assert/strict";
import { createMediaVoiceCapture } from "../assets/voice-capture.js";

function setup() {
  const timers = []; let clock = 0; let level = 0; let constraints; let activeRecorder; const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  const stream = { getTracks: () => tracks };
  class Recorder {
    static isTypeSupported(type) { return type.startsWith("audio/webm"); }
    constructor(_stream, options) { this.mimeType = options.mimeType; this.state = "inactive"; this.listeners = new Map(); activeRecorder = this; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    start(timeslice) { this.timeslice = timeslice; this.state = "recording"; }
    emit(value) { this.listeners.get("dataavailable")?.({ data: new Blob([value], { type: this.mimeType }) }); }
    stop() { if (this.state !== "recording") return; this.state = "inactive"; this.listeners.get("dataavailable")?.({ data: new Blob(["recorded"], { type: this.mimeType }) }); this.listeners.get("stop")?.(); }
  }
  const analyser = { fftSize: 16, smoothingTimeConstant: 0, getByteTimeDomainData(data) { data.fill(Math.max(0, Math.min(255, Math.round(128 + level * 128)))); } };
  class Context { constructor() { this.state = "running"; } createAnalyser() { return analyser; } createMediaStreamSource() { return { connect() {}, disconnect() {} }; } async close() { this.state = "closed"; } }
  const capture = createMediaVoiceCapture({ mediaDevices: { async getUserMedia(value) { constraints = value; return stream; } }, MediaRecorder: Recorder, AudioContext: Context,
    now: () => clock, schedule(callback, delay) { const timer = { callback, delay, cancelled: false }; timers.push(timer); return timer; }, cancelSchedule(timer) { timer.cancelled = true; }
  });
  const run = () => { const timer = timers.find((item) => !item.cancelled && !item.ran); if (!timer) throw new Error("No scheduled VAD sample."); timer.ran = true; clock += timer.delay; timer.callback(); };
  return { capture, setLevel(value) { level = value; }, run, tracks, recorder: () => activeRecorder, constraints: () => constraints };
}

test("MediaRecorder VAD ends a spoken turn after bounded silence", async () => {
  const flow = setup(); await flow.capture.connect(); let recording;
  flow.capture.listen({ onAudio: (value) => { recording = value; } }); flow.setLevel(0.1); flow.run(); flow.run(); flow.setLevel(0); for (let index = 0; index < 15; index += 1) flow.run();
  assert.ok(recording.audio instanceof Blob); assert.match(recording.mimeType, /^audio\/webm/); assert.ok(recording.durationSeconds >= 0.7 && recording.durationSeconds <= 1);
  assert.deepEqual(flow.constraints(), { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
});

test("MediaRecorder VAD reports bounded no-speech without producing an audio turn", async () => {
  const flow = setup(); await flow.capture.connect(); let noSpeech = 0; let audio = 0;
  flow.capture.listen({ onAudio: () => { audio += 1; }, onNoSpeech: () => { noSpeech += 1; } }); for (let index = 0; index < 160; index += 1) flow.run();
  assert.equal(noSpeech, 1); assert.equal(audio, 0);
});

test("playback monitor detects sustained owner speech for barge-in", async () => {
  const flow = setup(); await flow.capture.connect(); let barges = 0; flow.capture.watchForBargeIn(() => { barges += 1; }); flow.setLevel(0.1); flow.run(); flow.run(); assert.equal(barges, 1);
  await flow.capture.destroy(); assert.equal(flow.tracks[0].stopped, true);
});

test("100 ms capture retains the complete WebM stream and initialization header", async () => {
  const flow = setup(); await flow.capture.connect(); const events = []; let recording;
  flow.capture.listen({ onReady: () => events.push("ready"), onAudio: (value) => { recording = value; events.push("audio"); } });
  assert.deepEqual(events, ["ready"]); assert.equal(flow.recorder().timeslice, 100);
  const webmHeader = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
  flow.recorder().emit(webmHeader);
  for (const value of ["chunk-2", "chunk-3", "chunk-4", "chunk-5"]) flow.recorder().emit(value);
  flow.setLevel(0.1); flow.run(); flow.run(); flow.recorder().emit("spoken"); flow.setLevel(0); for (let index = 0; index < 15; index += 1) flow.run();
  assert.deepEqual(events, ["ready", "audio"]);
  const bytes = new Uint8Array(await recording.audio.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 4)], [...webmHeader]);
  assert.match(new TextDecoder().decode(bytes.subarray(4)), /^chunk-2chunk-3chunk-4chunk-5spokenrecorded$/);
  assert.equal("preRollMs" in recording, false);
});
