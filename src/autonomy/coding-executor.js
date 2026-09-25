import { createHash } from "node:crypto";

const SHA = /^[a-f0-9]{40}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SECRET = /(?:sk-[A-Za-z0-9_-]{16,}|(?:api[_-]?key|password|passcode|bearer|authorization)\s*[:=]\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----|seed\s+phrase\s*[:=]\s*\S+)/i;
const TERMINAL = new Set(["completed", "failed", "cancelled", "expired", "blocked"]);
const CODING_SPECIFICATION_VERSION = 1;
const CODING_TASK_ID = /^coding_[a-f0-9]{32}$/;

export class CodingExecutorError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = "CodingExecutorError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode = 409) {
  throw new CodingExecutorError(code, message, statusCode);
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
  });
}

export const codingSpecificationHash = (value) => hash(immutableCodingSpecification(value));

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

export function createCodingExecutorService({ runtime, storage, ownerId, bindings = [] } = {}) {
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
  return Object.freeze({
    async validatePrepared(input) {
      const { job } = await validatePrepared(input, { requireApproval: false });
      return { ok: true, specificationHash: codingSpecificationHash(job) };
    },
    async create(input) {
      const { job } = await validatePrepared(input, { requireApproval: true });
      const taskId = `coding_${hash([job.parentTaskId, job.jobId]).slice(0, 32)}`;
      const existing = await storage.getAutonomyTask(taskId, ownerId);
      const jobHash = hash(job);
      if (existing) {
        if (existing.metadata?.codingJobHash !== jobHash) fail("coding_job_identity_conflict", "The coding job identity is already bound to different inputs.");
        return { task: existing, result: publicResult(existing, await runtime.steps(taskId)), duplicate: true };
      }
      const task = await runtime.create({
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
          parentTaskId: job.parentTaskId,
          requiredCapability: "codex_local",
          autoDispatch: true,
          steps: [{
            type: "delegate_coding",
            input: { tool: "codex_execute", arguments: job },
            approvalRequired: false,
            reason: "Execute the exact approved coding job in the bound local repository.",
          }],
        },
      });
      await storage.appendActivity({
        ownerId,
        projectId: job.projectId,
        runId: task.id,
        action: "coding_job_prepared",
        tool: "codex_execute",
        status: "queued",
        summary: "Preparing the approved bounded Codex coding job.",
        metadata: { taskId: task.id, parentTaskId: job.parentTaskId, jobId: job.jobId, repository: job.repository.slug, branch: job.repository.branch },
      });
      return { task, result: publicResult(task, []), duplicate: false };
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
      if (!new Set(["preparing", "inspecting", "implementing", "testing", "reviewing"]).has(phase)) {
        fail("coding_progress_invalid", "Coding progress phase is invalid.", 400);
      }
      const handoffId = text(input.handoffId, "handoffId", 128);
      if (task.metadata?.localHandoff?.id !== handoffId || !["queued", "running"].includes(task.status)) {
        fail("coding_progress_stale", "Coding progress does not match the active durable handoff.");
      }
      const summary = text(input.summary, "summary", 300);
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
