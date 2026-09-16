const AGENTS_BASE_URL = "https://api.openai.com/v1";

export class DeveloperProviderConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeveloperProviderConfigurationError";
    this.code = "agents_api_configuration_required";
  }
}

function safeError(status) {
  const error = new Error(`Managed developer provider request failed with status ${status}.`);
  error.code = "agents_api_request_failed";
  return error;
}

function instructions(policy) {
  return JSON.stringify({
    contract: "nova_developer_session_v1",
    ownership: {
      nova: ["intent", "acceptance_criteria", "scope", "approvals", "business_decisions", "final_acceptance"],
      harness: ["repository_inspection", "file_operations", "shell", "tests", "mechanical_iteration"],
    },
    taskId: policy.taskId,
    goal: policy.goal,
    acceptanceCriteria: policy.acceptanceCriteria,
    repository: policy.repository,
    baseSha: policy.baseSha,
    allowedPaths: policy.allowedPaths,
    forbiddenPaths: policy.forbiddenPaths,
    approvalPolicy: policy.approvalPolicy,
    dryRun: policy.dryRun,
    invariants: [
      "Do not access or mutate paths outside allowedPaths.",
      "Do not push or deploy unless the corresponding Nova policy flag is true.",
      "Pause and return a structured approval request when approval is required.",
      "Return structured changedPaths and result fields; do not make product decisions for Nova.",
    ],
  });
}

function mappedSession(payload) {
  const status = payload.status === "in_progress"
    ? "running"
    : payload.status === "idle"
      ? "completed"
      : payload.status;
  return {
    providerSessionId: payload.id,
    status,
    approval: payload.status === "requires_action" ? { requiredActions: payload.required_actions || [] } : null,
    result: status === "completed" ? { sessionId: payload.id, outcome: "completed" } : null,
    error: payload.error ? { code: "agents_api_session_failed", message: "Managed developer session failed." } : null,
    changedPaths: [],
  };
}

export function createAgentsApiDeveloperProvider({ apiKey, agentId, environment, fetchImpl = globalThis.fetch, baseUrl = AGENTS_BASE_URL } = {}) {
  if (!apiKey || !agentId || !environment) {
    throw new DeveloperProviderConfigurationError("OPENAI_API_KEY, NOVA_DEVELOPER_AGENT_ID, and a managed repository environment are required.");
  }
  const request = async (path, options = {}) => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(options.headers || {}) },
    });
    if (!response.ok) throw safeError(response.status);
    return response.status === 204 ? null : response.json();
  };
  const retrieve = async (providerSessionId) => mappedSession(await request(`/agents/sessions/${encodeURIComponent(providerSessionId)}`));
  return Object.freeze({
    name: "agents_api",
    async start({ policy, policyHash }) {
      const created = await request("/agents/sessions", {
        method: "POST",
        body: JSON.stringify({
          agent_id: agentId,
          environment,
          metadata: { nova_task_id: policy.taskId, nova_policy_hash: policyHash },
          stream: false,
        }),
      });
      if (typeof created?.id !== "string" || !created.id) throw safeError(502);
      await request(`/agents/sessions/${encodeURIComponent(created.id)}/events`, {
        method: "POST",
        body: JSON.stringify({ events: [{ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text: instructions(policy) }] }] }] }),
      });
      return retrieve(created.id);
    },
    async resume({ providerSessionId, approval, approvalDecision, additionalInstruction, policyHash }) {
      const decision = { contract: "nova_developer_session_resume_v1", policyHash, approvalDecision };
      const requiredActions = Array.isArray(approval?.requiredActions) ? approval.requiredActions : [];
      const toolResults = requiredActions
        .filter((action) => action?.type === "function_call" && action.call_id && action.turn_id)
        .map((action) => ({
          type: "agent.session.input.tool_result",
          call_id: action.call_id,
          turn_id: action.turn_id,
          success: approvalDecision === "approved",
          output: JSON.stringify(decision),
        }));
      const message = additionalInstruction
        ? [{ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text: additionalInstruction }] }] }]
        : [];
      if (requiredActions.length && toolResults.length !== requiredActions.length) throw safeError(422);
      if (!toolResults.length && !message.length) message.push({ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify(decision) }] }] });
      await request(`/agents/sessions/${encodeURIComponent(providerSessionId)}/events`, {
        method: "POST",
        body: JSON.stringify({ events: [...toolResults, ...message] }),
      });
      return retrieve(providerSessionId);
    },
    async getStatus({ providerSessionId }) { return retrieve(providerSessionId); },
    async cancel({ providerSessionId }) {
      await request(`/agents/sessions/${encodeURIComponent(providerSessionId)}/events`, {
        method: "POST",
        body: JSON.stringify({ events: [{ type: "agent.session.input.cancel" }] }),
      });
      return { providerSessionId, status: "cancelled", changedPaths: [] };
    },
  });
}

export function createLegacyDeveloperProvider(delegate) {
  if (!delegate || ["start", "resume", "getStatus", "cancel"].some((method) => typeof delegate[method] !== "function")) {
    throw new DeveloperProviderConfigurationError("A complete legacy Developer Runtime delegate is required.");
  }
  return Object.freeze({ name: "legacy", ...delegate });
}

export function createDeveloperProviderRouter({ legacy, agentsApi, selected = "legacy" } = {}) {
  const providers = { ...(legacy ? { legacy } : {}), ...(agentsApi ? { agents_api: agentsApi } : {}) };
  if (!providers[selected]) throw new DeveloperProviderConfigurationError(`Configured developer provider ${selected} is unavailable.`);
  return Object.freeze({ providers: Object.freeze(providers), defaultProvider: selected });
}

export function createDeterministicDeveloperProvider(script = []) {
  const calls = [];
  let index = 0;
  const next = (method, input) => {
    calls.push(structuredClone({ method, input }));
    const value = script[index++];
    if (value instanceof Error) throw value;
    if (!value) throw Object.assign(new Error("Deterministic provider script exhausted."), { code: "fake_provider_exhausted" });
    return structuredClone(value);
  };
  return Object.freeze({
    name: "deterministic_fake",
    calls,
    async start(input) { return next("start", input); },
    async resume(input) { return next("resume", input); },
    async getStatus(input) { return next("getStatus", input); },
    async cancel(input) { return next("cancel", input); },
  });
}
