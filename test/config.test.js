import test from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../src/config/env.js";

test("mock provider remains the credential-free default", () => {
  const config = readConfig({});
  assert.equal(config.modelProvider, "mock");
  assert.equal(config.maxAgentSteps, 10);
  assert.equal(config.maxToolCallsPerStep, 4);
  assert.equal(config.syncAgentDeadlineMs, 75_000);
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
  assert.equal(config.openAI.serviceTier, "default");
  assert.deepEqual(config.openAI.routes, {
    chat: { model: "gpt-6-luna", reasoningEffort: "none", maxOutputTokens: null, stage: "chat" },
    intake: { model: "gpt-6-luna", reasoningEffort: "none", maxOutputTokens: null, stage: "intake" },
    planner: { model: "test-model", reasoningEffort: null, maxOutputTokens: null, stage: "planner" },
    noChange: { model: "gpt-6-luna", reasoningEffort: "none", maxOutputTokens: null, stage: "no_change" },
  });
});

test("OpenAI stage routing is explicit, bounded, and excludes premium service tiers", () => {
  const config = readConfig({
    NOVA_BRAIN_MODEL_PROVIDER: "openai",
    OPENAI_API_KEY: "test-key",
    OPENAI_MODEL: "strong-model",
    NOVA_BRAIN_CHAT_MODEL: "economical-model",
    NOVA_BRAIN_CHAT_REASONING_EFFORT: "low",
    NOVA_BRAIN_CHAT_MAX_OUTPUT_TOKENS: "2048",
    NOVA_BRAIN_NO_CHANGE_MODEL: "economical-model",
    NOVA_BRAIN_OPENAI_SERVICE_TIER: "flex",
  });
  assert.deepEqual(config.openAI.routes.chat, { model: "economical-model", reasoningEffort: "low", maxOutputTokens: 2048, stage: "chat" });
  assert.equal(config.openAI.routes.planner.model, "strong-model");
  assert.equal(config.openAI.routes.noChange.model, "economical-model");
  assert.equal(config.openAI.routes.noChange.reasoningEffort, "none");
  assert.equal(config.openAI.serviceTier, "flex");
  assert.throws(() => readConfig({ NOVA_BRAIN_MODEL_PROVIDER:"openai", OPENAI_API_KEY:"key", OPENAI_MODEL:"model", NOVA_BRAIN_OPENAI_SERVICE_TIER:"priority" }), /default or flex/);
  assert.throws(() => readConfig({ NOVA_BRAIN_MODEL_PROVIDER:"openai", OPENAI_API_KEY:"key", OPENAI_MODEL:"model", NOVA_BRAIN_CHAT_REASONING_EFFORT:"extreme" }), /must be one of/);
  assert.throws(() => readConfig({ NOVA_BRAIN_MODEL_PROVIDER:"openai", OPENAI_API_KEY:"key", OPENAI_MODEL:"model", NOVA_BRAIN_CHAT_MAX_OUTPUT_TOKENS:"255" }), /between 256 and 128000/);
});

test("economical defaults do not downgrade planner or explicit stage overrides", () => {
  const config = readConfig({
    NOVA_BRAIN_MODEL_PROVIDER: "openai",
    OPENAI_API_KEY: "test-key",
    OPENAI_MODEL: "strong-model",
    NOVA_BRAIN_CHAT_MODEL: "chat-override",
    NOVA_BRAIN_CHAT_REASONING_EFFORT: "medium",
    NOVA_BRAIN_NO_CHANGE_MODEL: "no-change-override",
    NOVA_BRAIN_NO_CHANGE_REASONING_EFFORT: "low",
  });

  assert.equal(config.openAI.routes.chat.model, "chat-override");
  assert.equal(config.openAI.routes.chat.reasoningEffort, "medium");
  assert.equal(config.openAI.routes.noChange.model, "no-change-override");
  assert.equal(config.openAI.routes.noChange.reasoningEffort, "low");
  assert.equal(config.openAI.routes.planner.model, "strong-model");
  assert.equal(config.openAI.routes.planner.reasoningEffort, null);
});

test("agent execution limits are bounded configuration values", () => {
  assert.throws(() => readConfig({ NOVA_BRAIN_MAX_STEPS: "0" }), /between 1 and 10/);
  assert.throws(() => readConfig({ NOVA_BRAIN_MAX_STEPS: "11" }), /between 1 and 10/);
  assert.throws(() => readConfig({ NOVA_BRAIN_SYNC_DEADLINE_MS: "90001" }), /between 10000 and 90000/);
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
