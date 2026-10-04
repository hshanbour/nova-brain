import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createElevenLabsTelephonyTts } from "../src/phone/elevenlabs-telephony.js";
import { decodeMulaw8k, pcm16ToLittleEndianBuffer } from "../src/phone/g711.js";
import { buildGptLivePrototypeSession } from "../src/phone/gpt-live-prototype.js";

export const GPT_LIVE_SAMPLE_VOICES = Object.freeze(["marin", "willow", "gleam"]);
export const GPT_LIVE_SAMPLE_LINES = Object.freeze([
  "أهلين محمد، أنا نوفا، وجاهزة نحكي معك بطريقة طبيعية وواضحة.",
  "Hello Mohammad, I’m Nova, and I’m ready to help.",
  "بالنسبة لمشروع Sharp Cuts، بقدر أراجع Codex والـ API معك.",
  "لحظة، قصدك نكمل من النقطة السابقة ولا نبدأ من جديد؟",
]);

const LIVE_URL = "wss://api.openai.com/v1/live/sessions";
const QUIET_MS = 2_000;
const TIMEOUT_MS = 90_000;
const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

export function pcm16Wav(samples, sampleRate = 8_000) {
  if (!(samples instanceof Int16Array)) throw new TypeError("PCM samples are required.");
  const pcm = pcm16ToLittleEndianBuffer(samples);
  const output = Buffer.alloc(44 + pcm.length);
  output.write("RIFF", 0);
  output.writeUInt32LE(36 + pcm.length, 4);
  output.write("WAVE", 8);
  output.write("fmt ", 12);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36);
  output.writeUInt32LE(pcm.length, 40);
  pcm.copy(output, 44);
  return output;
}

export function sampleFilename(voice) {
  if (!GPT_LIVE_SAMPLE_VOICES.includes(voice)) throw new TypeError("Unsupported sample voice.");
  return `nova-gpt-live-${voice}-pcmu8k.wav`;
}

async function generateVoiceSample({ apiKey, voice, outputDirectory, callerAudio, WebSocketImpl = WebSocket }) {
  const audio = [];
  let transcript = "";
  let usageSeconds = 0;
  let callerIndex = 0;
  let quietTimer;
  let timeoutTimer;
  let socket;
  const result = new Promise((resolveResult, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(quietTimer);
      socket?.close();
      reject(error);
    };
    const finish = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(quietTimer);
      try {
        const mulaw = Buffer.concat(audio);
        if (!mulaw.length) throw new Error("GPT-Live returned no sample audio.");
        const file = resolve(outputDirectory, sampleFilename(voice));
        await writeFile(file, pcm16Wav(decodeMulaw8k(mulaw)));
        resolveResult({ voice, file: basename(file), bytes: mulaw.length, durationSeconds: Number((mulaw.length / 8_000).toFixed(3)), usageSeconds, transcript: transcript.trim() });
      } catch (error) {
        reject(error);
      } finally {
        socket?.close();
      }
    };
    const streamCaller = async () => {
      const prompt = callerAudio[callerIndex];
      for (let offset = 0; offset < prompt.length; offset += 160) {
        socket.send(JSON.stringify({ type: "session.input_audio.append", event_id: randomUUID(), audio: prompt.subarray(offset, Math.min(offset + 160, prompt.length)).toString("base64") }));
        await sleep(20);
      }
    };
    const completeOutput = async () => {
      if (callerIndex + 1 >= callerAudio.length) return finish();
      callerIndex += 1;
      transcript += "\n";
      await streamCaller();
    };
    socket = new WebSocketImpl(LIVE_URL, { headers: { Authorization: `Bearer ${apiKey}`, "OpenAI-Beta": "realtime=v1" } });
    socket.on("open", () => {
      const session = {
        ...buildGptLivePrototypeSession({ voice }),
        instructions: `VOICE SAMPLE ONLY: The comparison script below has four numbered lines. When the caller asks for a specific line number, speak only that complete line exactly once, naturally, with no introduction, translation, explanation, added facts, or external action. Preserve Arabic, English, names, and technical terms exactly.\n\n${GPT_LIVE_SAMPLE_LINES.map((line, index) => `${index + 1}. ${line}`).join("\n")}`,
      };
      socket.send(JSON.stringify({ type: "session.start", event_id: randomUUID(), session }));
    });
    socket.on("message", (raw) => {
      const event = JSON.parse(String(raw));
      if (event.type === "session.started") {
        void streamCaller().catch(fail);
      } else if (event.type === "session.output_audio.delta") {
        const chunk = Buffer.from(String(event.delta || ""), "base64");
        if (chunk.length) audio.push(chunk);
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => { void completeOutput().catch(fail); }, QUIET_MS);
      } else if (event.type === "session.output_transcript.delta") {
        transcript += String(event.delta || "");
      } else if (event.type === "session.usage.updated" || event.type === "session.closed") {
        usageSeconds = Math.max(usageSeconds, Number(event.usage?.seconds) || 0);
      } else if (event.type === "error") {
        fail(Object.assign(new Error("GPT-Live voice sample provider error."), { code: String(event.error?.code || event.error?.type || "provider_error").slice(0, 80) }));
      }
    });
    socket.on("error", () => fail(Object.assign(new Error("GPT-Live voice sample transport failed."), { code: "gpt_live_sample_transport_failed" })));
    timeoutTimer = setTimeout(() => fail(Object.assign(new Error("GPT-Live voice sample timed out."), { code: "gpt_live_sample_timeout" })), TIMEOUT_MS);
  });
  return result;
}

export async function generateGptLiveVoiceSamples({ apiKey = process.env.OPENAI_API_KEY, outputDirectory = process.argv[2] || "/tmp/nova-gpt-live-voice-samples" } = {}) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is required.");
  if (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_VOICE_ID) throw new Error("ElevenLabs caller fixture configuration is required.");
  await mkdir(outputDirectory, { recursive: true });
  const tts = createElevenLabsTelephonyTts({
    config: {
      voiceV2: {
        elevenLabsApiKey: process.env.ELEVENLABS_API_KEY,
        elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID,
        ttsModel: process.env.ELEVENLABS_TTS_MODEL || "eleven_v3_conversational",
        ttsStability: 0.75,
        maxSpeechCharacters: 4_000,
      },
    },
  });
  const callerAudio = [];
  for (let index = 0; index < GPT_LIVE_SAMPLE_LINES.length; index += 1) {
    const callerChunks = [];
    for await (const chunk of tts.stream(`Please read configured sample line ${index + 1} exactly once now.`)) callerChunks.push(chunk);
    callerAudio.push(Buffer.concat(callerChunks));
  }
  const samples = [];
  for (const voice of GPT_LIVE_SAMPLE_VOICES) {
    samples.push(await generateVoiceSample({ apiKey, voice, outputDirectory, callerAudio }));
  }
  return Object.freeze({ ok: true, audioFormat: "provider PCMU 8 kHz decoded to PCM16 WAV for owner playback", rawCallerAudioPersisted: false, callerFixtureTtsRequests: callerAudio.length, samples });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateGptLiveVoiceSamples()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(JSON.stringify({ ok: false, code: String(error?.code || "gpt_live_sample_failed").slice(0, 80) }));
      process.exitCode = 1;
    });
}
