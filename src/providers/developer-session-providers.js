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
const MAX_SESSION_ITEMS = 100;
const MAX_TEST_FAILURES = 20;
const MAX_TEST_FAILURE_RECORD_BYTES = 2_048;
const MAX_TEST_FAILURE_EVIDENCE_BYTES = 16_384;
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
    .replace(/\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*[^\s,;]+/g, "[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function relativeSourceLocation(value) {
  if (typeof value !== "string") return null;
  return boundedResultText(value
    .replace(/^['"]|['"]$/g, "")
    .replace(/^file:\/\//, "")
    .replace(/^.*?\/workspace\/nova-brain\//, "")
    .replace(/^.*?\\workspace\\nova-brain\\/, "")
    .replace(/^(?:.*?\/)?workspace\/nova-brain\//, "")
    .replace(/^(?:.*?\\)?workspace\\nova-brain\\/, "")
    .replaceAll("\\", "/"), 512);
}

function testTotals(output) {
  if (typeof output !== "string") return null;
  const totals = {};
  const names = { tests: "total", pass: "passed", fail: "failed", cancelled: "cancelled", skipped: "skipped", todo: "todo" };
  for (const match of output.matchAll(/^\s*(?:#|ℹ)\s*(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/gmi)) {
    totals[names[match[1].toLowerCase()]] = Number(match[2]);
  }
  return Object.keys(totals).length ? totals : null;
}

function tapFailureBlocks(output) {
  if (typeof output !== "string") return [];
  const lines = output.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*not ok\s+\d+\s+-\s+(.+?)\s*$/i);
    if (!match) continue;
    const block = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^\s*(?:not )?ok\s+\d+\s+-\s+/i.test(lines[cursor]) || /^\s*(?:#|ℹ)\s+(?:tests|pass|fail)\s+\d+\s*$/i.test(lines[cursor])) break;
      block.push(lines[cursor]);
    }
    blocks.push({ title: match[1], block });
  }
  return blocks;
}

function specFailureBlocks(output) {
  if (typeof output !== "string") return [];
  const section = output.replace(/\u001b\[[0-9;]*m/g, "").split(/^\s*✖\s+failing tests:\s*$/mi)[1];
  if (!section) return [];
  const lines = section.split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const location = lines[index].match(/^\s*test at\s+(.+?)\s*$/i)?.[1];
    if (!location) continue;
    const titleMatch = lines[index + 1]?.match(/^\s*✖\s+(.+?)(?:\s+\([\d.]+ms\))?\s*$/i);
    if (!titleMatch) continue;
    const block = [`location: '${location}'`];
    for (let cursor = index + 2; cursor < lines.length && !/^\s*test at\s+/i.test(lines[cursor]); cursor += 1) block.push(lines[cursor]);
    blocks.push({ title: titleMatch[1], block });
  }
  return blocks;
}

function failureRecord({ title, block }) {
  const text = block.join("\n");
  const location = text.match(/^\s*location:\s*['"]?([^'"\r\n]+)['"]?\s*$/mi)?.[1]
    || text.match(/(?:file:\/\/)?([^\s()]+\.test\.[cm]?js:\d+:\d+)/i)?.[1]
    || null;
  const path = location?.match(/([^\s/\\]+(?:\/|\\))*[^\s/\\]+\.test\.[cm]?js/i)?.[0] || null;
  const errorType = text.match(/^\s*(?:name|code|failureType):\s*['"]?([^'"\r\n]+)['"]?\s*$/mi)?.[1] || null;
  const quotedMessage = text.match(/^\s*(?:error|message):\s*['"]([^'"\r\n]+)['"]\s*$/mi)?.[1];
  const blockMessage = text.match(/^\s*(?:error|message):\s*[|>]?-?\s*\r?\n\s+([^\r\n]+)/mi)?.[1];
  const standardError = text.match(/^\s*([A-Za-z][A-Za-z]*Error)(?:\s+\[[^\]]+\])?:\s*([^\r\n]+)/mi);
  const record = {
    title: boundedResultText(title, 512),
    filePath: relativeSourceLocation(path),
    message: boundedResultText(quotedMessage || blockMessage || standardError?.[2], 768),
    errorType: boundedResultText(errorType || standardError?.[1], 128),
    sourceLocation: relativeSourceLocation(location),
  };
  if (jsonBytes(record) <= MAX_TEST_FAILURE_RECORD_BYTES) return record;
  record.message = boundedResultText(record.message, 256);
  record.sourceLocation = boundedResultText(record.sourceLocation, 256);
  return record;
}

function extractTestFailureEvidence(items, itemOrder = "asc") {
  const commands = items.filter((item) => item?.type === "command_execution" && typeof item.output === "string");
  const newestFirst = itemOrder === "desc" ? commands : [...commands].reverse();
  const item = newestFirst.find((candidate) => {
    const command = Array.isArray(candidate.command) ? candidate.command.join(" ") : candidate.command;
    return /(?:npm\s+test|node\s+--test)/i.test(command || "") || testTotals(candidate.output) || /^\s*not ok\s+\d+\s+-/mi.test(candidate.output);
  });
  if (!item) return null;
  const totals = testTotals(item.output);
  const blocks = tapFailureBlocks(item.output);
  const parsed = (blocks.length ? blocks : specFailureBlocks(item.output)).map(failureRecord);
  const failures = [];
  for (const record of parsed.slice(0, MAX_TEST_FAILURES)) {
    const recordBytes = jsonBytes(record);
    if (recordBytes > MAX_TEST_FAILURE_RECORD_BYTES || jsonBytes([...failures, record]) > MAX_TEST_FAILURE_EVIDENCE_BYTES) break;
    failures.push(record);
  }
  const exitCode = Number.isInteger(item.exit_code) ? item.exit_code : null;
  return {
    version: 1,
    commandItemId: boundedResultText(item.id, 128),
    turnId: boundedResultText(item.turn_id, 128),
    exitCode,
    totals,
    failures,
    failureEvidenceIncomplete: parsed.length > failures.length
      || (Number.isInteger(totals?.failed) && totals.failed > failures.length)
      || (exitCode !== null && exitCode !== 0 && failures.length === 0),
  };
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

function extractEvidence(payload, itemPage, artifactPage, {
  itemOrder = "asc",
  afterAssistantItemId = null,
  requireFreshAssistantOutput = false,
} = {}) {
  const pageItems = Array.isArray(itemPage?.data) ? itemPage.data : [];
  const items = itemOrder === "desc" ? pageItems.slice(0, MAX_SESSION_ITEMS) : pageItems.slice(-MAX_SESSION_ITEMS);
  const artifacts = Array.isArray(artifactPage?.data) ? artifactPage.data.slice(0, MAX_RESULT_ITEMS) : [];
  const assistantOutputs = items
    .filter((item) => item?.type === "message" && item?.role === "assistant")
    .map((item) => ({
      itemId: boundedResultText(item.id, 128),
      turnId: boundedResultText(item.turn_id, 128),
      status: boundedResultText(item.status, 64),
      phase: boundedResultText(item.phase, 64),
      text: boundedResultText((Array.isArray(item.content) ? item.content : [])
        .map((part) => typeof part?.text === "string" ? part.text : "")
        .filter(Boolean)
        .join("\n")),
    }))
    .filter((item) => item.itemId && item.text);
  const newestAssistant = itemOrder === "desc" ? assistantOutputs[0] || null : assistantOutputs.at(-1) || null;
  const freshAssistant = afterAssistantItemId && newestAssistant?.itemId === afterAssistantItemId ? null : newestAssistant;
  const assistantOutputMissing = requireFreshAssistantOutput && !freshAssistant;
  const commandItems = items
    .filter((item) => item?.type === "command_execution")
    .slice(itemOrder === "desc" ? 0 : -20, itemOrder === "desc" ? 20 : undefined);
  const commandSummaries = (itemOrder === "desc" ? [...commandItems].reverse() : commandItems)
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
    latestOutput: assistantOutputMissing ? null : freshAssistant?.text || null,
    assistantOutput: assistantOutputMissing ? null : freshAssistant,
    assistantOutputMissing,
    ...(requireFreshAssistantOutput ? { assistantOutputRequest: { afterItemId: boundedResultText(afterAssistantItemId, 128) } } : {}),
    commandSummaries,
    testSummary,
    testFailureEvidence: extractTestFailureEvidence(items, itemOrder),
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

function mappedSession(payload, itemPage = null, artifactPage = null, evidenceOptions = {}) {
  const status = payload.status === "in_progress"
    ? "running"
    : payload.status === "error"
      ? "failed"
      : payload.status;
  const items = Array.isArray(itemPage?.data) ? itemPage.data : [];
  const evidence = extractEvidence(payload, itemPage, artifactPage, evidenceOptions);
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
  const retrieve = async (providerSessionId, evidenceOptions = {}) => {
    const encoded = encodeURIComponent(providerSessionId);
    const payload = await request(`/agents/sessions/${encoded}`, "agents_session_retrieve");
    const [items, artifacts] = await Promise.all([
      request(`/agents/sessions/${encoded}/items?limit=${MAX_SESSION_ITEMS}&order=desc`, "agents_session_items_list"),
      request(`/agents/sessions/${encoded}/artifacts?limit=${MAX_RESULT_ITEMS}&order=asc`, "agents_session_artifacts_list"),
    ]);
    return mappedSession(payload, items, artifacts, { itemOrder: "desc", ...evidenceOptions });
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
    async resume({
      providerSessionId, approval, approvalDecision, additionalInstruction, policyHash,
      afterAssistantItemId = null, requireFreshAssistantOutput = false,
    }) {
      let freshnessBaseline = afterAssistantItemId;
      if (requireFreshAssistantOutput && !freshnessBaseline) {
        const before = await retrieve(providerSessionId);
        freshnessBaseline = before.evidence?.assistantOutput?.itemId || null;
      }
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
      return retrieve(providerSessionId, { afterAssistantItemId: freshnessBaseline, requireFreshAssistantOutput });
    },
    async getStatus({ providerSessionId, afterAssistantItemId = null, requireFreshAssistantOutput = false }) {
      return retrieve(providerSessionId, { afterAssistantItemId, requireFreshAssistantOutput });
    },
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
