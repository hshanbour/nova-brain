import { createHash, randomUUID } from "node:crypto";
import { ApprovalRequiredError } from "../policy/action-policy.js";
import {activeContinuationExceeded,assertActiveImplementationPlan,planLifecycleMetadata,taskRuntimeWindow} from "./self-development-plan-lifecycle.js";
import {isExactApprovedDelivery} from "./auto-dispatch.js";

export const AUTONOMY_STATUSES = Object.freeze([
  "queued",
  "planning",
  "running",
  "waiting",
  "waiting_for_worker",
  "waiting_for_approval",
  "retrying",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);
export const STEP_CAPABILITIES = Object.freeze({
  inspect_repo: "repo_read_remote",
  search_code: "repo_read_remote",
  read_files: "repo_read_remote",
  inspect_logs: "vercel_preview",
  diagnose: "reasoning",
  plan_patch: "reasoning",
  plan_implementation: "reasoning",
  plan_repair: "reasoning",
  apply_patch: "repo_mutate_local",
  run_focused_tests: "test_local",
  run_full_tests: "test_local",
  inspect_diff: "repo_read_remote",
  review_commit: "repo_read_remote",
  commit: "repo_mutate_local",
  integrate_commit: "repo_mutate_local",
  request_push_approval: "github_write",
  authorize_protected_change: "reasoning",
  push: "github_write",
  deploy_preview: "vercel_preview",
  verify_preview: "vercel_preview",
  inspect_failure: "reasoning",
  retry_repair: "reasoning",
  summarize: "reasoning",
  wait: "scheduler",
});
const TERMINAL = new Set([
  "completed",
  "failed",
  "cancelled",
  "expired",
  "blocked",
]);
const HISTORICAL_APPROVED_DELIVERY=Object.freeze({taskId:"selfdev_10721df97b8cbc63c70d4171f6f4a440",fromStateVersion:266,approvedStateVersion:264,currentStep:308,approvalId:"fb4e62f7-9189-4151-ac11-c620e934d3aa",commitSha:"5818ce4a8b0eb13285971cfcede009c7ae0d5aad",repository:"hshanbour/nova-brain",branch:"feat/nova-brain-mvp-foundation",recoveryClass:"historical_approved_delivery_max_steps_recovery"});
const HISTORICAL_APPROVED_DELIVERY_RUNTIME=Object.freeze({...HISTORICAL_APPROVED_DELIVERY,fromStateVersion:269,priorDeliveryStateVersion:267,claimStateVersion:268,expirationStateVersion:269,claimKey:`auto:${HISTORICAL_APPROVED_DELIVERY.taskId}:267`,recoveryClass:"historical_approved_delivery_runtime_recovery",runtimeMinutes:5});
const HISTORICAL_APPROVED_DELIVERY_HANDOFF=Object.freeze({...HISTORICAL_APPROVED_DELIVERY,fromStateVersion:272,deliveryStateVersion:270,failedStepId:"309:push",recoveryClass:"historical_approved_delivery_handoff_recovery",runtimeMinutes:5});
const HISTORICAL_APPROVED_DELIVERY_HANDOFF_RUNTIME=Object.freeze({...HISTORICAL_APPROVED_DELIVERY,fromStateVersion:274,priorDeliveryStateVersion:273,failedStepId:"309:push",recoveryClass:"historical_approved_delivery_handoff_runtime_recovery",runtimeMinutes:5});
const HISTORICAL_APPROVED_DELIVERY_WORKER_CAPABILITY_RUNTIME=Object.freeze({...HISTORICAL_APPROVED_DELIVERY,fromStateVersion:276,priorDeliveryStateVersion:275,failedStepId:"309:push",priorRecoveryClass:HISTORICAL_APPROVED_DELIVERY_HANDOFF_RUNTIME.recoveryClass,recoveryClass:"historical_approved_delivery_worker_capability_runtime_recovery",runtimeMinutes:5});
const APPROVAL_CONTRACT_DELIVERY_RUNTIME="approval_contract_delivery_runtime";
const MUTATING = new Set(["apply_patch", "commit", "push"]);
const REASONING = new Set(["diagnose", "plan_patch", "inspect_failure"]);
const RETRYABLE = new Set([
  "network_error",
  "provider_timeout",
  "deployment_pending",
  "rate_limit",
  "preview_unavailable",
  "worker_crash",
]);
const redact = (value) => {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        /token|secret|password|authorization|api.?key/i.test(k) ? k : k,
        /token|secret|password|authorization|api.?key/i.test(k)
          ? "[REDACTED]"
          : redact(v),
      ]),
    );
  return value;
};
const fingerprint = (task, step) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        task.id,
        task.currentStep,
        step.type,
        redact(step.input || {}),
        task.currentCommit,
      ]),
    )
    .digest("hex");
const iso = (clock, ms = 0) => new Date(clock().getTime() + ms).toISOString();
export class WorkerError extends Error {
  constructor(
    code,
    message,
    { retryable = RETRYABLE.has(code), details, statusCode = 409 } = {},
  ) {
    super(message);
    this.name = "WorkerError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
    this.statusCode = statusCode;
  }
}

export function createWorkerRuntime({
  storage,
  ownerId,
  toolRegistry,
  planner,
  clock = () => new Date(),
  workerId = `worker-${randomUUID()}`,
  capabilities = [
    "repo_read_remote",
    "reasoning",
    "scheduler",
    "vercel_preview",
  ],
  leaseMs = 30000,
  approvedBranch = "feat/nova-brain-mvp-foundation",
  approvedRepository = "hshanbour/nova-brain",
} = {}) {
  if (!storage || !ownerId || !toolRegistry)
    throw new Error(
      "Worker runtime requires storage, ownerId, and Hands tools.",
    );
  const activity = (task, action, status, summary, metadata = {}) =>
    storage.appendActivity({
      ownerId,
      projectId: task.projectId,
      runId: task.id,
      action,
      status,
      summary,
      metadata: redact({ taskId: task.id, ...metadata }),
    });
  async function create(input) {
    if (
      typeof input?.title !== "string" ||
      !input.title.trim() ||
      typeof input?.objective !== "string" ||
      !input.objective.trim()
    )
      throw new WorkerError(
        "invalid_task_configuration",
        "Task title and objective are required.",
        { retryable: false },
      );
    if (input.branch && input.branch !== approvedBranch)
      throw new WorkerError(
        "branch_not_allowed",
        "Only the approved feature branch may host developer tasks.",
        { retryable: false },
      );
    const task = await storage.createAutonomyTask({
      ...input,
      metadata: redact(input.metadata || {}),
      branch: input.branch || approvedBranch,
      ownerId,
      maxSteps: Math.max(1, Math.min(100, input.maxSteps || 30)),
      maxRetries: Math.max(0, Math.min(10, input.maxRetries ?? 3)),
      maxRuntimeMinutes: Math.max(
        1,
        Math.min(240, input.maxRuntimeMinutes || 30),
      ),
    });
    await storage.createRun({
      id: task.id,
      ownerId,
      projectId: task.projectId,
      goal: task.objective,
      status: "queued",
    });
    await activity(
      task,
      "autonomy_task_created",
      "queued",
      "Autonomous task queued.",
    );
    return task;
  }
  async function control(id, action) {
    const task = await storage.getAutonomyTask(id, ownerId);
    if (!task)
      throw new WorkerError("task_not_found", "Task not found.", {
        retryable: false,
      });
    if (action === "cancel") {
      await storage.releaseAutonomyLocks(id);
      return storage.updateAutonomyTask(id, ownerId, {
        status: "cancelled",
        completedAt: iso(clock),
        blockedReason: "Cancelled by owner.",
      });
    }
    if (action === "pause" && !TERMINAL.has(task.status))
      return storage.updateAutonomyTask(id, ownerId, {
        status: "waiting",
        nextRunAt: null,
        blockedReason: "Paused by owner.",
      });
    if (
      action === "resume" &&
      ["waiting", "blocked", "waiting_for_worker"].includes(task.status)
    )
      return storage.updateAutonomyTask(id, ownerId, {
        status: "queued",
        nextRunAt: iso(clock),
        blockedReason: null,
        errorCode: null,
      });
    throw new WorkerError(
      "invalid_task_transition",
      "Task control action is invalid for its state.",
      { retryable: false },
    );
  }
  async function next(task) {
    if(task.approvalState?.approved===true&&!task.metadata?.steps?.[task.currentStep]){const approval=await storage.getApproval(task.approvalState.approvalId,ownerId),steps=await storage.listAutonomySteps(task.id);if(!isExactApprovedDelivery({task,approval,steps,approvedBranch,approvedRepository,allowClaimed:true}))throw new WorkerError("approval_invalidated","Approved delivery binding is stale or inconsistent.",{retryable:false});return{next_step:"push",reason:"Execute the exact owner-approved immutable delivery.",required_inputs:{tool:"git_push",arguments:{branch:task.branch,commitSha:task.currentCommit}},approval_required:false};}
    const planned =
      task.metadata?.steps?.[task.currentStep] ||
      (await planner?.({ task, checkpoint: task.checkpoint }));
    if (!planned)
      return {
        next_step: "summarize",
        reason: "Plan exhausted.",
        required_inputs: {},
        approval_required: false,
      };
    return planned.next_step
      ? planned
      : {
          next_step: planned.type,
          reason: planned.reason || "Planned deterministic step.",
          required_inputs: planned.input || {},
          approval_required: Boolean(planned.approvalRequired),
        };
  }
  async function tick({ idempotencyKey = randomUUID() } = {}) {
    const task = await storage.claimAutonomyTask({
      ownerId,
      workerId,
      capabilities,
      leaseMs,
      idempotencyKey,
    });
    if (!task) return { claimed: false };
    try {
      return await advance(task);
    } finally {
      await storage.releaseAutonomyLease(task.id, ownerId, task.leaseToken);
    }
  }
  async function tickTask(taskId, { idempotencyKey = randomUUID() } = {}) {
    if (typeof taskId !== "string" || !taskId.trim())
      throw new WorkerError("invalid_task_id", "An exact task ID is required.", {
        retryable: false,
        statusCode: 400,
      });
    const requested = await storage.getAutonomyTask(taskId, ownerId);
    if (!requested)
      throw new WorkerError("task_not_found", "Task not found.", {
        retryable: false,
        statusCode: 404,
      });
    if (requested.branch !== approvedBranch)
      throw new WorkerError("branch_not_allowed", "The requested task branch is not allowed.", { retryable: false, statusCode: 403 });
    if (requested.status === "waiting_for_approval")
      throw new WorkerError("approval_required", "The requested task is waiting for approval.", { retryable: false });
    if (TERMINAL.has(requested.status))
      throw new WorkerError("task_not_eligible", "The requested task is terminal.", { retryable: false });
    if (requested.leaseToken || requested.leaseOwner || requested.leaseExpiresAt)
      throw new WorkerError("task_lease_conflict", "The requested task already has a lease.", { retryable: false });
    const due = !requested.nextRunAt || new Date(requested.nextRunAt) <= clock();
    if (!(requested.status === "queued" || requested.status === "retrying" || (requested.status === "waiting" && requested.nextRunAt)) || !due)
      throw new WorkerError("task_not_eligible", "The requested task is not eligible to run.", { retryable: false });
    const planned = await next(requested);
    const approvedDelivery = planned.next_step === "push" && requested.approvalState?.approved === true && (!requested.metadata?.steps?.[requested.currentStep]||(requested.metadata.steps[requested.currentStep].type==="push"&&Boolean(requested.metadata?.approvedDeliveryRuntime)));
    const requiredCapability = requested.metadata?.requiredCapability || STEP_CAPABILITIES[planned.next_step] || planned.required_capability;
    if (!requiredCapability || !capabilities.includes(requiredCapability))
      throw new WorkerError("capability_mismatch", "This worker cannot execute the requested task step.", { retryable: false });
    const task = await storage.claimAutonomyTask({
      ownerId,
      workerId,
      capabilities,
      leaseMs,
      idempotencyKey,
      taskId: requested.id,
      expectedBranch: requested.branch,
      expectedCommit: requested.currentCommit,
      expectedVersion: requested.stateVersion,
    });
    if (!task) {
      const latest = await storage.getAutonomyTask(requested.id, ownerId);
      throw new WorkerError(latest?.stateVersion !== requested.stateVersion ? "version_conflict" : "task_not_eligible", "The requested task changed before it could be claimed.", { retryable: false });
    }
    try {
      return await advance(task);
    } finally {
      await storage.releaseAutonomyLease(task.id, ownerId, task.leaseToken);
    }
  }
  async function advance(task) {
    const plan = await next(task),
      type = plan.next_step,
      capability = STEP_CAPABILITIES[type] || plan.required_capability;
    const approvedDelivery = type === "push" && task.approvalState?.approved === true && (!task.metadata?.steps?.[task.currentStep]||(task.metadata.steps[task.currentStep].type==="push"&&Boolean(task.metadata?.approvedDeliveryRuntime)));
    if (!approvedDelivery && activeContinuationExceeded(task))
      return stop(task, "failed", "max_steps_reached");
    const deliveryRuntime=approvedDelivery&&task.metadata?.approvedDeliveryRuntime,
      deliveryRuntimeClassValid=deliveryRuntime?.recoveryClass===HISTORICAL_APPROVED_DELIVERY_RUNTIME.recoveryClass||deliveryRuntime?.recoveryClass===APPROVAL_CONTRACT_DELIVERY_RUNTIME||deliveryRuntime?.recoveryClass==="historical_v288_approval_contract_delivery_runtime_recovery",
      deliveryRuntimeValid=Boolean(deliveryRuntime&&deliveryRuntimeClassValid&&deliveryRuntime.taskId===task.id&&deliveryRuntime.approvalId===task.approvalState?.approvalId&&deliveryRuntime.approvedStateVersion===task.approvalState?.approvedStateVersion&&deliveryRuntime.deliveryStateVersion===task.approvalState?.deliveryStateVersion&&deliveryRuntime.repository===approvedRepository&&deliveryRuntime.branch===task.branch&&deliveryRuntime.commitSha===task.currentCommit&&deliveryRuntime.reviewStepId===`${task.currentStep}:review_commit`&&deliveryRuntime.deliveryStepId===`${task.currentStep+1}:push`&&deliveryRuntime.maxAdditionalDeliverySteps===1&&deliveryRuntime.consumed!==true&&new Date(deliveryRuntime.deadline)>clock());
    if (taskRuntimeWindow(task,clock()).expired&&!deliveryRuntimeValid)
      return stop(task, "expired", "max_runtime_reached");
    if (!capability) return stop(task, "failed", "invalid_step_type");
    if (!capabilities.includes(capability)) {
      await storage.updateAutonomyTask(task.id, ownerId, {
        status: "waiting_for_worker",
        blockedReason: `Worker capability required: ${capability}`,
        metadata: { ...task.metadata, requiredCapability: capability },
      });
      await activity(
        task,
        "autonomy_waiting_for_worker",
        "waiting",
        `Waiting for ${capability}.`,
        { capability },
      );
      return { claimed: true, status: "waiting_for_worker", capability };
    }
    const stepId = `${task.currentStep + 1}:${type}`,
      operationFingerprint = fingerprint(task, {
        type,
        input: plan.required_inputs,
      });
    const existing = (await storage.listAutonomySteps(task.id)).find(
      (x) =>
        x.operationFingerprint === operationFingerprint &&
        x.status === "completed",
    );
    if (existing) {
      await storage.updateAutonomyTask(task.id, ownerId, {
        status: "queued",
        currentStep: task.currentStep + 1,
        currentPhase: type,
        nextRunAt: iso(clock),
      });
      return { claimed: true, idempotent: true, step: existing };
    }
    let locked = false;
    if (MUTATING.has(type)) {
      locked = await storage.acquireAutonomyLock({
        lockKey: `${task.projectId || "repo"}:${task.branch}`,
        taskId: task.id,
        leaseToken: task.leaseToken,
        expiresAt: task.leaseExpiresAt,
      });
      if (!locked) {
        await storage.updateAutonomyTask(task.id, ownerId, {
          status: "waiting",
          nextRunAt: iso(clock, 1000),
          blockedReason: "Repository branch is locked.",
        });
        return { claimed: true, status: "waiting", code: "branch_locked" };
      }
    }
    const step = await storage.recordAutonomyStep({
      taskId: task.id,
      stepId,
      stepType: type,
      capability,
      operationFingerprint,
      input: redact(plan.required_inputs),
      status: "running",
    });
    await activity(
      task,
      "autonomy_step_started",
      "running",
      `${type} started.`,
      { stepId, capability },
    );
    try {
      if (type === "wait") {
        const delay = Math.max(
          1000,
          Math.min(300000, Number(plan.required_inputs.delayMs) || 30000),
        );
        await complete(
          task,
          step,
          { waiting: true },
          "waiting",
          iso(clock, delay),
        );
        return {
          claimed: true,
          status: "waiting",
          nextRunAt: iso(clock, delay),
        };
      }
      if (type === "summarize") {
        await storage.updateAutonomyStep(task.id, step.stepId, {
          status: "completed",
          result: redact(plan.required_inputs),
          completedAt: iso(clock),
        });
        return stop(
          task,
          "completed",
          null,
          plan.required_inputs.summary || "Task completed.",
        );
      }
      if (type === "retry_repair") {
        const limit = Math.max(
          1,
          Math.min(3, Number(task.metadata?.maxRepairIterations) || 3),
        );
        if (task.repairIteration >= limit)
          return stop(task, "failed", "repair_limit_reached");
        await storage.updateAutonomyTask(task.id, ownerId, {
          repairIteration: task.repairIteration + 1,
        });
        const result = {
          ok: true,
          repairIteration: task.repairIteration + 1,
          maxRepairIterations: limit,
        };
        await complete(task, step, result, "queued", iso(clock));
        return { claimed: true, status: "queued", stepType: type, result };
      }
      if (REASONING.has(type) && !plan.required_inputs.tool) {
        const result = {
          ok: true,
          reason: plan.reason,
          decision: redact(plan.required_inputs),
        };
        await complete(task, step, result, "queued", iso(clock));
        return { claimed: true, status: "queued", stepType: type, result };
      }
      const tool = plan.required_inputs.tool || toolFor(type);
      const rawArgs = plan.required_inputs.arguments || plan.required_inputs;
      const args = resolveTaskReferences(rawArgs, task);
      if(type==="apply_patch"&&task.taskType==="self_development"&&rawArgs?.files==="$IMPLEMENTATION_FILES")args.planProvenance=assertActiveImplementationPlan(task,args.files||[]);
      const result = await toolRegistry.execute(tool, args, {
        runId: task.id,
        projectId: task.projectId,
        approvalId: task.approvalState?.approvalId,
      });
      if(["plan_implementation","plan_repair"].includes(type)&&result?.evidenceExpansion){await completeEvidenceExpansion(task,step,plan,result);return{claimed:true,status:"queued",stepType:type,result:redact(result)};}
      await complete(task, step, result, approvedDelivery?"completed":"queued", approvedDelivery?null:iso(clock));
      return {
        claimed: true,
        status: approvedDelivery?"completed":"queued",
        stepType: type,
        result: redact(result),
      };
    } catch (error) {
      if (error instanceof ApprovalRequiredError) {
        await storage.updateAutonomyStep(task.id, step.stepId, {
          status: "waiting",
          errorCode: "approval_required",
        });
        await storage.updateAutonomyTask(task.id, ownerId, {
          status: "waiting_for_approval",
          approvalState: {
            approvalId: error.approval.id,
            tool: error.approval.tool,
            arguments: error.approval.arguments,
            branch: task.branch,
            commitSha: task.currentCommit,
            stepId: step.stepId,
          },
          blockedReason: "Owner approval required.",
        });
        await activity(
          task,
          "autonomy_approval_requested",
          "waiting",
          "Task paused for owner approval.",
          { approvalId: error.approval.id, stepId: step.stepId },
        );
        return {
          claimed: true,
          status: "waiting_for_approval",
          approval: error.approval,
        };
      }
      const code = error.code || "unexpected_error",
        retryable = error.retryable ?? RETRYABLE.has(code);
      await storage.updateAutonomyStep(task.id, step.stepId, {
        status: "failed",
        errorCode: code,
        result: { message: String(error.message).slice(0, 300), ...(error.safeDiagnostics ? { diagnostics: redact(error.safeDiagnostics) } : {}) },
        completedAt: iso(clock),
      });
      if (retryable && task.retryCount < task.maxRetries) {
        const retry = task.retryCount + 1,
          delay = Math.min(300000, 1000 * 2 ** (retry - 1));
        await storage.updateAutonomyTask(task.id, ownerId, {
          status: "retrying",
          retryCount: retry,
          errorCode: code,
          nextRunAt: iso(clock, delay),
          checkpoint: { ...task.checkpoint, pendingStep: plan },
        });
        await activity(
          task,
          "autonomy_step_retry",
          "retrying",
          `${type} scheduled for retry.`,
          { stepId, errorCode: code, retry, delay },
        );
        return {
          claimed: true,
          status: "retrying",
          errorCode: code,
          nextRunAt: iso(clock, delay),
        };
      }
      return stop(task, "failed", code);
    } finally {
      if (locked) await storage.releaseAutonomyLocks(task.id, task.leaseToken);
    }
  }
  async function completeEvidenceExpansion(task,step,plan,result){const expansion=result.evidenceExpansion,paths=[...new Set(expansion.paths||[])],currentPlan=task.metadata.steps[task.currentStep],inserted=paths.map((path,index)=>({type:"read_files",capability:"repo_read_remote",input:{tool:"repo_read",arguments:{path,startLine:1,endLine:1000}},expectedOutput:`Complete contents of ${path}`,successCondition:"Focused test evidence is read before execution",retryClassification:"safe_read",approvalRequired:false,idempotencyIdentity:`self-development:evidence-expansion:${expansion.attempt}:${index}:${fingerprint(task,path)}`})),replan={...currentPlan,input:{...currentPlan.input,arguments:{...currentPlan.input.arguments,candidatePaths:expansion.candidatePaths}}},metadata={...task.metadata,steps:[...task.metadata.steps.slice(0,task.currentStep+1),...inserted,replan,...task.metadata.steps.slice(task.currentStep+1)],requiredCapability:"repo_read_remote",implementationEvidenceExpansionHistory:[...(task.metadata.implementationEvidenceExpansionHistory||[]),{code:expansion.code,category:expansion.category,attempt:expansion.attempt,plannerAttempt:expansion.plannerAttempt,pathHashes:expansion.pathHashes,...(expansion.rejectedTarget?{rejectedTarget:expansion.rejectedTarget}:{}),requestedAt:iso(clock)}]};await storage.updateAutonomyStep(task.id,step.stepId,{status:"completed",result:redact({ok:true,evidenceExpansion:{code:expansion.code,category:expansion.category,attempt:expansion.attempt,pathHashes:expansion.pathHashes}}),completedAt:iso(clock)});await storage.updateAutonomyTask(task.id,ownerId,{status:"queued",currentStep:task.currentStep+1,currentPhase:"evidence_expansion",nextRunAt:iso(clock),checkpoint:{...task.checkpoint,completedSteps:[...(task.checkpoint?.completedSteps||[]),step.stepId],pendingStep:null,latestResult:redact({evidenceExpansion:{code:expansion.code,attempt:expansion.attempt,pathHashes:expansion.pathHashes}})},metadata,blockedReason:null,errorCode:null});await activity(task,"self_development_evidence_expansion_scheduled","queued","Bounded focused-test evidence reads scheduled before replanning.",{stepId:step.stepId,category:expansion.category,attempt:expansion.attempt,plannerAttempt:expansion.plannerAttempt,pathHashes:expansion.pathHashes,fileCount:paths.length,...(expansion.rejectedTarget?{rejectedTarget:expansion.rejectedTarget}:{})});}
  async function complete(task, step, result, status, nextRunAt) {
    const completed = [...(task.checkpoint?.completedSteps || []), step.stepId];
    await storage.updateAutonomyStep(task.id, step.stepId, {
      status: "completed",
      result: redact(result),
      completedAt: iso(clock),
    });
    await storage.updateAutonomyTask(task.id, ownerId, {
      status,
      currentStep: task.currentStep + 1,
      currentPhase: step.stepType,
      currentCommit: result?.commitSha || task.currentCommit,
      nextRunAt,
      checkpoint: {
        ...task.checkpoint,
        completedSteps: completed,
        pendingStep: null,
        latestResult: redact(result),
      },
      metadata: { ...(result?.implementationPlan?planLifecycleMetadata(task,redact(result.implementationPlan)):task.metadata), requiredCapability: null, ...(result?.deploymentId?{lastDeploymentId:result.deploymentId}:{}) },
      blockedReason: null,
      errorCode: null,
      ...(status === "completed" ? { completedAt: iso(clock) } : {}),
      ...(step.stepType === "push" ? { approvalState: null } : {}),
    });
    await activity(
      task,
      "autonomy_step_completed",
      "completed",
      `${step.stepType} completed.`,
      {
        stepId: step.stepId,
        commitSha: result?.commitSha,
        deploymentId: result?.deploymentId,
      },
    );
  }
  async function stop(task, status, errorCode, resultSummary) {
    await storage.releaseAutonomyLocks(task.id);
    const updated = await storage.updateAutonomyTask(task.id, ownerId, {
      status,
      errorCode: errorCode || null,
      resultSummary: resultSummary || task.resultSummary,
      completedAt: iso(clock),
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    await activity(
      task,
      `autonomy_task_${status}`,
      status,
      `Autonomous task ${status}.`,
      { errorCode },
    );
    return { claimed: true, status, task: updated };
  }
  async function resumeApproval(taskId, approval) {
    const task = await storage.getAutonomyTask(taskId, ownerId);
    if (!task || task.status !== "waiting_for_approval")
      throw new WorkerError(
        "approval_state_invalid",
        "Task is not waiting for approval.",
        { retryable: false },
      );
    const pending = task.approvalState;
    if (approval.status !== "approved")
      return stop(task, "cancelled", "approval_rejected");
    const durableApproval=await storage.getApproval(pending.approvalId,ownerId);
    const exactSelfDevelopment=task.taskType==="self_development"&&pending.bindingSource==="approval_contract";
    if (
      pending.commitSha !== task.currentCommit ||
      pending.branch !== task.branch ||
      (exactSelfDevelopment&&(
        pending.repository !== approvedRepository ||
        pending.arguments?.repository !== approvedRepository ||
        durableApproval?.status !== "approved" ||
        durableApproval?.arguments?.repository !== approvedRepository ||
        pending.approvedStateVersion !== task.stateVersion ||
        pending.arguments?.approvedStateVersion !== task.stateVersion ||
        durableApproval?.arguments?.approvedStateVersion !== task.stateVersion
      ))
    )
      throw new WorkerError(
        "approval_invalidated",
        "Task state changed after approval.",
        { retryable: false },
      );
    const deliveryStateVersion=task.stateVersion+1,startedAt=iso(clock),deadline=iso(clock,5*60000),approvedDeliveryRuntime=exactSelfDevelopment?{recoveryClass:APPROVAL_CONTRACT_DELIVERY_RUNTIME,taskId:task.id,approvalId:pending.approvalId,approvedStateVersion:task.stateVersion,deliveryStateVersion,repository:approvedRepository,branch:task.branch,commitSha:task.currentCommit,reviewStepId:`${task.currentStep}:review_commit`,deliveryStepId:`${task.currentStep+1}:push`,maxAdditionalDeliverySteps:1,runtimeMinutes:5,startedAt,deadline,consumed:false}:null;
    return storage.updateAutonomyTask(task.id, ownerId, {
      status: "queued",
      nextRunAt: startedAt,
      blockedReason: null,
      approvalState: { ...pending, approved: true, deliveryStateVersion },
      ...(approvedDeliveryRuntime?{metadata:{...task.metadata,approvedDeliveryRuntime}}:{}),
    });
  }
  async function recoverApprovedDeliveryMaxSteps(taskId,input){
    if(!input||Object.keys(input).some(key=>key!=="expectedVersion")||!Number.isInteger(input.expectedVersion))throw new WorkerError("approved_delivery_recovery_invalid","Exact version is required.",{retryable:false,statusCode:400});
    const expected=HISTORICAL_APPROVED_DELIVERY,current=await storage.getAutonomyTask(taskId,ownerId),prior=current?.metadata?.approvedDeliveryRecoveryHistory?.find(item=>item.recoveryClass===expected.recoveryClass&&item.fromStateVersion===input.expectedVersion);
    if(prior)return{task:current,recovery:prior,idempotent:true};
    if(!current)throw new WorkerError("task_not_found","Task not found.",{retryable:false,statusCode:404});
    if(current.stateVersion!==input.expectedVersion)throw new WorkerError("version_conflict","Task changed before approved-delivery recovery.",{retryable:false,statusCode:409});
    const approval=await storage.getApproval(expected.approvalId,ownerId),steps=await storage.listAutonomySteps(current.id),review=steps.find(step=>step.stepId==="308:review_commit"),commit=steps.find(step=>step.stepId==="307:commit"),state=current.approvalState;
    const exact=current.id===expected.taskId&&current.status==="failed"&&current.errorCode==="max_steps_reached"&&current.currentStep===expected.currentStep&&current.currentCommit===expected.commitSha&&current.branch===expected.branch&&current.metadata?.selfDevelopment?.repository===expected.repository&&state?.approved===true&&state.approvalId===expected.approvalId&&state.tool==="git_push"&&state.stepId==="309:push"&&state.branch===expected.branch&&state.commitSha===expected.commitSha&&state.arguments?.branch===expected.branch&&state.arguments?.commitSha===expected.commitSha&&approval?.id===expected.approvalId&&approval.status==="approved"&&approval.tool==="git_push"&&approval.runId===current.id&&approval.projectId===current.projectId&&approval.arguments?.branch===expected.branch&&approval.arguments?.commitSha===expected.commitSha&&commit?.status==="completed"&&commit.result?.commitSha===expected.commitSha&&review?.status==="completed"&&review.result?.commitSha===expected.commitSha&&!steps.some(step=>Number.parseInt(step.stepId,10)>expected.currentStep);
    if(!exact)throw new WorkerError("approved_delivery_recovery_precondition_failed","Only the exact historical immutable approved-delivery max-step failure may be recovered.",{retryable:false,statusCode:409});
    const now=iso(clock),toStateVersion=current.stateVersion+1,record={recoveryClass:expected.recoveryClass,fromStateVersion:current.stateVersion,toStateVersion,approvedStateVersion:expected.approvedStateVersion,taskId:current.id,approvalId:expected.approvalId,repository:expected.repository,branch:expected.branch,commitSha:expected.commitSha,reviewStepId:"308:review_commit",deliveryStepId:"309:push",maxAdditionalDeliverySteps:1,recoveredAt:now},approvalState={...state,repository:expected.repository,approvedStateVersion:expected.approvedStateVersion,deliveryStateVersion:toStateVersion,bindingSource:expected.recoveryClass},metadata={...current.metadata,autoDispatch:true,approvedDeliveryRecoveryHistory:[...(current.metadata?.approvedDeliveryRecoveryHistory||[]),record]};
    const prospective={...current,status:"queued",stateVersion:toStateVersion,approvalState,metadata};
    if(!isExactApprovedDelivery({task:prospective,approval,steps,approvedBranch,approvedRepository}))throw new WorkerError("approved_delivery_recovery_binding_invalid","Recovered approved delivery binding is not exact.",{retryable:false,statusCode:409});
    const updated=await storage.updateAutonomyTask(current.id,ownerId,{status:"queued",nextRunAt:now,completedAt:null,errorCode:null,blockedReason:null,approvalState,metadata},current.stateVersion);
    if(!updated)throw new WorkerError("version_conflict","Task changed during approved-delivery recovery.",{retryable:false,statusCode:409});
    await activity(updated,"approved_delivery_max_steps_recovered","queued","Exact immutable post-approval delivery eligibility restored.",{approvalId:expected.approvalId,commitSha:expected.commitSha,repository:expected.repository,branch:expected.branch,fromStateVersion:current.stateVersion,toStateVersion,maxAdditionalDeliverySteps:1});
    return{task:updated,recovery:record,idempotent:false};
  }
  async function recoverApprovedDeliveryRuntime(taskId,input){
    if(!input||Object.keys(input).some(key=>key!=="expectedVersion")||input.expectedVersion!==HISTORICAL_APPROVED_DELIVERY_RUNTIME.expirationStateVersion)throw new WorkerError("approved_delivery_runtime_recovery_invalid","Exact durable expiration version is required.",{retryable:false,statusCode:400});
    const expected=HISTORICAL_APPROVED_DELIVERY_RUNTIME,current=await storage.getAutonomyTask(taskId,ownerId),prior=current?.metadata?.approvedDeliveryRuntimeRecoveryHistory?.find(item=>item.recoveryClass===expected.recoveryClass&&item.fromStateVersion===input.expectedVersion);
    if(prior){if(current.stateVersion===prior.toStateVersion)return{task:current,recovery:prior,idempotent:true};throw new WorkerError("version_conflict","The bounded delivery runtime was already consumed or superseded.",{retryable:false,statusCode:409});}
    if(!current)throw new WorkerError("task_not_found","Task not found.",{retryable:false,statusCode:404});
    if(current.stateVersion!==input.expectedVersion)throw new WorkerError("version_conflict","Task changed before approved-delivery runtime recovery.",{retryable:false,statusCode:409});
    const approval=await storage.getApproval(expected.approvalId,ownerId),steps=await storage.listAutonomySteps(current.id),review=steps.find(step=>step.stepId==="308:review_commit"),commit=steps.find(step=>step.stepId==="307:commit"),state=current.approvalState,previous=current.metadata?.approvedDeliveryRecoveryHistory?.at(-1);
    const exactTransition=current.stateVersion===expected.expirationStateVersion&&expected.claimStateVersion===expected.priorDeliveryStateVersion+1&&expected.expirationStateVersion===expected.claimStateVersion+1&&current.metadata?.claimKey===expected.claimKey;
    const exact=current.id===expected.taskId&&exactTransition&&current.status==="expired"&&current.errorCode==="max_runtime_reached"&&current.currentStep===expected.currentStep&&current.currentCommit===expected.commitSha&&current.branch===expected.branch&&current.metadata?.selfDevelopment?.repository===expected.repository&&state?.approved===true&&state.approvalId===expected.approvalId&&state.approvedStateVersion===expected.approvedStateVersion&&state.deliveryStateVersion===expected.priorDeliveryStateVersion&&state.tool==="git_push"&&state.stepId==="309:push"&&state.branch===expected.branch&&state.commitSha===expected.commitSha&&state.arguments?.branch===expected.branch&&state.arguments?.commitSha===expected.commitSha&&approval?.status==="approved"&&approval.id===expected.approvalId&&approval.tool==="git_push"&&approval.runId===current.id&&approval.arguments?.branch===expected.branch&&approval.arguments?.commitSha===expected.commitSha&&commit?.status==="completed"&&commit.result?.commitSha===expected.commitSha&&review?.status==="completed"&&review.result?.commitSha===expected.commitSha&&previous?.recoveryClass===HISTORICAL_APPROVED_DELIVERY.recoveryClass&&previous.toStateVersion===expected.priorDeliveryStateVersion&&previous.maxAdditionalDeliverySteps===1&&!steps.some(step=>Number.parseInt(step.stepId,10)>expected.currentStep)&&!current.metadata?.approvedDeliveryRuntime;
    if(!exact)throw new WorkerError("approved_delivery_runtime_recovery_precondition_failed","Only the exact unconsumed historical approved delivery may receive a runtime window.",{retryable:false,statusCode:409});
    const now=iso(clock),toStateVersion=current.stateVersion+1,deadline=iso(clock,expected.runtimeMinutes*60000),record={recoveryClass:expected.recoveryClass,fromStateVersion:current.stateVersion,toStateVersion,taskId:current.id,approvalId:expected.approvalId,approvedStateVersion:expected.approvedStateVersion,priorDeliveryStateVersion:expected.priorDeliveryStateVersion,claimStateVersion:expected.claimStateVersion,expirationStateVersion:expected.expirationStateVersion,claimKey:expected.claimKey,deliveryStateVersion:toStateVersion,repository:expected.repository,branch:expected.branch,commitSha:expected.commitSha,reviewStepId:"308:review_commit",deliveryStepId:"309:push",maxAdditionalDeliverySteps:1,runtimeMinutes:expected.runtimeMinutes,startedAt:now,deadline};
    const approvalState={...state,deliveryStateVersion:toStateVersion,bindingSource:expected.recoveryClass},metadata={...current.metadata,autoDispatch:true,approvedDeliveryRuntime:{...record,consumed:false},approvedDeliveryRuntimeRecoveryHistory:[...(current.metadata?.approvedDeliveryRuntimeRecoveryHistory||[]),record]};
    const prospective={...current,status:"queued",stateVersion:toStateVersion,approvalState,metadata};
    if(!isExactApprovedDelivery({task:prospective,approval,steps,approvedBranch,approvedRepository}))throw new WorkerError("approved_delivery_runtime_recovery_binding_invalid","Recovered delivery runtime binding is not exact.",{retryable:false,statusCode:409});
    const updated=await storage.updateAutonomyTask(current.id,ownerId,{status:"queued",nextRunAt:now,completedAt:null,errorCode:null,blockedReason:null,approvalState,metadata},current.stateVersion);
    if(!updated)throw new WorkerError("version_conflict","Task changed during approved-delivery runtime recovery.",{retryable:false,statusCode:409});
    await activity(updated,"approved_delivery_runtime_recovered","queued","One exact immutable approved delivery received a bounded runtime window.",record);
    return{task:updated,recovery:record,idempotent:false};
  }
  async function recoverApprovedDeliveryHandoff(taskId,input){
    const expected=HISTORICAL_APPROVED_DELIVERY_HANDOFF;
    if(!input||Object.keys(input).some(key=>key!=="expectedVersion")||input.expectedVersion!==expected.fromStateVersion)throw new WorkerError("approved_delivery_handoff_recovery_invalid","Exact failed delivery version is required.",{retryable:false,statusCode:400});
    const current=await storage.getAutonomyTask(taskId,ownerId),prior=current?.metadata?.approvedDeliveryHandoffRecoveryHistory?.find(item=>item.recoveryClass===expected.recoveryClass&&item.fromStateVersion===input.expectedVersion);
    if(prior){if(current.stateVersion===prior.toStateVersion)return{task:current,recovery:prior,idempotent:true};throw new WorkerError("version_conflict","Approved delivery handoff recovery was already consumed or superseded.",{retryable:false,statusCode:409});}
    if(!current)throw new WorkerError("task_not_found","Task not found.",{retryable:false,statusCode:404});
    if(current.stateVersion!==expected.fromStateVersion)throw new WorkerError("version_conflict","Task changed before approved delivery handoff recovery.",{retryable:false,statusCode:409});
    const approval=await storage.getApproval(expected.approvalId,ownerId),steps=await storage.listAutonomySteps(current.id),failed=steps.find(step=>step.stepId===expected.failedStepId),review=steps.find(step=>step.stepId==="308:review_commit"),commit=steps.find(step=>step.stepId==="307:commit"),state=current.approvalState,runtime=current.metadata?.approvedDeliveryRuntime;
    const exact=current.id===expected.taskId&&current.status==="failed"&&current.errorCode==="unexpected_error"&&current.currentStep===expected.currentStep&&current.currentCommit===expected.commitSha&&current.branch===expected.branch&&current.metadata?.selfDevelopment?.repository===expected.repository&&state?.approved===true&&state.approvalId===expected.approvalId&&state.approvedStateVersion===expected.approvedStateVersion&&state.deliveryStateVersion===expected.deliveryStateVersion&&state.commitSha===expected.commitSha&&approval?.status==="approved"&&approval.id===expected.approvalId&&approval.runId===current.id&&approval.arguments?.branch===expected.branch&&approval.arguments?.commitSha===expected.commitSha&&commit?.status==="completed"&&commit.result?.commitSha===expected.commitSha&&review?.status==="completed"&&review.result?.commitSha===expected.commitSha&&failed?.stepType==="push"&&failed.status==="failed"&&failed.attempt===1&&failed.errorCode==="unexpected_error"&&failed.result?.message==="Tool is unavailable: git_push"&&steps.filter(step=>Number.parseInt(step.stepId,10)>expected.currentStep).length===1&&runtime?.recoveryClass===HISTORICAL_APPROVED_DELIVERY_RUNTIME.recoveryClass&&runtime.fromStateVersion===269&&runtime.toStateVersion===expected.deliveryStateVersion&&runtime.consumed===false;
    if(!exact)throw new WorkerError("approved_delivery_handoff_recovery_precondition_failed","Only the exact uninvoked approved delivery routing failure may be recovered.",{retryable:false,statusCode:409});
    const now=iso(clock),toStateVersion=current.stateVersion+1,deadline=iso(clock,expected.runtimeMinutes*60000),record={recoveryClass:expected.recoveryClass,fromStateVersion:current.stateVersion,toStateVersion,taskId:current.id,approvalId:expected.approvalId,approvedStateVersion:expected.approvedStateVersion,deliveryStateVersion:toStateVersion,repository:expected.repository,branch:expected.branch,commitSha:expected.commitSha,failedStepId:expected.failedStepId,failedAttempt:1,maxAdditionalDeliverySteps:1,runtimeMinutes:expected.runtimeMinutes,startedAt:now,deadline},approvalState={...state,deliveryStateVersion:toStateVersion,bindingSource:expected.recoveryClass},metadata={...current.metadata,autoDispatch:true,requiredCapability:"github_write",approvedDeliveryRuntime:{...runtime,startedAt:now,deadline,deliveryStateVersion:toStateVersion,consumed:false,handoffRecoveryFromStateVersion:current.stateVersion},approvedDeliveryHandoffRecoveryHistory:[...(current.metadata?.approvedDeliveryHandoffRecoveryHistory||[]),record]};
    const prospective={...current,status:"waiting_for_worker",stateVersion:toStateVersion,errorCode:null,approvalState,metadata};
    if(!isExactApprovedDelivery({task:prospective,approval,steps,approvedBranch,approvedRepository}))throw new WorkerError("approved_delivery_handoff_recovery_binding_invalid","Recovered local delivery binding is not exact.",{retryable:false,statusCode:409});
    const updated=await storage.updateAutonomyTask(current.id,ownerId,{status:"waiting_for_worker",nextRunAt:now,completedAt:null,errorCode:null,blockedReason:"Waiting for exact approved local delivery.",approvalState,metadata,leaseOwner:null,leaseToken:null,leaseExpiresAt:null},current.stateVersion);
    if(!updated)throw new WorkerError("version_conflict","Task changed during approved delivery handoff recovery.",{retryable:false,statusCode:409});
    await activity(updated,"approved_delivery_handoff_recovered","waiting_for_worker","Exact approved delivery was rebound to the controlled local worker.",record);
    return{task:updated,recovery:record,idempotent:false};
  }
  async function recoverApprovedDeliveryHandoffRuntime(taskId,input){
    const expected=input?.expectedVersion===HISTORICAL_APPROVED_DELIVERY_WORKER_CAPABILITY_RUNTIME.fromStateVersion?HISTORICAL_APPROVED_DELIVERY_WORKER_CAPABILITY_RUNTIME:HISTORICAL_APPROVED_DELIVERY_HANDOFF_RUNTIME;
    if(!input||Object.keys(input).some(key=>key!=="expectedVersion")||input.expectedVersion!==expected.fromStateVersion)throw new WorkerError("approved_delivery_handoff_runtime_recovery_invalid","Exact expired handoff-delivery version is required.",{retryable:false,statusCode:400});
    const current=await storage.getAutonomyTask(taskId,ownerId),prior=current?.metadata?.approvedDeliveryHandoffRuntimeRecoveryHistory?.find(item=>item.recoveryClass===expected.recoveryClass&&item.fromStateVersion===input.expectedVersion);
    if(prior){if(current.stateVersion===prior.toStateVersion)return{task:current,recovery:prior,idempotent:true};throw new WorkerError("version_conflict","Approved handoff-delivery runtime recovery was already consumed or superseded.",{retryable:false,statusCode:409});}
    if(!current)throw new WorkerError("task_not_found","Task not found.",{retryable:false,statusCode:404});
    if(current.stateVersion!==expected.fromStateVersion)throw new WorkerError("version_conflict","Task changed before handoff-delivery runtime recovery.",{retryable:false,statusCode:409});
    const approval=await storage.getApproval(expected.approvalId,ownerId),steps=await storage.listAutonomySteps(current.id),activities=await storage.listActivity(ownerId,{runId:current.id}),failed=steps.find(step=>step.stepId===expected.failedStepId),review=steps.find(step=>step.stepId==="308:review_commit"),commit=steps.find(step=>step.stepId==="307:commit"),state=current.approvalState,runtime=current.metadata?.approvedDeliveryRuntime,handoffRecovery=current.metadata?.approvedDeliveryHandoffRecoveryHistory?.at(-1),priorRuntimeRecovery=current.metadata?.approvedDeliveryHandoffRuntimeRecoveryHistory?.at(-1),handoffActivity=activities.some(item=>item.action==="local_worker_handoff_created"&&item.metadata?.stepId===expected.failedStepId),successPush=steps.some(step=>step.stepType==="push"&&step.status==="completed");
    const initialRecovery=expected===HISTORICAL_APPROVED_DELIVERY_HANDOFF_RUNTIME,provenanceExact=initialRecovery?state?.bindingSource===HISTORICAL_APPROVED_DELIVERY_HANDOFF.recoveryClass&&handoffRecovery?.recoveryClass===HISTORICAL_APPROVED_DELIVERY_HANDOFF.recoveryClass&&handoffRecovery.fromStateVersion===272&&handoffRecovery.toStateVersion===expected.priorDeliveryStateVersion:state?.bindingSource===expected.priorRecoveryClass&&runtime?.recoveryClass===expected.priorRecoveryClass&&priorRuntimeRecovery?.recoveryClass===expected.priorRecoveryClass&&priorRuntimeRecovery.fromStateVersion===274&&priorRuntimeRecovery.toStateVersion===expected.priorDeliveryStateVersion;
    const exact=current.id===expected.taskId&&current.status==="expired"&&current.errorCode==="max_runtime_reached"&&current.currentStep===expected.currentStep&&current.currentCommit===expected.commitSha&&current.branch===expected.branch&&current.metadata?.selfDevelopment?.repository===expected.repository&&state?.approved===true&&state.approvalId===expected.approvalId&&state.approvedStateVersion===expected.approvedStateVersion&&state.deliveryStateVersion===expected.priorDeliveryStateVersion&&provenanceExact&&state.commitSha===expected.commitSha&&approval?.status==="approved"&&approval.id===expected.approvalId&&approval.runId===current.id&&approval.arguments?.branch===expected.branch&&approval.arguments?.commitSha===expected.commitSha&&commit?.status==="completed"&&commit.result?.commitSha===expected.commitSha&&review?.status==="completed"&&review.result?.commitSha===expected.commitSha&&failed?.stepType==="push"&&failed.status==="failed"&&failed.attempt===1&&failed.errorCode==="unexpected_error"&&failed.result?.message==="Tool is unavailable: git_push"&&steps.filter(step=>Number.parseInt(step.stepId,10)>expected.currentStep).length===1&&!successPush&&runtime?.deliveryStateVersion===expected.priorDeliveryStateVersion&&runtime.consumed===false&&new Date(runtime.deadline)<=clock()&&!current.metadata?.localHandoff&&!handoffActivity;
    if(!exact)throw new WorkerError("approved_delivery_handoff_runtime_recovery_precondition_failed","Only the exact expired, unclaimed, uninvoked approved delivery may be recovered.",{retryable:false,statusCode:409});
    const now=iso(clock),toStateVersion=current.stateVersion+1,deadline=iso(clock,expected.runtimeMinutes*60000),record={recoveryClass:expected.recoveryClass,fromStateVersion:current.stateVersion,toStateVersion,priorDeliveryStateVersion:expected.priorDeliveryStateVersion,taskId:current.id,approvalId:expected.approvalId,approvedStateVersion:expected.approvedStateVersion,deliveryStateVersion:toStateVersion,repository:expected.repository,branch:expected.branch,commitSha:expected.commitSha,stepId:expected.failedStepId,maxAdditionalDeliverySteps:1,runtimeMinutes:expected.runtimeMinutes,startedAt:now,deadline,noHandoffProven:true,gitPushInvoked:false},approvalState={...state,deliveryStateVersion:toStateVersion,bindingSource:expected.recoveryClass},metadata={...current.metadata,autoDispatch:true,requiredCapability:"github_write",approvedDeliveryRuntime:{...runtime,recoveryClass:expected.recoveryClass,startedAt:now,deadline,deliveryStateVersion:toStateVersion,consumed:false},approvedDeliveryHandoffRuntimeRecoveryHistory:[...(current.metadata?.approvedDeliveryHandoffRuntimeRecoveryHistory||[]),record]};
    const prospective={...current,status:"waiting_for_worker",stateVersion:toStateVersion,errorCode:null,approvalState,metadata};
    if(!isExactApprovedDelivery({task:prospective,approval,steps,approvedBranch,approvedRepository}))throw new WorkerError("approved_delivery_handoff_runtime_recovery_binding_invalid","Recovered approved local delivery binding is not exact.",{retryable:false,statusCode:409});
    const updated=await storage.updateAutonomyTask(current.id,ownerId,{status:"waiting_for_worker",nextRunAt:now,completedAt:null,errorCode:null,blockedReason:"Waiting for exact approved local delivery.",approvalState,metadata,leaseOwner:null,leaseToken:null,leaseExpiresAt:null},current.stateVersion);
    if(!updated)throw new WorkerError("version_conflict","Task changed during handoff-delivery runtime recovery.",{retryable:false,statusCode:409});
    await activity(updated,"approved_delivery_handoff_runtime_recovered","waiting_for_worker","One expired, never-claimed approved delivery received its final bounded local-handoff window.",record);
    return{task:updated,recovery:record,idempotent:false};
  }
  return Object.freeze({
    workerId,
    capabilities: [...capabilities],
    create,
    get: (id) => storage.getAutonomyTask(id, ownerId),
    list: (options) => storage.listAutonomyTasks(ownerId, options),
    steps: (id) => storage.listAutonomySteps(id),
    control,
    tick,
    tickTask,
    resumeApproval,
    recoverApprovedDeliveryMaxSteps,
    recoverApprovedDeliveryRuntime,
    recoverApprovedDeliveryHandoff,
    recoverApprovedDeliveryHandoffRuntime,
  });
}

function toolFor(type) {
  return (
    {
      inspect_repo: "repo_list",
      search_code: "repo_search",
      read_files: "repo_read",
      inspect_logs: "deployment_logs",
      apply_patch: "repo_apply_patch",
      plan_repair: "self_development_plan_implementation",
      run_focused_tests: "test_run",
      run_full_tests: "test_run_full",
      inspect_diff: "repo_diff",
      commit: "git_commit",
      integrate_commit: "git_integrate_reviewed_commit",
      push: "git_push",
      deploy_preview: "preview_deploy",
      verify_preview: "preview_verify",
    }[type] || type
  );
}

function resolveTaskReferences(value, task) {
  if (Array.isArray(value)) return value.map((item) => resolveTaskReferences(item, task));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTaskReferences(item, task)]));
  if(value === "$CURRENT_COMMIT")return task.currentCommit;
  if(value === "$DEPLOYMENT_ID")return task.metadata?.lastDeploymentId;
  if(value === "$IMPLEMENTATION_FILES")return task.metadata?.selfDevelopmentImplementationPlan?.files;
  if(value === "$IMPLEMENTATION_TESTS")return task.metadata?.selfDevelopmentImplementationPlan?.focusedTests?.map(test=>typeof test==="string"?test:test.path);
  if(value === "$IMPLEMENTATION_PATHS")return task.metadata?.selfDevelopmentImplementationPlan?.files?.map(file=>file.path);
  return value;
}
