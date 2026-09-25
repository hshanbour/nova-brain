import { createHash } from "node:crypto";
import { codingSpecificationHash, immutableCodingSpecification } from "./coding-executor.js";

const CODING_ACTION = /\b(?:build|code|implement|fix|improve|change|update|finish|repair|refactor|add)\b/i;
const CODEX_DELEGATION = /\b(?:use|delegate|hand\s*off|assign|send)\b[\s\S]{0,80}\bCodex\b|\bCodex\b[\s\S]{0,80}\b(?:coding|executor|implement|engineer)/i;
const SHA = /^[a-f0-9]{40}$/;

const stable = (value) => Array.isArray(value)
  ? value.map(stable)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    : value;
const digest = (value) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const cleanList = (value, max = 40) => Array.isArray(value)
  ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, max)
  : [];
const publicParent = (task) => Object.freeze({
  id: task.id,
  taskType: task.taskType,
  status: task.status,
  stateVersion: task.stateVersion,
  projectId: task.projectId,
  branch: task.branch,
  startingCommit: task.startingCommit,
});

export function isChatCodingDelegationRequest(message) {
  const value = String(message || "");
  return CODING_ACTION.test(value) && CODEX_DELEGATION.test(value);
}

export function createCodingDelegationService({ runtime, storage, ownerId, bindings = [], verifyRemote } = {}) {
  if (!runtime?.create || !storage?.getAutonomyTask || typeof verifyRemote !== "function") {
    throw new Error("Coding delegation requires durable runtime, storage, and trusted remote resolution.");
  }
  const trusted = new Map(bindings.map((binding) => {
    if(!binding?.projectId||!binding?.workspaceId||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(binding?.repository||"")||!binding?.branch||["main","master"].includes(String(binding.branch).toLowerCase()))
      throw Object.assign(new Error("A trusted coding project binding is invalid."),{code:"coding_binding_invalid"});
    return [binding.projectId, Object.freeze({ ...binding })];
  }));
  return Object.freeze({
    async prepare(input, context = {}) {
      const requestedProject = context.projectId || input?.projectId || null;
      const binding = requestedProject ? trusted.get(requestedProject) : trusted.size === 1 ? [...trusted.values()][0] : null;
      if (requestedProject && !binding) {
        throw Object.assign(new Error("The requested project is not an approved coding binding."), { code: "coding_repository_binding_rejected" });
      }
      if (!binding) {
        const error = new Error(trusted.size > 1 ? "Which trusted project should Codex modify?" : "No trusted Codex project binding is available.");
        error.code = trusted.size > 1 ? "coding_project_binding_ambiguous" : "coding_project_binding_missing";
        throw error;
      }
      if (input?.projectId && input.projectId !== binding.projectId) {
        throw Object.assign(new Error("The requested project is not an approved coding binding."), { code: "coding_repository_binding_rejected" });
      }
      const requestFingerprint = String(context.delegationRequestFingerprint || "");
      if (!/^[a-f0-9]{64}$/.test(requestFingerprint)) {
        throw Object.assign(new Error("The Chat delegation request is not bound to its original message."), { code: "coding_delegation_unbound" });
      }
      const objective = String(input?.objective || "").trim();
      const acceptanceCriteria = cleanList(input?.acceptanceCriteria);
      if (!objective || objective.length > 8_000 || acceptanceCriteria.length === 0) {
        throw Object.assign(new Error("A bounded coding objective and acceptance criteria are required."), { code: "coding_delegation_invalid" });
      }
      const remote = await verifyRemote({ repository: binding.repository, branch: binding.branch, requiredAncestors: [], signal: context.signal });
      if (!SHA.test(remote?.currentTip || "")) {
        throw Object.assign(new Error("The trusted coding baseline could not be resolved."), { code: "coding_repository_not_resolved" });
      }
      const parentTaskId = `orchestration_${digest(["coding-delegation-v1", requestFingerprint, binding.projectId, binding.repository, binding.branch, remote.currentTip]).slice(0, 32)}`;
      const jobId = `job_${digest([parentTaskId, "codex-local-v1"]).slice(0, 32)}`;
      const job = immutableCodingSpecification({
        jobId,
        parentTaskId,
        objective,
        acceptanceCriteria,
        constraints: cleanList(input?.constraints),
        repository: Object.freeze({ slug: binding.repository, branch: binding.branch, baseline: remote.currentTip }),
        projectId: binding.projectId,
        workspaceId: binding.workspaceId,
        delivery: Object.freeze({ boundary: "local_commit", allowPush: false, allowDeploy: false }),
        verification: cleanList(input?.verification, 30),
      });
      const existing = await storage.getAutonomyTask(parentTaskId, ownerId);
      if (existing) {
        const prepared = existing.metadata?.codingDelegation, specificationHash = prepared?.codingJobHash;
        if (existing.taskType !== "coding_orchestration" || !prepared?.codingJob || specificationHash !== codingSpecificationHash(prepared.codingJob)) {
          throw Object.assign(new Error("The coding delegation identity is already bound to invalid or different durable inputs."), { code: "coding_delegation_identity_conflict" });
        }
        return { task: publicParent(existing), creationRequest: Object.freeze({ parentTaskId: existing.id, specificationHash }), duplicate: true };
      }
      const task = await runtime.create({
        id: parentTaskId,
        title: `Codex delegation: ${objective.slice(0, 90)}`,
        objective,
        taskType: "coding_orchestration",
        projectId: binding.projectId,
        branch: binding.branch,
        startingCommit: remote.currentTip,
        currentCommit: remote.currentTip,
        maxSteps: 1,
        maxRetries: 0,
        maxRuntimeMinutes: 120,
        metadata: {
          autoDispatch: false,
          parentTask: true,
          codingDelegation: { version: 1, requestFingerprint, codingJob: job, codingJobHash: codingSpecificationHash(job) },
          steps: [],
        },
      });
      return {
        task: publicParent(task),
        creationRequest: Object.freeze({ parentTaskId: task.id, specificationHash: task.metadata.codingDelegation.codingJobHash }),
        duplicate: false,
      };
    },
  });
}

export function codingDelegationFingerprint(message) {
  return digest(["chat-coding-delegation-v1", String(message || "").trim().replace(/\s+/g, " ")]);
}
