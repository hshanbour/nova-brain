const SUPPORTED_MODEL_PROVIDERS = new Set(["mock", "openai"]);

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
    openAI: Object.freeze({
      apiKey: environment.OPENAI_API_KEY || null,
      model: environment.OPENAI_MODEL || null
    }),
    allowedOrigins: parseOrigins(environment.CORS_ALLOWED_ORIGINS),
    maxBodyBytes: 64 * 1024
  });
}

function parseInteger(value, name, { defaultValue, min, max }) {
  if (value === undefined || value === "") return defaultValue;

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }

  return parsed;
}
