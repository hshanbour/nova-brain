import test from "node:test";
import assert from "node:assert/strict";
import { createRealtimeVoiceService } from "../src/voice/realtime-voice-service.js";
import { createRealtimeVoice } from "../assets/realtime-voice.js";

test("realtime service mints a short-lived, delegated, bilingual WebRTC session", async () => {
  let request;
  const service = createRealtimeVoiceService({
    apiKey: "server-key",
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ value: "ek_test", expires_at: 123 }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const result = await service.createClientSecret({ safetyIdentifier: "owner-hash" });
  assert.equal(result.clientSecret, "ek_test");
  assert.equal(request.url, "https://api.openai.com/v1/realtime/client_secrets");
  assert.equal(request.options.headers.Authorization, "Bearer server-key");
  assert.equal(request.options.headers["OpenAI-Safety-Identifier"], "owner-hash");
  assert.equal(request.body.expires_after.seconds, 60);
  assert.equal(request.body.session.model, "gpt-realtime-2.1");
  assert.equal(request.body.session.audio.input.turn_detection.interrupt_response, true);
  assert.equal(request.body.session.tools[0].name, "nova_turn");
  assert.equal(request.body.session.tool_choice, "auto");
  assert.match(request.body.session.instructions, /Arabic-English/);
  assert.match(request.body.session.instructions, /Call nova_turn exactly once/);
  assert.match(request.body.session.instructions, /questions about who Nova is/);
  assert.match(request.body.session.instructions, /Do not volunteer an identity-verification disclaimer/);
});

test("realtime browser always requests audio and recovers a stale selected microphone once", async () => {
  const channel = new FakeChannel(), peer = new FakePeer(channel), constraints = [], fallbacks = [];
  const stream = { getTracks: () => [{ stop() {} }] };
  const voice = createRealtimeVoice({
    mediaDevices: { async getUserMedia(value) { constraints.push(value); if (constraints.length === 1) throw Object.assign(new Error("missing device"), { name: "OverconstrainedError" }); return stream; } },
    RTCPeerConnectionImpl: class { constructor() { return peer; } },
    MediaRecorderImpl: null,
    AudioImpl: class { play() { return Promise.resolve(); } pause() {} },
    getAudioConstraints: () => ({ deviceId: { exact: "stale-owner-mic" }, echoCancellation: true }),
    onMicrophoneFallback: (value) => fallbacks.push(value),
    fetchImpl: async (url) => url === "/api/voice/realtime/session" ? new Response(JSON.stringify({ clientSecret: "ek_test" }), { status: 201, headers: { "Content-Type": "application/json" } }) : new Response("answer-sdp", { status: 200 }),
  });
  assert.equal(await voice.start(), true);
  assert.deepEqual(constraints[0], { audio: { deviceId: { exact: "stale-owner-mic" }, echoCancellation: true }, video: false });
  assert.deepEqual(constraints[1], { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  assert.deepEqual(fallbacks, [{ reason: "selected_device_unavailable" }]);
  voice.end();
});

test("realtime microphone denial is surfaced before minting a paid session and is not reclassified as provider failure", async () => {
  let fetches=0;
  const voice=createRealtimeVoice({
    mediaDevices:{async getUserMedia(){throw Object.assign(new Error("Permission denied"),{name:"NotAllowedError"});}},
    RTCPeerConnectionImpl:class{},
    fetchImpl:async()=>{fetches+=1;throw new Error("must not fetch");},
  });
  await assert.rejects(()=>voice.start(),error=>error.name==="NotAllowedError"&&error.novaVoiceStage==="microphone"&&/Permission denied/.test(error.message));
  assert.equal(fetches,0);
});

test("realtime browser delegates the exact transcript to Nova and returns the authoritative result", async () => {
  const channel = new FakeChannel();
  const peer = new FakePeer(channel);
  const states = [], transcripts = [], turns = [];
  const voice = createRealtimeVoice({
    mediaDevices: { async getUserMedia() { return { getTracks: () => [{ stop() {} }] }; } },
    RTCPeerConnectionImpl: class { constructor() { return peer; } },
    MediaRecorderImpl: null,
    AudioImpl: class { play() { return Promise.resolve(); } pause() {} },
    fetchImpl: async (url) => url === "/api/voice/realtime/session"
      ? new Response(JSON.stringify({ clientSecret: "ek_test" }), { status: 201, headers: { "Content-Type": "application/json" } })
      : new Response("answer-sdp", { status: 200 }),
    sendTurn: async (text) => { turns.push(text); return { message: "Verified Nova answer", conversationId: "conversation-1" }; },
    onTranscript: (text) => transcripts.push(text),
    onState: (state) => states.push(state.state),
  });
  assert.equal(await voice.start(), true);
  channel.open();
  channel.message({ type: "input_audio_buffer.speech_stopped" });
  channel.message({ type: "conversation.item.input_audio_transcription.completed", transcript: "What is next for Sharp Cuts?" });
  channel.message({ type: "response.done", response: { output: [{ type: "function_call", name: "nova_turn", call_id: "call-1", arguments: "{\"request\":\"ignored paraphrase\"}" }] } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(transcripts, ["What is next for Sharp Cuts?"]);
  assert.deepEqual(turns, ["What is next for Sharp Cuts?"]);
  assert.ok(channel.sent.some((event) => event.type === "conversation.item.create" && event.item.output.includes("Verified Nova answer")));
  assert.ok(channel.sent.some((event) => event.type === "response.create" && event.response?.tool_choice === "none"));
  assert.ok(states.includes("listening"));
  voice.end();
});

test("realtime warm-up is non-blocking, direct turns persist, and mute controls only the microphone track", async () => {
  const channel = new FakeChannel(), peer = new FakePeer(channel), direct = [], requests = [];
  const audioTrack = { kind: "audio", enabled: true, stop() {} };
  const voice = createRealtimeVoice({
    mediaDevices: { async getUserMedia() { return { getTracks: () => [audioTrack], getAudioTracks: () => [audioTrack] }; } },
    RTCPeerConnectionImpl: class { constructor() { return peer; } },
    MediaRecorderImpl: null,
    AudioImpl: class { play() { return Promise.resolve(); } pause() {} },
    fetchImpl: async (url) => { requests.push(url); if (url === "/api/voice/realtime/session") return new Response(JSON.stringify({ clientSecret: "ek_test" }), { status: 201, headers: { "Content-Type": "application/json" } }); if (url === "/api/voice/speaker/readiness") return new Promise(() => {}); return new Response("answer-sdp", { status: 200 }); },
    onDirectTurn: (turn) => direct.push(turn),
  });
  assert.equal(await voice.start(), true);
  assert.ok(requests.includes("/api/voice/speaker/readiness"));
  channel.open();
  channel.message({ type: "input_audio_buffer.speech_stopped" });
  channel.message({ type: "conversation.item.input_audio_transcription.completed", transcript: "مرحبا Nova" });
  channel.message({ type: "response.output_audio_transcript.done", transcript: "أهلاً، كيف أساعدك؟" });
  channel.message({ type: "response.done", response: { id: "response-1", output: [] } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(direct, [{ turnId: "response-1", userText: "مرحبا Nova", assistantText: "أهلاً، كيف أساعدك؟", conversationId: null }]);
  assert.equal(voice.setMuted(true), true); assert.equal(audioTrack.enabled, false); assert.equal(voice.isMuted(), true);
  assert.equal(voice.setMuted(false), false); assert.equal(audioTrack.enabled, true);
  voice.end();
});

class FakeChannel extends EventTarget {
  readyState = "connecting";
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = "closed"; }
  open() { this.readyState = "open"; this.dispatchEvent(new Event("open")); }
  message(value) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
}

test('audible visual meter gates paused/muted output, clears on interruption, and resumes on the next reply',async()=>{
 const oldRaf=globalThis.requestAnimationFrame,oldCancel=globalThis.cancelAnimationFrame;
 let frameId=0;const frames=new Map();
 globalThis.requestAnimationFrame=fn=>{frames.set(++frameId,fn);return frameId;};
 globalThis.cancelAnimationFrame=id=>frames.delete(id);
 const tick=()=>{const work=[...frames.values()];frames.clear();work.forEach(fn=>fn());};
 const channel=new FakeChannel(),peer=new FakePeer(channel),levels=[];let audio;
 class Audio{paused=true;muted=false;volume=1;ended=false;constructor(){audio=this;}play(){this.paused=false;return Promise.resolve();}pause(){this.paused=true;}}
 class Context{state='running';createMediaStreamSource(){return{connect(){},disconnect(){}};}createAnalyser(){return{fftSize:256,getByteTimeDomainData:a=>a.fill(144)};}close(){return Promise.resolve();}resume(){return Promise.resolve();}}
 const voice=createRealtimeVoice({mediaDevices:{async getUserMedia(){return{getTracks:()=>[]};}},RTCPeerConnectionImpl:class{constructor(){return peer;}},AudioImpl:Audio,AudioContextImpl:Context,MediaRecorderImpl:null,onAudibleLevel:n=>levels.push(n),fetchImpl:async url=>url.includes('session')?Response.json({clientSecret:'ek_test'}):new Response('answer')});
 try{
  await voice.start();channel.open();peer.ontrack({streams:[{getTracks:()=>[]}]});
  tick();assert.equal(levels.at(-1),0);
  channel.message({type:'output_audio_buffer.started'});tick();assert.ok(levels.at(-1)>0);
  audio.muted=true;tick();assert.equal(levels.at(-1),0);audio.muted=false;
  audio.paused=true;tick();assert.equal(levels.at(-1),0);audio.paused=false;
  voice.interrupt();assert.equal(levels.at(-1),0);tick();assert.equal(levels.at(-1),0);
  channel.message({type:'output_audio_buffer.started'});tick();assert.ok(levels.at(-1)>0);
  channel.message({type:'output_audio_buffer.stopped'});assert.equal(levels.at(-1),0);
  voice.end();assert.equal(levels.at(-1),0);
 }finally{voice.end();globalThis.requestAnimationFrame=oldRaf;globalThis.cancelAnimationFrame=oldCancel;}
});

class FakePeer extends EventTarget {
  connectionState = "new";
  constructor(channel) { super(); this.channel = channel; }
  createDataChannel() { return this.channel; }
  addTrack() {}
  async createOffer() { return { type: "offer", sdp: "offer-sdp" }; }
  async setLocalDescription() {}
  async setRemoteDescription(value) { this.remote = value; }
  close() { this.connectionState = "closed"; }
}

test("12 interrupted English/Arabic turns preserve queued Brain calls, camera freshness and playback state",async()=>{
  const channel=new FakeChannel(),peer=new FakePeer(channel),observed=[],turns=[];
  let unlock,look={observed:false};
  const voice=createRealtimeVoice({mediaDevices:{async getUserMedia(){return {getTracks:()=>[]};}},
    RTCPeerConnectionImpl:class{constructor(){return peer}},AudioImpl:class{pause(){}},MediaRecorderImpl:null,
    fetchImpl:async url=>url.includes("session")?Response.json({clientSecret:"ek_test"}):new Response("answer"),
    getConversationId:()=>"c1",readScene:()=>look,onState:e=>observed.push(e),
    sendTurn:async t=>{turns.push(t);if(turns.length===1)await new Promise(r=>unlock=r);return {message:"Local result: "+t};}});
  await voice.start();channel.open();
  for(let i=0;i<12;i++){
    const item_id="i"+i,id="r"+i,request=i%2?"تابع المهمة "+i:"Review task "+i;
    channel.message({type:"input_audio_buffer.speech_started",item_id});
    channel.message({type:"input_audio_buffer.speech_stopped",item_id});
    channel.message({type:"conversation.item.input_audio_transcription.completed",item_id,transcript:request});
    channel.message({type:"response.created",response:{id}});
    channel.message({type:"response.done",response:{id,output:[{type:"function_call",name:"nova_turn",call_id:"c"+i,arguments:"{}"}]}});
    await new Promise(r=>setTimeout(r,0));
  }
  unlock();await new Promise(r=>setTimeout(r,10));
  assert.equal(turns.length,12);assert.equal(new Set(turns).size,12);assert.equal(turns[1],"تابع المهمة 1");
  const outputs=()=>channel.sent.filter(x=>x.item?.type==="function_call_output");
  assert.equal(outputs().length,12);assert.equal(outputs()[11].item.call_id,"c11");
  look={observed:true,objects:[{label:"cup",position:"centre"}]};
  channel.message({type:"response.done",response:{output:[{type:"function_call",name:"nova_look",call_id:"l1"}]}});
  assert.deepEqual(JSON.parse(outputs().at(-1).item.output),look);
  channel.message({type:"output_audio_buffer.started"});channel.message({type:"response.done",response:{output:[]}});
  assert.equal(observed.at(-1).state,"speaking");voice.interrupt();assert.equal(observed.at(-1).state,"listening");
  assert.equal(voice.explainReport({conversationId:"other",text:"private"}),false);
  voice.end();assert.equal(voice.explainReport({conversationId:"c1",text:"private"}),false);
});
