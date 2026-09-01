import { ELEVENLABS_DEFAULT_TTS_MODEL, ELEVENLABS_OUTPUT_FORMAT } from "../voice/elevenlabs-models.js";

const SUPPORTED_MODEL_PROVIDERS = new Set(["mock", "openai"]);
const SUPPORTED_STORAGE_PROVIDERS = new Set(["auto", "memory", "postgres"]);

function parseOrigins(value) {
  if (!value) return [];

  return [...new Set(value.split(",").map((origin) => origin.trim()).filter(Boolean))];
}

export function readConfig(environment = process.env) {
  const modelProvider = environment.NOVA_BRAIN_MODEL_PROVIDER || "mock";

  if (!SUPPORTED_MODEL_PROVIDERS.has(modelProvider)) {
    throw new Error(`Unsupported NOVA_BRAIN_MODEL_PROVIDER: ${modelProvider}`);
  }

  const maxAgentSteps = parseInteger(
    environment.NOVA_BRAIN_MAX_STEPS,
    "NOVA_BRAIN_MAX_STEPS",
    { defaultValue: 5, min: 1, max: 10 }
  );
  const maxToolCallsPerStep = parseInteger(
    environment.NOVA_BRAIN_MAX_TOOL_CALLS_PER_STEP,
    "NOVA_BRAIN_MAX_TOOL_CALLS_PER_STEP",
    { defaultValue: 4, min: 1, max: 10 }
  );
  const configuredStorage = environment.NOVA_BRAIN_STORAGE_PROVIDER || "auto";
  if (!SUPPORTED_STORAGE_PROVIDERS.has(configuredStorage)) {
    throw new Error(`Unsupported NOVA_BRAIN_STORAGE_PROVIDER: ${configuredStorage}`);
  }
  const databaseUrl = environment.DATABASE_URL || environment.POSTGRES_URL || environment.POSTGRES_URL_NON_POOLING || null;
  const storageProvider = configuredStorage === "auto" ? (databaseUrl ? "postgres" : "memory") : configuredStorage;
  if (storageProvider === "postgres" && !databaseUrl) {
    throw new Error("A server-side Postgres connection variable is required when NOVA_BRAIN_STORAGE_PROVIDER=postgres.");
  }
  const conversationHistoryLimit = parseInteger(environment.NOVA_BRAIN_HISTORY_LIMIT, "NOVA_BRAIN_HISTORY_LIMIT", { defaultValue: 24, min: 2, max: 100 });
  const memoryRetrievalLimit = parseInteger(environment.NOVA_BRAIN_MEMORY_LIMIT, "NOVA_BRAIN_MEMORY_LIMIT", { defaultValue: 6, min: 1, max: 20 });

  if (modelProvider === "openai" && !environment.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when NOVA_BRAIN_MODEL_PROVIDER=openai.");
  }

  if (modelProvider === "openai" && !environment.OPENAI_MODEL) {
    throw new Error("OPENAI_MODEL is required when NOVA_BRAIN_MODEL_PROVIDER=openai.");
  }

  return Object.freeze({
    nodeEnv: environment.NODE_ENV || "development",
    modelProvider,
    maxAgentSteps,
    maxToolCallsPerStep,
    storageProvider,
    databaseUrl,
    conversationHistoryLimit,
    memoryRetrievalLimit,
    developmentBranch: environment.NOVA_BRAIN_DEVELOPMENT_BRANCH || "feat/nova-brain-mvp-foundation",
    openAI: Object.freeze({
      apiKey: environment.OPENAI_API_KEY || null,
      model: environment.OPENAI_MODEL || null
    }),
    integrations: Object.freeze({
      githubConfigured: Boolean(environment.NOVA_BRAIN_GITHUB_TOKEN && environment.NOVA_BRAIN_GITHUB_REPOSITORY),
      vercelConfigured: Boolean(environment.NOVA_BRAIN_VERCEL_TOKEN && environment.NOVA_BRAIN_VERCEL_PROJECT_ID)
    }),
    allowedOrigins: parseOrigins(environment.CORS_ALLOWED_ORIGINS),
    maxBodyBytes: 64 * 1024,
    voiceV2: Object.freeze({
      sttModel: "gpt-transcribe",
      ttsModel: ELEVENLABS_DEFAULT_TTS_MODEL,
      ttsOutputFormat: ELEVENLABS_OUTPUT_FORMAT,
      openAIApiKey: environment.OPENAI_API_KEY || null,
      elevenLabsApiKey: environment.ELEVENLABS_API_KEY || null,
      elevenLabsVoiceId: environment.ELEVENLABS_VOICE_ID || null,
      minDurationSeconds: 0.2,
      maxDurationSeconds: 30,
      maxAudioBytes: 2 * 1024 * 1024,
      maxBodyBytes: 3 * 1024 * 1024,
      maxSpeechAudioBytes: 32 * 1024 * 1024,
      maxSpeechCharacters: 6000,
      maxSpeechChunks: 64,
      firstSpeechChunkCharacters: 60,
      nextSpeechChunkCharacters: 120,
      speechLookahead: 2,
      ttsStability: 0.5,
      capabilityCacheMs: 10 * 60 * 1000,
      capabilityTimeoutMs: 5_000,
      ttsRetryDelayMs: 200,
      ttsConcurrencyRetryDelayMs: 1_200,
      requestTimeoutMs: 25_000,
      ttsFirstByteTimeoutMs: 10_000,
      ttsStreamStallTimeoutMs: 8_000,
      ttsChunkTimeoutMs: 45_000
    }),
    speakerRecognition: Object.freeze({
      endpoint: environment.NOVA_SPEAKER_EXTRACTOR_URL || null,
      token: environment.NOVA_SPEAKER_EXTRACTOR_TOKEN || null,
      assertionKey: environment.NOVA_SPEAKER_ASSERTION_KEY || null,
      embeddingKey: environment.NOVA_SPEAKER_EMBEDDING_KEY || null,
      modelVersion: environment.NOVA_SPEAKER_EXTRACTOR_MODEL || "speechbrain/spkrec-ecapa-voxceleb@ecapa-v1",
      minSpeechSeconds: 1.0,
      maxAudioBytes: 2 * 1024 * 1024,
      threshold: 0.86,
      ambiguityMargin: 0.05
    }),
    voiceBenchmark: Object.freeze({
      paidCallsApproved: environment.NOVA_VOICE_BENCHMARK_PAID_CALLS_APPROVED === "true",
      budgetUsd: parseMoney(environment.NOVA_VOICE_BENCHMARK_BUDGET_USD, "NOVA_VOICE_BENCHMARK_BUDGET_USD", 2),
      maxAudioBytes: 2 * 1024 * 1024,
      maxBodyBytes: 3 * 1024 * 1024,
      credentials: Object.freeze({
        openai: environment.OPENAI_API_KEY || null,
        deepgram: environment.DEEPGRAM_API_KEY || null,
        elevenlabs: environment.ELEVENLABS_API_KEY || null,
        elevenlabsVoiceId: environment.ELEVENLABS_VOICE_ID || null,
        azureKey: environment.AZURE_SPEECH_KEY || null,
        azureRegion: environment.AZURE_SPEECH_REGION || null
      })
    })
  });
}

function parseMoney(value, name, defaultValue) {
  if (value === undefined || value === "") return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 2) throw new Error(`${name} must be greater than 0 and no more than 2.00.`);
  return Math.round(parsed * 100) / 100;
}

function parseInteger(value, name, { defaultValue, min, max }) {
  if (value === undefined || value === "") return defaultValue;

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }

  return parsed;
}
