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
const MAX_RESULT_TEXT_LENGTH = 2_000;
const MAX_RESULT_ITEMS = 50;
const WORKSPACE_VERIFICATION_CREATE_RETRY_DELAY_MS = 50;

function sanitizedDiagnosticString(value, { maxLength, apiKey }) {
  if (typeof value !== "string") return null;
  const normalized = value
    .replaceAll(apiKey, "[REDACTED]")
    .replace(/\b(?:authorization|cookie|set-cookie)\s*[:=]\s*[^,;]+/gi, "[REDACTED]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "[REDACTED]")
    .replace(/\b(?:sk|sess|proj)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function safeError({ status = null, stage, requestStage = stage, classification = "upstream_http_error", payload, apiKey, cause = null }) {
  const upstreamError = payload?.error && typeof payload.error === "object" && !Array.isArray(payload.error)
    ? payload.error
    : null;
  const diagnostics = {
    stage,
    requestStage,
    classification,
    upstreamStatus: status,
    upstreamErrorType: sanitizedDiagnosticString(upstreamError?.type || cause?.name, { maxLength: MAX_UPSTREAM_TYPE_LENGTH, apiKey }),
    upstreamErrorCode: sanitizedDiagnosticString(upstreamError?.code || cause?.code, { maxLength: MAX_UPSTREAM_CODE_LENGTH, apiKey }),
    upstreamErrorMessage: sanitizedDiagnosticString(
      classification === "response_parse_failed"
        ? "Agents API success response was not valid JSON."
        : upstreamError?.message || cause?.message,
      { maxLength: MAX_UPSTREAM_MESSAGE_LENGTH, apiKey },
    ),
  };
  const error = new Error("Managed developer provider request failed.");
  error.code = "agents_api_request_failed";
  error.safeDiagnostics = Object.freeze(diagnostics);
  return error;
}

function withAttemptCount(error, attemptCount) {
  if (error?.safeDiagnostics && typeof error.safeDiagnostics === "object" && !Array.isArray(error.safeDiagnostics)) {
    error.safeDiagnostics = Object.freeze({ ...error.safeDiagnostics, attemptCount });
  }
  return error;
}

function retryableWorkspaceCreateConflict(error) {
  const diagnostics = error?.safeDiagnostics;
  return diagnostics?.stage === "agents_session_create"
    && diagnostics.requestStage === "agents_session_create"
    && diagnostics.upstreamStatus === 409
    && diagnostics.upstreamErrorType === "conflict_error"
    && diagnostics.upstreamErrorCode === "conflict_error"
    && diagnostics.upstreamErrorMessage === "session runtime changed during update";
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

function boundedResultText(value, maxLength = MAX_RESULT_TEXT_LENGTH) {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/\b(?:authorization|cookie|set-cookie)\s*[:=]\s*[^,;\r\n]+/gi, "[REDACTED]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "[REDACTED]")
    .replace(/\b(?:sk|sess|proj)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function boundedScalarRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 20)) {
    if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) result[key] = item;
    else if (typeof item === "string") result[key] = boundedResultText(item, 256);
  }
  return Object.keys(result).length ? result : null;
}

function extractChangedPaths(payload, items) {
  const candidates = [payload?.changed_paths, payload?.changedPaths, payload?.result?.changed_paths, payload?.result?.changedPaths];
  for (const item of items) candidates.push(item?.changed_paths, item?.changedPaths, item?.result?.changed_paths, item?.result?.changedPaths);
  const paths = candidates.flatMap((value) => Array.isArray(value) ? value : [])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.replaceAll("\\", "/").replace(/^\/workspace\/nova-brain\//, "").replace(/^\.\//, ""));
  return paths.length ? [...new Set(paths)].slice(0, MAX_RESULT_ITEMS) : null;
}

function boundedRequiredActions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((action) => ({
    type: boundedResultText(action?.type, 64),
    name: boundedResultText(action?.name, 128),
    call_id: boundedResultText(action?.call_id, 128),
    turn_id: boundedResultText(action?.turn_id, 128),
    environment_id: boundedResultText(action?.environment_id, 128),
  }));
}

function extractEvidence(payload, itemPage, artifactPage) {
  const items = Array.isArray(itemPage?.data) ? itemPage.data.slice(-MAX_RESULT_ITEMS) : [];
  const artifacts = Array.isArray(artifactPage?.data) ? artifactPage.data.slice(0, MAX_RESULT_ITEMS) : [];
  const assistantMessages = items
    .filter((item) => item?.type === "message" && item?.role === "assistant")
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .map((part) => boundedResultText(part?.text))
    .filter(Boolean);
  const commandSummaries = items
    .filter((item) => item?.type === "command_execution")
    .slice(-20)
    .map((item) => ({
      id: boundedResultText(item.id, 128),
      status: boundedResultText(item.status, 64),
      exitCode: Number.isInteger(item.exit_code) ? item.exit_code : null,
      executable: boundedResultText((Array.isArray(item.command) ? item.command[0] : item.command)?.split?.(/\s+/)?.[0], 64),
    }));
  const testSummary = [payload?.test_summary, payload?.testSummary, payload?.result?.tests, ...items.map((item) => item?.test_summary || item?.testSummary || item?.result?.tests)]
    .map(boundedScalarRecord)
    .find(Boolean) || null;
  const environmentId = [payload?.environment?.id, payload?.environment_id]
    .find((value) => typeof value === "string" && value) || null;
  const sessionError = typeof payload?.error === "string"
    ? { message: boundedResultText(payload.error, MAX_UPSTREAM_MESSAGE_LENGTH) }
    : boundedScalarRecord(payload?.error);
  return {
    environmentId,
    latestOutput: assistantMessages.at(-1) || null,
    commandSummaries,
    testSummary,
    safeDiagnostics: sessionError,
    artifacts: artifacts.map((artifact) => ({
      id: boundedResultText(artifact?.id, 128),
      environmentId: boundedResultText(artifact?.environment_id, 128),
      path: boundedResultText(artifact?.path, 512),
      sizeBytes: Number.isInteger(artifact?.size_bytes) && artifact.size_bytes >= 0 ? artifact.size_bytes : null,
      turnId: boundedResultText(artifact?.turn_id, 128),
    })),
  };
}

function mappedSession(payload, itemPage = null, artifactPage = null) {
  const status = payload.status === "in_progress"
    ? "running"
    : payload.status === "error"
      ? "failed"
      : payload.status;
  const items = Array.isArray(itemPage?.data) ? itemPage.data : [];
  const evidence = extractEvidence(payload, itemPage, artifactPage);
  const changedPaths = extractChangedPaths(payload, items);
  return {
    providerSessionId: payload.id,
    status,
    approval: payload.status === "requires_action" ? { requiredActions: boundedRequiredActions(payload.required_actions) } : null,
    result: status === "completed" ? { sessionId: payload.id, outcome: "completed" } : null,
    error: payload.error ? { code: "agents_api_session_failed", message: "Managed developer session failed." } : null,
    evidence,
    ...(changedPaths ? { changedPaths } : {}),
  };
}

export function createAgentsApiDeveloperProvider({
  apiKey, agentId, agent, environmentTemplateId, environment, fetchImpl = globalThis.fetch,
  baseUrl = AGENTS_BASE_URL,
  sleepImpl = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
} = {}) {
  if (!nonEmptyString(apiKey)) throw new DeveloperProviderConfigurationError("OPENAI_API_KEY is required for live Agents API calls.");
  const agentConfiguration = normalizeAgentConfiguration({ agentId, agent });
  const sessionEnvironment = normalizeEnvironmentConfiguration({ environmentTemplateId, environment });
  const request = async (path, stage, options = {}, responseMode = "json") => {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...(options.headers || {}),
          "OpenAI-Beta": "agents=v1",
        },
      });
    } catch (cause) {
      throw safeError({ stage, classification: "transport_error", apiKey, cause });
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw safeError({ status: response.status, stage, payload, apiKey });
    }
    if (responseMode === "void") return null;
    try {
      return await response.json();
    } catch (cause) {
      throw safeError({
        status: response.status,
        stage: "agents_response_parse",
        requestStage: stage,
        classification: "response_parse_failed",
        apiKey,
        cause,
      });
    }
  };
  const retrieve = async (providerSessionId) => {
    const encoded = encodeURIComponent(providerSessionId);
    const payload = await request(`/agents/sessions/${encoded}`, "agents_session_retrieve");
    const [items, artifacts] = await Promise.all([
      request(`/agents/sessions/${encoded}/items?limit=${MAX_RESULT_ITEMS}&order=asc`, "agents_session_items_list"),
      request(`/agents/sessions/${encoded}/artifacts?limit=${MAX_RESULT_ITEMS}&order=asc`, "agents_session_artifacts_list"),
    ]);
    return mappedSession(payload, items, artifacts);
  };
  const createSession = async ({ taskId, policyHash, mode }) => {
    const options = {
      method: "POST",
      body: JSON.stringify({
        ...agentConfiguration,
        environment: sessionEnvironment,
        metadata: { nova_task_id: taskId, nova_policy_hash: policyHash, ...(mode ? { nova_session_mode: mode } : {}) },
        stream: false,
      }),
    };
    let attemptCount = 1;
    let created;
    try {
      created = await request("/agents/sessions", "agents_session_create", options);
    } catch (error) {
      if (mode !== "workspace_verification") throw error;
      if (!retryableWorkspaceCreateConflict(error)) {
        throw withAttemptCount(error, attemptCount);
      }
      await sleepImpl(WORKSPACE_VERIFICATION_CREATE_RETRY_DELAY_MS);
      attemptCount += 1;
      try {
        created = await request("/agents/sessions", "agents_session_create", options);
      } catch (retryError) {
        throw withAttemptCount(retryError, attemptCount);
      }
    }
    if (typeof created?.id !== "string" || !created.id) {
      throw safeError({ stage: "agents_session_create", classification: "provider_result_invalid", payload: null, apiKey });
    }
    return { created, attemptCount };
  };
  return Object.freeze({
    name: "agents_api",
    async start({ policy, policyHash }) {
      const { created } = await createSession({ taskId: policy.taskId, policyHash });
      await request(`/agents/sessions/${encodeURIComponent(created.id)}/events`, "agents_initial_event_submit", {
        method: "POST",
        body: JSON.stringify({ events: [{ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text: instructions(policy) }] }] }] }),
      }, "void");
      return retrieve(created.id);
    },
    async verifyWorkspace({ policy, policyHash }) {
      const { created, attemptCount } = await createSession({ taskId: policy.taskId, policyHash, mode: "workspace_verification" });
      const retrieved = await request(`/agents/sessions/${encodeURIComponent(created.id)}`, "agents_session_retrieve");
      if (retrieved?.id !== created.id || retrieved?.status !== "idle") {
        const error = safeError({ stage: "agents_workspace_verification", classification: "workspace_integrity_failed", payload: retrieved, apiKey });
        error.code = "WORKSPACE_INTEGRITY_FAILED";
        throw error;
      }
      await request(`/agents/sessions/${encodeURIComponent(created.id)}/events`, "agents_session_cancel", {
        method: "POST",
        body: JSON.stringify({ events: [{ type: "agent.session.input.cancel" }] }),
      }, "void");
      const environmentId = [retrieved?.environment?.id, retrieved?.environment_id, created?.environment?.id, created?.environment_id]
        .find((value) => typeof value === "string" && value);
      return {
        providerSessionId: created.id,
        status: "completed",
        result: {
          sessionId: created.id,
          environmentId: environmentId || null,
          outcome: "workspace_integrity_verified",
          manifestHash: policy.metadata.manifestHash,
          archiveSha256: policy.metadata.archiveSha256,
          hostedFileCount: policy.metadata.hostedFileCount,
          materializedFileCount: policy.metadata.materializedFileCount,
          totalBytes: policy.metadata.totalBytes,
          baseSha: policy.baseSha,
          dirtyPaths: [...policy.metadata.dirtyPaths],
          networkDisabled: true,
          sessionCreateAttemptCount: attemptCount,
        },
        changedPaths: [],
      };
    },
    async materializeDependencies({ providerSessionId, environmentId, files, verificationInstruction }) {
      if (!nonEmptyString(providerSessionId) || !nonEmptyString(environmentId)
        || !Array.isArray(files) || files.length !== 3 || !nonEmptyString(verificationInstruction)) {
        throw safeError({ stage: "agents_dependency_materialization", classification: "provider_input_invalid", payload: null, apiKey });
      }
      for (const file of files) {
        if (!file || file.type !== "inline" || !nonEmptyString(file.path) || !nonEmptyString(file.data)) {
          throw safeError({ stage: "agents_dependency_materialization", classification: "provider_input_invalid", payload: null, apiKey });
        }
        await request(`/agents/environments/${encodeURIComponent(environmentId)}/files`, "agents_environment_file_create", {
          method: "POST",
          body: JSON.stringify(file),
        });
      }
      await request(`/agents/sessions/${encodeURIComponent(providerSessionId)}/events`, "agents_dependency_verification_submit", {
        method: "POST",
        body: JSON.stringify({ events: [{ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text: verificationInstruction }] }] }] }),
      }, "void");
      return retrieve(providerSessionId);
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
        throw safeError({ stage: "agents_session_resume", classification: "provider_input_invalid", payload: null, apiKey });
      }
      if (!toolResults.length && !message.length) message.push({ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify(decision) }] }] });
      await request(`/agents/sessions/${encodeURIComponent(providerSessionId)}/events`, "agents_session_resume", {
        method: "POST",
        body: JSON.stringify({ events: [...toolResults, ...message] }),
      }, "void");
      return retrieve(providerSessionId);
    },
    async getStatus({ providerSessionId }) { return retrieve(providerSessionId); },
    async cancel({ providerSessionId }) {
      await request(`/agents/sessions/${encodeURIComponent(providerSessionId)}/events`, "agents_session_cancel", {
        method: "POST",
        body: JSON.stringify({ events: [{ type: "agent.session.input.cancel" }] }),
      }, "void");
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
