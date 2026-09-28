import { createHash } from "node:crypto";

const SHA = /^[a-f0-9]{40}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SECRET = /(?:sk-[A-Za-z0-9_-]{16,}|(?:api[_-]?key|password|passcode|bearer|authorization)\s*[:=]\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----|seed\s+phrase\s*[:=]\s*\S+)/i;
const TERMINAL = new Set(["completed", "failed", "cancelled", "expired", "blocked"]);
const RETRYABLE_TERMINAL = new Set(["failed", "cancelled", "blocked"]);
const CODING_SPECIFICATION_VERSION = 1;
const CODING_RETRY_CONTRACT_VERSION = 1;
const CODING_RETRY_APPROVAL_VERSION = 1;
const MAX_SUCCESSOR_DEPTH = 32;
const CODING_TASK_ID = /^coding_[a-f0-9]{32}$/;
const ORCHESTRATION_TASK_ID = /^orchestration_[a-f0-9]{32}$/;
export const CODING_ACTIVE_PROGRESS_PHASES = Object.freeze(["preparing", "executing", "inspecting", "implementing", "testing", "reviewing"]);

export class CodingExecutorError extends Error {
  constructor(code, message, statusCode = 409, safeDiagnostics = undefined) {
    super(message);
    this.name = "CodingExecutorError";
    this.code = code;
    this.statusCode = statusCode;
    if (safeDiagnostics) this.safeDiagnostics = safeDiagnostics;
  }
}

function fail(code, message, statusCode = 409, safeDiagnostics) {
  throw new CodingExecutorError(code, message, statusCode, safeDiagnostics);
}

const HANDLE_HASH = /^[a-f0-9]{64}$/;

function normalizeCreationHandle(input) {
  const argumentKeys = input && typeof input === "object" && !Array.isArray(input) ? Object.keys(input).sort() : [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("coding_creation_handle_invalid", "A compact coding creation handle is required.", 400, { validationCode: "invalid_type", fieldPath: "coding_job_create", argumentKeys });
  }
  if (argumentKeys.some((key) => !["parentTaskId", "specificationHash"].includes(key))) {
    fail("coding_creation_handle_invalid", "The coding creation handle contains unsupported fields.", 400, { validationCode: "unsupported_field", fieldPath: "coding_job_create", argumentKeys });
  }
  if (typeof input.parentTaskId !== "string" || !ID.test(input.parentTaskId)) {
    fail("coding_creation_handle_invalid", "The coding creation parent is invalid.", 400, { validationCode: "invalid_identifier", fieldPath: "coding_job_create.parentTaskId", argumentKeys });
  }
  if (typeof input.specificationHash !== "string" || !HANDLE_HASH.test(input.specificationHash)) {
    fail("coding_creation_handle_invalid", "The coding specification hash is invalid.", 400, { validationCode: "invalid_hash", fieldPath: "coding_job_create.specificationHash", argumentKeys });
  }
  return Object.freeze({ parentTaskId: input.parentTaskId, specificationHash: input.specificationHash });
}

export function requireCodingTaskId(value) {
  if (typeof value !== "string" || !CODING_TASK_ID.test(value)) {
    fail("coding_task_identity_invalid", "A canonical durable coding task ID is required.", 400);
  }
  return value;
}

function text(value, name, max = 4_000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail("coding_job_invalid", `${name} is invalid.`, 400);
  if (SECRET.test(value)) fail("coding_job_secret_forbidden", `${name} may not contain credentials or secrets.`, 400);
  return value.trim();
}

function strings(value, name, { min = 0, max = 40, itemMax = 2_000 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail("coding_job_invalid", `${name} is invalid.`, 400);
  return Object.freeze(value.map((item, index) => text(item, `${name}[${index}]`, itemMax)));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

export function immutableCodingSpecification(value) {
  return Object.freeze({
    version: CODING_SPECIFICATION_VERSION,
    jobId: value.jobId,
    parentTaskId: value.parentTaskId,
    objective: value.objective,
    acceptanceCriteria: value.acceptanceCriteria,
    constraints: value.constraints,
    repository: value.repository,
    projectId: value.projectId,
    workspaceId: value.workspaceId,
    delivery: value.delivery,
    verification: value.verification,
    ...(value.trustedArtifact ? { trustedArtifact: value.trustedArtifact } : {}),
  });
}

export const codingSpecificationHash = (value) => hash(immutableCodingSpecification(value));

function codingTaskIdentity(job) {
  return `coding_${hash([job.parentTaskId, job.jobId]).slice(0, 32)}`;
}

function codingSuccessorIdentity(specificationHash, predecessor) {
  return `coding_${hash([
    `coding-terminal-successor-v${CODING_RETRY_CONTRACT_VERSION}`,
    specificationHash,
    predecessor.id,
    predecessor.stateVersion,
  ]).slice(0, 32)}`;
}

function codingRetryApprovalIdentity({ parentTaskId, specificationHash, predecessorTaskId, predecessorStateVersion, parentStateVersion }) {
  return `approval_coding_retry_${hash([
    `coding-retry-approval-v${CODING_RETRY_APPROVAL_VERSION}`,
    parentTaskId,
    specificationHash,
    predecessorTaskId,
    predecessorStateVersion,
    parentStateVersion,
  ]).slice(0, 32)}`;
}

function verifyStoredCodingIdentity(task, job, specificationHash) {
  const stored = task?.metadata?.codingJob;
  if (task?.taskType !== "coding_delegation" || !stored
    || task.metadata?.parentTaskId !== job.parentTaskId
    || hash(stored) !== task.metadata?.codingJobHash
    || codingSpecificationHash(stored) !== specificationHash
    || (task.metadata?.codingSpecificationHash && task.metadata.codingSpecificationHash !== specificationHash)) {
    fail("coding_job_identity_conflict", "The coding job identity is already bound to different inputs.");
  }
}

function verifyRetryLineage(task, { rootTaskId, predecessor, generation, specificationHash }) {
  const retry = task.metadata?.codingRetry;
  if (generation === 0 && !retry) return; // Legacy root jobs predate explicit retry lineage.
  if (retry?.contractVersion !== CODING_RETRY_CONTRACT_VERSION
    || retry?.rootTaskId !== rootTaskId
    || retry?.predecessorTaskId !== (predecessor?.id || null)
    || retry?.predecessorStateVersion !== (predecessor?.stateVersion || null)
    || retry?.generation !== generation
    || retry?.specificationHash !== specificationHash) {
    fail("coding_job_identity_conflict", "The coding job identity is already bound to different retry lineage.");
  }
}

function normalizeBindings(bindings) {
  const result = new Map();
  for (const binding of bindings || []) {
    if (!binding || !ID.test(binding.projectId || "") || !ID.test(binding.workspaceId || "")
      || typeof binding.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(binding.repository)
      || typeof binding.branch !== "string" || !binding.branch.trim() || ["main", "master"].includes(binding.branch.trim().toLowerCase())) {
      fail("coding_binding_invalid", "A configured coding project binding is invalid.", 500);
    }
    result.set(binding.projectId, Object.freeze({
      projectId: binding.projectId,
      workspaceId: binding.workspaceId,
      repository: binding.repository,
      branch: binding.branch.trim(),
    }));
  }
  return result;
}

export function configuredCodingBindings(environment = process.env, fallback = {}) {
  if (environment.NOVA_CODEX_PROJECT_BINDINGS) {
    try {
      const parsed = JSON.parse(environment.NOVA_CODEX_PROJECT_BINDINGS);
      if (!Array.isArray(parsed)) throw new Error("not an array");
      return parsed;
    } catch {
      fail("coding_binding_invalid", "NOVA_CODEX_PROJECT_BINDINGS must be a JSON array.", 500);
    }
  }
  return fallback.projectId && fallback.repository && fallback.branch
    ? [{ projectId: fallback.projectId, workspaceId: fallback.workspaceId || fallback.projectId, repository: fallback.repository, branch: fallback.branch }]
    : [];
}

function normalizeJob(input, binding, { requireApproval = true } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("coding_job_invalid", "A structured coding job is required.", 400);
  const jobId = text(input.jobId, "jobId", 128);
  const parentTaskId = text(input.parentTaskId, "parentTaskId", 128);
  if (!ID.test(jobId) || !ID.test(parentTaskId)) fail("coding_job_invalid", "jobId and parentTaskId must use stable identifiers.", 400);
  const repository = input.repository;
  if (!repository || typeof repository !== "object" || Array.isArray(repository)) fail("coding_job_invalid", "repository binding is required.", 400);
  const baseline = text(repository.baseline, "repository.baseline", 40).toLowerCase();
  if (!SHA.test(baseline)) fail("coding_job_invalid", "repository.baseline must be a full commit SHA.", 400);
  const projectId = text(input.projectId, "projectId", 128);
  const workspaceId = text(input.workspaceId, "workspaceId", 128);
  if (!binding || binding.projectId !== projectId || binding.workspaceId !== workspaceId
    || repository.slug !== binding.repository || repository.branch !== binding.branch) {
    fail("coding_repository_binding_rejected", "The coding job does not match a trusted project/repository binding.", 403);
  }
  const delivery = input.delivery;
  if (!delivery || delivery.boundary !== "local_commit" || delivery.allowPush === true || delivery.allowDeploy === true) {
    fail("coding_delivery_boundary_rejected", "Coding jobs are limited to a local commit; push and deployment require separate approval.", 403);
  }
  if (requireApproval && input.approval?.buildApproved !== true) fail("coding_build_approval_required", "The build stage requires explicit owner approval.", 403);
  let trustedArtifact;
  if (input.trustedArtifact !== undefined) {
    const artifact=input.trustedArtifact;
    if (!artifact || typeof artifact!=="object" || Array.isArray(artifact)
      || Object.keys(artifact).some(key=>!["version","sourceTaskId","sourceStateVersion","repository","sourceBranch","commitSha","artifactRef","filesChanged"].includes(key))
      || artifact.version!==1 || !CODING_TASK_ID.test(artifact.sourceTaskId||"") || !Number.isInteger(artifact.sourceStateVersion) || artifact.sourceStateVersion<1
      || artifact.repository!==binding.repository || typeof artifact.sourceBranch!=="string" || !artifact.sourceBranch.trim()
      || !SHA.test(artifact.commitSha||"") || artifact.artifactRef!==`refs/nova/coding-jobs/${artifact.sourceTaskId}`
      || !Array.isArray(artifact.filesChanged) || artifact.filesChanged.length>100 || artifact.filesChanged.some(path=>typeof path!=="string"||!path||path.length>240||path.startsWith("/")||path.includes(".."))) {
      fail("coding_trusted_artifact_invalid", "The trusted historical artifact provenance is invalid.", 409);
    }
    trustedArtifact=Object.freeze({version:1,sourceTaskId:artifact.sourceTaskId,sourceStateVersion:artifact.sourceStateVersion,repository:artifact.repository,sourceBranch:artifact.sourceBranch.trim(),commitSha:artifact.commitSha,artifactRef:artifact.artifactRef,filesChanged:Object.freeze([...new Set(artifact.filesChanged)])});
  }
  const specification = immutableCodingSpecification({
    jobId,
    parentTaskId,
    objective: text(input.objective, "objective", 8_000),
    acceptanceCriteria: strings(input.acceptanceCriteria, "acceptanceCriteria", { min: 1 }),
    constraints: strings(input.constraints || [], "constraints"),
    repository: Object.freeze({ slug: repository.slug, branch: repository.branch, baseline }),
    projectId,
    workspaceId,
    delivery: Object.freeze({ boundary: "local_commit", allowPush: false, allowDeploy: false }),
    verification: strings(input.verification || [], "verification", { max: 30 }),
    trustedArtifact,
  });
  return requireApproval
    ? Object.freeze({ ...specification, approval: Object.freeze({ buildApproved: true, approvalId: text(input.approval.approvalId, "approval.approvalId", 128) }) })
    : specification;
}

function publicResult(task, steps) {
  const execution = [...steps].reverse().find((step) => step.stepType === "delegate_coding");
  const stored = execution?.result || null;
  const raw = stored?.diagnostics?.codingResult || stored;
  return Object.freeze({
    jobId: task.metadata?.codingJob?.jobId || null,
    parentTaskId: task.metadata?.codingJob?.parentTaskId || null,
    taskId: task.id,
    status: task.status,
    summary: raw?.summary || task.blockedReason || null,
    repository: task.metadata?.codingJob?.repository || null,
    baseline: task.metadata?.codingJob?.repository?.baseline || null,
    finalLocalSha: raw?.finalLocalSha || raw?.commitSha || null,
    filesChanged: Array.isArray(raw?.filesChanged) ? raw.filesChanged : [],
    tests: Array.isArray(raw?.tests) ? raw.tests : [],
    limitations: Array.isArray(raw?.limitations) ? raw.limitations : [],
    pushOccurred: raw?.pushOccurred === true,
    deploymentOccurred: raw?.deploymentOccurred === true,
    approvalsRequiredNext: Array.isArray(raw?.approvalsRequiredNext) ? raw.approvalsRequiredNext : [],
    failure: raw?.failure || (task.errorCode ? { code: task.errorCode, message: task.blockedReason || "Coding execution failed." } : null),
    usage: raw?.usage || null,
    terminal: TERMINAL.has(task.status),
  });
}

export function createCodingExecutorService({ runtime, storage, ownerId, bindings = [], executionTruth } = {}) {
  if (!runtime?.create || !runtime?.get || !runtime?.steps || !runtime?.control || !storage?.getAutonomyTask) {
    throw new Error("Coding executor requires the durable task runtime and storage.");
  }
  const trusted = normalizeBindings(bindings);
  const validatePrepared = async (input, options) => {
    const binding = trusted.get(input?.projectId);
    const job = normalizeJob(input, binding, options);
    const parent = await storage.getAutonomyTask(job.parentTaskId, ownerId);
    if (!parent) fail("coding_parent_task_not_found", "The parent Nova task was not found.", 404);
    if (parent.projectId !== job.projectId || parent.branch !== job.repository.branch || parent.currentCommit !== job.repository.baseline) {
      fail("coding_parent_binding_changed", "The parent task no longer matches the trusted coding baseline.");
    }
    const prepared = parent.metadata?.codingDelegation;
    if (parent.taskType === "coding_orchestration" && prepared?.codingJobHash !== codingSpecificationHash(job)) {
      fail("coding_parent_specification_changed", "The approved coding job no longer matches its prepared parent task.");
    }
    return { job, parent };
  };
  const resolveCreationHandle = async (input) => {
    const handle = normalizeCreationHandle(input);
    const parent = await storage.getAutonomyTask(handle.parentTaskId, ownerId);
    if (!parent || parent.taskType !== "coding_orchestration") {
      fail("coding_parent_task_not_found", "The prepared coding parent was not found.", 404, { validationCode: "unknown_parent", fieldPath: "coding_job_create.parentTaskId", argumentKeys: Object.keys(handle) });
    }
    const prepared = parent.metadata?.codingDelegation;
    if (!prepared?.codingJob || typeof prepared.codingJobHash !== "string") {
      fail("coding_parent_specification_missing", "The prepared coding specification is unavailable.", 409, { validationCode: "stored_specification_missing", fieldPath: "coding_job_create.parentTaskId", argumentKeys: Object.keys(handle) });
    }
    const binding = trusted.get(prepared.codingJob.projectId);
    const job = normalizeJob(prepared.codingJob, binding, { requireApproval: false });
    const specificationHash = codingSpecificationHash(job);
    if (prepared.codingJobHash !== specificationHash) {
      fail("coding_parent_specification_changed", "The stored coding specification no longer matches its immutable hash.", 409, { validationCode: "stored_specification_hash_mismatch", fieldPath: "coding_job_create.specificationHash", argumentKeys: Object.keys(handle) });
    }
    if (handle.specificationHash !== specificationHash) {
      fail("coding_parent_specification_changed", "The coding creation handle does not match the prepared specification.", 409, { validationCode: "specification_hash_mismatch", fieldPath: "coding_job_create.specificationHash", argumentKeys: Object.keys(handle) });
    }
    if (parent.projectId !== job.projectId || parent.branch !== job.repository.branch || parent.currentCommit !== job.repository.baseline) {
      fail("coding_parent_binding_changed", "The parent task no longer matches the trusted coding baseline.");
    }
    return { handle, job, parent, specificationHash };
  };
  const resolveRetryLineage = async (taskId, { conversationId } = {}) => {
    taskId = requireCodingTaskId(taskId);
    const requested = await storage.getAutonomyTask(taskId, ownerId);
    if (!requested || requested.taskType !== "coding_delegation") fail("coding_retry_task_not_found", "The coding task was not found.", 404);
    if (!RETRYABLE_TERMINAL.has(requested.status) || requested.leaseOwner || requested.leaseToken) fail("coding_retry_unavailable", "This coding task is not eligible for a fresh approved retry.");
    const parentTaskId = requested.metadata?.parentTaskId;
    if (!ORCHESTRATION_TASK_ID.test(parentTaskId || "")) fail("coding_retry_parent_invalid", "The coding retry parent is invalid.");
    const parent = await storage.getAutonomyTask(parentTaskId, ownerId);
    const prepared = parent?.metadata?.codingDelegation;
    if (!parent || parent.taskType !== "coding_orchestration" || !prepared?.codingJob || typeof prepared.codingJobHash !== "string") fail("coding_retry_parent_invalid", "The coding retry parent is invalid.");
    const originConversationId = parent.metadata?.terminalReporting?.conversationId;
    if (typeof conversationId === "string" && conversationId && originConversationId !== conversationId) fail("coding_retry_conversation_unbound", "Coding retry requires the original trusted conversation.", 403);
    if (requested.metadata?.terminalReporting?.conversationId && requested.metadata.terminalReporting.conversationId !== originConversationId) fail("coding_retry_conversation_unbound", "Coding retry conversation binding changed.", 403);
    const binding = trusted.get(prepared.codingJob.projectId);
    const job = normalizeJob(prepared.codingJob, binding, { requireApproval: false });
    const specificationHash = codingSpecificationHash(job);
    if (prepared.codingJobHash !== specificationHash || job.parentTaskId !== parent.id || parent.projectId !== job.projectId || parent.branch !== job.repository.branch || parent.currentCommit !== job.repository.baseline) fail("coding_parent_specification_changed", "The canonical coding specification or parent binding changed.");
    const rootTaskId = codingTaskIdentity(job);
    let currentId = rootTaskId, predecessor = null, current = null;
    for (let generation = 0; generation <= MAX_SUCCESSOR_DEPTH; generation += 1) {
      current = await storage.getAutonomyTask(currentId, ownerId);
      if (!current) break;
      verifyStoredCodingIdentity(current, job, specificationHash);
      verifyRetryLineage(current, { rootTaskId, predecessor, generation, specificationHash });
      predecessor = current;
      currentId = codingSuccessorIdentity(specificationHash, current);
    }
    if (!predecessor || predecessor.id !== requested.id) fail("coding_retry_predecessor_superseded", "A newer coding attempt already exists for this workflow.");
    const retryApproval = parent.metadata?.codingRetryApproval;
    const pendingRetry = parent.status === "waiting_for_approval"
      && parent.currentPhase === "retry_waiting_for_approval"
      && parent.approvalState?.bindingSource === "coding_retry"
      && retryApproval?.version === CODING_RETRY_APPROVAL_VERSION
      && retryApproval.predecessorTaskId === requested.id
      && retryApproval.predecessorStateVersion === requested.stateVersion
      && retryApproval.specificationHash === specificationHash
      && parent.approvalState.approvalId === retryApproval.approvalId;
    if (!pendingRetry && (!TERMINAL.has(parent.status) || parent.leaseOwner || parent.leaseToken || parent.metadata?.delegatedTaskId !== requested.id)) fail("coding_retry_parent_invalid", "The coding retry parent is not at an eligible terminal boundary.");
    return { requested, parent, job, specificationHash, handle: Object.freeze({ parentTaskId: parent.id, specificationHash }), pendingRetry };
  };
  const createCanonical = async (job, parent = null) => {
      const specificationHash = codingSpecificationHash(job);
      const jobHash = hash(job);
      const rootTaskId = codingTaskIdentity(job);
      let taskId = rootTaskId, predecessor = null, generation = 0;
      for (; generation <= MAX_SUCCESSOR_DEPTH; generation += 1) {
        const existing = await storage.getAutonomyTask(taskId, ownerId);
        if (!existing) break;
        verifyStoredCodingIdentity(existing, job, specificationHash);
        verifyRetryLineage(existing, { rootTaskId, predecessor, generation, specificationHash });
        if (!RETRYABLE_TERMINAL.has(existing.status)) {
          return { task: existing, result: publicResult(existing, await runtime.steps(taskId)), duplicate: true };
        }
        if (existing.metadata?.codingJob?.approval?.approvalId === job.approval?.approvalId) {
          return { task: existing, result: publicResult(existing, await runtime.steps(taskId)), duplicate: true };
        }
        predecessor = existing;
        taskId = codingSuccessorIdentity(specificationHash, predecessor);
      }
      if (generation > MAX_SUCCESSOR_DEPTH) fail("coding_retry_lineage_invalid", "The bounded coding retry lineage is exhausted.");
      const retry = Object.freeze({
        contractVersion: CODING_RETRY_CONTRACT_VERSION,
        rootTaskId,
        predecessorTaskId: predecessor?.id || null,
        predecessorStateVersion: predecessor?.stateVersion || null,
        generation,
        specificationHash,
      });
      const createInput = {
        id: taskId,
        title: `Codex: ${job.objective.slice(0, 100)}`,
        objective: job.objective,
        taskType: "coding_delegation",
        projectId: job.projectId,
        branch: job.repository.branch,
        startingCommit: job.repository.baseline,
        maxSteps: 3,
        maxRetries: 0,
        maxRuntimeMinutes: 120,
        metadata: {
          codingJob: job,
          codingJobHash: jobHash,
          codingSpecificationHash: specificationHash,
          codingRetry: retry,
          parentTaskId: job.parentTaskId,
          requiredCapability: "codex_local",
          autoDispatch: true,
          ...(parent?.metadata?.terminalReporting?{terminalReporting:parent.metadata.terminalReporting}:{}),
          steps: [{
            type: "delegate_coding",
            input: { tool: "codex_execute", arguments: job },
            approvalRequired: false,
            reason: "Execute the exact approved coding job in the bound local repository.",
          }],
        },
      };
      let task;
      try {
        task = await runtime.create(createInput);
      } catch (error) {
        if (error?.code !== "23505" && error?.cause?.code !== "23505") throw error;
        const concurrent = await storage.getAutonomyTask(taskId, ownerId);
        if (!concurrent) throw error;
        verifyStoredCodingIdentity(concurrent, job, specificationHash);
        verifyRetryLineage(concurrent, { rootTaskId, predecessor, generation, specificationHash });
        return { task: concurrent, result: publicResult(concurrent, await runtime.steps(taskId)), duplicate: true };
      }
      await storage.appendActivity({
        ownerId,
        projectId: job.projectId,
        runId: task.id,
        action: "coding_job_prepared",
        tool: "codex_execute",
        status: "queued",
        summary: "Preparing the approved bounded Codex coding job.",
        metadata: { taskId: task.id, parentTaskId: job.parentTaskId, jobId: job.jobId, repository: job.repository.slug, branch: job.repository.branch, predecessorTaskId: predecessor?.id || null, retryGeneration: generation },
      });
      return { task, result: publicResult(task, []), duplicate: false };
  };
  return Object.freeze({
    async validatePrepared(input) {
      const { job } = await validatePrepared(input, { requireApproval: false });
      return { ok: true, specificationHash: codingSpecificationHash(job) };
    },
    async validateCreationHandle(input) {
      const { specificationHash } = await resolveCreationHandle(input);
      return { ok: true, specificationHash };
    },
    async createFromHandle(input, { approvalId } = {}) {
      const { job, parent, specificationHash } = await resolveCreationHandle(input);
      if (parent.approvalState?.bindingSource === "coding_retry") {
        const retry = parent.metadata?.codingRetryApproval;
        if (retry?.version !== CODING_RETRY_APPROVAL_VERSION || retry.approvalId !== approvalId || retry.specificationHash !== specificationHash || parent.status !== "waiting_for_approval" || parent.currentPhase !== "retry_waiting_for_approval" || parent.approvalState.approvalId !== approvalId || parent.approvalState.arguments?.parentTaskId !== parent.id || parent.approvalState.arguments?.specificationHash !== specificationHash) fail("coding_retry_approval_invalid", "The fresh coding retry approval is not bound to this exact lineage.");
        try {
          const lineage = await resolveRetryLineage(retry.predecessorTaskId, { conversationId: parent.metadata?.terminalReporting?.conversationId });
          if (!lineage.pendingRetry || lineage.parent.stateVersion !== retry.waitingStateVersion) fail("coding_retry_approval_invalid", "The approved coding retry lineage changed before execution.");
        } catch (error) {
          if (error?.code !== "coding_retry_predecessor_superseded") throw error;
          const predecessor = await storage.getAutonomyTask(retry.predecessorTaskId, ownerId), successor = predecessor ? await storage.getAutonomyTask(codingSuccessorIdentity(specificationHash, predecessor), ownerId) : null;
          if (!predecessor || predecessor.stateVersion !== retry.predecessorStateVersion || !successor || successor.metadata?.codingRetry?.predecessorTaskId !== predecessor.id || successor.metadata?.codingRetry?.predecessorStateVersion !== predecessor.stateVersion || successor.metadata?.codingJob?.approval?.approvalId !== approvalId) fail("coding_retry_approval_invalid", "The approved coding retry lineage changed before execution.");
          verifyStoredCodingIdentity(successor, job, specificationHash);
        }
      }
      const approved = normalizeJob({ ...job, approval: { buildApproved: true, approvalId } }, trusted.get(job.projectId), { requireApproval: true });
      return createCanonical(approved,parent);
    },
    async retryEligibility(taskId, { conversationId } = {}) {
      try { await resolveRetryLineage(taskId, { conversationId }); return true; }
      catch (error) { if (error instanceof CodingExecutorError) return false; throw error; }
    },
    async requestRetry(taskId, { conversationId, runId } = {}) {
      const lineage = await resolveRetryLineage(taskId, { conversationId });
      if (lineage.pendingRetry) {
        const approval = await storage.getApproval(lineage.parent.approvalState.approvalId, ownerId);
        if (!approval || approval.status !== "pending" || approval.tool !== "coding_job_create" || approval.runId !== lineage.parent.id || hash(approval.arguments) !== hash(lineage.handle)) fail("coding_retry_approval_invalid", "The pending coding retry approval is invalid.");
        return { task: lineage.parent, approval, creationRequest: lineage.handle, idempotent: true, workflowContinued: true };
      }
      const approvalId = codingRetryApprovalIdentity({ parentTaskId: lineage.parent.id, specificationHash: lineage.specificationHash, predecessorTaskId: lineage.requested.id, predecessorStateVersion: lineage.requested.stateVersion, parentStateVersion: lineage.parent.stateVersion });
      const approvalInput = { id: approvalId, ownerId, projectId: lineage.parent.projectId, runId: lineage.parent.id, tool: "coding_job_create", reason: "Owner approval is required before Codex retries this exact failed coding lineage.", riskLevel: "HIGH_IMPACT", arguments: lineage.handle };
      let approval = await storage.getApproval(approvalId, ownerId);
      if (!approval) {
        try { approval = await storage.createApproval(approvalInput); }
        catch (error) { if (error?.code !== "23505" && error?.cause?.code !== "23505") throw error; approval = await storage.getApproval(approvalId, ownerId); }
      }
      if (!approval || approval.status !== "pending" || approval.tool !== "coding_job_create" || approval.runId !== lineage.parent.id || hash(approval.arguments) !== hash(lineage.handle)) fail("coding_retry_approval_invalid", "The fresh coding retry approval could not be bound safely.");
      const waitingStateVersion = lineage.parent.stateVersion + 1;
      const record = Object.freeze({ version: CODING_RETRY_APPROVAL_VERSION, approvalId, predecessorTaskId: lineage.requested.id, predecessorStateVersion: lineage.requested.stateVersion, specificationHash: lineage.specificationHash, fromParentStateVersion: lineage.parent.stateVersion, waitingStateVersion, requestedRunId: typeof runId === "string" ? runId : null });
      const updated = await storage.updateAutonomyTask(lineage.parent.id, ownerId, { status: "waiting_for_approval", currentPhase: "retry_waiting_for_approval", nextRunAt: null, completedAt: null, errorCode: null, blockedReason: "A fresh owner approval is required before retrying the failed Codex job.", approvalState: { approvalId, approved: false, tool: "coding_job_create", stepId: "delegation:retry", arguments: lineage.handle, bindingSource: "coding_retry", predecessorTaskId: lineage.requested.id, predecessorStateVersion: lineage.requested.stateVersion }, metadata: { ...lineage.parent.metadata, delegatedTaskId: null, codingRetryApproval: record, codingRetryApprovalHistory: [...(lineage.parent.metadata?.codingRetryApprovalHistory || []), record] } }, lineage.parent.stateVersion);
      if (!updated) {
        const current = await storage.getAutonomyTask(lineage.parent.id, ownerId);
        const converged = current?.status === "waiting_for_approval" && current.approvalState?.approvalId === approvalId && current.metadata?.codingRetryApproval?.predecessorTaskId === lineage.requested.id;
        if (!converged) { await storage.decideApproval?.(approvalId, ownerId, "rejected").catch(() => null); fail("coding_retry_version_conflict", "The coding workflow changed before retry approval was bound."); }
        return { task: current, approval, creationRequest: lineage.handle, idempotent: true, workflowContinued: true };
      }
      await storage.appendActivity({ ownerId, projectId: updated.projectId, runId: updated.id, action: "coding_retry_approval_requested", tool: "coding_job_create", status: "waiting", summary: "The exact failed coding lineage awaits a fresh owner approval.", metadata: { taskId: updated.id, predecessorTaskId: lineage.requested.id, predecessorStateVersion: lineage.requested.stateVersion, approvalId, phase: "retry_waiting_for_approval" } });
      return { task: updated, approval, creationRequest: lineage.handle, idempotent: false, workflowContinued: true };
    },
    async create(input) {
      const { job, parent } = await validatePrepared(input, { requireApproval: true });
      return createCanonical(job,parent);
    },
    async get(taskId) {
      taskId = requireCodingTaskId(taskId);
      const task = await runtime.get(taskId);
      if (task.taskType !== "coding_delegation") fail("coding_job_not_found", "Coding job was not found.", 404);
      return { task, result: publicResult(task, await runtime.steps(taskId)) };
    },
    async progress(taskId, input = {}) {
      taskId = requireCodingTaskId(taskId);
      const task = await runtime.get(taskId);
      if (task.taskType !== "coding_delegation") fail("coding_job_not_found", "Coding job was not found.", 404);
      const phase = String(input.phase || "");
      if (!CODING_ACTIVE_PROGRESS_PHASES.includes(phase)) {
        fail("coding_progress_invalid", "Coding progress phase is invalid.", 400);
      }
      const handoffId = text(input.handoffId, "handoffId", 128);
      if (task.metadata?.localHandoff?.id !== handoffId || !["queued", "running"].includes(task.status)) {
        fail("coding_progress_stale", "Coding progress does not match the active durable handoff.");
      }
      const summary = text(input.summary, "summary", 300);
      if(executionTruth){const supplied=input.executionAttempt,attempt=await executionTruth.attemptForTask(task.id);if(!attempt||attempt.handoffId!==handoffId||!supplied||supplied.id!==attempt.id||supplied.generation!==attempt.generation||supplied.fenceToken!==attempt.fenceToken)fail("execution_attempt_stale","Coding progress does not match the fenced execution attempt.",409);await executionTruth.heartbeat({id:attempt.id,taskId:task.id,handoffId,workerId:task.metadata.localHandoff.workerId,generation:attempt.generation,fenceToken:attempt.fenceToken},{phase,executorStarted:phase!=="preparing",progress:true});}
      await storage.appendActivity({
        ownerId,
        projectId: task.projectId,
        runId: task.id,
        action: `coding_executor_${phase}`,
        tool: "codex_execute",
        status: "running",
        summary,
        metadata: { taskId: task.id, parentTaskId: task.metadata?.parentTaskId || null, jobId: task.metadata?.codingJob?.jobId || null, phase },
      });
      return { ok: true, taskId: task.id, phase };
    },
    async cancel(taskId) {
      taskId = requireCodingTaskId(taskId);
      const task = await runtime.get(taskId);
      if (task.taskType !== "coding_delegation") fail("coding_job_not_found", "Coding job was not found.", 404);
      if (task.status === "running" || task.leaseOwner || task.leaseToken) {
        fail("coding_job_active_not_cancellable", "The active Codex action must finish before cancellation can be recorded.");
      }
      return runtime.control(taskId, "cancel");
    },
  });
}
