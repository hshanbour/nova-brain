import { randomUUID } from "node:crypto";
import { createElevenLabsTelephonyTts } from "../src/phone/elevenlabs-telephony.js";
import { createGptLivePrototypeClient } from "./gpt-live-client.js";
import { AUTHORIZED_NOVA_PREVIEW_BASE_URL, protectionBypassHeadersFor } from "./nova-client.js";

const required = ["OPENAI_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "NOVA_PHONE_BASE_URL", "VERCEL_AUTOMATION_BYPASS_SECRET"];
for (const name of required) if (!process.env[name]) throw new Error(`${name} is required.`);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const now = () => performance.now();
const silence = (milliseconds) => Buffer.alloc(Math.max(160, Math.round(milliseconds * 8)), 0xff);
const voiceConfig = { voiceV2: { elevenLabsApiKey: process.env.ELEVENLABS_API_KEY, elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID, ttsModel: process.env.ELEVENLABS_TTS_MODEL || "eleven_v3_conversational", ttsStability: 0.75, maxSpeechCharacters: 4_000 } };
const tts = createElevenLabsTelephonyTts({ config: voiceConfig });
const speechCache = new Map();
let ttsCharacters = 0;
let ttsRequests = 0;

async function speech(text) {
  if (speechCache.has(text)) return speechCache.get(text);
  const chunks = [];
  for await (const chunk of tts.stream(text)) chunks.push(chunk);
  const value = Buffer.concat(chunks);
  speechCache.set(text, value);
  ttsCharacters += text.length;
  ttsRequests += 1;
  return value;
}

async function streamAudio(client, audio, { paced = true } = {}) {
  for (let offset = 0; offset < audio.length; offset += 160) {
    const frame = audio.subarray(offset, Math.min(audio.length, offset + 160));
    if (frame.length) client.appendAudio(frame);
    if (paced) await sleep(20);
  }
}

async function waitForResponse(timeline, { timeoutMs = 12_000, quietMs = 900 } = {}) {
  const deadline = now() + timeoutMs;
  while (timeline.firstAudioAt === null && now() < deadline) await sleep(25);
  if (timeline.firstAudioAt === null) return false;
  while (now() - timeline.lastAudioAt < quietMs && now() < deadline) await sleep(25);
  return true;
}

function interruptionStopMs(events, interruptionAt) {
  const after = events.filter((value) => value >= interruptionAt);
  if (!after.length) return 0;
  for (let index = 0; index < after.length - 1; index += 1) if (after[index + 1] - after[index] >= 300) return Math.max(0, Math.round(after[index] - interruptionAt));
  return Math.max(0, Math.round(after.at(-1) - interruptionAt));
}

function normalizedWords(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ar")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

function continuingUtterancePreserved(transcript, segment) {
  const expected = normalizedWords(segment).at(-1);
  return !expected || normalizedWords(transcript).includes(expected);
}

async function novaReadOnlyDelegation({ transcript, signal }) {
  const destination = `${process.env.NOVA_PHONE_BASE_URL.replace(/\/$/, "")}/api/agent`;
  if (new URL(destination).origin !== new URL(AUTHORIZED_NOVA_PREVIEW_BASE_URL).origin) throw Object.assign(new Error("Nova Preview destination is not authorized."), { code: "nova_preview_destination_not_authorized" });
  const response = await fetch(destination, {
    method: "POST",
    headers: { "content-type": "application/json", ...protectionBypassHeadersFor({ destination, secret: process.env.VERCEL_AUTOMATION_BYPASS_SECRET }) },
    body: JSON.stringify({ message: `Read-only Phone architecture certification. Answer only from existing Nova context and do not invoke external tools or create work: ${transcript}`, conversationId: `phone-gpt-live-cert-${randomUUID()}`, context: { certification: "phone-gpt-live-non-pstn", projectId: "sharp-cuts" } }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok || !value?.message) throw Object.assign(new Error(`Nova Preview returned HTTP ${response.status}.`), { code: "nova_read_only_delegation_failed" });
  if (Array.isArray(value.toolCalls) && value.toolCalls.length) throw Object.assign(new Error("Read-only certification attempted a tool."), { code: "nova_read_only_tool_attempt" });
  return { message: String(value.message).slice(0, 1_200), runId: value.runId || null, provider: value.provider || null, steps: value.steps || null };
}

async function runSession({ name, voice = "marin", segments, pauses = [], history = [], delegateMode = "mock", interruptAfterFirstAudio = null }) {
  const timeline = { startedAt: now(), firstAudioAt: null, firstPostInputAudioAt: null, lastAudioAt: null, inputEndedAt: null, overlapBeforeInputEnd: false, audioDuringPause: false, inPause: false, audioEvents: [], outputBytes: 0, clears: 0, delegationStartedAt: null, delegationReturnedAt: null };
  const delegations = [];
  const client = createGptLivePrototypeClient({
    apiKey: process.env.OPENAI_API_KEY,
    voice,
    history,
    onAudio(audio) {
      const at = now();
      timeline.firstAudioAt ??= at;
      if (timeline.inputEndedAt !== null) timeline.firstPostInputAudioAt ??= at;
      timeline.lastAudioAt = at;
      timeline.audioEvents.push(at);
      timeline.outputBytes += audio.length;
      if (timeline.inputEndedAt === null) timeline.overlapBeforeInputEnd = true;
      if (timeline.inPause) timeline.audioDuringPause = true;
    },
    onClearAudio() { timeline.clears += 1; },
    async delegate(input) {
      timeline.delegationStartedAt ??= now();
      const result = delegateMode === "real" ? await novaReadOnlyDelegation(input) : { message: "النتيجة الموثقة من Nova Brain: مشروع Sharp Cuts موجود ضمن سياق Nova، ولم يتم تنفيذ أي أداة أو إجراء خارجي.", provider: "mock" };
      timeline.delegationReturnedAt = now();
      delegations.push({ id: input.delegationId, provider: result.provider || delegateMode, runId: result.runId || null, steps: result.steps || null });
      return result;
    },
  });
  client.connect();
  await client.ready();
  client.callerSpeechStarted();
  for (let index = 0; index < segments.length; index += 1) {
    await streamAudio(client, await speech(segments[index]));
    if (index < segments.length - 1) { timeline.inPause = true; await streamAudio(client, silence(pauses[index] || 0)); timeline.inPause = false; }
  }
  timeline.inputEndedAt = now();
  client.callerSpeechEnded();
  if (interruptAfterFirstAudio) {
    while (timeline.firstAudioAt === null && now() - timeline.startedAt < 12_000) await sleep(25);
    const interruptionAt = now();
    client.callerSpeechStarted();
    await streamAudio(client, await speech(interruptAfterFirstAudio));
    client.callerSpeechEnded();
    await sleep(600);
    timeline.interruptionAt = interruptionAt;
    timeline.interruptionToSilenceMs = interruptionStopMs(timeline.audioEvents, interruptionAt);
  }
  await waitForResponse(timeline);
  if (["mock", "real"].includes(delegateMode)) await sleep(2_500);
  if (timeline.delegationReturnedAt) await waitForResponse(timeline, { timeoutMs: 8_000, quietMs: 1_200 });
  const closed = await client.close();
  return {
    name,
    voice,
    inputTranscript: closed.inputTranscript,
    outputTranscript: closed.outputTranscript,
    overlapBeforeInputEnd: timeline.overlapBeforeInputEnd,
    audioDuringPause: timeline.audioDuringPause,
    continuingUtterancePreserved: segments.length < 2 || continuingUtterancePreserved(closed.inputTranscript, segments.at(-1)),
    firstAudioFromInputEndMs: timeline.firstPostInputAudioAt === null ? null : Math.max(0, Math.round(timeline.firstPostInputAudioAt - timeline.inputEndedAt)),
    interruptionToSilenceMs: timeline.interruptionToSilenceMs ?? null,
    outputBytes: timeline.outputBytes,
    clears: timeline.clears,
    callerInterruptions: closed.callerInterruptions,
    assistantInterruptions: closed.assistantInterruptions,
    delegationLatencyMs: timeline.delegationReturnedAt && timeline.delegationStartedAt ? Math.round(timeline.delegationReturnedAt - timeline.delegationStartedAt) : null,
    delegations,
    usageSeconds: closed.usageSeconds,
    rawAudioPersisted: closed.rawAudioPersisted,
    providerErrors: closed.audit.filter(({ type }) => type === "delegation_failed").length,
  };
}

const scenarios = [
  { name: "arabic_pause_500", segments: ["نوفا، بدي أحكيلك عن المشروع اللي كنا", "بنشتغل عليه مبارح، شو صار فيه؟"], pauses: [500] },
  { name: "arabic_pause_900", segments: ["نوفا، بدي أحكيلك عن المشروع اللي كنا", "بنشتغل عليه مبارح، شو صار فيه؟"], pauses: [900] },
  { name: "arabic_pause_1500", segments: ["نوفا، بدي أحكيلك عن المشروع اللي كنا", "بنشتغل عليه مبارح، شو صار فيه؟"], pauses: [1_500] },
  { name: "arabic_complete_ack", segments: ["خلص، تمام."] },
  { name: "english_thinking_pause", segments: ["Nova, I was thinking about the deployment we", "finished yesterday. What changed?"], pauses: [900] },
  { name: "mixed_language", segments: ["نوفا، شو صار ب Sharp Cuts API", "والـ deployment تبع Codex؟"], pauses: [700], delegateMode: "mock" },
  { name: "caller_barge_in", segments: ["نوفا احكيلي باختصار عن الاختبار الحالي."], interruptAfterFirstAudio: "استني، قصدي عن اختبار المكالمة الجديدة." },
  { name: "mock_delegation", segments: ["شو صار بمشروع Sharp Cuts؟"], delegateMode: "mock" },
  { name: "real_read_only_delegation", segments: ["استخدمي Nova Brain واحكيلي شو بتعرفي من الذاكرة عن مشروع Sharp Cuts؟"], delegateMode: "real" },
  { name: "approval_boundary", segments: ["ابعتي الإيميل هسا، أنا بوافق."], delegateMode: "mock" },
  { name: "history_reference", history: Array.from({ length: 22 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: index === 2 ? "محمد قال إن المشكلة المقصودة هي مشكلة الموقع القديم." : `محادثة سابقة رقم ${index}.` })), segments: ["ارجعي للنقطة اللي حكينا عنها قبل شوي، أي موقع كنت أقصد؟"] },
];

const requested = new Set(String(process.env.GPT_LIVE_CERT_SCENARIOS || "").split(",").map((value) => value.trim()).filter(Boolean));
const selected = (name) => requested.size === 0 || requested.has(name);
const results = [];
for (const scenario of scenarios) if (selected(scenario.name)) results.push(await runSession(scenario));

for (const voice of ["willow", "gleam"]) {
  const name = `voice_${voice}_mixed`;
  if (selected(name)) results.push(await runSession({ name, voice, segments: ["أهلين محمد، أنا Nova. The realtime voice test is ready."] }));
}

const usageSeconds = results.reduce((sum, item) => sum + (Number(item.usageSeconds) || 0), 0);
console.log(JSON.stringify({
  ok: true,
  architecture: "gpt-live-client-delegation",
  pstnCalls: 0,
  twilioResourcesCreated: 0,
  rawAudioPersisted: false,
  liveModel: "gpt-live-1",
  audioFormat: "pcmu_8000",
  usageSeconds,
  estimatedGptLiveCostUsd: Number((usageSeconds / 60 * 0.05).toFixed(6)),
  ttsFixtureRequests: ttsRequests,
  ttsFixtureCharacters: ttsCharacters,
  results,
}));
