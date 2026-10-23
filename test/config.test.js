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
    web: { model: "gpt-6-luna", reasoningEffort: "none", maxOutputTokens: null, stage: "web_research" },
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
    NOVA_BRAIN_WEB_MODEL: "web-model",
    NOVA_BRAIN_WEB_REASONING_EFFORT: "low",
    NOVA_BRAIN_WEB_MAX_OUTPUT_TOKENS: "1024",
    NOVA_BRAIN_OPENAI_SERVICE_TIER: "flex",
  });
  assert.deepEqual(config.openAI.routes.chat, { model: "economical-model", reasoningEffort: "low", maxOutputTokens: 2048, stage: "chat" });
  assert.equal(config.openAI.routes.planner.model, "strong-model");
  assert.equal(config.openAI.routes.noChange.model, "economical-model");
  assert.equal(config.openAI.routes.noChange.reasoningEffort, "none");
  assert.deepEqual(config.openAI.routes.web, { model: "web-model", reasoningEffort: "low", maxOutputTokens: 1024, stage: "web_research" });
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

test("model spending authority is explicit, disabled by default, and bounded", () => {
  const disabled = readConfig({ NOVA_BRAIN_MODEL_PROVIDER: "openai", OPENAI_API_KEY: "key", OPENAI_MODEL: "gpt-6-sol" });
  assert.deepEqual(disabled.openAI.budget, { budgetId: "disabled", globalBudgetUsd: 0, taskBudgetUsd: 0 });
  const configured = readConfig({ NOVA_BRAIN_MODEL_PROVIDER: "openai", OPENAI_API_KEY: "key", OPENAI_MODEL: "gpt-6-sol", NOVA_OPENAI_BUDGET_ID: "recharge-2026-09-24-01", NOVA_OPENAI_GLOBAL_BUDGET_USD: "20", NOVA_OPENAI_TASK_BUDGET_USD: "3.50" });
  assert.deepEqual(configured.openAI.budget, { budgetId: "recharge-2026-09-24-01", globalBudgetUsd: 20, taskBudgetUsd: 3.5 });
  assert.throws(() => readConfig({ NOVA_OPENAI_BUDGET_ID: "bad id" }), /stable 1-80 character/);
  assert.throws(() => readConfig({ NOVA_OPENAI_GLOBAL_BUDGET_USD: "-1" }), /non-negative USD/);
  assert.throws(() => readConfig({ NOVA_OPENAI_TASK_BUDGET_USD: "1.0000001" }), /at most 6 decimal/);
});

test("browser provider authority is disabled without both secrets and keeps a separate conservative ledger",()=>{
  const disabled=readConfig({});assert.equal(disabled.browserRun.configured,false);assert.equal(disabled.browserRun.globalBudgetUsd,0.5);
  const configured=readConfig({NOVA_BRAIN_CLOUDFLARE_ACCOUNT_ID:"account",NOVA_BRAIN_CLOUDFLARE_BROWSER_TOKEN:"secret",NOVA_BROWSER_PROVIDER_BUDGET_USD:"0.50",NOVA_BROWSER_PROVIDER_NORMAL_RESERVATION_USD:"0.01",NOVA_BROWSER_PROVIDER_HEAVY_RESERVATION_USD:"0.02"});assert.deepEqual(configured.browserRun,{configured:true,accountId:"account",apiToken:"secret",budgetId:"nova-browser-provider-v1",globalBudgetUsd:0.5,normalReservationUsd:0.01,heavyReservationUsd:0.02});
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

test("project discovery requires its own paired team token and never reuses deployment credentials",()=>{
  const deploymentOnly=readConfig({NOVA_BRAIN_VERCEL_TOKEN:"deployment-only",NOVA_BRAIN_VERCEL_TEAM_ID:"team_owner",NOVA_BRAIN_VERCEL_PROJECT_ID:"prj_nova"});
  assert.equal(deploymentOnly.projectDiscovery.vercelToken,null);
  assert.equal(deploymentOnly.projectDiscovery.vercelTeamId,null);
  assert.equal(deploymentOnly.projectDiscovery.vercelIntegration.teamToken,null);
  assert.throws(()=>readConfig({NOVA_PROJECT_DISCOVERY_VERCEL_TOKEN:"discovery-only"}),/must be configured together/);
  assert.throws(()=>readConfig({NOVA_PROJECT_DISCOVERY_VERCEL_TEAM_ID:"team_owner"}),/must be configured together/);
  const configured=readConfig({NOVA_PROJECT_DISCOVERY_VERCEL_TOKEN:"dedicated-discovery",NOVA_PROJECT_DISCOVERY_VERCEL_TEAM_ID:"team_owner"});
  assert.equal(configured.projectDiscovery.vercelToken,"dedicated-discovery");
  assert.equal(configured.projectDiscovery.vercelTeamId,"team_owner");
  assert.equal(configured.projectDiscovery.vercelIntegration.teamToken,"dedicated-discovery");
});

test("Neon discovery requires a dedicated organization-bound credential pair",()=>{
  assert.throws(()=>readConfig({NOVA_PROJECT_DISCOVERY_NEON_API_KEY:"discovery-only"}),/must be configured together/);
  assert.throws(()=>readConfig({NOVA_PROJECT_DISCOVERY_NEON_ORG_ID:"org-owner"}),/must be configured together/);
  assert.throws(()=>readConfig({NOVA_PROJECT_DISCOVERY_NEON_API_KEY:"dedicated-neon",NOVA_PROJECT_DISCOVERY_NEON_ORG_ID:"wrong"}),/NEON_ORG_ID is invalid/);
  const configured=readConfig({NOVA_PROJECT_DISCOVERY_NEON_API_KEY:"dedicated-neon",NOVA_PROJECT_DISCOVERY_NEON_ORG_ID:"org-owner"});
  assert.equal(configured.projectDiscovery.neonApiKey,"dedicated-neon");
  assert.equal(configured.projectDiscovery.neonOrgId,"org-owner");
});

test("private Sharp Cuts R2 storage is all-or-none, free-tier bounded, and disabled by default",()=>{const disabled=readConfig({});assert.equal(disabled.socialMedia.r2Configured,false);assert.equal(disabled.socialMedia.hardQuotaBytes,8*1024**3);assert.equal(disabled.socialMedia.classALimit,800000);assert.equal(disabled.socialMedia.classBLimit,8000000);assert.equal(disabled.socialMedia.approvedOverageCents,0);assert.throws(()=>readConfig({NOVA_SHARP_CUTS_R2_ACCOUNT_ID:"a".repeat(32)}),/All four/);assert.throws(()=>readConfig({NOVA_SHARP_CUTS_R2_HARD_QUOTA_BYTES:String(11*1024**3)}),/free allowances/);const configured=readConfig({NOVA_SHARP_CUTS_R2_ACCOUNT_ID:"a".repeat(32),NOVA_SHARP_CUTS_R2_BUCKET:"sharp-cuts-approved",NOVA_SHARP_CUTS_R2_ACCESS_KEY_ID:"server-only-key",NOVA_SHARP_CUTS_R2_SECRET_ACCESS_KEY:"server-only-secret",NOVA_SHARP_CUTS_R2_HARD_QUOTA_BYTES:String(1024**3)});assert.equal(configured.socialMedia.r2Configured,true);assert.equal(configured.socialMedia.hardQuotaBytes,1024**3);});

test("cloud social scheduler uses a separate bounded secret and remains unconfigured by default",()=>{assert.equal(readConfig({}).socialSchedulerToken,null);assert.throws(()=>readConfig({NOVA_SOCIAL_SCHEDULER_TOKEN:"short"}),/at least 32 bytes/);assert.throws(()=>readConfig({NOVA_SOCIAL_SCHEDULER_TOKEN:"s".repeat(32),NOVA_LOCAL_WORKER_TOKEN:"s".repeat(32)}),/remain separate/);assert.equal(readConfig({NOVA_SOCIAL_SCHEDULER_TOKEN:"s".repeat(32)}).socialSchedulerToken,"s".repeat(32));});
