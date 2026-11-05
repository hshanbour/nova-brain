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
  assert.equal(request.body.session.tool_choice, "required");
  assert.match(request.body.session.instructions, /Arabic-English/);
  assert.match(request.body.session.instructions, /call nova_turn exactly once/);
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

class FakeChannel extends EventTarget {
  readyState = "connecting";
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = "closed"; }
  open() { this.readyState = "open"; this.dispatchEvent(new Event("open")); }
  message(value) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
}

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
