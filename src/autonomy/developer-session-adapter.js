import { createHash, randomUUID } from "node:crypto";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const VALID_DECISIONS = new Set(["approved", "rejected"]);

export class DeveloperSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DeveloperSessionError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new DeveloperSessionError(code, message);
}

function text(value, name) {
  if (typeof value !== "string" || !value.trim()) fail("developer_session_invalid", `${name} is required.`);
  return value.trim();
}

function repoPath(value, name) {
  const path = text(value, name).replaceAll("\\", "/").replace(/^\.\//, "");
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.split("/").includes("..")) {
    fail("developer_session_scope_invalid", `${name} must be a repository-relative path.`);
  }
  return path;
}

function pathList(value, name, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail("developer_session_scope_invalid", `${name} must be ${allowEmpty ? "an" : "a non-empty"} array.`);
  }
  const paths = value.map((item, index) => repoPath(item, `${name}[${index}]`));
  if (new Set(paths).size !== paths.length) fail("developer_session_scope_invalid", `${name} contains duplicate paths.`);
  return paths;
}

function normalizeRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("developer_session_invalid", "A developer session request is required.");
  const repository = input.repository;
  if (!repository || typeof repository !== "object" || Array.isArray(repository)) {
    fail("developer_session_invalid", "repository identity is required.");
  }
  const allowedPaths = pathList(input.allowedPaths, "allowedPaths");
  const forbiddenPaths = pathList(input.forbiddenPaths || [], "forbiddenPaths", { allowEmpty: true });
  if (allowedPaths.some((path) => forbiddenPaths.includes(path))) {
    fail("developer_session_scope_invalid", "Allowed and forbidden paths must not overlap.");
  }
  const baseSha = text(input.baseSha, "baseSha").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(baseSha)) fail("developer_session_invalid", "baseSha must be a full commit SHA.");
  if (!Array.isArray(input.acceptanceCriteria) || input.acceptanceCriteria.length === 0) {
    fail("developer_session_invalid", "acceptanceCriteria must be non-empty.");
  }
  const acceptanceCriteria = input.acceptanceCriteria.map((item, index) => text(item, `acceptanceCriteria[${index}]`));
  const approvalPolicy = Object.freeze({
    requireFor: Array.isArray(input.approvalPolicy?.requireFor)
      ? [...new Set(input.approvalPolicy.requireFor.map((item, index) => text(item, `approvalPolicy.requireFor[${index}]`)))]
      : [],
    allowPush: input.approvalPolicy?.allowPush === true,
    allowDeploy: input.approvalPolicy?.allowDeploy === true,
  });
  return Object.freeze({
    taskId: text(input.taskId, "taskId"),
    goal: text(input.goal, "goal"),
    acceptanceCriteria: Object.freeze(acceptanceCriteria),
    repository: Object.freeze({
      slug: text(repository.slug, "repository.slug"),
      branch: text(repository.branch, "repository.branch"),
      workspace: text(repository.workspace, "repository.workspace"),
    }),
    baseSha,
    allowedPaths: Object.freeze(allowedPaths),
    forbiddenPaths: Object.freeze(forbiddenPaths),
    approvalPolicy,
    metadata: Object.freeze({ ...(input.metadata || {}) }),
    dryRun: input.dryRun === true,
  });
}

function policyHash(policy) {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

function normalizeProviderState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("developer_provider_invalid", "Developer provider returned an invalid response.");
  const status = value.status === "requires_action" ? "approval_required" : value.status;
  if (!["queued", "running", "idle", "approval_required", "completed", "failed", "cancelled"].includes(status)) {
    fail("developer_provider_invalid", "Developer provider returned an unsupported status.");
  }
  if (status === "approval_required" && (!value.approval || typeof value.approval !== "object")) {
    fail("developer_provider_invalid", "Approval-required provider state must include a structured approval.");
  }
  if (status === "completed" && (!value.result || typeof value.result !== "object" || Array.isArray(value.result))) {
    fail("developer_provider_invalid", "Completed provider state must include a structured result.");
  }
  return { ...value, status };
}

function enforceScope(policy, state) {
  const changedPaths = Array.isArray(state.changedPaths) ? state.changedPaths.map((path, index) => repoPath(path, `changedPaths[${index}]`)) : null;
  if (!changedPaths) return state;
  const outside = changedPaths.filter((path) => !policy.allowedPaths.includes(path) || policy.forbiddenPaths.includes(path));
  if (outside.length) fail("developer_provider_scope_violation", `Provider reported out-of-scope changes: ${outside.join(", ")}`);
  if (policy.dryRun && changedPaths.length) fail("developer_provider_mutation_forbidden", "Dry-run developer sessions cannot report product mutations.");
  return { ...state, changedPaths };
}

function publicSession(record) {
  const { policy, ...rest } = record;
  return { ...rest, policy: { ...policy, metadata: { ...policy.metadata } } };
}

export function createDeveloperSessionAdapter({ providers, sessionStore, defaultProvider = "legacy", idFactory = randomUUID, clock = () => new Date() } = {}) {
  if (!providers || typeof providers !== "object") fail("developer_session_configuration_invalid", "providers are required.");
  if (!sessionStore?.get || !sessionStore?.save) fail("developer_session_configuration_invalid", "A persistent sessionStore is required.");
  if (!providers[defaultProvider]) fail("developer_session_configuration_invalid", `Default developer provider ${defaultProvider} is unavailable.`);

  const persist = async (record) => {
    await sessionStore.save(structuredClone(record));
    return publicSession(record);
  };
  const load = async (sessionId) => {
    const record = await sessionStore.get(text(sessionId, "sessionId"));
    if (!record) fail("developer_session_not_found", "Developer session was not found.");
    return record;
  };
  const assistantFreshness = (record) => ({
    afterAssistantItemId: record.evidence?.assistantOutputRequest?.afterItemId || null,
    requireFreshAssistantOutput: record.evidence?.assistantOutputMissing === true,
  });
  const apply = async (record, rawState) => {
    const state = enforceScope(record.policy, normalizeProviderState(rawState));
    const updatedAt = clock().toISOString();
    return persist({
      ...record,
      status: state.status,
      approval: state.approval || null,
      result: state.result || null,
      error: state.error ? { code: state.error.code || "provider_failed", message: state.error.message || "Developer provider failed." } : null,
      changedPaths: state.changedPaths || record.changedPaths,
      evidence: state.evidence || record.evidence || null,
      events: [...record.events, {
        type: "developer_session.status",
        status: state.status,
        at: updatedAt,
        changedPaths: state.changedPaths || record.changedPaths,
        ...(state.approval ? { approval: structuredClone(state.approval) } : {}),
        ...(state.result ? { result: structuredClone(state.result) } : {}),
        ...(state.evidence ? { evidence: structuredClone(state.evidence) } : {}),
      }],
      updatedAt,
    });
  };
  const providerFailure = async (record, error) => {
    const updatedAt = clock().toISOString();
    const safeDiagnostics = error?.safeDiagnostics && typeof error.safeDiagnostics === "object" && !Array.isArray(error.safeDiagnostics)
      ? structuredClone(error.safeDiagnostics)
      : null;
    const boundedError = {
      code: error?.code || "developer_provider_failed",
      message: "Developer provider failed closed.",
      ...(safeDiagnostics ? { diagnostics: safeDiagnostics } : {}),
    };
    return persist({
      ...record,
      status: "failed",
      approval: null,
      result: null,
      error: boundedError,
      events: [...record.events, { type: "developer_session.status", status: "failed", at: updatedAt, error: boundedError }],
      updatedAt,
    });
  };

  return Object.freeze({
    async verifyDeveloperWorkspace(input) {
      const policy = normalizeRequest(input);
      if (!policy.dryRun) fail("developer_provider_mutation_forbidden", "Workspace verification must be a dry-run session.");
      const providerName = input.provider || defaultProvider;
      const provider = providers[providerName];
      if (!provider || typeof provider.verifyWorkspace !== "function") {
        fail("developer_provider_unavailable", `Developer provider ${providerName} does not support workspace verification.`);
      }
      const now = clock().toISOString();
      let record = {
        id: idFactory(), taskId: policy.taskId, provider: providerName, providerSessionId: null,
        policy, policyHash: policyHash(policy), status: "queued", approval: null, result: null,
        error: null, changedPaths: [], events: [{ type: "developer_workspace_verification.created", status: "queued", at: now }], createdAt: now, updatedAt: now,
      };
      await sessionStore.save(structuredClone(record));
      try {
        const raw = await provider.verifyWorkspace({ policy, policyHash: record.policyHash });
        if (typeof raw?.providerSessionId !== "string" || !raw.providerSessionId) fail("developer_provider_invalid", "Developer provider did not return a session ID.");
        record = { ...record, providerSessionId: raw.providerSessionId };
        return await apply(record, raw);
      } catch (error) {
        if (error instanceof DeveloperSessionError && error.code.startsWith("developer_provider_")) {
          await providerFailure(record, error);
          throw error;
        }
        return providerFailure(record, error);
      }
    },

    async startDeveloperSession(input) {
      const policy = normalizeRequest(input);
      const providerName = input.provider || defaultProvider;
      const provider = providers[providerName];
      if (!provider) fail("developer_provider_unavailable", `Developer provider ${providerName} is unavailable.`);
      const now = clock().toISOString();
      let record = {
        id: idFactory(), taskId: policy.taskId, provider: providerName, providerSessionId: null,
        policy, policyHash: policyHash(policy), status: "queued", approval: null, result: null,
        error: null, changedPaths: [], events: [{ type: "developer_session.created", status: "queued", at: now }], createdAt: now, updatedAt: now,
      };
      await sessionStore.save(structuredClone(record));
      try {
        const raw = await provider.start({ policy, policyHash: record.policyHash });
        if (typeof raw?.providerSessionId !== "string" || !raw.providerSessionId) fail("developer_provider_invalid", "Developer provider did not return a session ID.");
        record = { ...record, providerSessionId: raw.providerSessionId };
        return await apply(record, raw);
      } catch (error) {
        if (error instanceof DeveloperSessionError && error.code.startsWith("developer_provider_")) {
          await providerFailure(record, error);
          throw error;
        }
        return providerFailure(record, error);
      }
    },

    async materializeDeveloperDependencies({ sessionId, environmentId, files, verificationInstruction, metadata } = {}) {
      let record = await load(sessionId);
      if (record.status !== "idle") fail("developer_session_not_idle", "Dependencies can be materialized only while the existing session is idle.");
      if (!record.providerSessionId || !environmentId || record.evidence?.environmentId !== environmentId) {
        fail("developer_provider_session_mismatch", "Dependency materialization is not bound to the existing provider environment.");
      }
      const provider = providers[record.provider];
      if (!provider || typeof provider.materializeDependencies !== "function") {
        fail("developer_provider_unavailable", "The developer provider does not support same-session dependency materialization.");
      }
      if (record.events.some((event) => event.type === "developer_dependencies.materialization_requested")) {
        fail("developer_session_replay", "Dependency materialization is single-use for this provider session.");
      }
      const requestedAt = clock().toISOString();
      record = {
        ...record,
        events: [...record.events, {
          type: "developer_dependencies.materialization_requested",
          status: "queued",
          at: requestedAt,
          metadata: structuredClone(metadata || {}),
        }],
        updatedAt: requestedAt,
      };
      await sessionStore.save(structuredClone(record));
      try {
        const raw = await provider.materializeDependencies({
          providerSessionId: record.providerSessionId,
          environmentId,
          files,
          verificationInstruction,
        });
        if (raw?.providerSessionId && raw.providerSessionId !== record.providerSessionId) {
          fail("developer_provider_session_mismatch", "Provider attempted to replace the persistent session identity.");
        }
        return await apply(record, raw);
      } catch (error) {
        if (error instanceof DeveloperSessionError && error.code.startsWith("developer_provider_")) {
          await providerFailure(record, error);
          throw error;
        }
        return providerFailure(record, error);
      }
    },

    async resumeDeveloperSession({ sessionId, approvalDecision, additionalInstruction } = {}) {
      const record = await load(sessionId);
      if (TERMINAL.has(record.status)) fail("developer_session_terminal", "A terminal developer session cannot be resumed.");
      if (record.status === "approval_required" && !VALID_DECISIONS.has(approvalDecision)) {
        fail("developer_session_approval_required", "An explicit approved or rejected decision is required.");
      }
      try {
        const raw = await providers[record.provider].resume({
          providerSessionId: record.providerSessionId,
          approval: record.approval ? structuredClone(record.approval) : null,
          approvalDecision: approvalDecision || null,
          additionalInstruction: additionalInstruction ? text(additionalInstruction, "additionalInstruction") : null,
          policyHash: record.policyHash,
          afterAssistantItemId: record.evidence?.assistantOutput?.itemId || null,
          requireFreshAssistantOutput: Boolean(additionalInstruction),
        });
        if (raw?.providerSessionId && raw.providerSessionId !== record.providerSessionId) {
          fail("developer_provider_session_mismatch", "Provider attempted to replace the persistent session identity.");
        }
        return await apply(record, raw);
      } catch (error) {
        if (error instanceof DeveloperSessionError && error.code.startsWith("developer_provider_")) {
          await providerFailure(record, error);
          throw error;
        }
        return providerFailure(record, error);
      }
    },

    async getDeveloperSession({ sessionId } = {}) {
      const record = await load(sessionId);
      if (TERMINAL.has(record.status)) return publicSession(record);
      try {
        const raw = await providers[record.provider].getStatus({
          providerSessionId: record.providerSessionId,
          policyHash: record.policyHash,
          ...assistantFreshness(record),
        });
        return await apply(record, raw);
      } catch (error) {
        return providerFailure(record, error);
      }
    },

    async reconcileDeveloperSession({ sessionId } = {}) {
      const record = await load(sessionId);
      try {
        const raw = await providers[record.provider].getStatus({
          providerSessionId: record.providerSessionId,
          policyHash: record.policyHash,
          ...assistantFreshness(record),
        });
        if (raw?.providerSessionId && raw.providerSessionId !== record.providerSessionId) {
          fail("developer_provider_session_mismatch", "Provider attempted to replace the persistent session identity.");
        }
        return await apply(record, raw);
      } catch (error) {
        if (error instanceof DeveloperSessionError && error.code.startsWith("developer_provider_")) {
          await providerFailure(record, error);
          throw error;
        }
        return providerFailure(record, error);
      }
    },

    async inspectDeveloperSessionLifecycle({ sessionId } = {}) {
      const record = await load(sessionId);
      const provider = providers[record.provider];
      if (!provider || typeof provider.inspectLifecycle !== "function") {
        fail("developer_provider_unavailable", "The developer provider does not support lifecycle inspection.");
      }
      const lifecycle = await provider.inspectLifecycle({ providerSessionId: record.providerSessionId });
      if (lifecycle?.providerSessionId !== record.providerSessionId) {
        fail("developer_provider_session_mismatch", "Lifecycle evidence does not belong to the persistent provider session.");
      }
      return structuredClone(lifecycle);
    },

    async cancelDeveloperSession({ sessionId } = {}) {
      const record = await load(sessionId);
      if (TERMINAL.has(record.status)) return publicSession(record);
      try {
        const raw = await providers[record.provider].cancel({ providerSessionId: record.providerSessionId, policyHash: record.policyHash });
        return await apply(record, raw);
      } catch (error) {
        return providerFailure(record, error);
      }
    },
  });
}
