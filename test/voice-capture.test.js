import test from "node:test";
import assert from "node:assert/strict";
import { createMediaVoiceCapture } from "../assets/voice-capture.js";

function setup(options = {}) {
  const timers = []; let clock = 0; let level = 0; let constraints; let activeRecorder; const recorders=[]; const tracks = [{ kind:"audio",stopped: false,getSettings(){return {echoCancellation:true,noiseSuppression:true,autoGainControl:true,sampleRate:48000,channelCount:1};}, stop() { this.stopped = true; } }];
  const stream = { getTracks: () => tracks,getAudioTracks:()=>tracks };
  class Recorder {
    static isTypeSupported(type) { return type.startsWith("audio/webm"); }
    constructor(_stream, options) { this.mimeType = options.mimeType; this.state = "inactive"; this.listeners = new Map(); activeRecorder = this; recorders.push(this); }
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
  const runFor = (milliseconds) => { for (let elapsed = 0; elapsed < milliseconds; elapsed += 50) { if(!timers.some((item)=>!item.cancelled&&!item.ran))break;run(); } };
  const speakFor = (milliseconds) => { level = 0.1; runFor(milliseconds); };
  const pauseFor = (milliseconds) => { level = 0; runFor(milliseconds); };
  return { capture, setLevel(value) { level = value; }, run, runFor, speakFor, pauseFor, now: () => clock, tracks, recorder: () => activeRecorder, recorders, constraints: () => constraints };
}

test("MediaRecorder VAD finalizes substantial speech after a patient bounded endpoint", async () => {
  const flow = setup(); const settings=await flow.capture.connect(); let recording;
  flow.capture.listen({ onAudio: (value) => { recording = value; } }); flow.speakFor(1_500); flow.pauseFor(1_950);
  assert.ok(recording.audio instanceof Blob); assert.match(recording.mimeType, /^audio\/webm/); assert.ok(recording.durationSeconds >= 3.0 && recording.durationSeconds <= 3.55);
  assert.ok(recording.endpointGraceMs >= 1_450 && recording.endpointGraceMs <= 1_550);
  assert.deepEqual(flow.constraints(), { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  assert.deepEqual(settings,{echoCancellation:true,noiseSuppression:true,autoGainControl:true,sampleRate:48000,channelCount:1,trackLive:true,trackEnabled:true});
});

test("capture readiness is emitted only after the recorder and acoustic sampler are armed",async()=>{const flow=setup();await flow.capture.connect();let ready;let recording;flow.capture.listen({onReady:value=>{ready=value;assert.equal(flow.recorder().state,"recording");},onAudio:value=>{recording=value;}});assert.deepEqual({recorderReady:ready.recorderReady,acousticDetectorReady:ready.acousticDetectorReady},{recorderReady:true,acousticDetectorReady:true});flow.speakFor(500);flow.pauseFor(2_000);assert.ok(recording?.audio instanceof Blob);});

test("MediaRecorder VAD reports bounded no-speech without producing an audio turn", async () => {
  const flow = setup(); await flow.capture.connect(); let noSpeech = 0; let audio = 0;
  flow.capture.listen({ onAudio: () => { audio += 1; }, onNoSpeech: () => { noSpeech += 1; } }); for (let index = 0; index < 160; index += 1) flow.run();
  assert.equal(noSpeech, 1); assert.equal(audio, 0);
});

test("interruption capture skips redundant calibration and bounds short owner commands", async () => {
  const flow = setup(); await flow.capture.connect(); let recording;
  flow.capture.listen({ interruptionProbe:true, onAudio:(value)=>{recording=value;} });
  flow.setLevel(.04); flow.run(); flow.run(); flow.setLevel(0); flow.pauseFor(900);
  assert.ok(recording?.audio instanceof Blob);
  assert.ok(recording.durationSeconds >= .8 && recording.durationSeconds <= 1.05);
  assert.ok(recording.endpointGraceMs >= 800 && recording.endpointGraceMs <= 850);
});

test("interruption capture cannot absorb playback contamination for an unbounded window", async () => {
  const flow = setup(); await flow.capture.connect(); let recording;
  flow.capture.listen({ interruptionProbe:true, onAudio:(value)=>{recording=value;} });
  flow.speakFor(5_000);
  assert.ok(recording?.audio instanceof Blob);
  assert.ok(recording.durationSeconds >= 3.95 && recording.durationSeconds <= 4.05);
});

test("playback monitor requires modest sustained credible speech for barge-in", async () => {
  const flow = setup(); await flow.capture.connect(); const barges=[]; flow.capture.watchForBargeIn((value) => { barges.push(value); }); flow.setLevel(0.1); for(let index=0;index<5;index+=1)flow.run();assert.equal(barges.length,0);flow.run();assert.equal(barges.length,1);assert.ok(barges[0].detectedAt-barges[0].speechOnsetAt>=100&&barges[0].detectedAt-barges[0].speechOnsetAt<=300);assert.equal(barges[0].echoCancellation,true);
  await flow.capture.destroy(); assert.equal(flow.tracks[0].stopped, true);
});

test("a one-frame click resets while a sustained short utterance reaches semantic barge confirmation",async()=>{const flow=setup();await flow.capture.connect();let barges=0;flow.capture.watchForBargeIn(()=>{barges+=1;});flow.setLevel(.01);flow.run();flow.run();flow.setLevel(.1);flow.run();flow.setLevel(0);for(let index=0;index<3;index+=1)flow.run();assert.equal(barges,0);flow.setLevel(.1);for(let index=0;index<4;index+=1){if(barges)break;flow.run();}assert.equal(barges,1);});

test("barge capture preserves the first credible frame in one continuous WebM recorder",async()=>{const flow=setup();await flow.capture.connect();let candidate;let recording;flow.capture.watchForBargeIn(value=>{candidate=value;});flow.setLevel(.01);flow.run();flow.run();flow.setLevel(.1);flow.run();const onsetRecorder=flow.recorder();onsetRecorder.emit("onset");for(let index=0;index<3&&!candidate;index+=1)flow.run();assert.equal(candidate.capturePrimed,true);flow.capture.listen({interruptionProbe:true,reuseCandidateCapture:true,onAudio:value=>{recording=value;}});assert.equal(flow.recorder(),onsetRecorder);assert.equal(flow.recorders.length,1);flow.setLevel(0);flow.pauseFor(900);assert.match(await recording.audio.text(),/onsetrecorded/);});

test("a rejected one-frame candidate discards its provisional recorder",async()=>{const flow=setup();await flow.capture.connect();flow.capture.watchForBargeIn(()=>{});flow.setLevel(.01);flow.run();flow.run();flow.setLevel(.1);flow.run();const provisional=flow.recorder();assert.equal(provisional.state,"recording");flow.setLevel(0);flow.run();assert.equal(provisional.state,"inactive");});

test("quiet clear and louder speech each barge in once while steady background and playback leakage do not",async()=>{for(const speechLevel of [.035,.12]){const flow=setup();await flow.capture.connect();let barges=0;flow.capture.watchForBargeIn(()=>{barges+=1;});flow.setLevel(.015);flow.runFor(1_000);assert.equal(barges,0);flow.setLevel(speechLevel);for(let index=0;index<5&&barges===0;index+=1)flow.run();assert.equal(barges,1);}for(const level of [.03,.045]){const background=setup();await background.capture.connect();let barges=0;background.capture.watchForBargeIn(()=>{barges+=1;});background.setLevel(level);background.runFor(2_000);assert.equal(barges,0);}});

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
