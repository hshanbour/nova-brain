import test from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../src/config/env.js";

test("mock provider remains the credential-free default", () => {
  const config = readConfig({});
  assert.equal(config.modelProvider, "mock");
  assert.equal(config.maxAgentSteps, 5);
  assert.equal(config.maxToolCallsPerStep, 4);
});

test("OpenAI provider configuration requires credentials and a model", () => {
  assert.throws(
    () => readConfig({ NOVA_BRAIN_MODEL_PROVIDER: "openai" }),
    /OPENAI_API_KEY is required/
  );
  assert.throws(
    () =>
      readConfig({
        NOVA_BRAIN_MODEL_PROVIDER: "openai",
        OPENAI_API_KEY: "test-key"
      }),
    /OPENAI_MODEL is required/
  );

  const config = readConfig({
    NOVA_BRAIN_MODEL_PROVIDER: "openai",
    OPENAI_API_KEY: "test-key",
    OPENAI_MODEL: "test-model"
  });
  assert.equal(config.modelProvider, "openai");
  assert.equal(config.openAI.model, "test-model");
});

test("agent execution limits are bounded configuration values", () => {
  assert.throws(() => readConfig({ NOVA_BRAIN_MAX_STEPS: "0" }), /between 1 and 10/);
  assert.throws(
    () => readConfig({ NOVA_BRAIN_MAX_TOOL_CALLS_PER_STEP: "11" }),
    /between 1 and 10/
  );
});

test("storage auto-detects durable Postgres without exposing its connection string", () => {
  const config = readConfig({ DATABASE_URL: "postgresql://private-token@example/db" });
  assert.equal(config.storageProvider, "postgres");
  assert.equal(config.databaseUrl, "postgresql://private-token@example/db");
  assert.equal(JSON.stringify({ provider: config.storageProvider }).includes("private-token"), false);
  assert.throws(() => readConfig({ NOVA_BRAIN_STORAGE_PROVIDER: "postgres" }), /Postgres connection variable is required/);
});
