import {
  ELEVENLABS_DEFAULT_TTS_MODEL,
  ELEVENLABS_OUTPUT_FORMAT,
} from "../voice/elevenlabs-models.js";

const SUPPORTED_MODEL_PROVIDERS = new Set(["mock", "openai"]);
const SUPPORTED_STORAGE_PROVIDERS = new Set(["auto", "memory", "postgres"]);
const SUPPORTED_OPENAI_SERVICE_TIERS = new Set(["default", "flex"]);
const SUPPORTED_REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const EXPECTED_GMAIL_ACCOUNT = "novadigitalservicesuk@gmail.com";

function parsePhoneConfig(environment) {
  const values = {
    accountSid: environment.TWILIO_ACCOUNT_SID || null,
    authToken: environment.TWILIO_AUTH_TOKEN || null,
    fromNumber: environment.NOVA_PHONE_NUMBER || null,
    bridgeBaseUrl: environment.NOVA_PHONE_BRIDGE_URL || null,
    bridgeWebSocketUrl: environment.NOVA_PHONE_BRIDGE_WEBSOCKET_URL || null,
    publicBaseUrl: environment.NOVA_PHONE_PUBLIC_BASE_URL || null,
    sessionSigningKey: environment.NOVA_PHONE_SESSION_SIGNING_KEY || null,
    ownerNumber: environment.NOVA_PHONE_OWNER_NUMBER || null,
    deploymentEnvironment: environment.VERCEL_ENV || environment.NODE_ENV || "development",
  };
  const required = [values.accountSid, values.authToken, values.fromNumber, values.bridgeBaseUrl, values.bridgeWebSocketUrl, values.publicBaseUrl, values.sessionSigningKey];
  const supplied = required.filter(Boolean).length;
  if (supplied > 0 && supplied !== required.length) throw new Error("All seven Phone V1 environment variables must be configured together.");
  if (!supplied) return Object.freeze({ configured: false, ...values, bridgeReadinessAttempts: 8, bridgeReadinessDelayMs: 250 });
  if (!/^AC[a-fA-F0-9]{32}$/.test(values.accountSid)) throw new Error("TWILIO_ACCOUNT_SID is invalid.");
  if (!/^\+44[1-9]\d{8,9}$/.test(values.fromNumber)) throw new Error("NOVA_PHONE_NUMBER must be a UK E.164 number.");
  if (values.ownerNumber && !/^\+44[1-9]\d{8,9}$/.test(values.ownerNumber)) throw new Error("NOVA_PHONE_OWNER_NUMBER must be a UK E.164 number.");
  for (const [name, value, protocol] of [["NOVA_PHONE_BRIDGE_URL", values.bridgeBaseUrl, "https:"], ["NOVA_PHONE_BRIDGE_WEBSOCKET_URL", values.bridgeWebSocketUrl, "wss:"], ["NOVA_PHONE_PUBLIC_BASE_URL", values.publicBaseUrl, "https:"]]) {
    let parsed; try { parsed = new URL(value); } catch { throw new Error(`${name} must be an absolute URL.`); }
    if (parsed.protocol !== protocol || parsed.username || parsed.password) throw new Error(`${name} must use ${protocol}`);
  }
  const key = /^[a-f0-9]{64}$/i.test(values.sessionSigningKey) ? Buffer.from(values.sessionSigningKey, "hex") : Buffer.from(values.sessionSigningKey, "base64");
  if (key.length !== 32) throw new Error("NOVA_PHONE_SESSION_SIGNING_KEY must decode to exactly 32 bytes.");
  return Object.freeze({ configured: true, ...values, sessionSigningKeyBytes: key, bridgeReadinessAttempts: 8, bridgeReadinessDelayMs: 250 });
}

function parseGmailConfig(environment) {
  const values = {
    clientId: environment.GOOGLE_OAUTH_CLIENT_ID || null,
    clientSecret: environment.GOOGLE_OAUTH_CLIENT_SECRET || null,
    redirectUri: environment.NOVA_GMAIL_OAUTH_REDIRECT_URI || null,
    tokenEncryptionKey: environment.NOVA_GMAIL_TOKEN_ENCRYPTION_KEY || null,
    accountEmail: environment.NOVA_GMAIL_ACCOUNT_EMAIL?.trim().toLowerCase() || null,
  };
  const supplied = Object.values(values).filter(Boolean).length;
  if (supplied > 0 && supplied !== Object.keys(values).length)
    throw new Error("All five Gmail OAuth environment variables must be configured together.");
  if (supplied === 0) return Object.freeze({ configured: false, ...values });
  if (values.accountEmail !== EXPECTED_GMAIL_ACCOUNT)
    throw new Error(`NOVA_GMAIL_ACCOUNT_EMAIL must be ${EXPECTED_GMAIL_ACCOUNT}.`);
  let redirect;
  try { redirect = new URL(values.redirectUri); }
  catch { throw new Error("NOVA_GMAIL_OAUTH_REDIRECT_URI must be an absolute URL."); }
  if (redirect.pathname !== "/api/integrations/gmail/oauth/callback")
    throw new Error("NOVA_GMAIL_OAUTH_REDIRECT_URI must use Nova's Gmail callback route.");
  if (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && redirect.hostname === "localhost"))
    throw new Error("NOVA_GMAIL_OAUTH_REDIRECT_URI must use HTTPS (or HTTP on localhost).");
  const key = /^[a-f0-9]{64}$/i.test(values.tokenEncryptionKey)
    ? Buffer.from(values.tokenEncryptionKey, "hex")
    : Buffer.from(values.tokenEncryptionKey, "base64");
  if (key.length !== 32)
    throw new Error("NOVA_GMAIL_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  return Object.freeze({ configured: true, ...values });
}

function parseOptionalReasoningEffort(value, name) {
  if (value === undefined || value === "") return null;
  if (!SUPPORTED_REASONING_EFFORTS.has(value)) {
    throw new Error(`${name} must be one of: ${[...SUPPORTED_REASONING_EFFORTS].join(", ")}.`);
  }
  return value;
}

function parseOptionalInteger(value, name, { min, max }) {
  if (value === undefined || value === "") return null;
  return parseInteger(value, name, { defaultValue: null, min, max });
}

function parseOrigins(value) {
  if (!value) return [];

  return [
    ...new Set(
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  ];
}

export function readConfig(environment = process.env) {
  const modelProvider = environment.NOVA_BRAIN_MODEL_PROVIDER || "mock";
  const gmail = parseGmailConfig(environment);
  const phone = parsePhoneConfig(environment);

  if (!SUPPORTED_MODEL_PROVIDERS.has(modelProvider)) {
    throw new Error(`Unsupported NOVA_BRAIN_MODEL_PROVIDER: ${modelProvider}`);
  }

  const maxAgentSteps = parseInteger(
    environment.NOVA_BRAIN_MAX_STEPS,
    "NOVA_BRAIN_MAX_STEPS",
    { defaultValue: 10, min: 1, max: 10 },
  );
  const syncAgentDeadlineMs = parseInteger(
    environment.NOVA_BRAIN_SYNC_DEADLINE_MS,
    "NOVA_BRAIN_SYNC_DEADLINE_MS",
    { defaultValue: 75_000, min: 10_000, max: 90_000 },
  );
  const maxToolCallsPerStep = parseInteger(
    environment.NOVA_BRAIN_MAX_TOOL_CALLS_PER_STEP,
    "NOVA_BRAIN_MAX_TOOL_CALLS_PER_STEP",
    { defaultValue: 4, min: 1, max: 10 },
  );
  const configuredStorage = environment.NOVA_BRAIN_STORAGE_PROVIDER || "auto";
  if (!SUPPORTED_STORAGE_PROVIDERS.has(configuredStorage)) {
    throw new Error(
      `Unsupported NOVA_BRAIN_STORAGE_PROVIDER: ${configuredStorage}`,
    );
  }
  const databaseUrl =
    environment.DATABASE_URL ||
    environment.POSTGRES_URL ||
    environment.POSTGRES_URL_NON_POOLING ||
    null;
  const storageProvider =
    configuredStorage === "auto"
      ? databaseUrl
        ? "postgres"
        : "memory"
      : configuredStorage;
  if (storageProvider === "postgres" && !databaseUrl) {
    throw new Error(
      "A server-side Postgres connection variable is required when NOVA_BRAIN_STORAGE_PROVIDER=postgres.",
    );
  }
  const conversationHistoryLimit = parseInteger(
    environment.NOVA_BRAIN_HISTORY_LIMIT,
    "NOVA_BRAIN_HISTORY_LIMIT",
    { defaultValue: 24, min: 2, max: 100 },
  );
  const memoryRetrievalLimit = parseInteger(
    environment.NOVA_BRAIN_MEMORY_LIMIT,
    "NOVA_BRAIN_MEMORY_LIMIT",
    { defaultValue: 6, min: 1, max: 20 },
  );

  if (modelProvider === "openai" && !environment.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is required when NOVA_BRAIN_MODEL_PROVIDER=openai.",
    );
  }

  if (modelProvider === "openai" && !environment.OPENAI_MODEL) {
    throw new Error(
      "OPENAI_MODEL is required when NOVA_BRAIN_MODEL_PROVIDER=openai.",
    );
  }

  const openAIServiceTier = environment.NOVA_BRAIN_OPENAI_SERVICE_TIER || "default";
  if (!SUPPORTED_OPENAI_SERVICE_TIERS.has(openAIServiceTier)) {
    throw new Error("NOVA_BRAIN_OPENAI_SERVICE_TIER must be default or flex.");
  }
  const openAIModel = environment.OPENAI_MODEL || null;
  const modelBudgetId = environment.NOVA_OPENAI_BUDGET_ID || "disabled";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(modelBudgetId)) {
    throw new Error("NOVA_OPENAI_BUDGET_ID must be a stable 1-80 character identifier.");
  }
  const openAIRoute = (
    stage,
    prefix,
    { defaultModel = openAIModel, defaultReasoningEffort = null } = {},
  ) => Object.freeze({
    model: environment[`NOVA_BRAIN_${prefix}_MODEL`] || defaultModel,
    reasoningEffort:
      environment[`NOVA_BRAIN_${prefix}_REASONING_EFFORT`] === undefined ||
      environment[`NOVA_BRAIN_${prefix}_REASONING_EFFORT`] === ""
        ? defaultReasoningEffort
        : parseOptionalReasoningEffort(
            environment[`NOVA_BRAIN_${prefix}_REASONING_EFFORT`],
            `NOVA_BRAIN_${prefix}_REASONING_EFFORT`,
          ),
    maxOutputTokens: parseOptionalInteger(
      environment[`NOVA_BRAIN_${prefix}_MAX_OUTPUT_TOKENS`],
      `NOVA_BRAIN_${prefix}_MAX_OUTPUT_TOKENS`,
      { min: 256, max: 128_000 },
    ),
    stage,
  });

  return Object.freeze({
    nodeEnv: environment.NODE_ENV || "development",
    modelProvider,
    maxAgentSteps,
    syncAgentDeadlineMs,
    maxToolCallsPerStep,
    storageProvider,
    databaseUrl,
    conversationHistoryLimit,
    memoryRetrievalLimit,
    developmentBranch:
      environment.NOVA_BRAIN_DEVELOPMENT_BRANCH ||
      "feat/nova-brain-mvp-foundation",
    workerAdminToken: environment.NOVA_WORKER_ADMIN_TOKEN || null,
    localWorkerToken: environment.NOVA_LOCAL_WORKER_TOKEN || null,
    openAI: Object.freeze({
      apiKey: environment.OPENAI_API_KEY || null,
      model: openAIModel,
      serviceTier: openAIServiceTier,
      routes: Object.freeze({
        chat: openAIRoute("chat", "CHAT", {
          defaultModel: "gpt-6-luna",
          defaultReasoningEffort: "none",
        }),
        intake: openAIRoute("intake", "INTAKE", {
          defaultModel: "gpt-6-luna",
          defaultReasoningEffort: "none",
        }),
        planner: openAIRoute("planner", "PLANNER"),
        noChange: openAIRoute("no_change", "NO_CHANGE", {
          defaultModel: "gpt-6-luna",
          defaultReasoningEffort: "none",
        }),
        web: openAIRoute("web_research", "WEB", {
          defaultModel: "gpt-6-luna",
          defaultReasoningEffort: "none",
        }),
      }),
      budget: Object.freeze({
        budgetId: modelBudgetId,
        globalBudgetUsd: parseBudgetMoney(environment.NOVA_OPENAI_GLOBAL_BUDGET_USD, "NOVA_OPENAI_GLOBAL_BUDGET_USD"),
        taskBudgetUsd: parseBudgetMoney(environment.NOVA_OPENAI_TASK_BUDGET_USD, "NOVA_OPENAI_TASK_BUDGET_USD"),
      }),
    }),
    browserRun: Object.freeze({
      configured: Boolean(environment.NOVA_BRAIN_CLOUDFLARE_ACCOUNT_ID&&environment.NOVA_BRAIN_CLOUDFLARE_BROWSER_TOKEN),
      accountId: environment.NOVA_BRAIN_CLOUDFLARE_ACCOUNT_ID||null,
      apiToken: environment.NOVA_BRAIN_CLOUDFLARE_BROWSER_TOKEN||null,
      budgetId: environment.NOVA_BROWSER_PROVIDER_BUDGET_ID||"nova-browser-provider-v1",
      globalBudgetUsd: parseBudgetMoney(environment.NOVA_BROWSER_PROVIDER_BUDGET_USD??"0.50","NOVA_BROWSER_PROVIDER_BUDGET_USD"),
      normalReservationUsd: parseBudgetMoney(environment.NOVA_BROWSER_PROVIDER_NORMAL_RESERVATION_USD??"0.01","NOVA_BROWSER_PROVIDER_NORMAL_RESERVATION_USD"),
      heavyReservationUsd: parseBudgetMoney(environment.NOVA_BROWSER_PROVIDER_HEAVY_RESERVATION_USD??"0.02","NOVA_BROWSER_PROVIDER_HEAVY_RESERVATION_USD"),
    }),
    integrations: Object.freeze({
      githubConfigured: Boolean(
        environment.NOVA_BRAIN_GITHUB_TOKEN &&
          environment.NOVA_BRAIN_GITHUB_REPOSITORY,
      ),
      vercelConfigured: Boolean(
        environment.NOVA_BRAIN_VERCEL_TOKEN &&
          (environment.NOVA_BRAIN_VERCEL_PROJECT_ID || environment.VERCEL_PROJECT_ID) &&
          (environment.NOVA_BRAIN_VERCEL_TEAM_ID || environment.VERCEL_TEAM_ID),
      ),
    }),
    gmail,
    phone,
    allowedOrigins: parseOrigins(environment.CORS_ALLOWED_ORIGINS),
    maxBodyBytes: 64 * 1024,
    developerWorkspaceHandoffMaxBodyBytes: 3 * 1024 * 1024,
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
      nextSpeechChunkCharacters: 420,
      speechLookahead: 2,
      ttsStability: 0.75,
      capabilityCacheMs: 10 * 60 * 1000,
      capabilityTimeoutMs: 5_000,
      ttsRetryDelayMs: 200,
      ttsConcurrencyRetryDelayMs: 1_200,
      requestTimeoutMs: 25_000,
      ttsFirstByteTimeoutMs: 10_000,
      ttsStreamStallTimeoutMs: 8_000,
      ttsChunkTimeoutMs: 45_000,
    }),
    speakerRecognition: Object.freeze({
      endpoint: environment.NOVA_SPEAKER_EXTRACTOR_URL || null,
      token: environment.NOVA_SPEAKER_EXTRACTOR_TOKEN || null,
      assertionKey: environment.NOVA_SPEAKER_ASSERTION_KEY || null,
      embeddingKey: environment.NOVA_SPEAKER_EMBEDDING_KEY || null,
      modelVersion:
        environment.NOVA_SPEAKER_EXTRACTOR_MODEL ||
        "speechbrain/spkrec-ecapa-voxceleb@ecapa-v1",
      minSpeechSeconds: 1.0,
      maxAudioBytes: 2 * 1024 * 1024,
      threshold: 0.35,
      ambiguityMargin: 0.05,
      familiarityThreshold: 0.55,
      familiarityAmbiguityMargin: 0.08,
    }),
    voiceBenchmark: Object.freeze({
      paidCallsApproved:
        environment.NOVA_VOICE_BENCHMARK_PAID_CALLS_APPROVED === "true",
      budgetUsd: parseMoney(
        environment.NOVA_VOICE_BENCHMARK_BUDGET_USD,
        "NOVA_VOICE_BENCHMARK_BUDGET_USD",
        2,
      ),
      maxAudioBytes: 2 * 1024 * 1024,
      maxBodyBytes: 3 * 1024 * 1024,
      credentials: Object.freeze({
        openai: environment.OPENAI_API_KEY || null,
        deepgram: environment.DEEPGRAM_API_KEY || null,
        elevenlabs: environment.ELEVENLABS_API_KEY || null,
        elevenlabsVoiceId: environment.ELEVENLABS_VOICE_ID || null,
        azureKey: environment.AZURE_SPEECH_KEY || null,
        azureRegion: environment.AZURE_SPEECH_REGION || null,
      }),
    }),
  });
}

function parseMoney(value, name, defaultValue) {
  if (value === undefined || value === "") return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 2)
    throw new Error(`${name} must be greater than 0 and no more than 2.00.`);
  return Math.round(parsed * 100) / 100;
}

function parseBudgetMoney(value, name) {
  if (value === undefined || value === "") return 0;
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) throw new Error(`${name} must be a non-negative USD amount with at most 6 decimal places.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100_000) throw new Error(`${name} must be between 0 and 100000 USD.`);
  return parsed;
}

function parseInteger(value, name, { defaultValue, min, max }) {
  if (value === undefined || value === "") return defaultValue;

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }

  return parsed;
}
