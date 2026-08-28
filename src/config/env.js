const SUPPORTED_MODEL_PROVIDERS = new Set(["mock"]);

function parseOrigins(value) {
  if (!value) return [];

  return [...new Set(value.split(",").map((origin) => origin.trim()).filter(Boolean))];
}

export function readConfig(environment = process.env) {
  const modelProvider = environment.NOVA_BRAIN_MODEL_PROVIDER || "mock";

  if (!SUPPORTED_MODEL_PROVIDERS.has(modelProvider)) {
    throw new Error(`Unsupported NOVA_BRAIN_MODEL_PROVIDER: ${modelProvider}`);
  }

  return Object.freeze({
    nodeEnv: environment.NODE_ENV || "development",
    modelProvider,
    allowedOrigins: parseOrigins(environment.CORS_ALLOWED_ORIGINS),
    maxBodyBytes: 64 * 1024
  });
}
