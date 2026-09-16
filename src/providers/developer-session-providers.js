const AGENTS_BASE_URL = "https://api.openai.com/v1";

export class DeveloperProviderConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeveloperProviderConfigurationError";
    this.code = "agents_api_configuration_required";
  }
}

const MAX_UPSTREAM_TYPE_LENGTH = 80;
const MAX_UPSTREAM_CODE_LENGTH = 80;
const MAX_UPSTREAM_MESSAGE_LENGTH = 256;

function sanitizedDiagnosticString(value, { maxLength, apiKey }) {
  if (typeof value !== "string") return null;
  const normalized = value
    .replaceAll(apiKey, "[REDACTED]")
    .replace(/\b(?:authorization|cookie|set-cookie)\s*[:=]\s*[^,;]+/gi, "[REDACTED]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|sess|proj)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function safeError({ status, stage, payload, apiKey }) {
  const upstreamError = payload?.error && typeof payload.error === "object" && !Array.isArray(payload.error)
    ? payload.error
    : null;
  const diagnostics = {
    requestStage: stage,
    upstreamStatus: status,
    upstreamErrorType: sanitizedDiagnosticString(upstreamError?.type, { maxLength: MAX_UPSTREAM_TYPE_LENGTH, apiKey }),
    upstreamErrorCode: sanitizedDiagnosticString(upstreamError?.code, { maxLength: MAX_UPSTREAM_CODE_LENGTH, apiKey }),
    upstreamErrorMessage: sanitizedDiagnosticString(upstreamError?.message, { maxLength: MAX_UPSTREAM_MESSAGE_LENGTH, apiKey }),
  };
  const error = new Error("Managed developer provider request failed.");
  error.code = "agents_api_request_failed";
  error.safeDiagnostics = Object.freeze(diagnostics);
  return error;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeAgentConfiguration({ agentId, agent }) {
  const hasAgentId = nonEmptyString(agentId);
  const hasInlineAgent = agent && typeof agent === "object" && !Array.isArray(agent) && nonEmptyString(agent.model);
  if (hasAgentId && agent !== undefined) {
    throw new DeveloperProviderConfigurationError("Choose either a saved Agents API agent_id or an inline agent configuration, not both.");
  }
  if (hasAgentId) return Object.freeze({ agent_id: agentId.trim() });
  if (hasInlineAgent) return Object.freeze({ agent: structuredClone(agent) });
  throw new DeveloperProviderConfigurationError("A saved NOVA_DEVELOPER_AGENT_ID or an inline Agents API configuration with an explicit model is required.");
}

function normalizeEnvironmentConfiguration({ environmentTemplateId, environment }) {
  const hasTemplate = nonEmptyString(environmentTemplateId);
  const hasInlineEnvironment = environment && typeof environment === "object" && !Array.isArray(environment);
  if (hasTemplate && hasInlineEnvironment) {
    throw new DeveloperProviderConfigurationError("Choose either a reusable hosted environment template or an inline session environment, not both.");
  }
  if (hasTemplate) {
    return Object.freeze({ type: "openai_hosted", environment_template_id: environmentTemplateId.trim() });
  }
  if (!hasInlineEnvironment) {
    throw new DeveloperProviderConfigurationError("A reusable hosted environment template or an inline session environment is required.");
  }
  if (environment.type === "openai_hosted") return Object.freeze(structuredClone(environment));
  if (environment.type === "self_hosted" && nonEmptyString(environment.workspace_directory)) {
    return Object.freeze(structuredClone(environment));
  }
  throw new DeveloperProviderConfigurationError("The inline session environment must be openai_hosted or a self_hosted environment with workspace_directory.");
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

export function createAgentsApiDeveloperProvider({ apiKey, agentId, agent, environmentTemplateId, environment, fetchImpl = globalThis.fetch, baseUrl = AGENTS_BASE_URL } = {}) {
  if (!nonEmptyString(apiKey)) throw new DeveloperProviderConfigurationError("OPENAI_API_KEY is required for live Agents API calls.");
  const agentConfiguration = normalizeAgentConfiguration({ agentId, agent });
  const sessionEnvironment = normalizeEnvironmentConfiguration({ environmentTemplateId, environment });
  const request = async (path, stage, options = {}) => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(options.headers || {}) },
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw safeError({ status: response.status, stage, payload, apiKey });
    }
    return response.status === 204 ? null : response.json();
  };
  const retrieve = async (providerSessionId) => mappedSession(await request(
    `/agents/sessions/${encodeURIComponent(providerSessionId)}`,
    "agents_session_retrieve",
  ));
  return Object.freeze({
    name: "agents_api",
    async start({ policy, policyHash }) {
      const created = await request("/agents/sessions", "agents_session_create", {
        method: "POST",
        body: JSON.stringify({
          ...agentConfiguration,
          environment: sessionEnvironment,
          metadata: { nova_task_id: policy.taskId, nova_policy_hash: policyHash },
          stream: false,
        }),
      });
      if (typeof created?.id !== "string" || !created.id) {
        throw safeError({ status: 502, stage: "agents_session_create", payload: null, apiKey });
      }
      await request(`/agents/sessions/${encodeURIComponent(created.id)}/events`, "agents_session_input", {
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
      if (requiredActions.length && toolResults.length !== requiredActions.length) {
        throw safeError({ status: 422, stage: "agents_session_resume", payload: null, apiKey });
      }
      if (!toolResults.length && !message.length) message.push({ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify(decision) }] }] });
      await request(`/agents/sessions/${encodeURIComponent(providerSessionId)}/events`, "agents_session_resume", {
        method: "POST",
        body: JSON.stringify({ events: [...toolResults, ...message] }),
      });
      return retrieve(providerSessionId);
    },
    async getStatus({ providerSessionId }) { return retrieve(providerSessionId); },
    async cancel({ providerSessionId }) {
      await request(`/agents/sessions/${encodeURIComponent(providerSessionId)}/events`, "agents_session_cancel", {
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
