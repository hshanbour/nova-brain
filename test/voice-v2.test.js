import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceV2 } from "../assets/voice-v2.js";

function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

function setup({ connectError, connectGate, transcript = "مرحبا Nova، راجع Sharp Cuts API رقم 35", speaker = { match_status:"confirmed",speaker_profile_id:"owner-profile",speaker_label:"owner",authenticated_identity:"owner" }, relevance, assistantMessage, transcribeError, sendError, speechError, manualReady = false, transcribeGate, agentGate, speechGate, checkpointTtlMs } = {}) {
  const events = []; const timers = []; const timings = []; let handlers; let barge; let playbackCallbacks; let interruptionCallbacks; let sends = 0; let speechCalls = 0; let clock = 0; let transcriptIndex=0;
  const capture = {
    async connect() { events.push("connect"); if (connectGate) await connectGate.promise; if (connectError) throw connectError; },
    listen(next) { handlers = next; events.push("listen-arm"); if (!manualReady) { events.push("listen-ready"); next.onReady(); } },
    watchForBargeIn(callback) { barge = callback; events.push("watch-barge"); },
    stop() { events.push("capture-stop"); }, async destroy() { events.push("destroy"); }
  };
  const client = {
    async transcribe({ signal,relevanceContext }) { events.push("transcribe");events.push(`relevance-context:${JSON.stringify(relevanceContext)}`);assert.equal(signal instanceof AbortSignal, true); if (transcribeGate) await transcribeGate.promise; if (transcribeError) throw transcribeError; clock += 40; const index=transcriptIndex++;return { transcript:Array.isArray(transcript)?transcript[Math.min(index,transcript.length-1)]:transcript,speaker:Array.isArray(speaker)?speaker[Math.min(index,speaker.length-1)]:speaker,...(relevance?{relevance:Array.isArray(relevance)?relevance[Math.min(index,relevance.length-1)]:relevance}:{}) }; },
    async speech(text, { signal }) { speechCalls += 1; events.push(`speech:${text}`); assert.equal(signal instanceof AbortSignal, true); if (speechGate) await speechGate.promise; if (speechError) throw speechError; clock += 80; return { audio: new Blob(["mp3"], { type: "audio/mpeg" }) }; }
  };
  let playing=false;let paused=false;const playback = { play(_audio, callbacks) { playbackCallbacks = callbacks;playing=true;paused=false; events.push("play"); }, stop() {playing=false;paused=false;events.push("playback-stop"); },pause(){if(!playing)return false;paused=true;events.push("playback-pause");return true;},resume(){if(!playing||!paused)return false;paused=false;events.push("playback-resume");return true;},checkpoint(){return playing?{currentTime:1,paused}:null;} };
  const interruptionPlayback={play(_audio,callbacks){interruptionCallbacks=callbacks;events.push("interruption-play");},stop(){events.push("interruption-stop");}};
  const states = []; const errors = []; const transcripts = [];
  const mode = createVoiceV2({ capture, client, playback, interruptionPlayback,
    async sendTurn(text, { signal, prepareAssistant }) {
      sends += 1; events.push(`send:${text}`); assert.equal(signal instanceof AbortSignal, true); if (agentGate) await agentGate.promise; if (sendError) throw sendError; clock += 120;
      const result = { message: assistantMessage||`Nova reply to ${text}`, conversationId: "conversation-1" }; let preparedAssistant; let preparationError;
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
    noSpeech: () => handlers.onNoSpeech(), barge: (detail) => barge(detail),
    started: () => { clock += 5; playbackCallbacks.onStarted(); },
    chunkStarted: (index) => playbackCallbacks.onChunkStarted?.({index}),
    ended: () => { clock += 500; playbackCallbacks.onEnded(); },
    interruptionStarted:()=>interruptionCallbacks.onStarted?.(),
    interruptionEnded:()=>interruptionCallbacks.onEnded?.(),
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
  assert.equal(flow.mode.getState(), "speaking"); const sends = flow.counts().sends; flow.mode.interrupt(); assert.ok(flow.states.includes("interrupted")); assert.equal(flow.mode.getState(), "listening");
  gate.resolve(); await processing; assert.equal(flow.counts().sends, sends); assert.equal(flow.events.includes("play"), false); assert.ok(flow.events.slice(-6).includes("playback-stop"));
});

test("background speech is discarded before transcript publication or agent turn creation",async()=>{const flow=setup({transcript:"Pass me the clipper.",relevance:{category:"likely_background_speech",accepted_as_turn:false,reason:"owner_speech_not_addressed_to_nova",confidence:.8}});await flow.mode.start();assert.equal(await flow.audio(),false);assert.equal(flow.counts().sends,0);assert.deepEqual(flow.transcripts,[]);assert.equal(flow.mode.getState(),"listening");});

test("background speech during Nova playback resumes the exact paused audio without an agent turn",async()=>{const flow=setup({transcript:["Nova, give a long answer","Are you waiting?"],relevance:[{category:"addressed_to_nova",accepted_as_turn:true,confidence:.99},{category:"likely_background_speech",accepted_as_turn:false,confidence:.8}]});await flow.mode.start();await flow.audio();flow.started();flow.barge();const sends=flow.counts().sends;assert.equal(await flow.audio(),false);assert.equal(flow.counts().sends,sends);assert.ok(flow.events.includes("playback-resume"));assert.equal(flow.mode.getState(),"speaking");});

test("contextual reply signal opens only after Nova finishes a direct question",async()=>{const flow=setup({transcript:["Nova hello","Ahmed"],assistantMessage:"What is your name?"});await flow.mode.start();await flow.audio();flow.started();assert.match(flow.events.find((item)=>item.startsWith("relevance-context:")),/awaiting_nova_reply\":false/);flow.ended();await flow.audio();assert.match(flow.events.filter((item)=>item.startsWith("relevance-context:")).at(-1),/awaiting_nova_reply\":true/);});

test("acoustic barge monitoring calibrates only after actual playback starts",async()=>{const flow=setup();await flow.mode.start();await flow.audio();assert.equal(flow.events.includes("watch-barge"),false);flow.started();assert.equal(flow.events.filter((item)=>item==="watch-barge").length,1);flow.barge();assert.equal(flow.mode.getState(),"listening");});

test("barge telemetry preserves precise RMS values and onset-to-stop timing",async()=>{const flow=setup();await flow.mode.start();await flow.audio();flow.started();flow.barge({speechOnsetAt:100,detectedAt:350,voicedMs:200,baselineRms:.01234,thresholdRms:.02789});const interrupted=flow.timings.at(-1);assert.equal(interrupted.stage,"interrupted");assert.equal(interrupted.measurements.bargeDetection,250);assert.equal(interrupted.measurements.bargeSpeechToPlaybackStop,145);assert.equal(interrupted.measurements.bargeBaselineRms,.01234);assert.equal(interrupted.measurements.bargeThresholdRms,.02789);});

test("false barge-in followed by silence resumes the same assistant playback",async()=>{const flow=setup();await flow.mode.start();await flow.audio();flow.started();const sends=flow.counts().sends;flow.barge();assert.equal(flow.mode.getState(),"listening");flow.noSpeech();assert.equal(flow.mode.getState(),"speaking");assert.equal(flow.counts().sends,sends);assert.ok(flow.events.includes("playback-pause"));assert.ok(flow.events.includes("playback-resume"));});

test("Arabic and English continue intents resume a fresh interrupted checkpoint before normal agent routing",async()=>{for(const intent of ["كمل","كمّل","كملي","continue","يلا ارجع كمليلي وين كنتي تحكي كملي من عند ما تركتي، كملي حكي"]){const flow=setup({transcript:["original owner question",intent],speaker:[{match_status:"confirmed",speaker_profile_id:"owner-profile",speaker_label:"owner"},{match_status:"confirmed",speaker_profile_id:"owner-profile",speaker_label:"owner"}]});await flow.mode.start();await flow.audio();flow.started();flow.barge();const sends=flow.counts().sends;assert.equal(await flow.audio(),true,intent);assert.equal(flow.counts().sends,sends,intent);assert.equal(flow.mode.getState(),"speaking",intent);assert.ok(flow.events.includes("playback-resume"),intent);}});

test("verified acknowledgement preserves the same-session checkpoint and كملي resumes the paused chunk",async()=>{const owner={match_status:"confirmed",speaker_profile_id:"owner-profile",speaker_label:"owner"};const flow=setup({transcript:["long question","لحظة نوفا، لحظة","كملي"],speaker:[owner,owner,{match_status:"insufficient_speech",speaker_profile_id:null,speaker_label:"unknown"}]});await flow.mode.start();await flow.audio();flow.started();flow.chunkStarted(2);flow.barge();const original=flow.mode.getInterruptedCheckpoint();assert.equal(original.chunkIndex,2);assert.equal(await flow.audio(),true);assert.ok(flow.events.includes("interruption-play"));assert.equal(flow.mode.getInterruptedCheckpoint().assistantTurnId,original.assistantTurnId);flow.interruptionStarted();flow.interruptionEnded();assert.equal(await flow.audio(),true);assert.equal(flow.counts().sends,2);assert.equal(flow.counts().speechCalls,2);assert.ok(flow.events.includes("playback-resume"));assert.equal(flow.mode.getInterruptedCheckpoint().chunkIndex,2);});

test("confirmed pause intent stays authoritatively paused through repeated silence until explicit resume",async()=>{const owner={match_status:"confirmed",speaker_profile_id:"owner-profile",speaker_label:"owner"};const flow=setup({transcript:["long question","استني شوي","كملي"],speaker:[owner,owner,owner]});await flow.mode.start();await flow.audio();flow.started();flow.chunkStarted(2);flow.barge();assert.equal(await flow.audio(),true);flow.interruptionStarted();flow.interruptionEnded();assert.equal(flow.mode.getState(),"paused_waiting_for_user");const resumes=flow.events.filter((item)=>item==="playback-resume").length;flow.noSpeech();assert.equal(flow.mode.getState(),"paused_waiting_for_user");assert.equal(flow.events.filter((item)=>item==="playback-resume").length,resumes);assert.equal(await flow.audio(),true);assert.equal(flow.events.filter((item)=>item==="playback-resume").length,resumes+1);});

test("an insufficient-speech pause acknowledgement preserves exact owner playback for a later verified resume",async()=>{const owner={match_status:"confirmed",speaker_profile_id:"owner-profile",speaker_label:"owner"};const insufficient={match_status:"insufficient_speech",speaker_profile_id:null,speaker_label:"unknown"};const flow=setup({transcript:["long answer request","شوي","كملي هس يلا"],speaker:[owner,insufficient,owner]});await flow.mode.start();await flow.audio();flow.started();flow.chunkStarted(2);flow.barge();const original=flow.mode.getInterruptedCheckpoint();assert.match(original.originalText,/long answer request/);assert.equal(await flow.audio(),true);assert.equal(flow.mode.getInterruptedCheckpoint().assistantTurnId,original.assistantTurnId);flow.interruptionStarted();flow.interruptionEnded();const sends=flow.counts().sends;assert.equal(await flow.audio(),true);assert.equal(flow.counts().sends,sends);assert.ok(flow.events.includes("playback-resume"));assert.equal(flow.events.filter((item)=>item==="play").length,1);});

test("an unverified resume retry never destroys the paused iterator before a verified repeated resume",async()=>{const owner={match_status:"confirmed",speaker_profile_id:"owner-profile",speaker_label:"owner"};const unknown={match_status:"unknown",speaker_profile_id:null,speaker_label:"unknown"};const flow=setup({transcript:["long answer request","كمل كمل","كمل كمل"],speaker:[owner,unknown,owner]});await flow.mode.start();await flow.audio();flow.started();flow.chunkStarted(1);flow.barge();assert.equal(await flow.audio(),false);assert.equal(flow.mode.getState(),"retrying");const stops=flow.events.filter((item)=>item==="playback-stop").length;flow.runTimer();assert.equal(flow.events.filter((item)=>item==="playback-stop").length,stops);assert.equal(await flow.audio(),true);assert.ok(flow.events.includes("playback-resume"));assert.equal(flow.counts().sends,1);});

test("the same response supports repeated interrupt acknowledgement and resume cycles without restarting or duplication",async()=>{const owner={match_status:"confirmed",speaker_profile_id:"owner-profile",speaker_label:"owner"};const flow=setup({transcript:["long answer request","لحظة","كملي","دقيقة","continue"],speaker:[owner,owner,owner,owner,owner]});await flow.mode.start();await flow.audio();flow.started();flow.chunkStarted(3);flow.barge();const target=flow.mode.getInterruptedCheckpoint();assert.equal(await flow.audio(),true);flow.interruptionStarted();flow.interruptionEnded();assert.equal(await flow.audio(),true);assert.equal(flow.mode.getInterruptedCheckpoint().chunkIndex,3);flow.barge();assert.equal(await flow.audio(),true);flow.interruptionStarted();flow.interruptionEnded();assert.equal(await flow.audio(),true);assert.equal(flow.mode.getInterruptedCheckpoint().assistantTurnId,target.assistantTurnId);assert.equal(flow.mode.getInterruptedCheckpoint().chunkIndex,3);assert.equal(flow.counts().sends,3);assert.equal(flow.counts().speechCalls,3);assert.equal(flow.events.filter((item)=>item==="playback-resume").length,2);assert.equal(flow.events.filter((item)=>item==="play").length,1);});

test("natural Arabic and English continuation variants use an available checkpoint instead of asking for context",async()=>{for(const intent of ["رجعي كملي","كملي من وين وقفتي","كملي من عند ما تركتي","شو كنتي تحكي؟","ارجعي لنفس النقطة","resume from where you stopped"]){const flow=setup({transcript:["long answer request",intent]});await flow.mode.start();await flow.audio();flow.started();flow.barge();const sends=flow.counts().sends;assert.equal(await flow.audio(),true,intent);assert.equal(flow.counts().sends,sends,intent);assert.ok(flow.events.includes("playback-resume"),intent);}});

test("Arabic and English pause phrases all use speech-onset barge-in and become one semantic turn",async()=>{for(const phrase of ["استني","لحظة","دقيقة","وقف","وقفة","خلاص","wait","hold on","stop","one second","pause"]){const flow=setup({transcript:["long answer request",phrase]});await flow.mode.start();await flow.audio();flow.started();flow.barge();assert.ok(flow.events.includes("playback-pause"),phrase);assert.equal(await flow.audio(),true,phrase);assert.equal(flow.counts().sends,2,phrase);assert.equal(flow.transcripts.at(-1),phrase);}});

test("a different confirmed speaker cannot resume an owner's interrupted answer",async()=>{const flow=setup({transcript:["owner question","continue"],speaker:[{match_status:"confirmed",speaker_profile_id:"owner-profile",speaker_label:"owner"},{match_status:"confirmed",speaker_profile_id:"other-profile",speaker_label:"known"}]});await flow.mode.start();await flow.audio();flow.started();flow.barge();assert.equal(await flow.audio(),false);assert.equal(flow.events.includes("playback-resume"),false);assert.equal(flow.mode.getState(),"retrying");});

test("End Voice intentionally destroys the interruption checkpoint",async()=>{const flow=setup();await flow.mode.start();await flow.audio();flow.started();flow.barge();assert.ok(flow.mode.getInterruptedCheckpoint());flow.mode.end();assert.equal(flow.mode.getInterruptedCheckpoint(),null);assert.ok(flow.events.includes("interruption-stop"));});

test("a genuinely completed response intentionally clears continuation state",async()=>{const flow=setup();await flow.mode.start();await flow.audio();flow.started();assert.ok(flow.mode.getInterruptedCheckpoint());flow.ended();assert.equal(flow.mode.getInterruptedCheckpoint(),null);});

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

test("ten sequential Voice turns keep exactly one capture and playback lifecycle per turn",async()=>{const flow=setup({transcript:Array.from({length:10},(_,index)=>`turn ${index+1}`)});await flow.mode.start();for(let index=0;index<10;index+=1){assert.equal(await flow.audio(),true);flow.started();flow.ended();}assert.equal(flow.counts().sends,10);assert.equal(flow.counts().speechCalls,10);assert.equal(flow.events.filter((item)=>item==="play").length,10);assert.equal(flow.events.filter((item)=>item==="watch-barge").length,10);assert.equal(flow.events.filter((item)=>item==="listen-arm").length,11);});
