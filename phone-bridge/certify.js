import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { createElevenLabsTelephonyTts } from "../src/phone/elevenlabs-telephony.js";
import { createOpenAiWebSocketTranscriber } from "./openai-transcriber.js";
import { AUTHORIZED_NOVA_PREVIEW_BASE_URL, protectionBypassHeadersFor } from "./nova-client.js";

const required = ["OPENAI_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "NOVA_PHONE_BASE_URL", "VERCEL_AUTOMATION_BYPASS_SECRET"];
for (const name of required) if (!process.env[name]) throw new Error(`${name} is required.`);

const timeout = (promise, milliseconds, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out.`)), milliseconds)),
]);
const now = () => performance.now();
const voiceConfig = { voiceV2: { elevenLabsApiKey: process.env.ELEVENLABS_API_KEY, elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID, ttsModel: process.env.ELEVENLABS_TTS_MODEL || "eleven_v3_conversational", ttsStability: 0.75, maxSpeechCharacters: 4000 } };
const tts = createElevenLabsTelephonyTts({ config: voiceConfig });

async function speech(text) {
  const started = now(); let firstAudioMs = null; let bytes = 0; const chunks = [];
  for await (const chunk of tts.stream(text)) {
    if (firstAudioMs === null) firstAudioMs = Math.round(now() - started);
    bytes += chunk.length; chunks.push(chunk);
  }
  return { audio: Buffer.concat(chunks), bytes, firstAudioMs, totalMs: Math.round(now() - started) };
}

async function transcribe(audio, turnId) {
  const started = now(); let providerError;
  const client = createOpenAiWebSocketTranscriber({ WebSocketImpl: WebSocket, apiKey: process.env.OPENAI_API_KEY, onError(error) { providerError ||= error; } });
  try {
    client.start(); await timeout(client.ready(), 15_000, "OpenAI streaming connection");
    client.appendMulaw(audio.toString("base64"));
    const result = await timeout(client.commit({ turnId }), 30_000, "OpenAI streaming transcription");
    return { transcript: result.transcript, latencyMs: Math.round(now() - started), pcmBytes: client.metrics().appendedPcmBytes };
  } catch (error) { throw providerError || error; }
  finally { client.close(); }
}

async function novaTurn(message, conversationId) {
  const started = now();
  const destination = `${process.env.NOVA_PHONE_BASE_URL.replace(/\/$/, "")}/api/agent`;
  const response = await fetch(destination, { method: "POST", headers: { "content-type": "application/json", ...protectionBypassHeadersFor({ destination, secret: process.env.VERCEL_AUTOMATION_BYPASS_SECRET, authorizedBaseUrl: AUTHORIZED_NOVA_PREVIEW_BASE_URL }) }, body: JSON.stringify({ message, conversationId, context: { certification: "phone-v1-phase-2" } }), signal: AbortSignal.timeout(75_000) });
  const value = await response.json().catch(() => null);
  if (!response.ok || !value?.message) throw new Error(`Nova Preview returned HTTP ${response.status}.`);
  if (Array.isArray(value.toolCalls) && value.toolCalls.length) throw new Error("Nova certification unexpectedly invoked a tool.");
  return { message: String(value.message).slice(0, 800), latencyMs: Math.round(now() - started), steps: value.steps, toolCalls: value.toolCalls?.length || 0 };
}

const samples = [
  { id: "english", text: "Nova, reply with one short sentence. Sharp Cuts test number is forty two." },
  { id: "arabic", text: "نوفا، ردي بجملة قصيرة. اختبار العربية ناجح والرقم خمسة وثلاثون." },
  { id: "mixed", text: "نوفا، ردي باختصار. Nova Brain و Sharp Cuts API رقم سبعة وعشرين." },
];

const conversationId = `phone-phase2-${randomUUID()}`; const results = [];
for (const sample of samples) {
  const caller = await speech(sample.text);
  const stt = await transcribe(caller.audio, `${sample.id}-${randomUUID()}`);
  const nova = await novaTurn(stt.transcript, conversationId);
  const reply = await speech(nova.message);
  results.push({ language: sample.id, expectedText: sample.text, transcript: stt.transcript, sttLatencyMs: stt.latencyMs, inputUlawBytes: caller.bytes, inputFirstAudioMs: caller.firstAudioMs, inputTtsMs: caller.totalMs, novaLatencyMs: nova.latencyMs, novaSteps: nova.steps, toolCalls: nova.toolCalls, outputUlawBytes: reply.bytes, outputFirstAudioMs: reply.firstAudioMs, outputTtsMs: reply.totalMs, outputFormat: "ulaw_8000" });
}
console.log(JSON.stringify({ ok: true, model: process.env.ELEVENLABS_TTS_MODEL || "eleven_v3_conversational", voice: "Nova Female V1", rawAudioPersisted: false, results }));
