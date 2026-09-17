import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createApi } from "../src/http/api.js";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";
import {
  createDeveloperSessionSmoke,
  DEVELOPER_SMOKE_ALLOWED_PATHS,
  DEVELOPER_SMOKE_BASE_SHA,
  DEVELOPER_SMOKE_BRANCH,
  DEVELOPER_SMOKE_TASK_ID,
} from "../src/autonomy/developer-session-smoke.js";
import { createDeterministicDeveloperProvider } from "../src/providers/developer-session-providers.js";

const OWNER = "owner";
const ADMIN = "a".repeat(40);
const SECRET = "sk-live-secret-must-never-serialize";

function environment(overrides = {}) {
  return {
    VERCEL_ENV: "preview",
    VERCEL_GIT_COMMIT_REF: DEVELOPER_SMOKE_BRANCH,
    OPENAI_API_KEY: SECRET,
    OPENAI_MODEL: "gpt-5.2-codex",
    ...overrides,
  };
}

function request({ method, url, body, authorized = true }) {
  const stream = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  stream.method = method;
  stream.url = url;
  stream.headers = {
    ...(body === undefined ? {} : { "content-type": "application/json" }),
    ...(authorized ? { authorization: `Bearer ${ADMIN}` } : {}),
  };
  return stream;
}

function response() {
  let body = "";
  return {
    statusCode: 0,
    setHeader() {},
    end(value = "") { body += value; },
    get json() { return body ? JSON.parse(body) : null; },
  };
}

function api(smoke) {
  return createApi({
    agent: { tools: { list: () => [] }, run: async () => { throw new Error("unused"); } },
    config: { allowedOrigins: [], maxBodyBytes: 64 * 1024, workerAdminToken: ADMIN },
    storage: { provider: "memory", durable: false },
    initialize: async () => {},
    ownerId: OWNER,
    developerSessionSmoke: smoke,
    logger: { info() {}, error() {} },
  });
}

function fixture({ env = environment(), script, providerError } = {}) {
  const storage = createInMemoryStorage();
  const provider = providerError || createDeterministicDeveloperProvider(script || [
    { providerSessionId: "remote-session-1", status: "running", changedPaths: [] },
  ]);
  const providerConfigurations = [];
  const smoke = createDeveloperSessionSmoke({
    environment: env,
    storage,
    ownerId: OWNER,
    providerFactory(configuration) {
      providerConfigurations.push(configuration);
      return provider;
    },
    idFactory: () => "nova-smoke-session-1",
    clock: () => new Date("2026-09-16T12:00:00.000Z"),
  });
  return { storage, provider, providerConfigurations, smoke, app: api(smoke) };
}

test("developer smoke invocation rejects unauthenticated callers", async () => {
  let called = false;
  const app = api({ async start() { called = true; } });
  const res = response();
  await app.handle(request({ method: "POST", url: "/api/admin/developer-sessions/smoke/start", body: {}, authorized: false }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(called, false);
});

test("developer smoke invocation is limited to the exact Preview branch", async () => {
  for (const env of [
    environment({ VERCEL_ENV: "production" }),
    environment({ VERCEL_GIT_COMMIT_REF: "main" }),
  ]) {
    const { app } = fixture({ env });
    const res = response();
    await app.handle(request({ method: "POST", url: "/api/admin/developer-sessions/smoke/start", body: {} }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.json.code, "developer_smoke_preview_only");
  }
});

test("protected Preview invocation uses server-only inline agent and bounded hosted environment", async () => {
  const { app, providerConfigurations } = fixture();
  const res = response();
  await app.handle(request({ method: "POST", url: "/api/admin/developer-sessions/smoke/start", body: {} }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.json.session.id, "nova-smoke-session-1");
  assert.equal(res.json.session.taskId, DEVELOPER_SMOKE_TASK_ID);
  assert.equal(res.json.session.policy.baseSha, DEVELOPER_SMOKE_BASE_SHA);
  assert.deepEqual(res.json.session.policy.allowedPaths, DEVELOPER_SMOKE_ALLOWED_PATHS);
  assert.equal(res.json.session.policy.dryRun, true);
  assert.equal(res.json.session.policy.approvalPolicy.allowPush, false);
  assert.equal(res.json.session.policy.approvalPolicy.allowDeploy, false);
  assert.equal(res.json.session.mutationPerformed, false);
  assert.equal(providerConfigurations[0].agentId, undefined);
  assert.equal(providerConfigurations[0].agent.model, "gpt-5.2-codex");
  assert.deepEqual(providerConfigurations[0].environment.network, { access: "disabled" });
  assert.doesNotMatch(JSON.stringify(res.json), /sk-live-secret|OPENAI_API_KEY/);
});

test("missing deployed OPENAI_API_KEY fails closed without fabricating a session", async () => {
  const { app, storage } = fixture({ env: environment({ OPENAI_API_KEY: "" }) });
  const res = response();
  await app.handle(request({ method: "POST", url: "/api/admin/developer-sessions/smoke/start", body: {} }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.json.code, "developer_smoke_openai_key_missing");
  assert.equal(await storage.getDeveloperSession("nova-smoke-session-1", OWNER), null);
});

test("caller cannot widen scope or replace the forbidden-path contract", async () => {
  for (const body of [
    { allowedPaths: [...DEVELOPER_SMOKE_ALLOWED_PATHS, "package.json"] },
    { forbiddenPaths: [] },
    { provider: "legacy" },
    { taskId: "selfdev_1a8f17abea3f043813fc4b5fc5db0e36" },
  ]) {
    const { app } = fixture();
    const res = response();
    await app.handle(request({ method: "POST", url: "/api/admin/developer-sessions/smoke/start", body }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.json.code, "developer_smoke_scope_forbidden");
  }
});

test("status and approval resume preserve the same durable provider session", async () => {
  const { app, provider } = fixture({ script: [
    { providerSessionId: "remote-session-1", status: "requires_action", approval: { requiredActions: [{ type: "function_call", call_id: "call-1", turn_id: "turn-1" }] }, changedPaths: [] },
    { providerSessionId: "remote-session-1", status: "requires_action", approval: { requiredActions: [{ type: "function_call", call_id: "call-1", turn_id: "turn-1" }] }, changedPaths: [] },
    { providerSessionId: "remote-session-1", status: "completed", result: { outcome: "inspected" }, changedPaths: [] },
  ] });
  const started = response();
  await app.handle(request({ method: "POST", url: "/api/admin/developer-sessions/smoke/start", body: {} }), started);
  assert.equal(started.json.session.status, "approval_required");
  const status = response();
  await app.handle(request({ method: "GET", url: "/api/admin/developer-sessions/nova-smoke-session-1" }), status);
  assert.equal(status.json.session.providerSessionId, "remote-session-1");
  const resumed = response();
  await app.handle(request({ method: "POST", url: "/api/admin/developer-sessions/nova-smoke-session-1/resume", body: { approvalDecision: "approved", additionalInstruction: "Continue the same non-mutating bounded smoke session." } }), resumed);
  assert.equal(resumed.json.session.providerSessionId, "remote-session-1");
  assert.equal(resumed.json.session.status, "completed");
  assert.equal(provider.calls[1].input.providerSessionId, "remote-session-1");
  assert.equal(provider.calls[2].input.providerSessionId, "remote-session-1");
});

test("cancel uses the same persisted provider session and remains authenticated", async () => {
  const { app, provider } = fixture({ script: [
    { providerSessionId: "remote-session-1", status: "running", changedPaths: [] },
    { providerSessionId: "remote-session-1", status: "cancelled", changedPaths: [] },
  ] });
  const started = response();
  await app.handle(request({ method: "POST", url: "/api/admin/developer-sessions/smoke/start", body: {} }), started);
  const denied = response();
  await app.handle(request({ method: "POST", url: "/api/admin/developer-sessions/nova-smoke-session-1/cancel", body: {}, authorized: false }), denied);
  assert.equal(denied.statusCode, 401);
  const cancelled = response();
  await app.handle(request({ method: "POST", url: "/api/admin/developer-sessions/nova-smoke-session-1/cancel", body: {} }), cancelled);
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.json.session.status, "cancelled");
  assert.equal(cancelled.json.session.providerSessionId, "remote-session-1");
  assert.equal(provider.calls[1].input.providerSessionId, "remote-session-1");
});

test("provider failure is persisted as a bounded closed failure", async () => {
  const failed = createDeterministicDeveloperProvider([Object.assign(new Error("Bearer secret detail"), { code: "upstream_broken" })]);
  const { app } = fixture({ providerError: failed });
  const res = response();
  await app.handle(request({ method: "POST", url: "/api/admin/developer-sessions/smoke/start", body: {} }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.json.session.status, "failed");
  assert.equal(res.json.session.error.code, "upstream_broken");
  assert.doesNotMatch(JSON.stringify(res.json), /Bearer secret detail|sk-live-secret/);
});

test("smoke mode never calls real autonomy-task mutation methods", async () => {
  const base = createInMemoryStorage();
  let autonomyMutation = false;
  const storage = new Proxy(base, {
    get(target, property, receiver) {
      if (typeof property === "string" && /AutonomyTask/.test(property) && /create|update|migrate|complete|fail|recover/i.test(property)) {
        return async () => { autonomyMutation = true; throw new Error("unexpected autonomy mutation"); };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const provider = createDeterministicDeveloperProvider([{ providerSessionId: "remote-session-1", status: "completed", result: { outcome: "done" }, changedPaths: [] }]);
  const smoke = createDeveloperSessionSmoke({ environment: environment(), storage, ownerId: OWNER, providerFactory: () => provider, idFactory: () => "isolated-smoke" });
  const session = await smoke.start({});
  assert.equal(session.status, "completed");
  assert.equal(autonomyMutation, false);
  assert.equal(session.taskId, DEVELOPER_SMOKE_TASK_ID);
});
