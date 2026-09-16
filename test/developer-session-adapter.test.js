import test from "node:test";
import assert from "node:assert/strict";
import { createDeveloperSessionAdapter, DeveloperSessionError } from "../src/autonomy/developer-session-adapter.js";
import {
  createAgentsApiDeveloperProvider,
  createDeterministicDeveloperProvider,
  createDeveloperProviderRouter,
  createLegacyDeveloperProvider,
  DeveloperProviderConfigurationError,
} from "../src/providers/developer-session-providers.js";
import { createOpenAIModelProvider } from "../src/providers/openai-model-provider.js";
import { MICROPHONE_ACCEPTANCE, MICROPHONE_ALLOWED_PATHS, microphoneDeveloperRequest, persistentTestStore } from "./developer-session-fixture.js";

function adapter(provider, store = persistentTestStore(), defaultProvider = "legacy") {
  return createDeveloperSessionAdapter({ providers: { [defaultProvider]: provider }, sessionStore: store, defaultProvider, idFactory: () => "nova-session-1", clock: () => new Date("2026-09-16T12:00:00.000Z") });
}

test("microphone fixture maps exact Nova policy and persists provider session identity", async () => {
  const provider = createDeterministicDeveloperProvider([{ providerSessionId: "agents-session-1", status: "requires_action", approval: { action: "shell", command: "npm test" }, changedPaths: [] }]);
  const store = persistentTestStore();
  const result = await adapter(provider, store).startDeveloperSession(microphoneDeveloperRequest());
  assert.equal(result.status, "approval_required");
  assert.equal(result.providerSessionId, "agents-session-1");
  assert.deepEqual(provider.calls[0].input.policy.allowedPaths, MICROPHONE_ALLOWED_PATHS);
  assert.deepEqual(provider.calls[0].input.policy.acceptanceCriteria, MICROPHONE_ACCEPTANCE);
  assert.equal(provider.calls[0].input.policy.baseSha, "911c1bc472e6017fac65146dd14298966a11c26f");
  assert.equal(provider.calls[0].input.policy.repository.slug, "hshanbour/nova-brain");
  assert.equal(provider.calls[0].input.policy.approvalPolicy.allowPush, false);
  assert.equal(provider.calls[0].input.policy.approvalPolicy.allowDeploy, false);
  assert.equal((await store.get("nova-session-1")).providerSessionId, "agents-session-1");
});

test("approval round trip resumes the same persistent provider session and returns structured completion", async () => {
  const provider = createDeterministicDeveloperProvider([
    { providerSessionId: "agents-session-1", status: "requires_action", approval: { action: "shell" }, changedPaths: [] },
    { providerSessionId: "agents-session-1", status: "completed", result: { outcome: "verified", tests: { passed: 10, failed: 0 } }, changedPaths: [] },
  ]);
  const api = adapter(provider);
  await api.startDeveloperSession(microphoneDeveloperRequest());
  const result = await api.resumeDeveloperSession({ sessionId: "nova-session-1", approvalDecision: "approved", additionalInstruction: "Run only the bounded fixture." });
  assert.equal(provider.calls[1].input.providerSessionId, "agents-session-1");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.result, { outcome: "verified", tests: { passed: 10, failed: 0 } });
  assert.equal(result.events.at(-1).type, "developer_session.status");
  assert.deepEqual(result.events.at(-1).result, result.result);
});

test("a new adapter instance resumes the provider session persisted by the first instance", async () => {
  const provider = createDeterministicDeveloperProvider([
    { providerSessionId: "durable-agents-session", status: "requires_action", approval: { action: "shell" }, changedPaths: [] },
    { providerSessionId: "durable-agents-session", status: "completed", result: { outcome: "same-session" }, changedPaths: [] },
  ]);
  const store = persistentTestStore();
  await adapter(provider, store).startDeveloperSession(microphoneDeveloperRequest());
  const resumed = await adapter(provider, store).resumeDeveloperSession({ sessionId: "nova-session-1", approvalDecision: "approved" });
  assert.equal(resumed.providerSessionId, "durable-agents-session");
  assert.equal(resumed.result.outcome, "same-session");
});

test("status and cancellation stay bound to the persisted provider session", async () => {
  const provider = createDeterministicDeveloperProvider([
    { providerSessionId: "long-running", status: "running", changedPaths: [] },
    { providerSessionId: "long-running", status: "requires_action", approval: { action: "shell" }, changedPaths: [] },
    { providerSessionId: "long-running", status: "cancelled", changedPaths: [] },
  ]);
  const api = adapter(provider);
  await api.startDeveloperSession(microphoneDeveloperRequest());
  assert.equal((await api.getDeveloperSession({ sessionId: "nova-session-1" })).status, "approval_required");
  assert.equal((await api.cancelDeveloperSession({ sessionId: "nova-session-1" })).status, "cancelled");
  assert.equal(provider.calls[1].input.providerSessionId, "long-running");
  assert.equal(provider.calls[2].input.providerSessionId, "long-running");
});

test("idle is resumable and continuation keeps the same provider session", async () => {
  const provider = createDeterministicDeveloperProvider([
    { providerSessionId: "idle-session", status: "idle", changedPaths: [] },
    { providerSessionId: "idle-session", status: "running", changedPaths: [] },
  ]);
  const api = adapter(provider);
  const started = await api.startDeveloperSession(microphoneDeveloperRequest());
  assert.equal(started.status, "idle");
  const resumed = await api.resumeDeveloperSession({ sessionId: "nova-session-1", additionalInstruction: "Continue the bounded task." });
  assert.equal(resumed.status, "running");
  assert.equal(resumed.providerSessionId, "idle-session");
  assert.equal(provider.calls[1].input.providerSessionId, "idle-session");
});

test("a historically misclassified completion can reconcile from provider truth without creating a new session", async () => {
  const provider = createDeterministicDeveloperProvider([
    { providerSessionId: "historical-session", status: "completed", result: { outcome: "historically-misclassified" }, changedPaths: [] },
    { providerSessionId: "historical-session", status: "idle", evidence: { environmentId: "env-historical" } },
  ]);
  const api = adapter(provider);
  assert.equal((await api.startDeveloperSession(microphoneDeveloperRequest())).status, "completed");
  const reconciled = await api.reconcileDeveloperSession({ sessionId: "nova-session-1" });
  assert.equal(reconciled.status, "idle");
  assert.equal(reconciled.providerSessionId, "historical-session");
  assert.equal(reconciled.evidence.environmentId, "env-historical");
  assert.deepEqual(provider.calls.map((call) => call.method), ["start", "getStatus"]);
});

test("scope input and provider output fail closed", async () => {
  const noCall = createDeterministicDeveloperProvider([]);
  await assert.rejects(adapter(noCall).startDeveloperSession(microphoneDeveloperRequest({ allowedPaths: ["../secret"] })), (error) => error instanceof DeveloperSessionError && error.code === "developer_session_scope_invalid");
  const outside = createDeterministicDeveloperProvider([{ providerSessionId: "outside", status: "completed", result: { outcome: "done" }, changedPaths: ["package.json"] }]);
  await assert.rejects(adapter(outside).startDeveloperSession(microphoneDeveloperRequest({ dryRun: false })), (error) => error.code === "developer_provider_scope_violation");
});

test("dry-run fixture rejects any reported product mutation", async () => {
  const provider = createDeterministicDeveloperProvider([{ providerSessionId: "mutated", status: "running", changedPaths: [MICROPHONE_ALLOWED_PATHS[0]] }]);
  await assert.rejects(adapter(provider).startDeveloperSession(microphoneDeveloperRequest()), (error) => error.code === "developer_provider_mutation_forbidden");
});

test("provider failures persist a safe closed failure without leaking the upstream message", async () => {
  const provider = createDeterministicDeveloperProvider([Object.assign(new Error("Bearer sk-secret-value"), { code: "upstream_broken" })]);
  const result = await adapter(provider).startDeveloperSession(microphoneDeveloperRequest());
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "upstream_broken");
  assert.doesNotMatch(JSON.stringify(result), /sk-secret|Bearer/);
});

for (const upstreamStatus of [400, 401, 403, 404, 429, 503]) {
  test(`agents API session-create ${upstreamStatus} persists only bounded safe diagnostics`, async () => {
    const apiKey = "sk-private-upstream-key-123456789";
    const fetchImpl = async () => Response.json({
      error: {
        type: `request_type_${upstreamStatus}`,
        code: `request_code_${upstreamStatus}`,
        message: `Rejected upstream. Authorization: Bearer ${apiKey}; Cookie=session-private-value ${"x".repeat(400)}`,
      },
      raw_secret: "must-not-be-persisted",
      headers: { authorization: `Bearer ${apiKey}` },
    }, { status: upstreamStatus });
    const provider = createAgentsApiDeveloperProvider({
      apiKey,
      agent: { model: "gpt-5.2-codex" },
      environment: { type: "openai_hosted", network: { access: "disabled" } },
      fetchImpl,
    });

    const result = await adapter(provider, persistentTestStore(), "agents_api")
      .startDeveloperSession(microphoneDeveloperRequest({ provider: "agents_api" }));

    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "agents_api_request_failed");
    assert.equal(result.error.message, "Developer provider failed closed.");
    assert.deepEqual({ ...result.error.diagnostics, upstreamErrorMessage: undefined }, {
      stage: "agents_session_create",
      requestStage: "agents_session_create",
      classification: "upstream_http_error",
      upstreamStatus,
      upstreamErrorType: `request_type_${upstreamStatus}`,
      upstreamErrorCode: `request_code_${upstreamStatus}`,
      upstreamErrorMessage: undefined,
    });
    assert.ok(result.error.diagnostics.upstreamErrorMessage.length <= 256);
    assert.doesNotMatch(JSON.stringify(result), /private-upstream-key|session-private-value|must-not-be-persisted|authorization/i);
  });
}

test("legacy provider remains the safe routing default while agents_api is opt-in", async () => {
  const legacy = createLegacyDeveloperProvider({
    async start() { return { providerSessionId: "legacy-1", status: "running", changedPaths: [] }; },
    async resume() { return { providerSessionId: "legacy-1", status: "running", changedPaths: [] }; },
    async getStatus() { return { providerSessionId: "legacy-1", status: "running", changedPaths: [] }; },
    async cancel() { return { providerSessionId: "legacy-1", status: "cancelled", changedPaths: [] }; },
  });
  const agentsApi = createDeterministicDeveloperProvider([]);
  const routed = createDeveloperProviderRouter({ legacy, agentsApi });
  assert.equal(routed.defaultProvider, "legacy");
  assert.equal(routed.providers.legacy.name, "legacy");
  assert.equal(routed.providers.agents_api, agentsApi);
});

test("agents API provider fails closed without a live API key", () => {
  assert.throws(() => createAgentsApiDeveloperProvider({ agentId: "agent-1", environmentTemplateId: "env-1" }), (error) => error instanceof DeveloperProviderConfigurationError && error.code === "agents_api_configuration_required" && /OPENAI_API_KEY/.test(error.message));
});

test("agents API provider fails closed without a saved or valid inline agent configuration", () => {
  assert.throws(() => createAgentsApiDeveloperProvider({ apiKey: "test", environmentTemplateId: "env-1" }), (error) => error instanceof DeveloperProviderConfigurationError && error.code === "agents_api_configuration_required");
  assert.throws(() => createAgentsApiDeveloperProvider({ apiKey: "test", agent: { instructions: "missing model" }, environmentTemplateId: "env-1" }), (error) => error instanceof DeveloperProviderConfigurationError && error.code === "agents_api_configuration_required");
});

function agentsSessionFetch(requests) {
  return async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === "POST" && url.endsWith("/agents/sessions")) return Response.json({ id: "managed-1", status: "idle" });
    if (options.method === "POST") return new Response(null, { status: 200 });
    return Response.json({ id: "managed-1", status: "idle" });
  };
}

test("void Agents event responses are accepted without JSON parsing", async () => {
  const requests = [];
  const provider = createAgentsApiDeveloperProvider({
    apiKey: "test",
    agentId: "agent-1",
    environmentTemplateId: "env-1",
    fetchImpl: agentsSessionFetch(requests),
  });

  const result = await provider.start({ policy: microphoneDeveloperRequest(), policyHash: "void-event" });

  assert.equal(result.providerSessionId, "managed-1");
  assert.equal(result.status, "idle");
  assert.match(requests[1].url, /\/agents\/sessions\/managed-1\/events$/);
});

test("dependency files attach to the existing environment and verifier resumes only the same session", async () => {
  const requests = [];
  const provider = createAgentsApiDeveloperProvider({
    apiKey: "dependency-secret",
    agentId: "agent-1",
    environmentTemplateId: "env-template-1",
    async fetchImpl(url, options = {}) {
      requests.push({ url, options });
      if (options.method === "POST" && url.includes("/agents/environments/env-live/files")) {
        const body = JSON.parse(options.body);
        return Response.json({ environment_id: "env-live", object: "agent.environment.file", path: body.path, size_bytes: 1 });
      }
      if (options.method === "POST" && url.endsWith("/agents/sessions/provider-live/events")) return new Response(null, { status: 200 });
      if (url.includes("/items?") || url.includes("/artifacts?")) return Response.json({ data: [] });
      return Response.json({ id: "provider-live", status: "idle", environment: { id: "env-live" } });
    },
  });
  const files = ["dependencies.tar.gz", "manifest.json", "verify.mjs"].map((name) => ({
    type: "inline", path: `/workspace/.nova-dependency-handoff/${name}`, data: Buffer.from(name).toString("base64"),
  }));
  const result = await provider.materializeDependencies({
    providerSessionId: "provider-live",
    environmentId: "env-live",
    files,
    verificationInstruction: "Run exactly the bounded dependency verifier.",
  });
  assert.equal(result.providerSessionId, "provider-live");
  assert.equal(result.evidence.environmentId, "env-live");
  const uploads = requests.filter((item) => item.options.method === "POST" && item.url.includes("/agents/environments/env-live/files"));
  assert.equal(uploads.length, 3);
  assert.equal(requests.some((item) => item.url.endsWith("/agents/sessions") && item.options.method === "POST"), false);
  const event = requests.find((item) => item.url.endsWith("/agents/sessions/provider-live/events"));
  assert.match(JSON.parse(event.options.body).events[0].input[0].content[0].text, /dependency verifier/);
  for (const item of requests) assert.equal(item.options.headers["OpenAI-Beta"], "agents=v1");
  assert.doesNotMatch(JSON.stringify(result), /dependency-secret|Authorization/);
});

test("Agents session retrieval preserves bounded outputs artifacts tests environment and truthful changed paths", async () => {
  const provider = createAgentsApiDeveloperProvider({
    apiKey: "sk-provider-secret-123456789",
    agentId: "agent-1",
    environmentTemplateId: "env-1",
    async fetchImpl(url, options = {}) {
      if (options.method === "POST" && url.endsWith("/agents/sessions")) return Response.json({ id: "managed-evidence", status: "idle" });
      if (options.method === "POST") return new Response(null, { status: 200 });
      if (url.includes("/items?")) return Response.json({ data: [
        { id: "message-1", type: "message", role: "assistant", content: [{ type: "output_text", text: "Focused repair complete." }] },
        { id: "command-1", type: "command_execution", status: "completed", exit_code: 0, command: "node --test test/voice-input.test.js", changed_paths: ["/workspace/nova-brain/assets/voice-input.js"], test_summary: { passed: 7, failed: 0 } },
      ] });
      if (url.includes("/artifacts?")) return Response.json({ data: [{ id: "artifact-1", environment_id: "env-live", path: "/workspace/nova-brain/assets/voice-input.js", size_bytes: 123, turn_id: "turn-1" }] });
      return Response.json({ id: "managed-evidence", status: "idle", environment: { id: "env-live" } });
    },
  });

  const result = await provider.start({ policy: microphoneDeveloperRequest(), policyHash: "evidence" });
  assert.equal(result.status, "idle");
  assert.equal(result.evidence.environmentId, "env-live");
  assert.equal(result.evidence.latestOutput, "Focused repair complete.");
  assert.deepEqual(result.evidence.testSummary, { passed: 7, failed: 0 });
  assert.deepEqual(result.changedPaths, ["assets/voice-input.js"]);
  assert.deepEqual(result.evidence.artifacts[0], { id: "artifact-1", environmentId: "env-live", path: "/workspace/nova-brain/assets/voice-input.js", sizeBytes: 123, turnId: "turn-1" });
  assert.equal(result.evidence.commandSummaries[0].exitCode, 0);
  assert.equal(result.evidence.commandSummaries[0].executable, "node");
  assert.doesNotMatch(JSON.stringify(result), /provider-secret|Authorization|Bearer/);
});

test("Agents reconciliation retains bounded structured failures from large TAP command output", async () => {
  const noise = "diagnostic noise that must not be retained\n".repeat(600);
  const output = `${noise}
# tests 761
# suites 0
# pass 758
# fail 3
# cancelled 0
# skipped 0
# todo 0

✖ failing tests:

test at file:///workspace/nova-brain/test/api.test.js:412:1
✖ API preserves the existing draft (10ms)
  AssertionError [ERR_ASSERTION]: expected draft to remain; OPENAI_API_KEY=never-persist-this

test at file:///workspace/nova-brain/test/voice-benchmark.test.js:88:1
✖ voice benchmark stays below latency budget (4ms)
  AssertionError: latency threshold exceeded

test at file:///workspace/nova-brain/test/voice-v2-service.test.js:155:1
✖ voice v2 service preserves mixed script (3ms)
  AssertionError: mixed script mismatch
`;
  const provider = createAgentsApiDeveloperProvider({
    apiKey: "test",
    agentId: "agent-1",
    environmentTemplateId: "env-1",
    async fetchImpl(url, options = {}) {
      if (options.method === "POST" && url.endsWith("/agents/sessions")) return Response.json({ id: "managed-full-suite", status: "idle", environment: { id: "env-live" } });
      if (options.method === "POST") return new Response(null, { status: 200 });
      if (url.includes("/items?")) return Response.json({ data: [{ id: "command-full", turn_id: "turn-full", type: "command_execution", status: "failed", exit_code: 1, command: "npm test", output }] });
      if (url.includes("/artifacts?")) return Response.json({ data: [] });
      return Response.json({ id: "managed-full-suite", status: "idle", environment: { id: "env-live" } });
    },
  });
  const store = persistentTestStore();
  const api = adapter(provider, store, "agents_api");
  const started = await api.startDeveloperSession(microphoneDeveloperRequest());
  const reconciled = await api.reconcileDeveloperSession({ sessionId: started.id });
  const evidence = reconciled.evidence.testFailureEvidence;

  assert.deepEqual(evidence.totals, { total: 761, passed: 758, failed: 3, cancelled: 0, skipped: 0, todo: 0 });
  assert.equal(evidence.exitCode, 1);
  assert.equal(evidence.failures.length, 3);
  assert.equal(evidence.failureEvidenceIncomplete, false);
  assert.equal(evidence.failures[0].title, "API preserves the existing draft");
  assert.equal(evidence.failures[0].filePath, "test/api.test.js");
  assert.equal(evidence.failures[0].sourceLocation, "test/api.test.js:412:1");
  assert.equal(evidence.failures[1].errorType, "AssertionError");
  assert.equal((await store.get(started.id)).evidence.testFailureEvidence.failures[2].filePath, "test/voice-v2-service.test.js");
  const serialized = JSON.stringify(reconciled);
  assert.doesNotMatch(serialized, /diagnostic noise|never-persist-this|OPENAI_API_KEY|rawOutput|stdout|stderr/);
  assert.ok(evidence.failures.every((record) => Buffer.byteLength(JSON.stringify(record)) <= 2_048));
  assert.ok(Buffer.byteLength(JSON.stringify(evidence.failures)) <= 16_384);
});

test("Agents test evidence caps failed records and marks unavailable details incomplete", async () => {
  const failures = Array.from({ length: 23 }, (_, index) => `not ok ${index + 1} - failed test ${index + 1}\n  ---\n  error: 'failure ${index + 1}'\n  ...`).join("\n");
  const outputs = [
    `${failures}\n# tests 30\n# pass 7\n# fail 23`,
    "# tests 761\n# pass 758\n# fail 3",
    "# tests 10\n# pass 10\n# fail 0",
  ];
  let retrieval = 0;
  const provider = createAgentsApiDeveloperProvider({
    apiKey: "test",
    agentId: "agent-1",
    environmentTemplateId: "env-1",
    async fetchImpl(url) {
      if (url.includes("/items?")) {
        const output = outputs[Math.min(retrieval++, outputs.length - 1)];
        return Response.json({ data: [{ id: `command-${retrieval}`, type: "command_execution", status: retrieval === 3 ? "completed" : "failed", exit_code: retrieval === 3 ? 0 : 1, command: "npm test", output }] });
      }
      if (url.includes("/artifacts?")) return Response.json({ data: [] });
      return Response.json({ id: "managed-caps", status: "idle" });
    },
  });

  const capped = (await provider.getStatus({ providerSessionId: "managed-caps" })).evidence.testFailureEvidence;
  assert.equal(capped.failures.length, 20);
  assert.equal(capped.failureEvidenceIncomplete, true);
  const unavailable = (await provider.getStatus({ providerSessionId: "managed-caps" })).evidence.testFailureEvidence;
  assert.deepEqual(unavailable.failures, []);
  assert.equal(unavailable.failureEvidenceIncomplete, true);
  const success = (await provider.getStatus({ providerSessionId: "managed-caps" })).evidence.testFailureEvidence;
  assert.deepEqual(success.totals, { total: 10, passed: 10, failed: 0 });
  assert.deepEqual(success.failures, []);
  assert.equal(success.failureEvidenceIncomplete, false);
  assert.ok(Buffer.byteLength(JSON.stringify(success)) < 512);
});

test("Agents lifecycle preserves approval and bounded failed-session diagnostics", async () => {
  const states = [
    { id: "managed-state", status: "requires_action", required_actions: [{ type: "function_call", name: "approval", call_id: "call-1", turn_id: "turn-1" }] },
    { id: "managed-state", status: "failed", error: { type: "execution_error", code: "turn_failed", message: "Bounded failure" } },
  ];
  let stateIndex = 0;
  const provider = createAgentsApiDeveloperProvider({
    apiKey: "test",
    agentId: "agent-1",
    environmentTemplateId: "env-1",
    async fetchImpl(url) {
      if (url.includes("/items?") || url.includes("/artifacts?")) return Response.json({ data: [] });
      return Response.json(states[Math.min(stateIndex++, states.length - 1)]);
    },
  });
  const approval = await provider.getStatus({ providerSessionId: "managed-state" });
  assert.equal(approval.status, "requires_action");
  assert.equal(approval.approval.requiredActions[0].call_id, "call-1");
  const failed = await provider.getStatus({ providerSessionId: "managed-state" });
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.evidence.safeDiagnostics, { type: "execution_error", code: "turn_failed", message: "Bounded failure" });
});

test("Agents session retrieval does not fabricate changed paths when upstream omits them", async () => {
  const provider = createAgentsApiDeveloperProvider({
    apiKey: "test",
    agentId: "agent-1",
    environmentTemplateId: "env-1",
    async fetchImpl(url, options = {}) {
      if (options.method === "POST" && url.endsWith("/agents/sessions")) return Response.json({ id: "managed-no-paths", status: "idle" });
      if (options.method === "POST") return new Response(null, { status: 200 });
      if (url.includes("/items?") || url.includes("/artifacts?")) return Response.json({ data: [] });
      return Response.json({ id: "managed-no-paths", status: "idle" });
    },
  });
  const result = await provider.start({ policy: microphoneDeveloperRequest(), policyHash: "no-paths" });
  assert.equal(Object.hasOwn(result, "changedPaths"), false);
});

test("workspace verification creates, retrieves and cancels without submitting an engineering input", async () => {
  const requests = [];
  const provider = createAgentsApiDeveloperProvider({
    apiKey: "test",
    agent: { model: "gpt-5.2-codex", instructions: "Perform no agent work." },
    environment: { type: "openai_hosted", network: { access: "disabled" }, files: [] },
    async fetchImpl(url, options = {}) {
      requests.push({ url, options });
      if (options.method === "POST" && url.endsWith("/agents/sessions")) {
        return Response.json({ id: "verification-provider-1", status: "idle", environment: { id: "environment-1" } });
      }
      if (!options.method) return Response.json({ id: "verification-provider-1", status: "idle", environment: { id: "environment-1" } });
      return new Response(null, { status: 200 });
    },
  });
  const policy = microphoneDeveloperRequest({
    dryRun: true,
    metadata: { manifestHash: "a".repeat(64), archiveSha256: "b".repeat(64), hostedFileCount: 3, materializedFileCount: 153, totalBytes: 1611766, dirtyPaths: MICROPHONE_ALLOWED_PATHS },
  });
  const result = await provider.verifyWorkspace({ policy, policyHash: "verification-policy" });

  assert.equal(result.status, "completed");
  assert.equal(result.result.outcome, "workspace_integrity_verified");
  assert.equal(result.result.environmentId, "environment-1");
  assert.equal(result.result.archiveSha256, "b".repeat(64));
  assert.equal(result.result.hostedFileCount, 3);
  assert.equal(result.result.sessionCreateAttemptCount, 1);
  assert.equal(result.changedPaths.length, 0);
  assert.equal(requests.length, 3);
  assert.match(requests[0].url, /\/agents\/sessions$/);
  assert.equal(requests[1].options.method, undefined);
  assert.match(requests[2].url, /\/agents\/sessions\/verification-provider-1\/events$/);
  const cancellation = JSON.parse(requests[2].options.body);
  assert.deepEqual(cancellation.events, [{ type: "agent.session.input.cancel" }]);
  assert.doesNotMatch(JSON.stringify(requests.map((item) => item.options.body || "")), /agent\.session\.input\.message|Continue Nova's microphone repair/);
});

test("workspace verification retries exactly once for the proven create-time runtime conflict", async () => {
  const requests = [];
  const delays = [];
  let creates = 0;
  const provider = createAgentsApiDeveloperProvider({
    apiKey: "test",
    agent: { model: "gpt-5.2-codex", instructions: "Perform no agent work." },
    environment: { type: "openai_hosted", network: { access: "disabled" }, files: [] },
    sleepImpl: async (delayMs) => { delays.push(delayMs); },
    async fetchImpl(url, options = {}) {
      requests.push({ url, options });
      if (options.method === "POST" && url.endsWith("/agents/sessions")) {
        creates += 1;
        if (creates === 1) return Response.json({
          error: {
            type: "conflict_error",
            code: "conflict_error",
            message: "session runtime changed during update",
          },
        }, { status: 409 });
        return Response.json({ id: "verification-provider-retry", status: "idle", environment: { id: "environment-retry" } });
      }
      if (!options.method) return Response.json({ id: "verification-provider-retry", status: "idle", environment: { id: "environment-retry" } });
      return new Response(null, { status: 200 });
    },
  });
  const policy = microphoneDeveloperRequest({
    dryRun: true,
    metadata: { manifestHash: "a".repeat(64), archiveSha256: "b".repeat(64), hostedFileCount: 3, materializedFileCount: 153, totalBytes: 1611766, dirtyPaths: MICROPHONE_ALLOWED_PATHS },
  });

  const result = await provider.verifyWorkspace({ policy, policyHash: "verification-retry" });

  assert.equal(result.status, "completed");
  assert.equal(result.result.sessionCreateAttemptCount, 2);
  assert.deepEqual(delays, [50]);
  assert.equal(requests.filter(({ url, options }) => options.method === "POST" && url.endsWith("/agents/sessions")).length, 2);
  assert.equal(requests.filter(({ options }) => JSON.stringify(options.body || "").includes("agent.session.input.message")).length, 0);
  assert.equal(requests.filter(({ url, options }) => options.method === "POST" && url.endsWith("/events")).length, 1);
  assert.equal(requests[0].options.body, requests[1].options.body);
});

test("workspace verification does not retry other 409 or 4xx failures", async () => {
  for (const failure of [
    { status: 409, type: "conflict_error", code: "conflict_error", message: "another conflict" },
    { status: 400, type: "invalid_request_error", code: "invalid_request", message: "bad request" },
  ]) {
    let calls = 0;
    const provider = createAgentsApiDeveloperProvider({
      apiKey: "test",
      agentId: "agent-1",
      environmentTemplateId: "env-1",
      sleepImpl: async () => { throw new Error("delay must not run"); },
      async fetchImpl() {
        calls += 1;
        return Response.json({ error: { type: failure.type, code: failure.code, message: failure.message } }, { status: failure.status });
      },
    });
    await assert.rejects(
      provider.verifyWorkspace({ policy: microphoneDeveloperRequest(), policyHash: "not-retryable" }),
      (error) => error.safeDiagnostics.upstreamStatus === failure.status && error.safeDiagnostics.attemptCount === 1,
    );
    assert.equal(calls, 1);
  }
});

test("workspace verification stops after one retry and preserves bounded attempt diagnostics", async () => {
  let calls = 0;
  const delays = [];
  const store = persistentTestStore();
  const provider = createAgentsApiDeveloperProvider({
    apiKey: "test",
    agentId: "agent-1",
    environmentTemplateId: "env-1",
    sleepImpl: async (delayMs) => { delays.push(delayMs); },
    async fetchImpl() {
      calls += 1;
      return Response.json({
        error: { type: "conflict_error", code: "conflict_error", message: "session runtime changed during update" },
      }, { status: 409 });
    },
  });

  const result = await adapter(provider, store, "agents_api")
    .verifyDeveloperWorkspace(microphoneDeveloperRequest({ provider: "agents_api" }));
  const persisted = await store.get("nova-session-1");

  assert.equal(result.status, "failed");
  assert.equal(result.error.diagnostics.stage, "agents_session_create");
  assert.equal(result.error.diagnostics.upstreamStatus, 409);
  assert.equal(result.error.diagnostics.upstreamErrorType, "conflict_error");
  assert.equal(result.error.diagnostics.upstreamErrorCode, "conflict_error");
  assert.equal(result.error.diagnostics.upstreamErrorMessage, "session runtime changed during update");
  assert.equal(result.error.diagnostics.attemptCount, 2);
  assert.deepEqual(persisted.error, result.error);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [50]);
});

test("real developer start does not retry the verification-only runtime conflict", async () => {
  let calls = 0;
  const provider = createAgentsApiDeveloperProvider({
    apiKey: "test",
    agentId: "agent-1",
    environmentTemplateId: "env-1",
    sleepImpl: async () => { throw new Error("real start must not delay or retry"); },
    async fetchImpl() {
      calls += 1;
      return Response.json({
        error: { type: "conflict_error", code: "conflict_error", message: "session runtime changed during update" },
      }, { status: 409 });
    },
  });
  await assert.rejects(
    provider.start({ policy: microphoneDeveloperRequest(), policyHash: "real-start" }),
    (error) => error.safeDiagnostics.upstreamStatus === 409 && error.safeDiagnostics.attemptCount === undefined,
  );
  assert.equal(calls, 1);
});

test("workspace verification fails closed unless the hosted session is idle after setup", async () => {
  const provider = createAgentsApiDeveloperProvider({
    apiKey: "test",
    agentId: "agent-1",
    environmentTemplateId: "env-1",
    async fetchImpl(url, options = {}) {
      if (options.method === "POST" && url.endsWith("/agents/sessions")) return Response.json({ id: "verification-provider-1", status: "idle" });
      return Response.json({ id: "verification-provider-1", status: "failed", error: { message: "WORKSPACE_INTEGRITY_FAILED" } });
    },
  });
  const policy = microphoneDeveloperRequest({
    metadata: { manifestHash: "a".repeat(64), materializedFileCount: 1, totalBytes: 1, dirtyPaths: MICROPHONE_ALLOWED_PATHS },
  });
  await assert.rejects(
    provider.verifyWorkspace({ policy, policyHash: "verification-policy" }),
    (error) => error.code === "WORKSPACE_INTEGRITY_FAILED" && error.safeDiagnostics.stage === "agents_workspace_verification",
  );
});

test("response-parse diagnostics survive adapter persistence without response or secret leakage", async () => {
  const store = persistentTestStore();
  const provider = createAgentsApiDeveloperProvider({
    apiKey: "sk-parse-secret-123456789",
    agentId: "agent-1",
    environmentTemplateId: "env-1",
    async fetchImpl() {
      return new Response("raw-secret-response-body", { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await adapter(provider, store, "agents_api")
    .startDeveloperSession(microphoneDeveloperRequest({ provider: "agents_api" }));
  const persisted = await store.get("nova-session-1");

  assert.equal(result.error.code, "agents_api_request_failed");
  assert.deepEqual(result.error.diagnostics, {
    stage: "agents_response_parse",
    requestStage: "agents_session_create",
    classification: "response_parse_failed",
    upstreamStatus: 200,
    upstreamErrorType: "SyntaxError",
    upstreamErrorCode: null,
    upstreamErrorMessage: "Agents API success response was not valid JSON.",
  });
  assert.deepEqual(persisted.error, result.error);
  assert.doesNotMatch(JSON.stringify({ result, persisted }), /raw-secret-response-body|parse-secret|Bearer/);
});

test("every Agents provider operation retains its exact bounded transport stage", async () => {
  const configuration = {
    apiKey: "sk-transport-secret-123456789",
    agentId: "agent-1",
    environmentTemplateId: "env-1",
  };
  const transportFailure = () => Object.assign(new TypeError("Bearer sk-transport-secret-123456789"), { code: "UND_ERR_CONNECT_TIMEOUT" });
  const expectStage = async (operation, expectedStage) => {
    await assert.rejects(operation, (error) => {
      assert.equal(error.code, "agents_api_request_failed");
      assert.equal(error.safeDiagnostics.stage, expectedStage);
      assert.equal(error.safeDiagnostics.requestStage, expectedStage);
      assert.equal(error.safeDiagnostics.classification, "transport_error");
      assert.equal(error.safeDiagnostics.upstreamStatus, null);
      assert.equal(error.safeDiagnostics.upstreamErrorType, "TypeError");
      assert.equal(error.safeDiagnostics.upstreamErrorCode, "UND_ERR_CONNECT_TIMEOUT");
      assert.doesNotMatch(JSON.stringify(error.safeDiagnostics), /transport-secret|Bearer/);
      return true;
    });
  };

  await expectStage(
    createAgentsApiDeveloperProvider({ ...configuration, fetchImpl: async () => { throw transportFailure(); } })
      .start({ policy: microphoneDeveloperRequest(), policyHash: "create" }),
    "agents_session_create",
  );

  let initialCall = 0;
  await expectStage(
    createAgentsApiDeveloperProvider({
      ...configuration,
      fetchImpl: async () => {
        initialCall += 1;
        if (initialCall === 1) return Response.json({ id: "managed-1", status: "idle" });
        throw transportFailure();
      },
    }).start({ policy: microphoneDeveloperRequest(), policyHash: "initial-event" }),
    "agents_initial_event_submit",
  );

  await expectStage(
    createAgentsApiDeveloperProvider({ ...configuration, fetchImpl: async () => { throw transportFailure(); } })
      .getStatus({ providerSessionId: "managed-1" }),
    "agents_session_retrieve",
  );
  await expectStage(
    createAgentsApiDeveloperProvider({ ...configuration, fetchImpl: async () => { throw transportFailure(); } })
      .resume({ providerSessionId: "managed-1", approval: null, approvalDecision: "approved", additionalInstruction: null, policyHash: "resume" }),
    "agents_session_resume",
  );
  await expectStage(
    createAgentsApiDeveloperProvider({ ...configuration, fetchImpl: async () => { throw transportFailure(); } })
      .cancel({ providerSessionId: "managed-1" }),
    "agents_session_cancel",
  );
});

test("saved agent_id mode creates a session without an inline agent", async () => {
  const requests = [];
  const provider = createAgentsApiDeveloperProvider({ apiKey: "test", agentId: "agent-1", environmentTemplateId: "env-1", fetchImpl: agentsSessionFetch(requests) });
  await provider.start({ policy: microphoneDeveloperRequest(), policyHash: "saved-agent" });
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.agent_id, "agent-1");
  assert.equal("agent" in body, false);
});

test("inline agent mode creates a session without NOVA_DEVELOPER_AGENT_ID", async () => {
  const requests = [];
  const agent = { model: "gpt-5.2-codex", instructions: "Use the bounded Nova execution contract." };
  const provider = createAgentsApiDeveloperProvider({ apiKey: "test", agent, environmentTemplateId: "env-1", fetchImpl: agentsSessionFetch(requests) });
  await provider.start({ policy: microphoneDeveloperRequest(), policyHash: "inline-agent" });
  const body = JSON.parse(requests[0].options.body);
  assert.deepEqual(body.agent, agent);
  assert.equal("agent_id" in body, false);
});

test("reusable environment template mode creates the official hosted reference", async () => {
  const requests = [];
  const provider = createAgentsApiDeveloperProvider({ apiKey: "test", agentId: "agent-1", environmentTemplateId: "env-template-1", fetchImpl: agentsSessionFetch(requests) });
  await provider.start({ policy: microphoneDeveloperRequest(), policyHash: "template-environment" });
  assert.deepEqual(JSON.parse(requests[0].options.body).environment, { type: "openai_hosted", environment_template_id: "env-template-1" });
});

test("inline hosted environment mode creates a session without a reusable template", async () => {
  const requests = [];
  const environment = { type: "openai_hosted", network: { access: "disabled" }, packages: { npm: ["typescript"] } };
  const provider = createAgentsApiDeveloperProvider({ apiKey: "test", agentId: "agent-1", environment, fetchImpl: agentsSessionFetch(requests) });
  await provider.start({ policy: microphoneDeveloperRequest(), policyHash: "inline-environment" });
  assert.deepEqual(JSON.parse(requests[0].options.body).environment, environment);
});

test("agents API provider maps bounded policy to official managed session endpoints without logging secrets", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === "POST" && url.endsWith("/agents/sessions")) return Response.json({ id: "managed-1", status: "idle" });
    if (options.method === "POST") return new Response(null, { status: 200 });
    if (requests.filter((item) => !item.options.method).length === 1) return Response.json({ id: "managed-1", status: "requires_action", required_actions: [{ type: "function_call", name: "approval", call_id: "call-1", turn_id: "turn-1" }] });
    return Response.json({ id: "managed-1", status: "idle" });
  };
  const provider = createAgentsApiDeveloperProvider({ apiKey: "api-secret", agentId: "agent-1", environment: { type: "openai_hosted", network: { access: "disabled" } }, fetchImpl });
  const policy = microphoneDeveloperRequest();
  const started = await provider.start({ policy, policyHash: "policy-hash" });
  assert.equal(started.status, "requires_action");
  const body = JSON.parse(requests[0].options.body);
  const eventBody = JSON.parse(requests[1].options.body);
  const contract = JSON.parse(eventBody.events[0].input[0].content[0].text);
  assert.deepEqual(contract.allowedPaths, MICROPHONE_ALLOWED_PATHS);
  assert.equal(contract.repository.workspace, "C:/bounded/nova-brain-microphone-task");
  assert.equal(body.metadata.nova_policy_hash, "policy-hash");
  assert.equal(JSON.stringify(requests).includes("api-secret"), true);
  assert.equal(JSON.stringify(body).includes("api-secret"), false);
  const resumed = await provider.resume({ providerSessionId: "managed-1", approval: started.approval, approvalDecision: "approved", additionalInstruction: null, policyHash: "policy-hash" });
  assert.equal(resumed.providerSessionId, "managed-1");
  assert.equal(resumed.status, "idle");
  assert.ok(requests.length >= 5);
  for (const request of requests) {
    assert.equal(request.options.headers["OpenAI-Beta"], "agents=v1");
    assert.equal(request.options.headers.Authorization, "Bearer api-secret");
  }
  assert.doesNotMatch(JSON.stringify({ started, resumed }), /api-secret|Authorization|OpenAI-Beta/);
  const resumeRequest = requests.find((request) => request.options.method === "POST"
    && request.url.endsWith("/agents/sessions/managed-1/events")
    && JSON.stringify(request.options.body).includes("agent.session.input.tool_result"));
  assert.ok(resumeRequest);
  assert.deepEqual(JSON.parse(resumeRequest.options.body).events[0], {
    type: "agent.session.input.tool_result",
    call_id: "call-1",
    turn_id: "turn-1",
    success: true,
    output: JSON.stringify({ contract: "nova_developer_session_resume_v1", policyHash: "policy-hash", approvalDecision: "approved" }),
  });
});

test("Agents beta header is isolated from unrelated OpenAI Responses API calls", async () => {
  let request;
  const provider = createOpenAIModelProvider({
    apiKey: "responses-secret",
    model: "test-model",
    async fetchImpl(url, options) {
      request = { url, options };
      return Response.json({
        id: "response-1",
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      });
    },
  });

  const result = await provider.generate({
    message: "bounded check",
    conversationHistory: [],
    context: {},
    tools: [],
  });

  assert.equal(result.message, "ok");
  assert.equal(request.options.headers.Authorization, "Bearer responses-secret");
  assert.equal("OpenAI-Beta" in request.options.headers, false);
  assert.doesNotMatch(JSON.stringify(result), /responses-secret/);
});

test("adapter refuses provider session replacement and terminal replay", async () => {
  const provider = createDeterministicDeveloperProvider([
    { providerSessionId: "stable", status: "approval_required", approval: { action: "shell" }, changedPaths: [] },
    { providerSessionId: "replacement", status: "running", changedPaths: [] },
  ]);
  const api = adapter(provider);
  await api.startDeveloperSession(microphoneDeveloperRequest());
  await assert.rejects(api.resumeDeveloperSession({ sessionId: "nova-session-1", approvalDecision: "approved" }), (error) => error.code === "developer_provider_session_mismatch");
});

test("terminal completion cannot be resumed", async () => {
  const provider = createDeterministicDeveloperProvider([{ providerSessionId: "done", status: "completed", result: { outcome: "done" }, changedPaths: [] }]);
  const api = adapter(provider);
  await api.startDeveloperSession(microphoneDeveloperRequest());
  await assert.rejects(api.resumeDeveloperSession({ sessionId: "nova-session-1" }), (error) => error.code === "developer_session_terminal");
});
