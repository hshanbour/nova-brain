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
  assert.equal(result.status, "completed");
  assert.match(requests[1].url, /\/agents\/sessions\/managed-1\/events$/);
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
  assert.equal(resumed.status, "completed");
  assert.ok(requests.length >= 5);
  for (const request of requests) {
    assert.equal(request.options.headers["OpenAI-Beta"], "agents=v1");
    assert.equal(request.options.headers.Authorization, "Bearer api-secret");
  }
  assert.doesNotMatch(JSON.stringify({ started, resumed }), /api-secret|Authorization|OpenAI-Beta/);
  assert.match(requests[3].url, /\/agents\/sessions\/managed-1\/events$/);
  assert.deepEqual(JSON.parse(requests[3].options.body).events[0], {
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
