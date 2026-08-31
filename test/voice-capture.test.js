import test from "node:test";
import assert from "node:assert/strict";
import { createMediaVoiceCapture } from "../assets/voice-capture.js";

function setup(options = {}) {
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
    ...options, now: () => clock, schedule(callback, delay) { const timer = { callback, delay, cancelled: false }; timers.push(timer); return timer; }, cancelSchedule(timer) { timer.cancelled = true; }
  });
  const run = () => { const timer = timers.find((item) => !item.cancelled && !item.ran); if (!timer) throw new Error("No scheduled VAD sample."); timer.ran = true; clock += timer.delay; timer.callback(); };
  const runFor = (milliseconds) => { for (let elapsed = 0; elapsed < milliseconds; elapsed += 50) run(); };
  const speakFor = (milliseconds) => { level = 0.1; runFor(milliseconds); };
  const pauseFor = (milliseconds) => { level = 0; runFor(milliseconds); };
  return { capture, setLevel(value) { level = value; }, run, runFor, speakFor, pauseFor, now: () => clock, tracks, recorder: () => activeRecorder, constraints: () => constraints };
}

test("MediaRecorder VAD finalizes substantial speech after a patient bounded endpoint", async () => {
  const flow = setup(); await flow.capture.connect(); let recording;
  flow.capture.listen({ onAudio: (value) => { recording = value; } }); flow.speakFor(1_500); flow.pauseFor(1_850);
  assert.ok(recording.audio instanceof Blob); assert.match(recording.mimeType, /^audio\/webm/); assert.ok(recording.durationSeconds >= 3.25 && recording.durationSeconds <= 3.5);
  assert.ok(recording.endpointGraceMs >= 1_700 && recording.endpointGraceMs <= 1_900);
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
  flow.speakFor(1_500); flow.recorder().emit("spoken"); flow.pauseFor(1_850);
  assert.deepEqual(events, ["ready", "audio"]);
  const bytes = new Uint8Array(await recording.audio.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 4)], [...webmHeader]);
  assert.match(new TextDecoder().decode(bytes.subarray(4)), /^chunk-2chunk-3chunk-4chunk-5spokenrecorded$/);
  assert.equal("preRollMs" in recording, false);
});

for (const hesitationMs of [500, 700, 1_000, 1_300]) {
  test(`${hesitationMs} ms natural hesitation resumes the same recording and turn`, async () => {
    const flow = setup(); await flow.capture.connect(); const endpointEvents = []; const recordings = [];
    flow.capture.listen({ onAudio: (value) => recordings.push(value), onEndpoint: (value) => endpointEvents.push(value) });
    flow.recorder().emit(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])); flow.speakFor(1_500); flow.recorder().emit("before-pause");
    flow.pauseFor(hesitationMs); assert.equal(recordings.length, 0);
    flow.speakFor(300); flow.recorder().emit("after-pause"); flow.pauseFor(2_000);
    assert.equal(recordings.length, 1); assert.match(await recordings[0].audio.text(), /before-pauseafter-pause/);
    assert.ok(endpointEvents.some(({ phase }) => phase === "possible-end")); assert.ok(endpointEvents.some(({ phase }) => phase === "resumed"));
  });
}

test("1,500 ms pause after a short fragment remains the same turn",async()=>{const flow=setup();await flow.capture.connect();const recordings=[];flow.capture.listen({onAudio:(value)=>recordings.push(value)});flow.recorder().emit(new Uint8Array([0x1a,0x45,0xdf,0xa3]));flow.speakFor(500);flow.recorder().emit("before");flow.pauseFor(1_500);assert.equal(recordings.length,0);flow.speakFor(300);flow.recorder().emit("after");flow.pauseFor(2_000);assert.equal(recordings.length,1);assert.match(await recordings[0].audio.text(),/beforeafter/);});

test("several pauses in one long Arabic utterance remain one complete turn", async () => {
  const flow = setup(); await flow.capture.connect(); const recordings = [];
  flow.capture.listen({ onAudio: (value) => recordings.push(value) }); flow.recorder().emit(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]));
  for (const [speech, pause] of [["أنا أريد", 700], ["أن نراجع المشروع", 900], ["ونكمل الخطة", 1_000]]) { flow.speakFor(1_000); flow.recorder().emit(speech); flow.pauseFor(pause); assert.equal(recordings.length, 0); }
  flow.speakFor(500); flow.recorder().emit("اليوم"); flow.pauseFor(2_100);
  assert.equal(recordings.length, 1); const text = await recordings[0].audio.text(); for (const part of ["أنا أريد", "أن نراجع المشروع", "ونكمل الخطة", "اليوم"]) assert.match(text, new RegExp(part));
});

test("Arabic-English code-switching with pauses stays one turn without duplicate completion", async () => {
  const flow = setup(); await flow.capture.connect(); const recordings = [];
  flow.capture.listen({ onAudio: (value) => recordings.push(value) }); flow.recorder().emit(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]));
  for (const part of ["راجع Sharp Cuts", "وبعدين Nova Brain API", "رقم 35"]) { flow.speakFor(900); flow.recorder().emit(part); flow.pauseFor(700); assert.equal(recordings.length, 0); }
  flow.speakFor(300); flow.pauseFor(2_100); assert.equal(recordings.length, 1);
  const text = await recordings[0].audio.text(); assert.match(text, /Sharp Cuts.*Nova Brain API.*35/s);
});

test("End Voice during endpoint grace discards the pending turn", async () => {
  const flow = setup(); await flow.capture.connect(); let audio = 0; let endpoint = 0;
  flow.capture.listen({ onAudio: () => { audio += 1; }, onEndpoint: ({ phase }) => { if (phase === "possible-end") endpoint += 1; } });
  flow.speakFor(1_500); flow.pauseFor(500); assert.equal(endpoint, 1); flow.capture.stop(); assert.equal(audio, 0);
});

