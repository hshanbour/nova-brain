import { createHash, randomUUID } from "node:crypto";
import {createActiveContinuation,assertActiveImplementationPlan,planLifecycleMetadata,rebindEquivalentImplementationPlan} from "./self-development-plan-lifecycle.js";

const REPOSITORY = "hshanbour/nova-brain",
  BRANCH = "feat/nova-brain-mvp-foundation",
  SHA = /^[a-f0-9]{40}$/,
  REVIEW_HASH = /^[a-f0-9]{64}$/,
  DELIVERY_ATTESTATION_SHA = "58ab99b426fed92d8e36e8493718b4fc62935d08";
const PROTECTED =
  /(^|\/)(src\/(policy|storage|autonomy)|\.github|vercel\.json|api\/index\.js)(\/|$)|approval|credential|secret|production|worker-runtime/i;
const SECRET = /token|secret|password|authorization|api.?key|private.?key/i;
const CAPABILITIES = Object.freeze([
  "repo_read_remote",
  "reasoning",
  "repo_mutate_local",
  "test_local",
  "github_write",
  "vercel_preview",
  "scheduler",
]);
const IMPLEMENTATION_GOAL =
  /\b(add|build|change|create|develop|fix|implement|improve|modify|update)\b/i;
const REPLAN_PROTECTED =
  /(^|\/)(src\/(?:voice|policy|storage|autonomy)|speaker-worker|api\/index\.js|\.github|assets\/(?:voice-(?!input(?:\.|$))|speaker-))(\/|$)|ecapa|elevenlabs|voice-control|production|credential|secret|token/i;
const TASK_DIFF_DIGESTS = Object.freeze({
  git_sha1: /^[a-f0-9]{40}$/i,
  sha256: /^[a-f0-9]{64}$/i,
});
const LEGACY_TASK_DIFF_EVIDENCE = Object.freeze({
  selfdev_10721df97b8cbc63c70d4171f6f4a440: Object.freeze({
    semantic: "task_diff",
    algorithm: "git_sha1",
    digest: "a901d364098ffc719aceab431dc63ac19ddb3731",
    expectedVersion: 43,
    targetPath: "test/voice-input.test.js",
  }),
});
const HISTORICAL_DIVERGED_APPROVED_DELIVERY = Object.freeze({
  recoveryClass: "historical_diverged_approved_delivery_integration_recovery",
  taskId: "selfdev_10721df97b8cbc63c70d4171f6f4a440",
  fromStateVersion: 280,
  currentStep: 308,
  failedStepId: "309:push",
  approvalId: "fb4e62f7-9189-4151-ac11-c620e934d3aa",
  minimumFirstParentSha: "523386be918a4072e7990f559e6870f5c652498a",
  secondParentSha: "5818ce4a8b0eb13285971cfcede009c7ae0d5aad",
  mergeBaseSha: "e8fe14200c1cd2060aca9328b38036b771be6cba",
  reviewHash: "f1ed0eddac728d408160c564c0944cc506630d1de2da611e980672684c61dd10",
  allowedPaths: Object.freeze([
    "assets/voice-input.js",
    "test/composer-dictation.test.js",
    "test/voice-input.test.js",
  ]),
  repository: REPOSITORY,
  branch: BRANCH,
  runtimeMinutes: 10,
  maxContinuationSteps: 3,
});
export class SelfDevelopmentError extends Error {
  constructor(code, message, statusCode = 409, safeDiagnostics) {
    super(message);
    this.name = "SelfDevelopmentError";
    this.code = code;
    this.statusCode = statusCode;
    if (safeDiagnostics) this.safeDiagnostics = safeDiagnostics;
  }
}
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const gitBlobHash = (value) => {
  const content=Buffer.from(String(value??""),"utf8");
  return createHash("sha1").update(Buffer.from(`blob ${content.length}\0`)).update(content).digest("hex");
};
const clean = (value) => {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET.test(key) ? "[REDACTED]" : clean(item),
      ]),
    );
  return value;
};
const boundedText = (value, name, max = 2000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new SelfDevelopmentError(
      "invalid_input",
      `${name} is required.`,
      400,
    );
  return value.trim();
};
const safePath = (value) => {
  const path = boundedText(value, "scope path", 240).replaceAll("\\", "/");
  if (path.startsWith("/") || path.includes("..") || SECRET.test(path))
    throw new SelfDevelopmentError(
      "invalid_scope",
      "Self-development scope contains a protected or invalid path.",
      400,
    );
  return path;
};
export const isExactMissingBranchSchemaDiagnostic = (diagnostic, {stepType, templateTool}={}) =>
  (diagnostic?.tool === "repo_apply_patch" ||
    (!diagnostic?.tool && stepType === "apply_patch" && templateTool === "repo_apply_patch")) &&
  diagnostic?.fieldPath === "repo_apply_patch.branch" &&
  diagnostic?.validationCode === "required_field_missing" &&
  (diagnostic?.received === "missing" || diagnostic?.received?.type === "missing") &&
  (diagnostic?.expected === "required" || diagnostic?.expected?.type === "required");
const taskDiffEvidence = (task, targetPath, expectedVersion) => {
  const stored = task.metadata?.failedAttemptEvidence?.taskDiff;
  const evidence = stored || LEGACY_TASK_DIFF_EVIDENCE[task.id];
  if (
    !evidence ||
    evidence.semantic !== "task_diff" ||
    !TASK_DIFF_DIGESTS[evidence.algorithm]?.test(evidence.digest || "") ||
    (evidence.expectedVersion !== undefined &&
      evidence.expectedVersion !== expectedVersion) ||
    (evidence.targetPath !== undefined && evidence.targetPath !== targetPath)
  )
    throw new SelfDevelopmentError(
      "create_conflict_evidence_missing",
      "Exact durable task-diff evidence is unavailable or invalid.",
    );
  return Object.freeze({
    semantic: "task_diff",
    algorithm: evidence.algorithm,
    digest: evidence.digest.toLowerCase(),
  });
};
const annotation = (
  index,
  type,
  capability,
  input,
  expectedOutput,
  successCondition,
  { retry = "bounded", approval = false } = {},
) => ({
  type,
  input,
  capability,
  expectedOutput,
  successCondition,
  retryClassification: retry,
  approvalRequired: approval,
  idempotencyIdentity: `self-development:${index}:${hash([type, clean(input)])}`,
});

const stepOrdinal = (step) => {
  const match = /^(\d+):/.exec(String(step?.stepId || ""));
  return match ? Number(match[1]) : null;
};
const RECOVERY_SIDE_EFFECT_STEPS = new Set([
  "apply_patch", "run_focused_tests", "run_full_tests", "inspect_diff",
  "commit", "review_commit", "push", "deploy_preview",
]);
export function resolveSemanticPlanApplyState(task, steps, failureCode, {planStepTypes=["plan_implementation"]}={}) {
  const ordered = steps.map((step) => ({step, ordinal: stepOrdinal(step)}))
    .filter((entry) => entry.ordinal !== null).sort((a, b) => a.ordinal - b.ordinal);
  const failedApplies = ordered.filter(({step}) => step.stepType === "apply_patch" && step.status === "failed" && step.errorCode === failureCode);
  if (!failedApplies.length) throw new SelfDevelopmentError("semantic_recovery_state_unresolved", "The intended failed mutation attempt cannot be resolved.");
  const failedOrdinal = Math.max(...failedApplies.map((entry) => entry.ordinal));
  const failures = failedApplies.filter((entry) => entry.ordinal === failedOrdinal);
  if (failures.length !== 1) throw new SelfDevelopmentError("semantic_recovery_state_ambiguous", "The failed mutation history is ambiguous.");
  const failed = failures[0];
  const laterMutationAttempts = ordered.filter(({step, ordinal}) => ordinal > failed.ordinal && step.stepType === "apply_patch");
  const plans = ordered.filter(({step, ordinal}) => ordinal < failed.ordinal && planStepTypes.includes(step.stepType) && step.status === "completed" && step.result?.implementationPlan);
  if (!plans.length || laterMutationAttempts.length) throw new SelfDevelopmentError("semantic_recovery_state_unresolved", "A unique latest implementation plan and mutation attempt are required.");
  const plannedOrdinal = Math.max(...plans.map((entry) => entry.ordinal));
  const latestPlans = plans.filter((entry) => entry.ordinal === plannedOrdinal);
  if (latestPlans.length !== 1) throw new SelfDevelopmentError("semantic_recovery_state_ambiguous", "Multiple unsuperseded implementation plans cannot be distinguished.");
  const planned = latestPlans[0], planTemplate = task.metadata?.steps?.[planned.ordinal - 1], failedTemplate = task.metadata?.steps?.[failed.ordinal - 1];
  const mutationReported = failed.step.result?.mutationApplied === true || failed.step.result?.changed === true || (Array.isArray(failed.step.result?.changedFiles) && failed.step.result.changedFiles.length > 0);
  const completedAfterPlan = ordered.some(({step, ordinal}) => ordinal > planned.ordinal && RECOVERY_SIDE_EFFECT_STEPS.has(step.stepType) && step.status === "completed");
  if (!planStepTypes.includes(planTemplate?.type) || failedTemplate?.type !== "apply_patch" || mutationReported) throw new SelfDevelopmentError("semantic_recovery_state_unresolved", "The durable plan or no-mutation boundary cannot be proven.");
  return {failed:failed.step, failedOrdinal:failed.ordinal, planned:planned.step, plannedOrdinal:planned.ordinal, planTemplate, remaining:task.metadata.steps.slice(failed.ordinal - 1), completedAfterPlan};
}

export function createSelfDevelopmentService({
  runtime,
  storage,
  ownerId,
  approvedBranch = BRANCH,
  repository = REPOSITORY,
  currentCommit,
  verifyRemote,
  compareRemoteEvidence,
  verifyDeployment,
  resolvePathState,
  clock = () => new Date(),
} = {}) {
  if (!runtime || !storage || !ownerId)
    throw new Error("Self-development dependencies are required.");
  function structure(input) {
    const userGoal = boundedText(input?.userGoal || input?.goal, "user_goal"),
      targetBranch = input?.targetBranch || approvedBranch,
      targetRepository = input?.repository || repository,
      environment = input?.environment || "preview";
    if (
      targetBranch !== approvedBranch ||
      ["main", "master"].includes(targetBranch)
    )
      throw new SelfDevelopmentError(
        "branch_not_allowed",
        "Only the approved feature branch is allowed.",
        403,
      );
    if (targetRepository !== repository)
      throw new SelfDevelopmentError(
        "repository_not_resolved",
        "The requested repository could not be resolved to Nova Brain.",
        400,
      );
    if (environment !== "preview")
      throw new SelfDevelopmentError(
        "production_target_forbidden",
        "Self-development V1 is Preview-only.",
        403,
      );
    const startingCommit = input?.startingCommit || currentCommit;
    if (!SHA.test(startingCommit || ""))
      throw new SelfDevelopmentError(
        "invalid_input",
        "An exact deployed starting commit could not be resolved.",
        400,
      );
    const projectValue = String(input?.targetProject || "nova-brain")
        .trim()
        .toLowerCase(),
      knownProjects = new Set([
        "nova-brain",
        "nova brain",
        "hshanbour/nova-brain",
        "nova-test-project",
      ]);
    if (!knownProjects.has(projectValue))
      throw new SelfDevelopmentError(
        "project_not_found",
        "The requested project could not be resolved to Nova Brain.",
        400,
      );
    const targetProject = "nova-brain";
    const rawScope = input.scope || {};
    if (
      !rawScope ||
      typeof rawScope !== "object" ||
      Array.isArray(rawScope) ||
      !Array.isArray(rawScope.paths || []) ||
      !Array.isArray(rawScope.searchTerms || []) ||
      !Array.isArray(rawScope.focusedTests || []) ||
      !Array.isArray(rawScope.patch?.files || [])
    )
      throw new SelfDevelopmentError(
        "invalid_scope",
        "Self-development scope must use bounded path, search, patch-file, and focused-test arrays.",
        400,
      );
    const paths = (rawScope.paths || []).map(safePath),
      patchFiles = (rawScope.patch?.files || []).map((file) => {
        if (!file || typeof file !== "object" || Array.isArray(file))
          throw new SelfDevelopmentError(
            "invalid_scope",
            "Each patch file must contain a bounded path and content.",
            400,
          );
        return {
          path: safePath(file.path),
          content: boundedText(file.content, "patch content", 50000),
        };
      });
    if (paths.length > 30 || patchFiles.length > 20)
      throw new SelfDevelopmentError(
        "scope_too_large",
        "Self-development scope is too large.",
        400,
      );
    const focusedTests = (rawScope.focusedTests || []).map(safePath);
    if (focusedTests.length > 30)
      throw new SelfDevelopmentError(
        "scope_too_large",
        "Focused test scope is too large.",
        400,
      );
    if (
      input.acceptanceCriteria !== undefined &&
      !Array.isArray(input.acceptanceCriteria)
    )
      throw new SelfDevelopmentError(
        "invalid_input",
        "Acceptance criteria must be an array.",
        400,
      );
    const acceptanceCriteria = (
      input.acceptanceCriteria?.length
        ? input.acceptanceCriteria
        : [
            "Inspect and produce a bounded implementation plan for the requested improvement.",
            "Preserve main, Production, approval, and Preview safety boundaries.",
            "Run relevant focused and full tests before any reviewed commit.",
          ]
    ).map((item) => boundedText(item, "acceptance criterion", 500));
    if (acceptanceCriteria.length > 30)
      throw new SelfDevelopmentError(
        "invalid_input",
        "Too many acceptance criteria were supplied.",
        400,
      );
    if (
      input.maxRepairIterations !== undefined &&
      (!Number.isInteger(input.maxRepairIterations) ||
        input.maxRepairIterations < 1 ||
        input.maxRepairIterations > 3)
    )
      throw new SelfDevelopmentError(
        "invalid_repair_limit",
        "Repair limit must be an integer from 1 to 3.",
        400,
      );
    if (
      input.runtimeBudgetMinutes !== undefined &&
      (!Number.isInteger(input.runtimeBudgetMinutes) ||
        input.runtimeBudgetMinutes < 15 ||
        input.runtimeBudgetMinutes > 120)
    )
      throw new SelfDevelopmentError(
        "invalid_runtime_budget",
        "Runtime budget must be an integer from 15 to 120 minutes.",
        400,
      );
    const protectedPaths = [...paths, ...patchFiles.map((x) => x.path)].filter(
        (path) => PROTECTED.test(path),
      ),
      riskLevel = protectedPaths.length ? "high" : "medium",
      maxRepairIterations = input.maxRepairIterations ?? 3,
      runtimeBudgetMinutes = input.runtimeBudgetMinutes ?? 60;
    return Object.freeze({
      kind: "self_development_task",
      userGoal,
      targetProject,
      targetBranch,
      repository: targetRepository,
      environment,
      scope: clean({
        paths,
        inspectPath: rawScope.inspectPath ? safePath(rawScope.inspectPath) : "",
        searchTerms: (rawScope.searchTerms || [])
          .slice(0, 10)
          .map((x) => boundedText(x, "search term", 120)),
        patch: { files: patchFiles },
        focusedTests,
      }),
      acceptanceCriteria,
      riskLevel,
      protectedPaths,
      requiredCapabilities: CAPABILITIES,
      approvalBoundaries: {
        localSafeOperations: "policy_controlled",
        protectedArchitecture: "strong_exact_approval",
        gitPush: "exact_task_branch_sha_args",
        previewCreation: "existing_policy",
        production: "forbidden",
      },
      maxRepairIterations,
      runtimeBudgetMinutes,
      status: "structured",
      startingCommit,
    });
  }
  function plan(request) {
    const steps = [],
      add = (...args) => steps.push(annotation(steps.length + 1, ...args)),
      root = request.scope.inspectPath || ".";
    add(
      "inspect_repo",
      "repo_read_remote",
      { tool: "repo_list", arguments: { path: root, limit: 100 } },
      "Bounded repository inventory",
      "Repository paths returned",
      { retry: "safe_read" },
    );
    add(
      "search_code",
      "repo_read_remote",
      {
        tool: "repo_search",
        arguments: {
          query: (request.scope.searchTerms[0] || request.userGoal).slice(
            0,
            120,
          ),
          path: root,
          limit: 100,
        },
      },
      "Relevant implementation matches",
      "Search evidence returned",
      { retry: "safe_read" },
    );
    const patchPaths = new Set(
      request.scope.patch.files.map((file) => file.path),
    );
    for (const path of request.scope.paths
      .filter((path) => !patchPaths.has(path))
      .slice(0, 10))
      add(
        "read_files",
        "repo_read_remote",
        { tool: "repo_read", arguments: { path } },
        `Contents of ${path}`,
        "File read succeeds",
        { retry: "safe_read" },
      );
    add(
      "plan_patch",
      "reasoning",
      {
        goal: request.userGoal,
        acceptanceCriteria: request.acceptanceCriteria,
        scope: request.scope.paths,
      },
      "Bounded implementation decision",
      "Plan stays within declared scope",
      { retry: "new_evidence_required" },
    );
    const files = request.scope.patch.files;
    if (files.length) {
      if (request.riskLevel === "high")
        add(
          "authorize_protected_change",
          "reasoning",
          {
            tool: "self_development_protected_change",
            arguments: {
              repository: request.repository,
              branch: request.targetBranch,
              startingCommit: request.startingCommit,
              paths: files.map((x) => x.path),
              scopeHash: hash(files),
            },
          },
          "Exact protected-change approval",
          "Approved action exactly matches protected scope",
          { retry: "not_retryable", approval: true },
        );
      add(
        "apply_patch",
        "repo_mutate_local",
        {
          tool: "repo_apply_patch",
          arguments: { branch: request.targetBranch, files },
        },
        "Bounded files changed",
        "Only declared files are modified",
        { retry: "repair_required" },
      );
      if (request.scope.focusedTests.length)
        add(
          "run_focused_tests",
          "test_local",
          {
            tool: "test_run",
            arguments: { files: request.scope.focusedTests, timeoutMs: 180000 },
          },
          "Focused test report",
          "All focused tests pass",
          { retry: "repair_required" },
        );
      add(
        "run_full_tests",
        "test_local",
        { tool: "test_run_full", arguments: { timeoutMs: 180000 } },
        "Full test report",
        "Complete suite passes",
        { retry: "repair_required" },
      );
      add(
        "inspect_diff",
        "repo_read_remote",
        { tool: "repo_diff", arguments: { paths: files.map((x) => x.path) } },
        "Bounded reviewed diff",
        "Diff contains only declared scope",
        { retry: "safe_read" },
      );
      add(
        "commit",
        "repo_mutate_local",
        {
          tool: "git_commit",
          arguments: {
            paths: files.map((x) => x.path),
            branch: request.targetBranch,
            message: "Complete bounded Nova self-development task",
          },
        },
        "Exact local commit SHA",
        "One local commit created",
        { retry: "idempotent_commit" },
      );
      add(
        "push",
        "github_write",
        {
          tool: "git_push",
          arguments: {
            branch: request.targetBranch,
            commitSha: "$CURRENT_COMMIT",
          },
        },
        "Approved remote feature commit",
        "Exact push approval succeeds",
        { retry: "approval_bound", approval: true },
      );
      add(
        "deploy_preview",
        "vercel_preview",
        {
          tool: "preview_deploy",
          arguments: {
            branch: request.targetBranch,
            commitSha: "$CURRENT_COMMIT",
          },
        },
        "Git-backed Preview deployment",
        "Preview deployment created",
        { retry: "idempotent_deploy", approval: true },
      );
      add(
        "wait",
        "scheduler",
        { delayMs: 5000 },
        "Bounded deployment wait",
        "Task reschedules without busy-looping",
        { retry: "bounded_wait" },
      );
      add(
        "verify_preview",
        "vercel_preview",
        {
          tool: "preview_verify",
          arguments: {
            deploymentId: "$DEPLOYMENT_ID",
            path: "/api/health",
            expectedStatus: 200,
            commitSha: "$CURRENT_COMMIT",
          },
        },
        "Protected Preview verification",
        "Exact SHA Preview health succeeds",
        { retry: "repair_required" },
      );
    }
    add(
      "summarize",
      "reasoning",
      {
        summary: files.length
          ? "Nova self-development task completed after Preview verification."
          : "Nova self-development discovery and planning completed.",
      },
      "Durable owner-facing summary",
      "All planned acceptance gates completed",
      { retry: "not_retryable" },
    );
    return Object.freeze(steps);
  }
  async function create(input) {
    const request = structure(input),
      steps = plan(request),
      requestFingerprint = hash(request),
      taskId = `selfdev_${requestFingerprint.slice(0, 32)}`,
      prior = await runtime.get(taskId);
    if (prior) {
      if (
        prior.metadata?.selfDevelopmentRequestFingerprint !== requestFingerprint
      )
        throw new SelfDevelopmentError(
          "durable_task_create_failed",
          "Existing task identity does not match this request.",
        );
      return {
        request,
        plan: prior.metadata.steps,
        task: prior,
        idempotent: true,
        dispatch: { status: "scheduled", durable: true },
      };
    }
    let task;
    try {
      task = await runtime.create({
        id: taskId,
        title: `Self-development: ${request.userGoal.slice(0, 80)}`,
        objective: request.userGoal,
        taskType: "self_development",
        projectId: request.targetProject,
        branch: request.targetBranch,
        startingCommit: request.startingCommit,
        maxSteps: Math.min(100, steps.length + request.maxRepairIterations * 6),
        maxRetries: 1,
        maxRuntimeMinutes: request.runtimeBudgetMinutes,
        metadata: {
          steps,
          maxRepairIterations: request.maxRepairIterations,
          selfDevelopment: request,
          selfDevelopmentRequestFingerprint: requestFingerprint,
          repairHistory: [],
          autoDispatch: true,
        },
      });
    } catch (error) {
      const concurrent = await runtime.get(taskId).catch(() => null);
      if (
        concurrent?.metadata?.selfDevelopmentRequestFingerprint ===
        requestFingerprint
      )
        return {
          request,
          plan: concurrent.metadata.steps,
          task: concurrent,
          idempotent: true,
          dispatch: { status: "scheduled", durable: true },
        };
      throw new SelfDevelopmentError(
        "durable_task_create_failed",
        "The durable Self-Development task could not be created safely.",
        503,
      );
    }
    for (const [action, summary] of [
      [
        "self_development_request_received",
        "Self-development request received.",
      ],
      [
        "self_development_scope_resolved",
        "Self-development scope and risk resolved.",
      ],
      ["self_development_plan_created", "Bounded Worker plan created."],
      [
        "self_development_auto_dispatch_scheduled",
        "Durable background continuation scheduled.",
      ],
    ])
      await storage.appendActivity({
        ownerId,
        projectId: task.projectId,
        runId: task.id,
        action,
        status: "completed",
        summary,
        metadata: {
          taskId: task.id,
          riskLevel: request.riskLevel,
          stepCount: steps.length,
        },
      });
    return {
      request,
      plan: steps,
      task,
      idempotent: false,
      dispatch: { status: "scheduled", durable: true },
    };
  }
  async function get(taskId) {
    const task = await runtime.get(taskId);
    if (!task || task.taskType !== "self_development")
      throw new SelfDevelopmentError(
        "task_not_found",
        "Self-development task not found.",
        404,
      );
    return {
      task,
      steps: await runtime.steps(task.id),
      request: task.metadata?.selfDevelopment,
    };
  }
  async function replanDiscoveryOnly(taskId, input) {
    const allowed = new Set([
      "expectedVersion",
      "runtimeBudgetMinutes",
      "candidatePaths",
    ]);
    if (
      !input ||
      Object.keys(input).some((key) => !allowed.has(key)) ||
      !Number.isInteger(input.expectedVersion)
    )
      throw new SelfDevelopmentError(
        "replan_invalid",
        "An exact task version and bounded evidence candidates are required.",
        400,
      );
    const current = await runtime.get(taskId);
    if (!current || current.taskType !== "self_development")
      throw new SelfDevelopmentError(
        "task_not_found",
        "Self-development task not found.",
        404,
      );
    if (current.stateVersion !== input.expectedVersion)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed before discovery-only replanning.",
      );
    const request = current.metadata?.selfDevelopment,
      steps = await runtime.steps(current.id),
      completedTypes = steps
        .filter((step) => step.status === "completed")
        .map((step) => step.stepType),
      requiredDiscovery = [
        "inspect_repo",
        "search_code",
        "plan_patch",
        "summarize",
      ];
    const priorApprovals = await storage.listApprovals(ownerId, { limit: 100 });
    const hasDeliveryEvidence =
      steps.some((step) =>
        [
          "apply_patch",
          "commit",
          "review_commit",
          "push",
          "deploy_preview",
        ].includes(step.stepType),
      ) ||
      priorApprovals.some((approval) => approval.runId === current.id) ||
      current.currentCommit !== current.startingCommit ||
      current.approvalState ||
      current.metadata?.lastDeploymentId ||
      current.metadata?.selfDevelopmentDeliveryAttestation;
    if (
      current.status !== "completed" ||
      current.branch !== approvedBranch ||
      request?.targetBranch !== approvedBranch ||
      request?.environment !== "preview" ||
      !IMPLEMENTATION_GOAL.test(current.objective || request?.userGoal || "") ||
      request?.scope?.patch?.files?.length ||
      request?.scope?.paths?.length ||
      !requiredDiscovery.every((type) => completedTypes.includes(type)) ||
      hasDeliveryEvidence
    )
      throw new SelfDevelopmentError(
        "discovery_replan_precondition_failed",
        "Only an exact completed discovery-only implementation task may be replanned.",
      );
    const runtimeBudgetMinutes = input.runtimeBudgetMinutes ?? 60;
    if (
      !Number.isInteger(runtimeBudgetMinutes) ||
      runtimeBudgetMinutes < 15 ||
      runtimeBudgetMinutes > 90
    )
      throw new SelfDevelopmentError(
        "invalid_runtime_budget",
        "Recovery runtime budget must be an integer from 15 to 90 minutes.",
        400,
      );
    if (
      !Array.isArray(input.candidatePaths) ||
      input.candidatePaths.length < 2 ||
      input.candidatePaths.length > 12
    )
      throw new SelfDevelopmentError(
        "replan_scope_empty",
        "Implementation recovery requires 2-12 evidence candidate files.",
        400,
      );
    const candidates = [...new Set(input.candidatePaths.map(safePath))];
    const inventory = new Set(
      steps
        .filter(
          (step) =>
            step.stepType === "inspect_repo" && step.status === "completed",
        )
        .flatMap((step) => step.result?.files || step.result?.items || [])
        .map((item) =>
          safePath(typeof item === "string" ? item : item?.path || ""),
        ),
    );
    for (const path of candidates) {
      if (!inventory.has(path))
        throw new SelfDevelopmentError(
          "replan_scope_not_discovered",
          "Every candidate path must be present in durable repository discovery evidence.",
          400,
        );
      if (REPLAN_PROTECTED.test(path))
        throw new SelfDevelopmentError(
          "replan_protected_scope",
          "Discovery-only recovery cannot target protected Voice or runtime architecture.",
          403,
        );
    }
    if (
      !candidates.some((path) => !path.startsWith("test/")) ||
      !candidates.some((path) => path.startsWith("test/"))
    )
      throw new SelfDevelopmentError(
        "replan_scope_empty",
        "Evidence candidates must include implementation and focused-test files.",
        400,
      );
    const evidenceStepIds = steps
        .filter(
          (step) =>
            requiredDiscovery.includes(step.stepType) &&
            step.status === "completed",
        )
        .map((step) => step.stepId),
      base = current.metadata.steps.length,
      continuation = [];
    for (const path of candidates)
      continuation.push(
        annotation(
          base + continuation.length + 1,
          "read_files",
          "repo_read_remote",
          {
            tool: "repo_read",
            arguments: { path, startLine: 1, endLine: 1000 },
          },
          `Complete contents of ${path}`,
          "Evidence candidate is read before implementation planning",
          { retry: "safe_read" },
        ),
      );
    continuation.push(
      annotation(
        base + continuation.length + 1,
        "plan_implementation",
        "reasoning",
        {
          tool: "self_development_plan_implementation",
          arguments: {
            taskId: current.id,
            candidatePaths: candidates,
            currentCommit: current.currentCommit,
          },
        },
        "Nova-generated structured implementation plan",
        "Plan is generated only from durable evidence",
        { retry: "new_evidence_required" },
      ),
    );
    continuation.push(
      annotation(
        base + continuation.length + 1,
        "apply_patch",
        "repo_mutate_local",
        {
          tool: "repo_apply_patch",
          arguments: {
            branch: current.branch,
            currentCommit: "$CURRENT_COMMIT",
            files: "$IMPLEMENTATION_FILES",
          },
        },
        "Bounded evidence-generated files changed",
        "Hands applies only the validated Nova plan",
        { retry: "repair_required" },
      ),
    );
    continuation.push(
      annotation(
        base + continuation.length + 1,
        "run_focused_tests",
        "test_local",
        {
          tool: "test_run",
          arguments: { files: "$IMPLEMENTATION_TESTS", timeoutMs: 180000 },
        },
        "Focused test report",
        "All Nova-selected focused tests pass",
        { retry: "repair_required" },
      ),
    );
    continuation.push(
      annotation(
        base + continuation.length + 1,
        "run_full_tests",
        "test_local",
        { tool: "test_run_full", arguments: { timeoutMs: 180000 } },
        "Full test report",
        "Complete suite passes",
        { retry: "repair_required" },
      ),
    );
    continuation.push(
      annotation(
        base + continuation.length + 1,
        "inspect_diff",
        "repo_read_remote",
        { tool: "repo_diff", arguments: { paths: "$IMPLEMENTATION_PATHS" } },
        "Complete bounded diff review",
        "Diff contains only evidence-generated scope",
        { retry: "safe_read" },
      ),
    );
    continuation.push(
      annotation(
        base + continuation.length + 1,
        "commit",
        "repo_mutate_local",
        {
          tool: "git_commit",
          arguments: {
            paths: "$IMPLEMENTATION_PATHS",
            branch: current.branch,
            message: "Complete bounded Nova self-development task",
          },
        },
        "Exact local commit SHA",
        "One reviewed local commit created",
        { retry: "idempotent_commit" },
      ),
    );
    continuation.push(
      annotation(
        base + continuation.length + 1,
        "review_commit",
        "repo_read_remote",
        {
          tool: "repo_review_commit",
          arguments: {
            commitSha: "$CURRENT_COMMIT",
            paths: "$IMPLEMENTATION_PATHS",
          },
        },
        "Exact immutable commit review",
        "Commit exactly matches the reviewed bounded change-set",
        { retry: "not_retryable" },
      ),
    );
    for (const step of plan({
      ...request,
      scope: {
        ...request.scope,
        patch: { files: [{ path: "placeholder", content: "placeholder" }] },
      },
    }).filter((step) =>
      [
        "push",
        "deploy_preview",
        "wait",
        "verify_preview",
        "summarize",
      ].includes(step.type),
    ))
      continuation.push({
        ...step,
        idempotencyIdentity: `self-development:${base + continuation.length + 1}:${hash([step.type, clean(step.input)])}`,
      });
    const now = clock().toISOString(),
      scopeHash = hash(candidates),
      replanRecord = {
        fromStatus: current.status,
        fromStateVersion: current.stateVersion,
        previousStartedAt: current.startedAt,
        previousCompletedAt: current.completedAt,
        evidenceStepIds,
        candidatePaths: candidates,
        scopeHash,
        createdAt: now,
      };
    const updated = await storage.updateAutonomyTask(
      current.id,
      ownerId,
      {
        status: "queued",
        currentStep: base,
        currentPhase: "replan_implementation",
        nextRunAt: now,
        startedAt: now,
        completedAt: null,
        errorCode: null,
        resultSummary: null,
        retryCount: 0,
        maxRuntimeMinutes: runtimeBudgetMinutes,
        blockedReason: null,
        maxSteps: Math.min(
          100,
          base +
            continuation.length +
            (current.metadata.maxRepairIterations || 2) * 6,
        ),
        metadata: {
          ...current.metadata,
          steps: [...current.metadata.steps, ...continuation],
          requiredCapability: "repo_read_remote",
          autoDispatch: true,
          discoveryOnlyReplanHistory: [
            ...(current.metadata.discoveryOnlyReplanHistory || []),
            replanRecord,
          ],
        },
      },
      current.stateVersion,
    );
    if (!updated)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed during discovery-only replanning.",
      );
    await storage.appendActivity({
      ownerId,
      projectId: current.projectId,
      runId: current.id,
      action: "self_development_replanned_after_discovery_only_completion",
      status: "queued",
      summary:
        "Completed discovery-only task reopened with an evidence-bound implementation continuation.",
      metadata: {
        taskId: current.id,
        previousStateVersion: current.stateVersion,
        evidenceStepIds,
        scopeHash,
        runtimeBudgetMinutes,
        continuationStepCount: continuation.length,
      },
    });
    return {
      task: updated,
      evidenceStepIds,
      scopeHash,
      continuationSteps: continuation.map((step) => step.type),
    };
  }
  async function recoverImplementationPlan(taskId, input) {
    if (
      !input ||
      Object.keys(input).some((key) => key !== "expectedVersion") ||
      !Number.isInteger(input.expectedVersion)
    )
      throw new SelfDevelopmentError(
        "implementation_plan_recovery_invalid",
        "An exact task version is required.",
        400,
      );
    const current = await runtime.get(taskId);
    if (!current || current.taskType !== "self_development")
      throw new SelfDevelopmentError(
        "task_not_found",
        "Self-development task not found.",
        404,
      );
    if (current.stateVersion !== input.expectedVersion)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed before implementation-plan recovery.",
      );
    const steps = await runtime.steps(current.id),
      failed = steps.find(
        (step) =>
          step.stepId === `${current.currentStep + 1}:plan_implementation` &&
          step.status === "failed" &&
          step.errorCode === "implementation_plan_invalid",
      ),
      reads = steps.filter(
        (step) => step.stepType === "read_files" && step.status === "completed",
      ),
      approvals = await storage.listApprovals(ownerId, { limit: 100 }),
      unsafe =
        steps.some((step) =>
          [
            "apply_patch",
            "commit",
            "review_commit",
            "push",
            "deploy_preview",
          ].includes(step.stepType),
        ) || approvals.some((approval) => approval.runId === current.id),
      candidates =
        current.metadata?.discoveryOnlyReplanHistory?.at(-1)?.candidatePaths ||
        [];
    if (
      current.status !== "failed" ||
      current.errorCode !== "implementation_plan_invalid" ||
      !failed ||
      candidates.length < 2 ||
      candidates.some(
        (path) =>
          !reads.some(
            (step) =>
              (step.result?.path || step.input?.arguments?.path) === path,
          ),
      ) ||
      unsafe ||
      current.currentCommit !== current.startingCommit
    )
      throw new SelfDevelopmentError(
        "implementation_plan_recovery_precondition_failed",
        "Only the exact pre-mutation planner-format failure may be recovered.",
      );
    const now = clock().toISOString(),
      record = {
        failedStepId: failed.stepId,
        previousStateVersion: current.stateVersion,
        validationIssues: failed.result?.diagnostics?.validationIssues || [],
        outputShapeHash: failed.result?.diagnostics?.outputShapeHash || null,
        recoveredAt: now,
      },
      updated = await storage.updateAutonomyTask(
        current.id,
        ownerId,
        {
          status: "queued",
          currentPhase: "plan_implementation_recovery",
          nextRunAt: now,
          startedAt: now,
          completedAt: null,
          errorCode: null,
          retryCount: 0,
          blockedReason: null,
          metadata: {
            ...current.metadata,
            requiredCapability: "reasoning",
            autoDispatch: true,
            implementationPlanRecoveryHistory: [
              ...(current.metadata.implementationPlanRecoveryHistory || []),
              record,
            ],
          },
        },
        current.stateVersion,
      );
    if (!updated)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed during implementation-plan recovery.",
      );
    await storage.appendActivity({
      ownerId,
      projectId: current.projectId,
      runId: current.id,
      action: "self_development_implementation_plan_recovered",
      status: "queued",
      summary:
        "Exact pre-mutation planner-format failure requeued with bounded schema correction.",
      metadata: {
        taskId: current.id,
        failedStepId: failed.stepId,
        previousStateVersion: current.stateVersion,
        validationIssues: record.validationIssues,
        outputShapeHash: record.outputShapeHash,
      },
    });
    return { task: updated, recoveredStepId: failed.stepId };
  }
  async function recoverImplementationSchema(taskId, input) {
    if (!input || Object.keys(input).some((key) => key !== "expectedVersion") || !Number.isInteger(input.expectedVersion))
      throw new SelfDevelopmentError("implementation_schema_recovery_invalid", "An exact task version is required.", 400);
    const current = await runtime.get(taskId);
    if (!current || current.taskType !== "self_development")
      throw new SelfDevelopmentError("task_not_found", "Self-development task not found.", 404);
    const prior = current.metadata?.implementationSchemaRecoveryHistory?.find((item) => item.previousStateVersion === input.expectedVersion);
    if (prior && current.status !== "failed") return { task: current, recoveredStepId: prior.failedStepId, idempotent: true };
    if (current.stateVersion !== input.expectedVersion)
      throw new SelfDevelopmentError("version_conflict", "Task changed before implementation-schema recovery.");
    const steps = await runtime.steps(current.id), semantic = resolveSemanticPlanApplyState(current, steps, "schema_mismatch",{planStepTypes:["plan_implementation","plan_repair"]}), {failed, planned, planTemplate, remaining, completedAfterPlan: unsafeAfterPlan} = semantic, approvals = await storage.listApprovals(ownerId, { limit: 100 }), schemaMessage = String(failed?.result?.message || ""), diagnostic=failed?.result?.diagnostics, repairBranchMissing=isExactMissingBranchSchemaDiagnostic(diagnostic,{stepType:failed?.stepType,templateTool:remaining[0]?.input?.tool}), legacyCurrentCommit=schemaMessage.includes("repo_apply_patch.currentCommit"), exactFailedStep=failed.stepId===`${current.currentStep+1}:apply_patch`;
    if (current.status !== "failed" || current.errorCode !== "schema_mismatch" || (!repairBranchMissing&&!legacyCurrentCommit) || !exactFailedStep || current.branch!==approvedBranch || ["main","master"].includes(current.branch) || remaining[0]?.type !== "apply_patch" || unsafeAfterPlan || current.leaseOwner || current.approvalState || approvals.some((approval) => approval.runId === current.id) || current.metadata?.lastDeploymentId || current.metadata?.selfDevelopmentDeliveryAttestation)
      throw new SelfDevelopmentError("implementation_schema_recovery_precondition_failed", "Only the exact pre-mutation implementation bridge schema failure may be recovered.");
    const canonicalPatch={...remaining[0],input:{...remaining[0].input,tool:"repo_apply_patch",arguments:{branch:"$TASK_BRANCH",currentCommit:"$CURRENT_COMMIT",files:"$IMPLEMENTATION_FILES",planProvenance:"$IMPLEMENTATION_PLAN_PROVENANCE"}}}, continuation=repairBranchMissing?[canonicalPatch,...remaining.slice(1)]:[{...planTemplate}, ...remaining], base = current.metadata.steps.length, nextSteps = continuation.map((step, index) => ({...step, idempotencyIdentity: `${step.idempotencyIdentity || `self-development:${step.type}`}:schema-recovery:${base + index + 1}`})), now = clock().toISOString(), record = {failedStepId: failed.stepId, plannedStepId: planned.stepId, previousStateVersion: current.stateVersion, fieldPath: repairBranchMissing?"repo_apply_patch.branch":"repo_apply_patch.currentCommit", expected: repairBranchMissing?"required exact task branch":"declared string commit binding", received: repairBranchMissing?"missing":"string", validationCode: repairBranchMissing?"required_field_missing":"unsupported_field", schemaVersion: diagnostic?.schemaVersion||"1", recoveredAt: now};
    if (!repairBranchMissing && base + nextSteps.length > current.maxSteps)
      throw new SelfDevelopmentError("implementation_schema_recovery_budget_exceeded", "The existing bounded step budget cannot contain schema recovery.");
    const activeContinuation=repairBranchMissing?createActiveContinuation({task:current,startStep:base,plannedSteps:nextSteps.length,repairLimit:current.metadata?.selfDevelopment?.repairLimit??2,recoveryClass:"repair_apply_patch_schema_binding",runtimeStartedAt:now,runtimeMinutes:15}):current.metadata?.activeContinuation;
    const updated = await storage.updateAutonomyTask(current.id, ownerId, {status:"queued",currentStep:base,currentPhase:"plan_implementation_schema_recovery",nextRunAt:now,startedAt:now,completedAt:null,errorCode:null,retryCount:0,blockedReason:null,metadata:{...current.metadata,steps:[...current.metadata.steps,...nextSteps],requiredCapability:repairBranchMissing?"repo_mutate_local":"reasoning",autoDispatch:true,...(repairBranchMissing?{activeContinuation,continuationHistory:[...(current.metadata?.continuationHistory||[]),activeContinuation]}:{}),implementationSchemaRecoveryHistory:[...(current.metadata.implementationSchemaRecoveryHistory || []),record]}}, current.stateVersion);
    if (!updated) throw new SelfDevelopmentError("version_conflict", "Task changed during implementation-schema recovery.");
    await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_implementation_schema_recovered",status:"queued",summary:"Exact pre-mutation implementation bridge schema failure requeued for canonical replanning.",metadata:{taskId:current.id,failedStepId:failed.stepId,previousStateVersion:current.stateVersion,fieldPath:record.fieldPath,expected:record.expected,received:record.received,validationCode:record.validationCode,schemaVersion:record.schemaVersion}});
    return { task: updated, recoveredStepId: failed.stepId, idempotent: false };
  }
  async function recoverFocusedTestSchema(taskId,input){
    if(!input||Object.keys(input).some(key=>key!=="expectedVersion")||!Number.isInteger(input.expectedVersion))throw new SelfDevelopmentError("focused_test_schema_recovery_invalid","Exact version is required.",400);
    const current=await runtime.get(taskId);if(!current||current.taskType!=="self_development")throw new SelfDevelopmentError("task_not_found","Self-development task not found.",404);
    const prior=current.metadata?.focusedTestSchemaRecoveryHistory?.find(item=>item.previousStateVersion===input.expectedVersion);if(prior&&current.status!=="failed")return{task:current,recoveredStepId:prior.failedStepId,idempotent:true};
    if(current.stateVersion!==input.expectedVersion)throw new SelfDevelopmentError("version_conflict","Task changed before focused-test schema recovery.");
    const steps=await runtime.steps(current.id),failed=steps.filter(step=>step.status==="failed").at(-1),diagnostic=failed?.result?.diagnostics,failedOrdinal=Number.parseInt(failed?.stepId||"",10),exactStep=failed?.stepId===`${current.currentStep+1}:run_focused_tests`,exactDiagnostic=failed?.stepType==="run_focused_tests"&&failed?.errorCode==="schema_mismatch"&&diagnostic?.tool==="test_run"&&diagnostic?.fieldPath==="test_run.files"&&diagnostic?.validationCode==="required_field_missing"&&diagnostic?.received?.type==="missing",approvals=await storage.listApprovals(ownerId,{limit:100}),plan=current.metadata?.selfDevelopmentImplementationPlan;
    if(current.status!=="failed"||current.errorCode!=="schema_mismatch"||!exactStep||!exactDiagnostic||!Number.isInteger(failedOrdinal)||!plan?.provenance||current.metadata?.activeImplementationPlanGeneration!==plan.provenance.generationId||plan.provenance.taskId!==current.id||plan.provenance.currentCommit!==current.currentCommit||current.branch!==approvedBranch||current.leaseOwner||current.approvalState||approvals.some(item=>item.runId===current.id)||current.metadata?.lastDeploymentId||current.metadata?.selfDevelopmentDeliveryAttestation)throw new SelfDevelopmentError("focused_test_schema_recovery_precondition_failed","Only the exact active-plan pre-test files binding failure may be recovered.");
    assertActiveImplementationPlan(current,plan.files);const remaining=current.metadata.steps.slice(failedOrdinal),focused={...current.metadata.steps[failedOrdinal-1],input:{tool:"test_run",arguments:{files:"$IMPLEMENTATION_TESTS"}}},continuation=[focused,...remaining],base=current.metadata.steps.length,nextSteps=continuation.map((step,index)=>({...step,idempotencyIdentity:`${step.idempotencyIdentity||`self-development:${step.type}`}:focused-test-schema-recovery:${base+index+1}`})),now=clock().toISOString(),activeContinuation=createActiveContinuation({task:current,startStep:base,plannedSteps:nextSteps.length,repairLimit:current.metadata?.maxRepairIterations??2,recoveryClass:"focused_test_files_binding",runtimeStartedAt:now,runtimeMinutes:15}),record={recoveryClass:"focused_test_files_binding",previousStateVersion:current.stateVersion,failedStepId:failed.stepId,fieldPath:"test_run.files",validationCode:"required_field_missing",planGenerationId:plan.provenance.generationId,recoveredAt:now};
    const updated=await storage.updateAutonomyTask(current.id,ownerId,{status:"waiting_for_worker",currentStep:base,currentPhase:"focused_test_schema_recovery",nextRunAt:now,startedAt:now,completedAt:null,errorCode:null,retryCount:0,blockedReason:null,checkpoint:{...current.checkpoint,pendingStep:null},metadata:{...current.metadata,steps:[...current.metadata.steps,...nextSteps],requiredCapability:"test_local",autoDispatch:true,activeContinuation,continuationHistory:[...(current.metadata?.continuationHistory||[]),activeContinuation],focusedTestSchemaRecoveryHistory:[...(current.metadata?.focusedTestSchemaRecoveryHistory||[]),record]}},current.stateVersion);if(!updated)throw new SelfDevelopmentError("version_conflict","Task changed during focused-test schema recovery.");
    await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_focused_test_schema_recovered",status:"waiting_for_worker",summary:"Exact pre-test focused-test files binding was restored for bounded continuation.",metadata:{taskId:current.id,previousStateVersion:current.stateVersion,failedStepId:failed.stepId,fieldPath:record.fieldPath,validationCode:record.validationCode,planGenerationId:record.planGenerationId}});return{task:updated,recoveredStepId:failed.stepId,idempotent:false};
  }
  async function recoverStaleBasePatchConflict(taskId, input) {
    if (!input || Object.keys(input).some((key) => !["expectedVersion","workspace"].includes(key)) || !Number.isInteger(input.expectedVersion) || !input.workspace || Object.keys(input.workspace).some((key) => !["head","clean"].includes(key)) || !SHA.test(input.workspace.head || "") || input.workspace.clean !== true)
      throw new SelfDevelopmentError("stale_base_recovery_invalid", "Exact version and clean controlled-workspace attestation are required.", 400);
    const current = await runtime.get(taskId);
    if (!current || current.taskType !== "self_development") throw new SelfDevelopmentError("task_not_found", "Self-development task not found.", 404);
    const prior = current.metadata?.baseRevisionHistory?.find((item) => item.previousStateVersion === input.expectedVersion);
    if (prior && current.status !== "failed") return {task:current,previousBaseCommit:prior.previousBaseCommit,newBaseCommit:prior.newBaseCommit,idempotent:true};
    if (current.stateVersion !== input.expectedVersion) throw new SelfDevelopmentError("version_conflict", "Task changed before base-revision recovery.");
    if (!verifyRemote || !SHA.test(currentCommit || "") || input.workspace.head !== currentCommit) throw new SelfDevelopmentError("base_revision_verification_unavailable", "The exact deployed branch tip and controlled workspace must agree.", 503);
    const steps=await runtime.steps(current.id), semantic=resolveSemanticPlanApplyState(current,steps,"patch_conflict"), {failed,planned,planTemplate,remaining,completedAfterPlan}=semantic, approvals=await storage.listApprovals(ownerId,{limit:100}), completedDelivery=steps.some((step)=>["commit","review_commit","push","deploy_preview"].includes(step.stepType)&&step.status==="completed"), oldCommit=current.currentCommit;
    if (current.status!=="failed"||current.errorCode!=="patch_conflict"||!String(failed.result?.message||"").includes("Expected existing content does not match")||current.branch!==approvedBranch||["main","master"].includes(current.branch)||current.startingCommit!==oldCommit||oldCommit===currentCommit||completedAfterPlan||completedDelivery||approvals.some((approval)=>approval.runId===current.id)||current.metadata?.lastDeploymentId||current.metadata?.selfDevelopmentDeliveryAttestation||current.leaseOwner||remaining[0]?.type!=="apply_patch") throw new SelfDevelopmentError("stale_base_recovery_precondition_failed","Only the exact clean pre-commit stale-base patch conflict may be recovered.");
    const remote=await verifyRemote({repository,branch:current.branch,requiredAncestors:[oldCommit,currentCommit]});
    if(remote.currentTip!==currentCommit||remote.ancestors?.[oldCommit]!==true||remote.ancestors?.[currentCommit]!==true) throw new SelfDevelopmentError("base_revision_ancestry_mismatch","The new base is not the exact live descendant tip.");
    const implementation=planned.result.implementationPlan, evidencePaths=[...new Set([...(implementation.evidencePaths||[]),...implementation.files.map((file)=>file.path)].map(safePath))];
    if(!evidencePaths.length||evidencePaths.length>12||evidencePaths.some((path)=>REPLAN_PROTECTED.test(path))) throw new SelfDevelopmentError("stale_base_evidence_invalid","Bounded implementation evidence cannot be refreshed.");
    const base=current.metadata.steps.length, reads=evidencePaths.map((path,index)=>annotation(base+index+1,"read_files","repo_read_remote",{tool:"repo_read",arguments:{path,startLine:1,endLine:1000}},`Current contents of ${path}`,"New-base evidence is read before replanning",{retry:"safe_read"})), replan={...planTemplate,input:{...planTemplate.input,arguments:{...planTemplate.input.arguments,taskId:current.id,candidatePaths:evidencePaths,currentCommit}},idempotencyIdentity:`${planTemplate.idempotencyIdentity||"self-development:plan_implementation"}:base-refresh:${currentCommit}`}, continuation=[...reads,replan,...remaining], maxSteps=Math.min(100,base+continuation.length);
    if(maxSteps<base+continuation.length) throw new SelfDevelopmentError("stale_base_recovery_budget_exceeded","Bounded recovery exceeds the safe step maximum.");
    const now=clock().toISOString(), record={previousBaseCommit:oldCommit,newBaseCommit:currentCommit,previousStateVersion:current.stateVersion,failedStepId:failed.stepId,invalidatedEvidencePaths:evidencePaths,workingTreeClean:true,ancestryVerified:true,recoveredAt:now};
    const updated=await storage.updateAutonomyTask(current.id,ownerId,{status:"queued",currentStep:base,currentPhase:"stale_base_evidence_refresh",currentCommit,maxSteps,nextRunAt:now,startedAt:now,completedAt:null,errorCode:null,retryCount:0,blockedReason:null,checkpoint:{...current.checkpoint,pendingStep:null},metadata:{...current.metadata,steps:[...current.metadata.steps,...continuation],requiredCapability:"repo_read_remote",autoDispatch:true,selfDevelopmentImplementationPlan:null,baseRevisionHistory:[...(current.metadata.baseRevisionHistory||[]),record],staleContentEvidence:[...(current.metadata.staleContentEvidence||[]),{baseCommit:oldCommit,paths:evidencePaths,invalidatedAt:now}]}},current.stateVersion);
    if(!updated) throw new SelfDevelopmentError("version_conflict","Task changed during base-revision recovery.");
    await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_base_revision_advanced",status:"queued",summary:"Task base advanced along verified feature history; stale content evidence requires bounded refresh.",metadata:{taskId:current.id,previousBaseCommit:oldCommit,newBaseCommit:currentCommit,previousStateVersion:current.stateVersion,failedStepId:failed.stepId,invalidatedEvidencePaths:evidencePaths,workingTreeClean:true,ancestryVerified:true,maxSteps}});
    return{task:updated,previousBaseCommit:oldCommit,newBaseCommit:currentCommit,invalidatedEvidencePaths:evidencePaths,idempotent:false};
  }
  async function recoverHandsCommitMismatch(taskId,input,{failureCode="commit_mismatch",recoveryClass="commit_mismatch_descendant_rebind",recoveryRoute="recover-hands-commit-mismatch"}={}){
    if(!input||Object.keys(input).some(key=>!["expectedVersion","workspace"].includes(key))||!Number.isInteger(input.expectedVersion)||!input.workspace||Object.keys(input.workspace).some(key=>!["root","gitTopLevel","head","clean","changedFiles"].includes(key))||!SHA.test(input.workspace.head||"")||typeof input.workspace.root!=="string"||input.workspace.root!==input.workspace.gitTopLevel||typeof input.workspace.clean!=="boolean")
      throw new SelfDevelopmentError("hands_context_recovery_invalid","Exact version and bounded repository context are required.",400);
    const current=await runtime.get(taskId);if(!current||current.taskType!=="self_development")throw new SelfDevelopmentError("task_not_found","Self-development task not found.",404);
    const prior=current.metadata?.handsContextRecoveryHistory?.find(item=>item.previousStateVersion===input.expectedVersion);if(prior&&current.status!=="failed")return{task:current,recoveredStepId:prior.failedStepId,idempotent:true};
    if(current.stateVersion!==input.expectedVersion)throw new SelfDevelopmentError("version_conflict","Task changed before Hands-context recovery.");
    const steps=await runtime.steps(current.id),semantic=resolveSemanticPlanApplyState(current,steps,failureCode,{planStepTypes:["plan_implementation","plan_repair"]}),{failed,planned,planTemplate,remaining,completedAfterPlan}=semantic,approvals=await storage.listApprovals(ownerId,{limit:100}),oldCommit=current.currentCommit,newCommit=currentCommit,noMutation=failed?.result?.mutationApplied!==true&&failed?.result?.changed!==true&&!(failed?.result?.changedFiles||[]).length;
    if(current.status!=="failed"||current.errorCode!==failureCode||!failed||!planned||!noMutation||current.branch!==approvedBranch||["main","master"].includes(current.branch)||!SHA.test(newCommit||"")||input.workspace.head!==newCommit||completedAfterPlan||approvals.some(approval=>approval.runId===current.id)||current.metadata?.lastDeploymentId||current.metadata?.selfDevelopmentDeliveryAttestation||current.leaseOwner||remaining[0]?.type!=="apply_patch")throw new SelfDevelopmentError("hands_context_recovery_precondition_failed","Only the exact pre-mutation Hands repository-context mismatch may be recovered.");
    if(!verifyRemote||!compareRemoteEvidence)throw new SelfDevelopmentError("hands_context_verification_unavailable","Remote ancestry and evidence verification are required.",503);
    const remote=await verifyRemote({repository,branch:current.branch,requiredAncestors:[oldCommit,newCommit]});if(remote.currentTip!==newCommit||remote.ancestors?.[oldCommit]!==true||remote.ancestors?.[newCommit]!==true)throw new SelfDevelopmentError("hands_context_ancestry_mismatch","The controlled checkout is not the exact live descendant feature tip.");
    const implementation=planned.result.implementationPlan,hasBoundPlan=Boolean(implementation?.provenance);if(hasBoundPlan)assertActiveImplementationPlan(current,implementation.files);const declaredDirty=Array.isArray(input.workspace.changedFiles)?input.workspace.changedFiles:[],replaceOnly=implementation.files.every(file=>file.operation==="replace"),expectedDirty=implementation.files.map(file=>({path:safePath(file.path),hashAlgorithm:"git_sha1",hash:gitBlobHash(file.expectedContent)})).sort((a,b)=>a.path.localeCompare(b.path)),expectedDirtyByPath=new Map(expectedDirty.map(item=>[item.path,item])),actualDirty=declaredDirty.map(item=>({path:safePath(item?.path),hashAlgorithm:item?.hashAlgorithm,hash:String(item?.hash||"").toLowerCase()})).sort((a,b)=>a.path.localeCompare(b.path)),taskOwnedDirty=input.workspace.clean===false&&["commit_mismatch","working_tree_dirty"].includes(failureCode)&&hasBoundPlan&&replaceOnly&&actualDirty.length>0&&actualDirty.length<=expectedDirty.length&&actualDirty.every(item=>{const expected=expectedDirtyByPath.get(item.path);return expected&&item.hashAlgorithm==="git_sha1"&&item.hash===expected.hash;});if((failureCode==="working_tree_dirty"&&input.workspace.clean!==false)||(input.workspace.clean===true&&declaredDirty.length)||(input.workspace.clean===false&&!taskOwnedDirty))throw new SelfDevelopmentError("hands_context_recovery_dirty_unproven","A dirty checkout is allowed only when every changed file exactly matches the active plan's pre-mutation content.",400);
    const evidencePaths=[...new Set([...(implementation.evidencePaths||[]),...implementation.files.map(file=>file.path)].map(safePath))];if(!evidencePaths.length||evidencePaths.length>12||evidencePaths.some(path=>REPLAN_PROTECTED.test(path)))throw new SelfDevelopmentError("hands_context_evidence_invalid","Bounded implementation evidence cannot be verified.");
    const evidence=await compareRemoteEvidence({repository,paths:evidencePaths,oldCommit,newCommit}),changedPaths=evidencePaths.filter(path=>evidence[path]?.equivalent!==true),base=current.metadata.steps.length;
    const reads=changedPaths.map((path,index)=>annotation(base+index+1,"read_files","repo_read_remote",{tool:"repo_read",arguments:{path,startLine:1,endLine:1000}},`Current contents of ${path}`,"Rebound evidence is read before replanning",{retry:"safe_read"})),replan=changedPaths.length?{...planTemplate,input:{...planTemplate.input,arguments:{...planTemplate.input.arguments,taskId:current.id,candidatePaths:evidencePaths,currentCommit:newCommit}},idempotencyIdentity:`${planTemplate.idempotencyIdentity||"self-development:plan_implementation"}:hands-rebind:${newCommit}`}:null,continuation=[...reads,...(replan?[replan]:[]),...remaining],nextSteps=continuation.map((step,index)=>({...step,idempotencyIdentity:`${step.idempotencyIdentity||`self-development:${step.type}`}:hands-context-recovery:${base+index+1}`}));
    const reboundTask={...current,currentCommit:newCommit},reboundPlan=changedPaths.length?null:hasBoundPlan?rebindEquivalentImplementationPlan({task:reboundTask,plan:implementation,evidence:implementation.files.filter(file=>file.operation==="replace").map(file=>({path:file.path,content:file.expectedContent}))}):implementation,reboundMetadata=hasBoundPlan&&reboundPlan?planLifecycleMetadata(reboundTask,reboundPlan):current.metadata,now=clock().toISOString(),activeContinuation=createActiveContinuation({task:reboundTask,startStep:base,plannedSteps:nextSteps.length,repairLimit:current.metadata?.maxRepairIterations??2,recoveryClass,runtimeStartedAt:now,runtimeMinutes:15}),record={recoveryClass,previousStateVersion:current.stateVersion,failedStepId:failed.stepId,plannedStepId:planned.stepId,semanticPlanOrdinal:semantic.plannedOrdinal,semanticApplyOrdinal:semantic.failedOrdinal,previousCurrentCommit:oldCommit,newCurrentCommit:newCommit,ancestryVerified:true,evidence:Object.fromEntries(evidencePaths.map(path=>[path,{oldBlob:evidence[path].oldSha,newBlob:evidence[path].newSha,equivalent:evidence[path].equivalent===true}])),invalidatedEvidencePaths:changedPaths,repositoryRoot:input.workspace.root,gitTopLevel:input.workspace.gitTopLevel,workingTreeClean:input.workspace.clean,taskOwnedDirtyFiles:taskOwnedDirty?actualDirty:[],previousPlanGenerationId:implementation.provenance?.generationId||null,newPlanGenerationId:reboundPlan?.provenance?.generationId||null,activeContinuation,recoveredAt:now},requiredCapability=changedPaths.length?"repo_read_remote":"repo_mutate_local",status=changedPaths.length?"queued":"waiting_for_worker";
    let updated;try{updated=await storage.updateAutonomyTask(current.id,ownerId,{status,currentStep:base,currentPhase:"hands_repository_context_recovery",currentCommit:newCommit,nextRunAt:now,startedAt:now,completedAt:null,errorCode:null,retryCount:0,blockedReason:null,checkpoint:{...current.checkpoint,pendingStep:null},metadata:{...reboundMetadata,steps:[...current.metadata.steps,...nextSteps],requiredCapability,autoDispatch:true,selfDevelopmentImplementationPlan:changedPaths.length?null:reboundPlan,activeImplementationPlanGeneration:changedPaths.length?null:reboundPlan?.provenance?.generationId||current.metadata.activeImplementationPlanGeneration,activeContinuation,continuationHistory:[...(current.metadata?.continuationHistory||[]),activeContinuation],handsContextRecoveryHistory:[...(current.metadata.handsContextRecoveryHistory||[]),record],baseRevisionHistory:[...(current.metadata.baseRevisionHistory||[]),{previousBaseCommit:oldCommit,newBaseCommit:newCommit,previousStateVersion:current.stateVersion,ancestryVerified:true,recoveredAt:now}] }},current.stateVersion);}catch(error){const internalCode=typeof error?.code==="string"&&/^[a-z0-9_]{1,80}$/i.test(error.code)&&!SECRET.test(error.code)?error.code:"storage_error";throw new SelfDevelopmentError("hands_context_recovery_persistence_failed","Hands-context recovery could not be persisted safely.",500,{recoveryRoute,recoveryClass,stage:"persistence",operation:"update_autonomy_task",taskId:current.id,stepId:failed.stepId,stepType:failed.stepType,internalCode,mutationStarted:true,mutationCompleted:false});}if(!updated)throw new SelfDevelopmentError("version_conflict","Task changed during Hands-context recovery.");
    await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_hands_context_recovered",status,summary:"Exact pre-mutation Hands repository context and descendant task base were verified for bounded continuation.",metadata:{taskId:current.id,previousStateVersion:current.stateVersion,failedStepId:failed.stepId,previousCurrentCommit:oldCommit,newCurrentCommit:newCommit,ancestryVerified:true,invalidatedEvidencePaths:changedPaths,repositoryRoot:input.workspace.root,continuationGenerationId:activeContinuation.generationId,continuationStepBudget:activeContinuation.maxSteps}});
    return{task:updated,recoveredStepId:failed.stepId,previousCurrentCommit:oldCommit,newCurrentCommit:newCommit,invalidatedEvidencePaths:changedPaths,evidence,idempotent:false};
  }
  const recoverHandsWorkingTreeDirty=(taskId,input)=>recoverHandsCommitMismatch(taskId,input,{failureCode:"working_tree_dirty",recoveryClass:"task_owned_dirty_patch_resume",recoveryRoute:"recover-hands-working-tree-dirty"});
  const recoverRepositoryContextFailure=(taskId,input)=>recoverHandsCommitMismatch(taskId,input,{failureCode:"repository_context_unproven",recoveryClass:"repository_context_descendant_rebind"});
  async function recoverPlanLifecycle(taskId,input){
    if(!input||Object.keys(input).some(key=>!["expectedVersion","workspace"].includes(key))||!Number.isInteger(input.expectedVersion)||!input.workspace||Object.keys(input.workspace).some(key=>!["root","gitTopLevel","head","clean"].includes(key))||!SHA.test(input.workspace.head||"")||input.workspace.clean!==true||input.workspace.root!==input.workspace.gitTopLevel)throw new SelfDevelopmentError("plan_lifecycle_recovery_invalid","Exact version and clean repository proof are required.",400);
    const current=await runtime.get(taskId);if(!current||current.taskType!=="self_development")throw new SelfDevelopmentError("task_not_found","Self-development task not found.",404);
    const prior=current.metadata?.planLifecycleRecoveryHistory?.find(item=>item.previousStateVersion===input.expectedVersion);if(prior&&current.status!=="failed")return{task:current,idempotent:true,recovery:prior};
    if(current.stateVersion!==input.expectedVersion)throw new SelfDevelopmentError("version_conflict","Task changed before plan-lifecycle recovery.");
    const steps=await runtime.steps(current.id),semantic=resolveSemanticPlanApplyState(current,steps,"patch_conflict"),{failed,planned,planTemplate,remaining,completedAfterPlan}=semantic,approvals=await storage.listApprovals(ownerId,{limit:100}),oldCommit=current.currentCommit,newCommit=currentCommit;
    const noMutation=failed.result?.mutationApplied!==true&&failed.result?.changed!==true&&!(failed.result?.changedFiles||[]).length;
    if(current.status!=="failed"||current.errorCode!=="patch_conflict"||!String(failed.result?.message||"").includes("Expected existing content does not match")||!noMutation||completedAfterPlan||approvals.some(item=>item.runId===current.id)||current.metadata?.lastDeploymentId||current.metadata?.selfDevelopmentDeliveryAttestation||current.leaseOwner||remaining[0]?.type!=="apply_patch"||current.branch!==approvedBranch||input.workspace.head!==newCommit||!SHA.test(newCommit||""))throw new SelfDevelopmentError("plan_lifecycle_recovery_precondition_failed","Only the exact pre-mutation stale-plan conflict may be recovered.");
    if(!verifyRemote||!compareRemoteEvidence)throw new SelfDevelopmentError("plan_lifecycle_verification_unavailable","Remote ancestry and evidence verification are required.",503);
    const remote=await verifyRemote({repository,branch:current.branch,requiredAncestors:[oldCommit,newCommit]});if(remote.currentTip!==newCommit||remote.ancestors?.[oldCommit]!==true||remote.ancestors?.[newCommit]!==true)throw new SelfDevelopmentError("plan_lifecycle_ancestry_mismatch","The corrective commit is not the exact descendant feature tip.");
    const implementation=planned.result.implementationPlan,evidencePaths=[...new Set([...(implementation.evidencePaths||[]),...implementation.files.map(file=>file.path)].map(safePath))];if(!evidencePaths.length||evidencePaths.length>12||evidencePaths.some(path=>REPLAN_PROTECTED.test(path)))throw new SelfDevelopmentError("plan_lifecycle_evidence_invalid","Bounded plan evidence cannot be refreshed.");
    const evidence=await compareRemoteEvidence({repository,paths:evidencePaths,oldCommit,newCommit}),base=current.metadata.steps.length,reads=evidencePaths.map((path,index)=>annotation(base+index+1,"read_files","repo_read_remote",{tool:"repo_read",arguments:{path,startLine:1,endLine:1000}},`Complete contents of ${path}`,"Authoritative current-generation evidence is read before replanning",{retry:"safe_read"})),replan={...planTemplate,input:{...planTemplate.input,arguments:{...planTemplate.input.arguments,taskId:current.id,candidatePaths:evidencePaths,currentCommit:newCommit}},idempotencyIdentity:`${planTemplate.idempotencyIdentity||"self-development:plan_implementation"}:plan-generation:${newCommit}:${base}`},continuation=[...reads,replan,...remaining],nextSteps=continuation.map((step,index)=>({...step,idempotencyIdentity:`${step.idempotencyIdentity||`self-development:${step.type}`}:continuation:${base+index+1}`}));
    const rebound={...current,currentCommit:newCommit},now=clock().toISOString(),activeContinuation=createActiveContinuation({task:rebound,startStep:base,plannedSteps:nextSteps.length,repairLimit:current.metadata?.maxRepairIterations??2,recoveryClass:"plan_provenance_descendant_rebind",runtimeStartedAt:now,runtimeMinutes:15}),generations=(current.metadata?.implementationPlanGenerations||[]).map(item=>item.authority==="active"?{...item,authority:"superseded",supersededReason:"descendant_rebind_requires_replan"}:item),record={previousStateVersion:current.stateVersion,failedStepId:failed.stepId,plannedStepId:planned.stepId,previousCurrentCommit:oldCommit,newCurrentCommit:newCommit,evidence:Object.fromEntries(evidencePaths.map(path=>[path,{oldBlob:evidence[path].oldSha,newBlob:evidence[path].newSha,equivalent:evidence[path].equivalent===true}])),supersededPlanHash:implementation.planHash||null,activeContinuation,recoveredAt:now};
    const metadata={...current.metadata,steps:[...current.metadata.steps,...nextSteps],requiredCapability:"repo_read_remote",autoDispatch:true,selfDevelopmentImplementationPlan:null,activeImplementationPlanGeneration:null,implementationPlanGenerations:generations,activeContinuation,continuationHistory:[...(current.metadata?.continuationHistory||[]),activeContinuation],planLifecycleRecoveryHistory:[...(current.metadata?.planLifecycleRecoveryHistory||[]),record],baseRevisionHistory:[...(current.metadata?.baseRevisionHistory||[]),{previousBaseCommit:oldCommit,newBaseCommit:newCommit,previousStateVersion:current.stateVersion,ancestryVerified:true,recoveredAt:now}]};
    const updated=await storage.updateAutonomyTask(current.id,ownerId,{status:"queued",currentStep:base,currentPhase:"plan_lifecycle_recovery",currentCommit:newCommit,nextRunAt:now,startedAt:now,completedAt:null,errorCode:null,retryCount:0,blockedReason:null,checkpoint:{...current.checkpoint,pendingStep:null},metadata},current.stateVersion);if(!updated)throw new SelfDevelopmentError("version_conflict","Task changed during plan-lifecycle recovery.");
    await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_plan_generation_recovered",status:"queued",summary:"Stale implementation authority was superseded and a bounded evidence-backed continuation was created.",metadata:{taskId:current.id,previousStateVersion:current.stateVersion,previousCurrentCommit:oldCommit,newCurrentCommit:newCommit,failedStepId:failed.stepId,evidencePaths,continuationGenerationId:activeContinuation.generationId,continuationStepBudget:activeContinuation.maxSteps}});
    return{task:updated,idempotent:false,recovery:record};
  }
  async function recoverFocusedTestEvidence(taskId, input) {
    if (
      !input ||
      Object.keys(input).some((key) => key !== "expectedVersion") ||
      !Number.isInteger(input.expectedVersion)
    )
      throw new SelfDevelopmentError(
        "focused_test_evidence_recovery_invalid",
        "An exact task version is required.",
        400,
      );
    const current = await runtime.get(taskId);
    if (!current || current.taskType !== "self_development")
      throw new SelfDevelopmentError(
        "task_not_found",
        "Self-development task not found.",
        404,
      );
    if (current.stateVersion !== input.expectedVersion)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed before focused-test evidence recovery.",
      );
    const steps = await runtime.steps(current.id),
      failed = steps.find(
        (step) =>
          step.stepId === `${current.currentStep + 1}:plan_implementation` &&
          step.status === "failed" &&
          step.errorCode === "implementation_scope_violation" &&
          step.result?.diagnostics?.validationIssues?.some((issue) =>
            [
              "focused_test_evidence_required",
              "focused_test_evidence_rejected",
            ].includes(issue),
          ),
      ),
      approvals = await storage.listApprovals(ownerId, { limit: 100 }),
      unsafe =
        steps.some((step) =>
          [
            "apply_patch",
            "run_focused_tests",
            "run_full_tests",
            "commit",
            "review_commit",
            "push",
            "deploy_preview",
          ].includes(step.stepType),
        ) || approvals.some((approval) => approval.runId === current.id);
    if (
      current.status !== "failed" ||
      current.errorCode !== "implementation_scope_violation" ||
      !failed ||
      unsafe ||
      current.currentCommit !== current.startingCommit
    )
      throw new SelfDevelopmentError(
        "focused_test_evidence_recovery_precondition_failed",
        "Only the exact pre-mutation focused-test evidence failure may be recovered.",
      );
    const now = clock().toISOString(),
      updated = await storage.updateAutonomyTask(
        current.id,
        ownerId,
        {
          status: "queued",
          currentPhase: "focused_test_evidence_recovery",
          nextRunAt: now,
          startedAt: now,
          completedAt: null,
          errorCode: null,
          retryCount: 0,
          blockedReason: null,
          metadata: {
            ...current.metadata,
            requiredCapability: "reasoning",
            autoDispatch: true,
            focusedTestEvidenceRecoveryHistory: [
              ...(current.metadata.focusedTestEvidenceRecoveryHistory || []),
              {
                failedStepId: failed.stepId,
                previousStateVersion: current.stateVersion,
                recoveredAt: now,
              },
            ],
          },
        },
        current.stateVersion,
      );
    if (!updated)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed during focused-test evidence recovery.",
      );
    await storage.appendActivity({
      ownerId,
      projectId: current.projectId,
      runId: current.id,
      action: "self_development_focused_test_evidence_recovered",
      status: "queued",
      summary:
        "Exact pre-mutation focused-test evidence failure requeued for bounded expansion.",
      metadata: {
        taskId: current.id,
        failedStepId: failed.stepId,
        previousStateVersion: current.stateVersion,
      },
    });
    return { task: updated, recoveredStepId: failed.stepId };
  }
  async function recoverCreateConflict(taskId, input) {
    const allowed = new Set([
      "expectedVersion",
      "targetPath",
      "taskDiffHash",
      "workingTree",
    ]);
    if (
      !input ||
      Object.keys(input).some((key) => !allowed.has(key)) ||
      !Number.isInteger(input.expectedVersion) ||
      !Object.values(TASK_DIFF_DIGESTS).some((pattern) =>
        pattern.test(input.taskDiffHash || ""),
      ) ||
      input.workingTree?.clean !== true ||
      input.workingTree?.unrelatedChanges !== false
    )
      throw new SelfDevelopmentError(
        "create_conflict_recovery_invalid",
        "Exact version and clean task-owned worktree attestation are required.",
        400,
      );
    const targetPath = safePath(input.targetPath),
      current = await runtime.get(taskId);
    if (!current || current.taskType !== "self_development")
      throw new SelfDevelopmentError(
        "task_not_found",
        "Self-development task not found.",
        404,
      );
    const prior = current.metadata?.createConflictRecoveryHistory?.find(
      (item) =>
        item.fromStateVersion === input.expectedVersion &&
        item.targetPath === targetPath &&
        item.taskDiffHash === input.taskDiffHash,
    );
    if (prior)
      return { task: current, idempotent: true, recoveredPath: targetPath };
    if (current.stateVersion !== input.expectedVersion)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed before create-conflict recovery.",
      );
    const durableTaskDiff = taskDiffEvidence(
      current,
      targetPath,
      input.expectedVersion,
    );
    if (input.taskDiffHash.toLowerCase() !== durableTaskDiff.digest)
      throw new SelfDevelopmentError(
        "create_conflict_evidence_mismatch",
        "Caller task-diff evidence does not match the immutable durable evidence.",
      );
    const steps = await runtime.steps(current.id),
      approvals = await storage.listApprovals(ownerId, { limit: 100 }),
      implementation = current.metadata?.selfDevelopmentImplementationPlan,
      planned = implementation?.files?.find(
        (file) => file.path === targetPath && file.operation === "create",
      ),
      patch = steps.find(
        (step) =>
          step.stepType === "apply_patch" &&
          step.status === "completed" &&
          step.result?.files?.includes(targetPath),
      ),
      focused = steps.find(
        (step) =>
          step.stepType === "run_focused_tests" && step.status === "completed",
      ),
      failedFull = steps.find(
        (step) =>
          step.stepType === "run_full_tests" &&
          step.status === "failed" &&
          step.errorCode === "test_failed",
      ),
      delivery =
        steps.some((step) =>
          ["commit", "review_commit", "push", "deploy_preview"].includes(
            step.stepType,
          ),
        ) ||
        current.currentCommit !== current.startingCommit ||
        current.approvalState ||
        current.metadata?.lastDeploymentId ||
        current.metadata?.selfDevelopmentDeliveryAttestation ||
        approvals.some((approval) => approval.runId === current.id);
    if (
      current.status !== "failed" ||
      current.errorCode !== "test_failed" ||
      !planned ||
      !patch ||
      !focused ||
      !failedFull ||
      delivery
    )
      throw new SelfDevelopmentError(
        "create_conflict_recovery_precondition_failed",
        "Only the exact audited post-patch create-over-existing failure may be recovered.",
      );
    if (REPLAN_PROTECTED.test(targetPath) || !targetPath.startsWith("test/"))
      throw new SelfDevelopmentError(
        "create_conflict_recovery_scope_forbidden",
        "Recovery target is outside the bounded test scope.",
        403,
      );
    if (typeof resolvePathState !== "function")
      throw new SelfDevelopmentError(
        "create_conflict_recovery_unavailable",
        "Authoritative repository existence verification is unavailable.",
        503,
      );
    const pathState = await resolvePathState(targetPath, current.currentCommit);
    if (!pathState?.existsInCommit)
      throw new SelfDevelopmentError(
        "create_conflict_target_missing",
        "The create-conflict target does not exist in the bound commit.",
      );
    const candidates = [
        ...new Set([...(implementation.evidencePaths || []), targetPath]),
      ],
      base = current.metadata.steps.length,
      continuation = [];
    continuation.push(
      annotation(
        base + 1,
        "read_files",
        "repo_read_remote",
        {
          tool: "repo_read",
          arguments: { path: targetPath, startLine: 1, endLine: 1000 },
        },
        `Complete contents of ${targetPath}`,
        "Existing target is evidence-read before replanning",
        { retry: "safe_read" },
      ),
    );
    continuation.push(
      annotation(
        base + 2,
        "plan_implementation",
        "reasoning",
        {
          tool: "self_development_plan_implementation",
          arguments: {
            taskId: current.id,
            candidatePaths: candidates,
            currentCommit: current.currentCommit,
          },
        },
        "Nova-generated corrected implementation plan",
        "Planner receives authoritative existing-file evidence",
        { retry: "new_evidence_required" },
      ),
    );
    continuation.push(
      annotation(
        base + 3,
        "apply_patch",
        "repo_mutate_local",
        {
          tool: "repo_apply_patch",
          arguments: {
            branch: current.branch,
            currentCommit: "$CURRENT_COMMIT",
            files: "$IMPLEMENTATION_FILES",
          },
        },
        "Corrected bounded files changed",
        "Invalid create attempt is never replayed",
        { retry: "repair_required" },
      ),
    );
    continuation.push(
      annotation(
        base + 4,
        "run_focused_tests",
        "test_local",
        {
          tool: "test_run",
          arguments: { files: "$IMPLEMENTATION_TESTS", timeoutMs: 180000 },
        },
        "Focused test report",
        "Corrected focused tests pass",
        { retry: "repair_required" },
      ),
    );
    continuation.push(
      annotation(
        base + 5,
        "run_full_tests",
        "test_local",
        { tool: "test_run_full", arguments: { timeoutMs: 180000 } },
        "Full test report",
        "Complete suite passes",
        { retry: "repair_required" },
      ),
    );
    continuation.push(
      annotation(
        base + 6,
        "inspect_diff",
        "repo_read_remote",
        { tool: "repo_diff", arguments: { paths: "$IMPLEMENTATION_PATHS" } },
        "Complete bounded diff review",
        "Corrected diff is fully reviewed",
        { retry: "safe_read" },
      ),
    );
    continuation.push(
      annotation(
        base + 7,
        "commit",
        "repo_mutate_local",
        {
          tool: "git_commit",
          arguments: {
            paths: "$IMPLEMENTATION_PATHS",
            branch: current.branch,
            message: "Complete bounded Nova self-development task",
          },
        },
        "Exact local commit SHA",
        "One reviewed local commit created",
        { retry: "idempotent_commit" },
      ),
    );
    continuation.push(
      annotation(
        base + 8,
        "review_commit",
        "repo_read_remote",
        {
          tool: "repo_review_commit",
          arguments: {
            commitSha: "$CURRENT_COMMIT",
            paths: "$IMPLEMENTATION_PATHS",
          },
        },
        "Exact immutable commit review",
        "Commit matches the corrected reviewed change-set",
        { retry: "not_retryable" },
      ),
    );
    for (const step of plan({
      ...current.metadata.selfDevelopment,
      scope: {
        ...current.metadata.selfDevelopment.scope,
        patch: { files: [{ path: "placeholder", content: "placeholder" }] },
      },
    }).filter((step) =>
      [
        "push",
        "deploy_preview",
        "wait",
        "verify_preview",
        "summarize",
      ].includes(step.type),
    ))
      continuation.push({
        ...step,
        idempotencyIdentity: `self-development:${base + continuation.length + 1}:${hash([step.type, clean(step.input)])}`,
      });
    const now = clock().toISOString(),
      record = {
        recoveryClass: "post_patch_create_over_existing",
        fromStateVersion: current.stateVersion,
        targetPath,
        taskDiffHash: durableTaskDiff.digest,
        taskDiffEvidence: durableTaskDiff,
        priorPlanHash: implementation.planHash || null,
        priorPatchStepId: patch.stepId,
        priorFocusedStepId: focused.stepId,
        priorFailedStepId: failedFull.stepId,
        pathState: {
          exists: true,
          existsInCommit: true,
          discovered: (implementation.evidencePaths || []).includes(targetPath),
        },
        recoveredAt: now,
      };
    const updated = await storage.updateAutonomyTask(
      current.id,
      ownerId,
      {
        status: "queued",
        currentStep: base,
        currentPhase: "create_conflict_evidence_read",
        nextRunAt: now,
        startedAt: now,
        completedAt: null,
        errorCode: null,
        retryCount: 0,
        blockedReason: null,
        maxSteps: Math.min(
          100,
          base +
            continuation.length +
            (current.metadata.maxRepairIterations || 2) * 6,
        ),
        metadata: {
          ...current.metadata,
          steps: [...current.metadata.steps, ...continuation],
          requiredCapability: "repo_read_remote",
          autoDispatch: true,
          authoritativePathStates: {
            ...(current.metadata.authoritativePathStates || {}),
            [targetPath]: {
              exists: true,
              existsInCommit: true,
              commitSha: current.currentCommit,
            },
          },
          createConflictRecoveryHistory: [
            ...(current.metadata.createConflictRecoveryHistory || []),
            record,
          ],
        },
      },
      current.stateVersion,
    );
    if (!updated)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed during create-conflict recovery.",
      );
    await storage.appendActivity({
      ownerId,
      projectId: current.projectId,
      runId: current.id,
      action: "self_development_create_conflict_recovered",
      status: "queued",
      summary:
        "Audited create-over-existing attempt superseded; existing target scheduled for evidence read.",
      metadata: {
        taskId: current.id,
        targetPath,
        taskDiffHash: durableTaskDiff.digest,
        taskDiffAlgorithm: durableTaskDiff.algorithm,
        fromStateVersion: current.stateVersion,
        priorFailedStepId: failedFull.stepId,
      },
    });
    return {
      task: updated,
      idempotent: false,
      recoveredPath: targetPath,
      pathState: { exists: true, existsInCommit: true },
    };
  }
  async function recoverCreateConflictBudget(taskId, input) {
    if (
      !input ||
      Object.keys(input).some((key) => key !== "expectedVersion") ||
      !Number.isInteger(input.expectedVersion)
    )
      throw new SelfDevelopmentError(
        "create_conflict_budget_recovery_invalid",
        "An exact state version is required.",
        400,
      );
    const current = await runtime.get(taskId);
    if (!current || current.taskType !== "self_development")
      throw new SelfDevelopmentError(
        "task_not_found",
        "Self-development task not found.",
        404,
      );
    const priorBudgetRecovery =
      current.metadata?.createConflictBudgetRecoveryHistory?.find(
        (entry) => entry.fromStateVersion === input.expectedVersion,
      );
    if (priorBudgetRecovery)
      return { task: current, idempotent: true, maxSteps: current.maxSteps };
    if (current.stateVersion !== input.expectedVersion)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed before recovery-budget repair.",
      );
    const recovery = current.metadata?.createConflictRecoveryHistory?.at(-1),
      steps = await runtime.steps(current.id),
      approvals = await storage.listApprovals(ownerId, { limit: 100 }),
      postRecoveryExecution = steps.some((step) => {
        const index = Number.parseInt(step.stepId, 10);
        return Number.isInteger(index) && index > current.currentStep;
      }),
      delivery =
        steps.some((step) =>
          ["commit", "review_commit", "push", "deploy_preview"].includes(
            step.stepType,
          ),
        ) ||
        current.currentCommit !== current.startingCommit ||
        current.approvalState ||
        current.metadata?.lastDeploymentId ||
        current.metadata?.selfDevelopmentDeliveryAttestation ||
        approvals.some((approval) => approval.runId === current.id);
    if (
      current.status !== "failed" ||
      current.errorCode !== "max_steps_reached" ||
      current.currentPhase !== "create_conflict_evidence_read" ||
      !recovery ||
      recovery.recoveryClass !== "post_patch_create_over_existing" ||
      postRecoveryExecution ||
      delivery ||
      current.leaseOwner ||
      current.leaseToken ||
      current.leaseExpiresAt
    )
      throw new SelfDevelopmentError(
        "create_conflict_budget_recovery_precondition_failed",
        "Only the exact unexecuted post-create-conflict budget failure may be recovered.",
      );
    const repairLimit = Math.max(
        1,
        Math.min(3, current.metadata?.maxRepairIterations || 2),
      ),
      planLength = current.metadata.steps.length,
      maxSteps = Math.min(100, planLength + repairLimit * 6);
    if (maxSteps <= current.currentStep)
      throw new SelfDevelopmentError(
        "create_conflict_budget_exhausted",
        "The bounded recovery plan cannot fit within the safe step limit.",
      );
    const now = clock().toISOString(),
      record = {
        recoveryClass: "post_create_conflict_max_steps_reached",
        fromStateVersion: current.stateVersion,
        currentStep: current.currentStep,
        priorMaxSteps: current.maxSteps,
        planLength,
        repairLimit,
        maxSteps,
        recoveredAt: now,
      },
      updated = await storage.updateAutonomyTask(
        current.id,
        ownerId,
        {
          status: "queued",
          maxSteps,
          nextRunAt: now,
          completedAt: null,
          errorCode: null,
          blockedReason: null,
          retryCount: 0,
          metadata: {
            ...current.metadata,
            requiredCapability: "repo_read_remote",
            autoDispatch: true,
            createConflictBudgetRecoveryHistory: [
              ...(current.metadata.createConflictBudgetRecoveryHistory || []),
              record,
            ],
          },
        },
        current.stateVersion,
      );
    if (!updated)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed during recovery-budget repair.",
      );
    await storage.appendActivity({
      ownerId,
      projectId: current.projectId,
      runId: current.id,
      action: "self_development_create_conflict_budget_recovered",
      status: "queued",
      summary:
        "Persisted a bounded step budget for the pending create-conflict continuation.",
      metadata: record,
    });
    return { task: updated, idempotent: false, maxSteps };
  }
  async function recoverReview(taskId, input) {
    const current = await runtime.get(taskId);
    if (!current || current.taskType !== "self_development")
      throw new SelfDevelopmentError(
        "task_not_found",
        "Self-development task not found.",
        404,
      );
    if (
      current.status !== "waiting_for_approval" ||
      current.currentPhase !== "commit" ||
      current.approvalState?.approvalId !== input?.approvalId ||
      current.currentCommit !== input?.expectedCommit
    )
      throw new SelfDevelopmentError(
        "review_recovery_precondition_failed",
        "Exact waiting approval state does not match.",
      );
    const approval = await storage.getApproval(input.approvalId, ownerId),
      steps = await runtime.steps(current.id),
      incomplete = [...steps]
        .reverse()
        .find(
          (step) =>
            step.stepType === "inspect_diff" && step.status === "completed",
        );
    if (
      !approval ||
      approval.status !== "pending" ||
      approval.tool !== "git_push" ||
      approval.arguments?.commitSha !== current.currentCommit ||
      incomplete?.result?.reviewedChangeSet?.reviewHash
    )
      throw new SelfDevelopmentError(
        "review_recovery_precondition_failed",
        "Only an incomplete reviewed change-set may be recovered.",
      );
    await storage.decideApproval(approval.id, ownerId, "rejected");
    const paths = current.metadata.selfDevelopment.scope.patch.files.map(
        (file) => file.path,
      ),
      continuation = [
        annotation(
          current.currentStep + 1,
          "review_commit",
          "repo_read_remote",
          {
            tool: "repo_review_commit",
            arguments: { commitSha: current.currentCommit, paths },
          },
          "Exact committed change-set review",
          "Commit contains only fully reviewed bounded text files",
          { retry: "not_retryable" },
        ),
        ...plan(current.metadata.selfDevelopment).filter((step) =>
          [
            "push",
            "deploy_preview",
            "wait",
            "verify_preview",
            "summarize",
          ].includes(step.type),
        ),
      ],
      updated = await storage.updateAutonomyTask(
        current.id,
        ownerId,
        {
          status: "waiting_for_worker",
          approvalState: null,
          blockedReason: "Exact local commit review required.",
          metadata: {
            ...current.metadata,
            steps: [
              ...current.metadata.steps.slice(0, current.currentStep),
              ...continuation,
            ],
            requiredCapability: "repo_read_remote",
          },
        },
        current.stateVersion,
      );
    if (!updated)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed during review recovery.",
      );
    await storage.appendActivity({
      ownerId,
      projectId: current.projectId,
      runId: current.id,
      action: "self_development_review_recovery_started",
      status: "waiting",
      summary:
        "Incomplete pre-commit review invalidated; exact local commit review required.",
      metadata: {
        taskId: current.id,
        invalidatedApprovalId: approval.id,
        commitSha: current.currentCommit,
      },
    });
    return { task: updated, invalidatedApprovalId: approval.id };
  }
  async function supersedeCommit(taskId, input) {
    const current = await runtime.get(taskId);
    if (!current || current.taskType !== "self_development")
      throw new SelfDevelopmentError(
        "task_not_found",
        "Self-development task not found.",
        404,
      );
    if (
      current.status !== "waiting_for_approval" ||
      current.approvalState?.approvalId !== input?.approvalId ||
      current.currentCommit !== input?.supersededCommit ||
      !SHA.test(input?.baseCommit || "")
    )
      throw new SelfDevelopmentError(
        "commit_supersession_precondition_failed",
        "Exact waiting approval state does not match.",
      );
    const approval = await storage.getApproval(input.approvalId, ownerId);
    if (
      !approval ||
      approval.status !== "pending" ||
      approval.tool !== "git_push" ||
      approval.arguments?.branch !== current.branch ||
      approval.arguments?.commitSha !== current.currentCommit
    )
      throw new SelfDevelopmentError(
        "commit_supersession_precondition_failed",
        "Exact pending push approval does not match.",
      );
    const request = current.metadata.selfDevelopment,
      generated = plan(request),
      types = new Set([
        "apply_patch",
        "inspect_diff",
        "commit",
        "push",
        "deploy_preview",
        "wait",
        "verify_preview",
        "summarize",
      ]),
      continuation = generated.filter((step) => types.has(step.type)),
      commitIndex = continuation.findIndex((step) => step.type === "commit");
    continuation.splice(
      commitIndex + 1,
      0,
      annotation(
        current.currentStep + commitIndex + 2,
        "review_commit",
        "repo_read_remote",
        {
          tool: "repo_review_commit",
          arguments: {
            commitSha: "$CURRENT_COMMIT",
            paths: request.scope.patch.files.map((file) => file.path),
          },
        },
        "Exact committed change-set review",
        "Commit contains only the reviewed bounded change-set",
        { retry: "not_retryable" },
      ),
    );
    await storage.decideApproval(approval.id, ownerId, "rejected");
    const updated = await storage.updateAutonomyTask(
      current.id,
      ownerId,
      {
        status: "waiting_for_worker",
        currentCommit: input.baseCommit,
        approvalState: null,
        blockedReason:
          "Reviewed acceptance change must be recreated on the current feature history.",
        metadata: {
          ...current.metadata,
          steps: [
            ...current.metadata.steps.slice(0, current.currentStep),
            ...continuation,
          ],
          requiredCapability: "repo_mutate_local",
          supersededCommit: {
            sha: current.currentCommit,
            reason: "branch_history_safety",
            pushed: false,
          },
        },
      },
      current.stateVersion,
    );
    if (!updated)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed during commit supersession.",
      );
    await storage.appendActivity({
      ownerId,
      projectId: current.projectId,
      runId: current.id,
      action: "self_development_commit_superseded",
      status: "waiting",
      summary:
        "Unpushed acceptance commit superseded for branch-history safety.",
      metadata: {
        taskId: current.id,
        supersededCommit: current.currentCommit,
        baseCommit: input.baseCommit,
        invalidatedApprovalId: approval.id,
      },
    });
    return { task: updated, invalidatedApprovalId: approval.id };
  }
  async function attestDelivery(taskId, input) {
    if (!verifyRemote || !verifyDeployment)
      throw new SelfDevelopmentError(
        "attestation_unavailable",
        "Delivery attestation is unavailable.",
        503,
      );
    const allowed = new Set([
      "approvalId",
      "commitSha",
      "branch",
      "deploymentId",
      "deploymentUrl",
      "preCommitReviewHash",
      "finalCommitReviewHash",
    ]);
    if (
      !input ||
      Object.keys(input).some((key) => !allowed.has(key)) ||
      input.branch !== approvedBranch ||
      !SHA.test(input.commitSha || "") ||
      !REVIEW_HASH.test(input.preCommitReviewHash || "") ||
      !REVIEW_HASH.test(input.finalCommitReviewHash || "")
    )
      throw new SelfDevelopmentError(
        "delivery_attestation_invalid",
        "Exact delivery attestation with both review bindings is required.",
        400,
      );
    const current = await runtime.get(taskId),
      prior = current?.metadata?.selfDevelopmentDeliveryAttestation;
    if (
      prior &&
      prior.approvalId === input.approvalId &&
      prior.commitSha === input.commitSha &&
      prior.deploymentId === input.deploymentId &&
      prior.preCommitReviewHash === input.preCommitReviewHash &&
      prior.finalCommitReviewHash === input.finalCommitReviewHash
    )
      return { task: current, approvalId: input.approvalId, idempotent: true };
    const approval = await storage.getApproval(input.approvalId, ownerId);
    if (
      !current ||
      current.taskType !== "self_development" ||
      current.status !== "waiting_for_approval" ||
      current.currentCommit !== input.commitSha ||
      current.branch !== input.branch ||
      current.approvalState?.approvalId !== input.approvalId
    )
      throw new SelfDevelopmentError(
        "delivery_attestation_precondition_failed",
        "Exact task approval state does not match.",
      );
    if (
      !approval ||
      approval.status !== "pending" ||
      approval.runId !== current.id ||
      approval.tool !== "git_push" ||
      approval.arguments?.branch !== input.branch ||
      approval.arguments?.commitSha !== input.commitSha
    )
      throw new SelfDevelopmentError(
        "delivery_attestation_precondition_failed",
        "Exact pending approval does not match.",
      );
    const steps = await runtime.steps(current.id),
      commitIndex = steps.findLastIndex(
        (step) =>
          step.stepType === "commit" &&
          step.status === "completed" &&
          step.result?.commitSha === input.commitSha,
      ),
      preCommitReview = steps.findLast(
        (step, index) =>
          index < commitIndex &&
          step.stepType === "inspect_diff" &&
          step.status === "completed" &&
          step.result?.reviewedChangeSet?.reviewHash ===
            input.preCommitReviewHash,
      ),
      finalCommitReview = steps.findLast(
        (step, index) =>
          index > commitIndex &&
          step.stepType === "review_commit" &&
          step.status === "completed" &&
          step.result?.commitSha === input.commitSha &&
          step.result?.reviewedChangeSet?.reviewHash ===
            input.finalCommitReviewHash,
      );
    if (
      commitIndex < 0 ||
      steps[commitIndex]?.result?.reviewHash !== input.preCommitReviewHash ||
      !preCommitReview
    )
      throw new SelfDevelopmentError(
        "pre_commit_review_binding_mismatch",
        "Durable pre-commit review does not match.",
      );
    if (!finalCommitReview)
      throw new SelfDevelopmentError(
        "final_commit_review_binding_mismatch",
        "Durable immutable commit review does not match.",
      );
    if (
      current.metadata.steps[current.currentStep]?.type !== "push" ||
      current.metadata.steps[current.currentStep + 1]?.type !== "deploy_preview"
    )
      throw new SelfDevelopmentError(
        "delivery_attestation_precondition_failed",
        "Task is not at its exact delivery boundary.",
      );
    const remote = await verifyRemote({
      repository,
      branch: input.branch,
      requiredAncestors: [input.commitSha, DELIVERY_ATTESTATION_SHA],
    });
    if (
      !SHA.test(remote?.currentTip || "") ||
      remote?.ancestors?.[input.commitSha] !== true
    )
      throw new SelfDevelopmentError(
        "accepted_commit_ancestry_mismatch",
        "Accepted commit is not an exact ancestor of the live feature tip.",
      );
    if (remote?.ancestors?.[DELIVERY_ATTESTATION_SHA] !== true)
      throw new SelfDevelopmentError(
        "attestation_fix_ancestry_mismatch",
        "Delivery-attestation fix is not an exact ancestor of the live feature tip.",
      );
    const deployment = await verifyDeployment({
      deploymentId: input.deploymentId,
    });
    if (
      deployment?.target === "production" ||
      deployment?.id !== input.deploymentId ||
      deployment?.url !== input.deploymentUrl ||
      deployment?.sha !== input.commitSha ||
      deployment?.branch !== input.branch ||
      deployment?.status !== "READY"
    )
      throw new SelfDevelopmentError(
        "deployment_binding_mismatch",
        "Exact READY Preview does not match.",
      );
    await storage.decideApproval(approval.id, ownerId, "approved");
    const first = current.currentStep + 1,
      completed = [
        ...(current.checkpoint?.completedSteps || []),
        `${first}:push`,
        `${first + 1}:deploy_preview`,
      ],
      reviewBindings = {
        preCommitReviewHash: input.preCommitReviewHash,
        finalCommitReviewHash: input.finalCommitReviewHash,
      },
      result = {
        ok: true,
        attested: true,
        commitSha: input.commitSha,
        deploymentId: input.deploymentId,
        url: input.deploymentUrl,
        status: "READY",
        ...reviewBindings,
      };
    const attestation = {
      approvalId: input.approvalId,
      commitSha: input.commitSha,
      deploymentId: input.deploymentId,
      ...reviewBindings,
    };
    const updated = await storage.updateAutonomyTask(
      current.id,
      ownerId,
      {
        status: "queued",
        currentStep: current.currentStep + 2,
        currentPhase: "deploy_preview",
        nextRunAt: clock().toISOString(),
        approvalState: null,
        blockedReason: null,
        checkpoint: {
          ...current.checkpoint,
          completedSteps: completed,
          latestResult: result,
        },
        metadata: {
          ...current.metadata,
          requiredCapability: null,
          selfDevelopmentDeliveryAttestation: attestation,
        },
      },
      current.stateVersion,
    );
    if (!updated)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed during delivery attestation.",
      );
    for (const [offset, type] of [
      [0, "push"],
      [1, "deploy_preview"],
    ])
      await storage.recordAutonomyStep({
        taskId: current.id,
        stepId: `${first + offset}:${type}`,
        stepType: type,
        capability: "verified_delivery_attestation",
        operationFingerprint: hash([
          current.id,
          type,
          input.commitSha,
          input.deploymentId,
          ...Object.values(reviewBindings),
        ]),
        input: { attestation: true },
        status: "completed",
        result,
        completedAt: clock().toISOString(),
      });
    await storage.appendActivity({
      ownerId,
      projectId: current.projectId,
      runId: current.id,
      action: "self_development_delivery_attested",
      status: "completed",
      summary: "Verified the exact approved feature push and READY Preview.",
      metadata: {
        taskId: current.id,
        commitSha: input.commitSha,
        approvalId: input.approvalId,
        deploymentId: input.deploymentId,
        ...reviewBindings,
      },
    });
    return { task: updated, approvalId: approval.id, idempotent: false };
  }
  async function repair(taskId, input) {
    const current = await runtime.get(taskId);
    if (!current || current.taskType !== "self_development")
      throw new SelfDevelopmentError(
        "task_not_found",
        "Self-development task not found.",
        404,
      );
    const durableSteps = await runtime.steps(current.id),
      latestFocusedFailure = durableSteps
        .filter(
          (step) =>
            step.stepType === "run_focused_tests" &&
            step.status === "failed" &&
            step.errorCode === "test_failed",
        )
        .at(-1),
      focusedFailureOrdinal = stepOrdinal(latestFocusedFailure),
      deliveredAfterFocused = durableSteps.some(
        (step) =>
          stepOrdinal(step) > focusedFailureOrdinal &&
          ["commit", "review_commit", "push", "deploy_preview"].includes(
            step.stepType,
          ) &&
          step.status === "completed",
      ),
      legacyEmptyRepairCompletion =
        current.status === "completed" &&
        current.currentPhase === "inspect_failure" &&
        Boolean(latestFocusedFailure) &&
        !deliveredAfterFocused &&
        durableSteps.slice(-2).map((step) => step.stepType).join("|") ===
          "inspect_failure|summarize",
      priorEmptyRepairRecovery = (
        current.metadata?.continuationHistory || []
      ).some(
        (item) => item.recoveryClass === "focused_test_empty_repair_recovery",
      ),
      falseRepairBudgetConsumed =
        legacyEmptyRepairCompletion ||
        (current.status === "failed" &&
          current.errorCode === "repair_limit_reached" &&
          priorEmptyRepairRecovery),
      effectiveRepairIteration = falseRepairBudgetConsumed
        ? Math.max(0, current.repairIteration - 1)
        : current.repairIteration;
    if (
      !["failed", "retrying"].includes(current.status) &&
      !legacyEmptyRepairCompletion
    )
      throw new SelfDevelopmentError(
        "repair_state_invalid",
        "Task is not repairable.",
      );
    const evidence = boundedText(input?.evidence, "repair evidence", 4000),
      fingerprint = hash([current.currentStep, current.errorCode, evidence]);
    const history = current.metadata?.repairHistory || [],
      limit = current.metadata?.maxRepairIterations || 3;
    if (history.some((item) => item.fingerprint === fingerprint))
      throw new SelfDevelopmentError(
        "identical_repair_rejected",
        "Repeated repair requires new evidence.",
      );
    if (effectiveRepairIteration >= limit) {
      const stopped = await storage.updateAutonomyTask(
        current.id,
        ownerId,
        {
          status: "failed",
          errorCode: "repair_limit_reached",
          completedAt: clock().toISOString(),
        },
        current.stateVersion,
      );
      await storage.appendActivity({
        ownerId,
        projectId: current.projectId,
        runId: current.id,
        action: "self_development_repair_limit_reached",
        status: "failed",
        summary: "Self-development repair limit reached.",
        metadata: {
          taskId: current.id,
          repairIteration: current.repairIteration,
        },
      });
      return { task: stopped, repairLimitReached: true };
    }
    const repairRequest = structure({
        ...current.metadata.selfDevelopment,
        scope: {
          ...current.metadata.selfDevelopment.scope,
          patch: input.patch,
          focusedTests:
            input.focusedTests ||
            current.metadata.selfDevelopment.scope.focusedTests,
        },
      }),
      allowed =
        current.currentStep === 0
          ? [
              "inspect_repo",
              "search_code",
              "read_files",
              "plan_patch",
              "authorize_protected_change",
              "apply_patch",
              "run_focused_tests",
              "run_full_tests",
              "inspect_diff",
              "commit",
              "push",
              "deploy_preview",
              "wait",
              "verify_preview",
              "summarize",
            ]
          : [
              "authorize_protected_change",
              "apply_patch",
              "run_focused_tests",
              "run_full_tests",
              "inspect_diff",
              "commit",
              "push",
              "deploy_preview",
              "wait",
              "verify_preview",
              "summarize",
            ],
      activePlan = current.metadata?.selfDevelopmentImplementationPlan,
      focusedRepairSteps = latestFocusedFailure
        ? [
            { type: "plan_repair", input: { tool: "self_development_plan_implementation", arguments: { taskId: current.id, candidatePaths: (activePlan?.files || []).map((file) => file.path), currentCommit: "$CURRENT_COMMIT", failureEvidence: latestFocusedFailure.result?.diagnostics } }, idempotencyIdentity: `focused-test-repair-plan:${latestFocusedFailure.result?.diagnostics?.fingerprint}` },
            { type: "apply_patch", input: { tool: "repo_apply_patch", arguments: { branch: "$TASK_BRANCH", currentCommit: "$CURRENT_COMMIT", files: "$IMPLEMENTATION_FILES", planProvenance: "$IMPLEMENTATION_PLAN_PROVENANCE" } }, idempotencyIdentity: `focused-test-repair-patch:${latestFocusedFailure.result?.diagnostics?.fingerprint}` },
            { type: "run_focused_tests", input: { tool: "test_run", arguments: { files: "$IMPLEMENTATION_TESTS" } }, idempotencyIdentity: `focused-test-repair-focused:${latestFocusedFailure.result?.diagnostics?.fingerprint}` },
            { type: "run_full_tests", input: { tool: "test_run_full", arguments: {} }, idempotencyIdentity: `focused-test-repair-full:${latestFocusedFailure.result?.diagnostics?.fingerprint}` },
            { type: "inspect_diff", input: { tool: "repo_diff", arguments: { paths: "$IMPLEMENTATION_PATHS" } }, idempotencyIdentity: `focused-test-repair-diff:${latestFocusedFailure.result?.diagnostics?.fingerprint}` },
            { type: "commit", input: { tool: "git_commit", arguments: { paths: "$IMPLEMENTATION_PATHS", branch: current.branch, message: "Complete bounded Nova self-development task" } }, idempotencyIdentity: `focused-test-repair-commit:${latestFocusedFailure.result?.diagnostics?.fingerprint}` },
            { type: "review_commit", input: { tool: "repo_review_commit", arguments: { commitSha: "$CURRENT_COMMIT", paths: "$IMPLEMENTATION_PATHS" } }, idempotencyIdentity: `focused-test-repair-review:${latestFocusedFailure.result?.diagnostics?.fingerprint}` },
          ]
        : null,
      repairSteps = focusedRepairSteps || plan(repairRequest).filter((step) =>
        allowed.includes(step.type),
      ),
      prefix = latestFocusedFailure
        ? current.metadata.steps
        : current.metadata.steps.slice(0, current.currentStep),
      inspection = annotation(
        prefix.length + 1,
        "inspect_failure",
        "reasoning",
        { failureCode: current.errorCode, evidenceHash: fingerprint },
        "Failure evidence classified",
        "Repair decision uses new evidence",
        { retry: "not_retryable" },
      ),
      steps = [...prefix, inspection, ...repairSteps],
      continuationStart = prefix.length,
      now = clock().toISOString(),
      activeContinuation = latestFocusedFailure
        ? createActiveContinuation({ task: current, startStep: continuationStart, plannedSteps: repairSteps.length + 1, repairLimit: Math.min(2, current.metadata?.selfDevelopment?.repairLimit ?? 2), recoveryClass: legacyEmptyRepairCompletion ? "focused_test_empty_repair_recovery" : "structured_focused_test_repair", runtimeStartedAt: now, runtimeMinutes: 15 })
        : current.metadata?.activeContinuation;
    const updated = await storage.updateAutonomyTask(
      current.id,
      ownerId,
      {
        status: "queued",
        currentStep: latestFocusedFailure ? continuationStart : current.currentStep,
        currentPhase: latestFocusedFailure ? "plan_repair" : current.currentPhase,
        nextRunAt: now,
        errorCode: null,
        completedAt: null,
        retryCount: 0,
        repairIteration: effectiveRepairIteration + 1,
        metadata: {
          ...current.metadata,
          steps,
          requiredCapability: "reasoning",
          repairHistory: [
            ...history,
            {
              fingerprint,
              failureCode: current.errorCode,
              createdAt: clock().toISOString(),
            },
          ],
          ...(latestFocusedFailure
            ? {
                activeContinuation,
                continuationHistory: [
                  ...(current.metadata?.continuationHistory || []),
                  activeContinuation,
                ],
                autoDispatch: true,
                ...(falseRepairBudgetConsumed
                  ? {
                      focusedTestRepairBudgetRecoveryHistory: [
                        ...(current.metadata
                          ?.focusedTestRepairBudgetRecoveryHistory || []),
                        {
                          recoveryClass:
                            "empty_focused_repair_budget_reclassification",
                          fromStateVersion: current.stateVersion,
                          previousRepairIteration: current.repairIteration,
                          effectiveRepairIteration,
                          recoveredAt: now,
                        },
                      ],
                    }
                  : {}),
              }
            : {}),
        },
      },
      current.stateVersion,
    );
    if (!updated)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed during repair planning.",
      );
    await storage.appendActivity({
      ownerId,
      projectId: current.projectId,
      runId: current.id,
      action: "self_development_repair_started",
      status: "queued",
      summary: "Bounded self-development repair planned from new evidence.",
      metadata: {
        taskId: current.id,
        repairIteration: updated.repairIteration,
        evidenceHash: fingerprint,
      },
    });
    return { task: updated, repairLimitReached: false };
  }
  async function requestEscalatedRepair(taskId,input){
    if(!input||Object.keys(input).some(key=>key!=="expectedVersion")||!Number.isInteger(input.expectedVersion))throw new SelfDevelopmentError("escalated_repair_request_invalid","An exact state version is required.",400);
    const current=await runtime.get(taskId);if(!current||current.taskType!=="self_development")throw new SelfDevelopmentError("task_not_found","Self-development task not found.",404);
    if(current.stateVersion!==input.expectedVersion)throw new SelfDevelopmentError("version_conflict","Task changed before escalated-repair approval was requested.");
    const steps=await runtime.steps(current.id),focusedFailures=steps.filter(step=>step.stepType==="run_focused_tests"&&step.status==="failed"&&step.errorCode==="test_failed"),failed=focusedFailures.at(-1),ordinal=stepOrdinal(failed),diagnostics=failed?.result?.diagnostics,counts=diagnostics?.counts||{},plan=current.metadata?.selfDevelopmentImplementationPlan,activePaths=new Set((plan?.files||[]).map(file=>safePath(file.path))),failedFiles=[...(diagnostics?.failedFiles||[])].map(safePath),priorProgress=focusedFailures.slice(0,-1).some(step=>Number(step.result?.diagnostics?.counts?.failed)>Number(counts.failed)),delivered=steps.some(step=>stepOrdinal(step)>ordinal&&["commit","review_commit","push","deploy_preview"].includes(step.stepType)&&step.status==="completed"),limit=current.metadata?.maxRepairIterations||3,fingerprint=diagnostics?.fingerprint;
    if(current.status!=="failed"||current.errorCode!=="repair_limit_reached"||current.repairIteration<limit||!failed||ordinal!==current.currentStep+1||counts.failed!==1||!Number.isInteger(counts.tests)||counts.tests<2||counts.passed!==counts.tests-1||failedFiles.length!==1||!failedFiles.every(path=>activePaths.has(path))||!priorProgress||delivered||current.approvalState||current.leaseOwner||!fingerprint||!plan?.provenance||current.metadata?.activeImplementationPlanGeneration!==plan.provenance.generationId||plan.provenance.taskId!==current.id||plan.provenance.currentCommit!==current.currentCommit||current.metadata?.escalatedRepairHistory?.length)throw new SelfDevelopmentError("escalated_repair_precondition_failed","Only one narrowly bounded, progress-proven repair-limit exception may request approval.");
    const arguments_={taskId:current.id,expectedVersion:current.stateVersion,branch:current.branch,currentCommit:current.currentCommit,failedStepId:failed.stepId,failureFingerprint:fingerprint,planGenerationId:plan.provenance.generationId,maxAdditionalAttempts:1},existing=(await storage.listApprovals(ownerId,{limit:100})).find(item=>item.tool==="self_development_escalated_repair"&&item.arguments?.taskId===current.id&&item.arguments?.expectedVersion===current.stateVersion&&item.arguments?.failureFingerprint===fingerprint&&["pending","approved"].includes(item.status));if(existing)return{task:current,approval:existing,idempotent:true};
    const approval=await storage.createApproval({id:randomUUID(),ownerId,projectId:current.projectId,runId:null,tool:"self_development_escalated_repair",reason:"Owner approval is required for one exact, bounded Nova repair attempt after genuine repair-limit exhaustion.",riskLevel:"SENSITIVE",arguments:arguments_});
    await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_escalated_repair_approval_requested",status:"waiting",summary:"One exact additional Nova repair attempt requires owner approval.",metadata:{taskId:current.id,approvalId:approval.id,expectedVersion:current.stateVersion,failedStepId:failed.stepId,failureFingerprint:fingerprint,maxAdditionalAttempts:1}});return{task:current,approval,idempotent:false};
  }
  async function recoverEscalatedRepair(taskId,input){
    if(!input||Object.keys(input).some(key=>!["expectedVersion","approvalId"].includes(key))||!Number.isInteger(input.expectedVersion)||typeof input.approvalId!=="string")throw new SelfDevelopmentError("escalated_repair_recovery_invalid","Exact version and approval are required.",400);
    const current=await runtime.get(taskId);if(!current||current.taskType!=="self_development")throw new SelfDevelopmentError("task_not_found","Self-development task not found.",404);const prior=current.metadata?.escalatedRepairHistory?.find(item=>item.fromStateVersion===input.expectedVersion&&item.approvalId===input.approvalId);if(prior)return{task:current,recovery:prior,idempotent:true};if(current.stateVersion!==input.expectedVersion)throw new SelfDevelopmentError("version_conflict","Task changed before escalated repair recovery.");
    const approval=await storage.getApproval(input.approvalId,ownerId),steps=await runtime.steps(current.id),focusedFailures=steps.filter(step=>step.stepType==="run_focused_tests"&&step.status==="failed"&&step.errorCode==="test_failed"),failed=focusedFailures.at(-1),ordinal=stepOrdinal(failed),diagnostics=failed?.result?.diagnostics,counts=diagnostics?.counts||{},plan=current.metadata?.selfDevelopmentImplementationPlan,activePaths=new Set((plan?.files||[]).map(file=>safePath(file.path))),failedFiles=[...(diagnostics?.failedFiles||[])].map(safePath),priorProgress=focusedFailures.slice(0,-1).some(step=>Number(step.result?.diagnostics?.counts?.failed)>Number(counts.failed)),delivered=steps.some(step=>stepOrdinal(step)>ordinal&&["commit","review_commit","push","deploy_preview"].includes(step.stepType)&&step.status==="completed"),args=approval?.arguments||{},limit=current.metadata?.maxRepairIterations||3;
    if(!approval||approval.status!=="approved"||approval.tool!=="self_development_escalated_repair"||args.taskId!==current.id||args.expectedVersion!==current.stateVersion||args.branch!==current.branch||args.currentCommit!==current.currentCommit||args.failedStepId!==failed?.stepId||args.failureFingerprint!==diagnostics?.fingerprint||args.planGenerationId!==plan?.provenance?.generationId||args.maxAdditionalAttempts!==1||current.status!=="failed"||current.errorCode!=="repair_limit_reached"||current.repairIteration<limit||ordinal!==current.currentStep+1||counts.failed!==1||counts.passed!==counts.tests-1||failedFiles.length!==1||!failedFiles.every(path=>activePaths.has(path))||!priorProgress||delivered||current.approvalState||current.leaseOwner||current.metadata?.escalatedRepairHistory?.length)throw new SelfDevelopmentError("escalated_repair_recovery_precondition_failed","The approved repair-limit exception no longer matches the exact bounded failure.");
    assertActiveImplementationPlan(current,plan.files);const base=current.metadata.steps.length,repairSteps=[{type:"plan_repair",input:{tool:"self_development_plan_implementation",arguments:{taskId:current.id,candidatePaths:[...activePaths],currentCommit:"$CURRENT_COMMIT",failureEvidence:diagnostics}},idempotencyIdentity:`escalated-repair-plan:${diagnostics.fingerprint}`},{type:"apply_patch",input:{tool:"repo_apply_patch",arguments:{branch:"$TASK_BRANCH",currentCommit:"$CURRENT_COMMIT",files:"$IMPLEMENTATION_FILES",planProvenance:"$IMPLEMENTATION_PLAN_PROVENANCE"}},idempotencyIdentity:`escalated-repair-patch:${diagnostics.fingerprint}`},{type:"run_focused_tests",input:{tool:"test_run",arguments:{files:"$IMPLEMENTATION_TESTS"}},idempotencyIdentity:`escalated-repair-focused:${diagnostics.fingerprint}`},{type:"run_full_tests",input:{tool:"test_run_full",arguments:{}},idempotencyIdentity:`escalated-repair-full:${diagnostics.fingerprint}`},{type:"inspect_diff",input:{tool:"repo_diff",arguments:{paths:"$IMPLEMENTATION_PATHS"}},idempotencyIdentity:`escalated-repair-diff:${diagnostics.fingerprint}`},{type:"commit",input:{tool:"git_commit",arguments:{paths:"$IMPLEMENTATION_PATHS",branch:current.branch,message:"Complete bounded Nova self-development task"}},idempotencyIdentity:`escalated-repair-commit:${diagnostics.fingerprint}`},{type:"review_commit",input:{tool:"repo_review_commit",arguments:{commitSha:"$CURRENT_COMMIT",paths:"$IMPLEMENTATION_PATHS"}},idempotencyIdentity:`escalated-repair-review:${diagnostics.fingerprint}`}],now=clock().toISOString(),activeContinuation=createActiveContinuation({task:current,startStep:base,plannedSteps:repairSteps.length,repairLimit:1,recoveryClass:"owner_approved_single_repair_extension",runtimeStartedAt:now,runtimeMinutes:15}),record={recoveryClass:"owner_approved_single_repair_extension",fromStateVersion:current.stateVersion,approvalId:approval.id,failedStepId:failed.stepId,failureFingerprint:diagnostics.fingerprint,planGenerationId:plan.provenance.generationId,previousRepairIteration:current.repairIteration,globalRepairLimit:limit,maxAdditionalAttempts:1,recoveredAt:now},metadata={...current.metadata,steps:[...current.metadata.steps,...repairSteps],requiredCapability:"reasoning",autoDispatch:true,activeContinuation,continuationHistory:[...(current.metadata?.continuationHistory||[]),activeContinuation],escalatedRepairHistory:[record]};const updated=await storage.updateAutonomyTask(current.id,ownerId,{status:"queued",currentStep:base,currentPhase:"owner_approved_escalated_repair",nextRunAt:now,completedAt:null,errorCode:null,blockedReason:null,retryCount:0,metadata},current.stateVersion);if(!updated)throw new SelfDevelopmentError("version_conflict","Task changed during escalated repair recovery.");await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_escalated_repair_recovered",status:"queued",summary:"Owner-approved single additional Nova repair attempt started.",metadata:{taskId:current.id,...record}});return{task:updated,recovery:record,idempotent:false};
  }
  async function recoverFullTestHandoffOverflow(taskId,input){
    if(!input||Object.keys(input).some(key=>key!=="expectedVersion")||!Number.isInteger(input.expectedVersion))throw new SelfDevelopmentError("full_test_handoff_recovery_invalid","An exact state version is required.",400);const current=await runtime.get(taskId);if(!current||current.taskType!=="self_development")throw new SelfDevelopmentError("task_not_found","Self-development task not found.",404);const prior=current.metadata?.fullTestHandoffRecoveryHistory?.find(item=>item.fromStateVersion===input.expectedVersion);if(prior)return{task:current,recovery:prior,idempotent:true};if(current.stateVersion!==input.expectedVersion)throw new SelfDevelopmentError("version_conflict","Task changed before full-test handoff recovery.");
    const steps=await runtime.steps(current.id),failed=steps.filter(step=>step.stepType==="run_full_tests"&&step.status==="failed"&&step.errorCode==="handoff_failed").at(-1),failedOrdinal=stepOrdinal(failed),focused=steps.filter(step=>step.stepType==="run_focused_tests"&&step.status==="completed"&&stepOrdinal(step)<failedOrdinal).at(-1),delivered=steps.some(step=>stepOrdinal(step)>failedOrdinal&&["commit","review_commit","push","deploy_preview"].includes(step.stepType)&&step.status==="completed"),plan=current.metadata?.selfDevelopmentImplementationPlan,next=current.metadata?.steps?.[current.currentStep];if(current.status!=="failed"||current.errorCode!=="handoff_failed"||!failed||failedOrdinal!==current.currentStep+1||!focused||delivered||current.approvalState||current.leaseOwner||next?.type!=="run_full_tests"||!plan?.provenance||current.metadata?.activeImplementationPlanGeneration!==plan.provenance.generationId||plan.provenance.taskId!==current.id||plan.provenance.currentCommit!==current.currentCommit)throw new SelfDevelopmentError("full_test_handoff_recovery_precondition_failed","Only the exact post-focused, pre-delivery full-test handoff failure may be recovered.");assertActiveImplementationPlan(current,plan.files);
    const remaining=current.metadata.steps.slice(current.currentStep),base=current.metadata.steps.length;if(!remaining.length||remaining.length>8||remaining[0].type!=="run_full_tests")throw new SelfDevelopmentError("full_test_handoff_recovery_budget_exceeded","The remaining full-test continuation is not safely bounded.");const recoverySteps=remaining.map((step,index)=>({...step,idempotencyIdentity:`${step.idempotencyIdentity||step.type}:bounded-result-recovery:${base+index+1}`})),now=clock().toISOString(),activeContinuation=createActiveContinuation({task:current,startStep:base,plannedSteps:recoverySteps.length,repairLimit:0,recoveryClass:"full_test_result_envelope_recovery",runtimeStartedAt:now,runtimeMinutes:15}),record={recoveryClass:"full_test_result_envelope_recovery",fromStateVersion:current.stateVersion,failedStepId:failed.stepId,focusedStepId:focused.stepId,maxResultBytes:20000,recoveredAt:now},metadata={...current.metadata,steps:[...current.metadata.steps,...recoverySteps],requiredCapability:"test_local",autoDispatch:true,activeContinuation,continuationHistory:[...(current.metadata?.continuationHistory||[]),activeContinuation],fullTestHandoffRecoveryHistory:[...(current.metadata?.fullTestHandoffRecoveryHistory||[]),record]};const updated=await storage.updateAutonomyTask(current.id,ownerId,{status:"waiting_for_worker",currentStep:base,currentPhase:"full_test_handoff_recovery",nextRunAt:now,completedAt:null,errorCode:null,blockedReason:null,retryCount:0,metadata},current.stateVersion);if(!updated)throw new SelfDevelopmentError("version_conflict","Task changed during full-test handoff recovery.");await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_full_test_handoff_recovered",status:"waiting_for_worker",summary:"The bounded full-test completion envelope was reopened without another repair attempt.",metadata:{taskId:current.id,...record}});return{task:updated,recovery:record,idempotent:false};
  }
  async function recoverFullTestFailure(taskId,input){
    if(!input||Object.keys(input).some(key=>!["expectedVersion","workspace"].includes(key))||!Number.isInteger(input.expectedVersion))throw new SelfDevelopmentError("full_test_recovery_invalid","An exact state version and bounded workspace proof are required.",400);
    const current=await runtime.get(taskId);if(!current||current.taskType!=="self_development")throw new SelfDevelopmentError("task_not_found","Self-development task not found.",404);
    const prior=current.metadata?.fullTestFailureRecoveryHistory?.find(item=>item.fromStateVersion===input.expectedVersion);if(prior)return{task:current,idempotent:true,recovery:prior};
    if(current.stateVersion!==input.expectedVersion)throw new SelfDevelopmentError("version_conflict","Task changed before full-test recovery.");
    const workspace=input.workspace||{},root=String(workspace.root||"").replaceAll("\\","/").replace(/\/$/,""),top=String(workspace.gitTopLevel||"").replaceAll("\\","/").replace(/\/$/,""),changed=[...(workspace.changedPaths||[])].map(safePath).sort(),planned=(current.metadata?.selfDevelopmentImplementationPlan?.files||[]).map(file=>safePath(file.path)).sort(),steps=await runtime.steps(current.id),failed=steps.filter(step=>step.stepType==="run_full_tests"&&step.status==="failed").at(-1),focused=steps.some(step=>step.stepType==="run_focused_tests"&&step.status==="completed"),patched=steps.some(step=>step.stepType==="apply_patch"&&step.status==="completed"),delivered=steps.some(step=>["commit","review_commit","push","deploy_preview"].includes(step.stepType)&&step.status==="completed");
    if(current.status!=="failed"||current.errorCode!=="test_failed"||!failed||!focused||!patched||delivered||current.approvalState||current.leaseOwner||root!==top||!root||workspace.head!==currentCommit||changed.join("|")!==planned.join("|")||!/^[a-f0-9]{40}$/.test(workspace.taskDiffHash||""))throw new SelfDevelopmentError("full_test_recovery_precondition_failed","Only the exact task-owned post-full-test failure may be recovered.");
    const remote=await verifyRemote?.({repository,branch:current.branch,requiredAncestors:[current.currentCommit,currentCommit]});if(!remote||remote.currentTip!==currentCommit||remote.ancestors?.[current.currentCommit]!==true)throw new SelfDevelopmentError("full_test_recovery_ancestry_mismatch","The deployed commit is not a verified descendant of the task commit.");
    const failedOrdinal=Number.parseInt(failed.stepId,10),remaining=current.metadata.steps.slice(failedOrdinal),base=current.metadata.steps.length,recoverySteps=[{type:"run_full_tests",input:{tool:"test_run_full",arguments:{}},idempotencyIdentity:`full-test-diagnostic:${workspace.taskDiffHash}`},...remaining],now=clock().toISOString(),record={recoveryClass:"structured_full_test_evidence_reconstruction",fromStateVersion:current.stateVersion,previousCurrentCommit:current.currentCommit,currentCommit,failedStepId:failed.stepId,taskDiffHash:workspace.taskDiffHash,changedPaths:changed,recoveredAt:now};
    const metadata={...current.metadata,steps:[...current.metadata.steps,...recoverySteps],requiredCapability:"test_local",autoDispatch:true,activeContinuation:createActiveContinuation({task:current,startStep:base,plannedSteps:recoverySteps.length,repairLimit:Math.min(2,current.metadata?.selfDevelopment?.repairLimit??2),recoveryClass:record.recoveryClass,runtimeStartedAt:now,runtimeMinutes:15}),fullTestFailureRecoveryHistory:[...(current.metadata.fullTestFailureRecoveryHistory||[]),record]};
    const updated=await storage.updateAutonomyTask(current.id,ownerId,{status:"waiting_for_worker",currentStep:base,currentCommit,maxSteps:Math.min(100,Math.max(current.maxSteps,base+recoverySteps.length+4)),nextRunAt:now,completedAt:null,errorCode:null,blockedReason:null,retryCount:0,metadata},current.stateVersion);if(!updated)throw new SelfDevelopmentError("version_conflict","Task changed during full-test recovery.");
    await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_full_test_failure_recovered",status:"waiting_for_worker",summary:"Exact task-owned full-suite failure was requeued for structured diagnostic evidence.",metadata:record});return{task:updated,idempotent:false,recovery:record};
  }
  async function recoverTestRunnerInfrastructure(taskId,input){
    if(!input||Object.keys(input).some(key=>key!=="expectedVersion")||!Number.isInteger(input.expectedVersion))throw new SelfDevelopmentError("test_runner_recovery_invalid","An exact state version is required.",400);
    const current=await runtime.get(taskId);if(!current||current.taskType!=="self_development")throw new SelfDevelopmentError("task_not_found","Self-development task not found.",404);
    const prior=current.metadata?.testRunnerInfrastructureRecoveryHistory?.find(item=>item.fromStateVersion===input.expectedVersion);if(prior)return{task:current,idempotent:true,recovery:prior};
    if(current.stateVersion!==input.expectedVersion)throw new SelfDevelopmentError("version_conflict","Task changed before test-runner recovery.");
    const active=current.metadata?.activeContinuation,nextStep=current.metadata?.steps?.[current.currentStep],stuckReasoning=current.status==="waiting_for_worker"&&!current.errorCode&&current.currentPhase==="test_runner_infrastructure_recovery"&&active?.recoveryClass==="post_runner_repair_evidence_rebind"&&current.metadata?.requiredCapability==="reasoning"&&nextStep?.type==="plan_repair"&&!current.leaseOwner&&!current.leaseToken&&!current.approvalState;
    if(stuckReasoning){const now=clock().toISOString(),runtimeMinutes=15,runtimeWindow={runtimeStartedAt:now,runtimeMinutes,runtimeDeadline:new Date(new Date(now).getTime()+runtimeMinutes*60000).toISOString()},record={recoveryClass:"post_runner_reasoning_dispatch_rebind",fromStateVersion:current.stateVersion,continuationGenerationId:active.generationId,recoveredAt:now},metadata={...current.metadata,activeContinuation:{...active,...runtimeWindow},testRunnerInfrastructureRecoveryHistory:[...(current.metadata.testRunnerInfrastructureRecoveryHistory||[]),record]};const updated=await storage.updateAutonomyTask(current.id,ownerId,{status:"queued",nextRunAt:now,startedAt:now,metadata},current.stateVersion);if(!updated)throw new SelfDevelopmentError("version_conflict","Task changed during reasoning-dispatch recovery.");await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_reasoning_dispatch_recovered",status:"queued",summary:"The exact evidence-bound repair continuation was rebound to server reasoning dispatch.",metadata:{taskId:current.id,...record}});return{task:updated,idempotent:false,recovery:record};}
    const steps=await runtime.steps(current.id),failed=steps.filter(step=>step.stepType==="run_full_tests"&&step.status==="failed"&&step.errorCode==="test_failed").at(-1),latestFailed=steps.filter(step=>step.status==="failed").at(-1),evidence=failed?.result?.diagnostics,failedOrdinal=stepOrdinal(failed),latestFailedOrdinal=stepOrdinal(latestFailed),isNpmUnavailable=value=>value?.identity?.command==="npm:test"&&value?.durationMs===0&&value?.exitCode===1&&value?.stderrExcerpt==="spawn npm ENOENT"&&Array.isArray(value.failedFiles)&&value.failedFiles.length===0&&Array.isArray(value.failedTitles)&&value.failedTitles.length===0&&value?.counts&&Object.values(value.counts).every(item=>item===null),isGitUnavailable=value=>value?.identity?.command==="npm:test"&&value?.exitCode===1&&value?.errorMessage==="A validated Git executable is unavailable."&&value?.failedFiles?.includes("test/git-execution.test.js")&&value?.stdoutExcerpt?.includes("spawn git ENOENT"),isUnavailable=value=>isNpmUnavailable(value)||isGitUnavailable(value),history=current.metadata?.fullTestRepairHistory||[],matchingHistory=history.filter(item=>item.fingerprint===evidence?.fingerprint&&item.failedStepId===failed?.stepId),invalidHistory=history.filter(item=>item.fingerprint===evidence?.fingerprint&&steps.some(step=>step.stepId===item.failedStepId&&isUnavailable(step.result?.diagnostics))),plan=current.metadata?.selfDevelopmentImplementationPlan,latestFocused=steps.filter(step=>step.stepType==="run_focused_tests"&&step.status==="completed"&&stepOrdinal(step)<failedOrdinal).at(-1),focusedOrdinal=stepOrdinal(latestFocused),mutationAfterFocused=steps.some(step=>stepOrdinal(step)>focusedOrdinal&&stepOrdinal(step)<failedOrdinal&&((step.stepType==="apply_patch"&&step.status==="completed")||step.result?.mutationApplied===true||(["commit","push","deploy_preview"].includes(step.stepType)&&step.status==="completed"))),focused=Boolean(latestFocused)&&!mutationAfterFocused,direct=current.errorCode==="repair_limit_reached"&&latestFailed===failed&&failedOrdinal===current.currentStep+1&&isNpmUnavailable(evidence),contaminated=current.errorCode==="implementation_scope_violation"&&latestFailed?.stepType==="plan_repair"&&latestFailedOrdinal===current.currentStep+1&&latestFailed?.result?.diagnostics?.validationIssues?.includes("focused_test_evidence_required")&&failedOrdinal<latestFailedOrdinal&&isGitUnavailable(evidence),priorInfrastructureRecovery=(current.metadata?.testRunnerInfrastructureRecoveryHistory||[]).some(item=>item.recoveryClass==="test_runner_git_path_reclassification"&&item.fromStateVersion<current.stateVersion),repairEvidenceGap=current.errorCode==="implementation_scope_violation"&&latestFailed?.stepType==="plan_repair"&&latestFailedOrdinal===current.currentStep+1&&latestFailed?.result?.diagnostics?.validationIssues?.includes("focused_test_evidence_required")&&failedOrdinal<latestFailedOrdinal&&!isUnavailable(evidence)&&matchingHistory.length===1&&priorInfrastructureRecovery,delivered=steps.some(step=>["commit","review_commit","push","deploy_preview"].includes(step.stepType)&&step.status==="completed"&&stepOrdinal(step)>failedOrdinal);
    if(current.status!=="failed"||(!direct&&!contaminated&&!repairEvidenceGap)||!failed||(!repairEvidenceGap&&!invalidHistory.length)||!focused||delivered||current.approvalState||current.leaseOwner||!plan?.provenance||current.metadata?.activeImplementationPlanGeneration!==plan.provenance.generationId||plan.provenance.taskId!==current.id||plan.provenance.currentCommit!==current.currentCommit)throw new SelfDevelopmentError("test_runner_recovery_precondition_failed","Only an exact false repair-limit, contaminated repair plan, or its evidence-bound repair continuation may be recovered.");
    assertActiveImplementationPlan(current,plan.files);
    const invalidIds=new Set(invalidHistory.map(item=>item.failedStepId)),continuations=[...(current.metadata?.continuationHistory||[]),current.metadata?.activeContinuation].filter(Boolean),sourceContinuation=continuations.find(item=>item.startStep===failedOrdinal-1&&item.recoveryClass==="test_runner_unavailable_reclassification"),nextContinuationStart=sourceContinuation?Math.min(...continuations.map(item=>item.startStep).filter(start=>start>sourceContinuation.startStep)):Infinity,remainingEnd=contaminated&&Number.isFinite(nextContinuationStart)?nextContinuationStart:current.metadata.steps.length,remaining=repairEvidenceGap?current.metadata.steps.slice(latestFailedOrdinal-1):current.metadata.steps.slice(failedOrdinal,remainingEnd),base=current.metadata.steps.length,recoverySteps=repairEvidenceGap?remaining:[{type:"run_full_tests",input:{tool:"test_run_full",arguments:{}},idempotencyIdentity:`test-runner-infrastructure-recovery:${evidence.fingerprint}`},...remaining];
    if(recoverySteps.length>15)throw new SelfDevelopmentError("test_runner_recovery_budget_exceeded","The active test continuation exceeds its safe bound.");
    const now=clock().toISOString(),recoveryClass=repairEvidenceGap?"post_runner_repair_evidence_rebind":isGitUnavailable(evidence)?"test_runner_git_path_reclassification":"test_runner_unavailable_reclassification",activeContinuation=createActiveContinuation({task:current,startStep:base,plannedSteps:recoverySteps.length,repairLimit:Math.min(2,current.metadata?.selfDevelopment?.repairLimit??2),recoveryClass,runtimeStartedAt:now,runtimeMinutes:15}),record={recoveryClass,fromStateVersion:current.stateVersion,failedStepId:failed.stepId,terminalFailedStepId:latestFailed.stepId,fingerprint:evidence.fingerprint,retiredRepairHistoryStepIds:[...invalidIds],recoveredAt:now},metadata={...current.metadata,steps:[...current.metadata.steps,...recoverySteps],requiredCapability:repairEvidenceGap?"reasoning":"test_local",autoDispatch:true,fullTestRepairHistory:history.filter(item=>!invalidIds.has(item.failedStepId)),activeContinuation,continuationHistory:[...(current.metadata?.continuationHistory||[]),activeContinuation],testRunnerInfrastructureRecoveryHistory:[...(current.metadata?.testRunnerInfrastructureRecoveryHistory||[]),record]};
    const recoveryStatus=repairEvidenceGap?"queued":"waiting_for_worker",updated=await storage.updateAutonomyTask(current.id,ownerId,{status:recoveryStatus,currentStep:base,currentPhase:"test_runner_infrastructure_recovery",nextRunAt:now,startedAt:now,completedAt:null,errorCode:null,blockedReason:null,retryCount:0,metadata},current.stateVersion);if(!updated)throw new SelfDevelopmentError("version_conflict","Task changed during test-runner recovery.");
    await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_test_runner_infrastructure_recovered",status:"waiting_for_worker",summary:"A false repair-limit caused by unavailable npm execution was reclassified and the bounded full-test continuation reopened.",metadata:{taskId:current.id,...record}});return{task:updated,idempotent:false,recovery:record};
  }
  async function resumeFullTestContinuationRuntime(taskId,input){
    if(!input||Object.keys(input).some(key=>key!=="expectedVersion")||!Number.isInteger(input.expectedVersion))throw new SelfDevelopmentError("continuation_runtime_resume_invalid","An exact state version is required.",400);
    const current=await runtime.get(taskId);if(!current||current.taskType!=="self_development")throw new SelfDevelopmentError("task_not_found","Self-development task not found.",404);
    const prior=current.metadata?.continuationRuntimeResumeHistory?.find(item=>item.fromStateVersion===input.expectedVersion);if(prior)return{task:current,idempotent:true,runtimeWindow:prior.runtimeWindow};
    if(current.stateVersion!==input.expectedVersion)throw new SelfDevelopmentError("version_conflict","Task changed before continuation runtime repair.");
    const recovery=current.metadata?.fullTestFailureRecoveryHistory?.at(-1),steps=await runtime.steps(current.id),executedAfterRecovery=steps.some(step=>Number.parseInt(step.stepId,10)>current.currentStep),active=current.metadata?.activeContinuation;
    if(current.status!=="waiting_for_worker"||current.errorCode||!recovery||recovery.recoveryClass!=="structured_full_test_evidence_reconstruction"||!active||active.recoveryClass!==recovery.recoveryClass||executedAfterRecovery||current.leaseOwner||current.leaseToken||current.approvalState)throw new SelfDevelopmentError("continuation_runtime_resume_precondition_failed","Only the exact unclaimed recovered continuation may receive a fresh runtime window.");
    const now=clock().toISOString(),runtimeMinutes=15,runtimeWindow={runtimeStartedAt:now,runtimeMinutes,runtimeDeadline:new Date(new Date(now).getTime()+runtimeMinutes*60000).toISOString()},record={recoveryClass:"stale_task_runtime_to_active_continuation",fromStateVersion:current.stateVersion,continuationGenerationId:active.generationId,runtimeWindow,resumedAt:now},metadata={...current.metadata,activeContinuation:{...active,version:2,...runtimeWindow},continuationRuntimeResumeHistory:[...(current.metadata.continuationRuntimeResumeHistory||[]),record],requiredCapability:"test_local",autoDispatch:true};
    const updated=await storage.updateAutonomyTask(current.id,ownerId,{status:"waiting_for_worker",nextRunAt:now,blockedReason:null,errorCode:null,metadata},current.stateVersion);if(!updated)throw new SelfDevelopmentError("version_conflict","Task changed during continuation runtime repair.");
    await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_continuation_runtime_resumed",status:"waiting_for_worker",summary:"A fresh bounded runtime window was attached to the exact recovered continuation.",metadata:{taskId:current.id,...record}});return{task:updated,idempotent:false,runtimeWindow};
  }
  async function recoverDivergedApprovedDeliveryIntegration(taskId,input){
    const expected=HISTORICAL_DIVERGED_APPROVED_DELIVERY;
    if(!input||Object.keys(input).some(key=>key!=="expectedVersion")||input.expectedVersion!==expected.fromStateVersion)throw new SelfDevelopmentError("diverged_delivery_integration_recovery_invalid","The exact historical state version is required.",400);
    const current=await runtime.get(taskId);if(!current||current.taskType!=="self_development")throw new SelfDevelopmentError("task_not_found","Self-development task not found.",404);
    const prior=current.metadata?.divergedApprovedDeliveryIntegrationRecoveryHistory?.find(item=>item.fromStateVersion===input.expectedVersion);if(prior)return{task:current,recovery:prior,idempotent:true};
    if(current.stateVersion!==input.expectedVersion)throw new SelfDevelopmentError("version_conflict","Task changed before integration recovery.");
    const steps=await runtime.steps(current.id),approval=await storage.getApproval(expected.approvalId,ownerId),failed=steps.find(step=>step.stepId===expected.failedStepId),review=steps.find(step=>step.stepId===`${expected.currentStep}:review_commit`),reviewed=review?.result?.reviewedChangeSet,state=current.approvalState,runtimeState=current.metadata?.approvedDeliveryRuntime,paths=[...(reviewed?.allowedPaths||[])].map(safePath).sort(),expectedPaths=[...expected.allowedPaths].sort(),completedPush=steps.some(step=>step.stepType==="push"&&step.status==="completed"),laterStep=steps.some(step=>(stepOrdinal(step)||0)>expected.currentStep+1),approvalArgs=approval?.arguments||{};
    if(current.id!==expected.taskId||current.status!=="failed"||current.errorCode!=="push_failed"||current.stateVersion!==expected.fromStateVersion||current.currentStep!==expected.currentStep||current.currentCommit!==expected.secondParentSha||current.branch!==expected.branch||current.metadata?.selfDevelopment?.repository!==expected.repository||current.leaseOwner||current.leaseToken||failed?.stepType!=="push"||failed?.status!=="failed"||failed?.errorCode!=="push_failed"||failed?.attempt!==2||failed?.result?.message!=="Public push failed."||laterStep||completedPush||state?.approvalId!==expected.approvalId||state?.approved!==true||state?.commitSha!==expected.secondParentSha||state?.branch!==expected.branch||approval?.status!=="approved"||approval?.tool!=="git_push"||approvalArgs.repository!==expected.repository||approvalArgs.branch!==expected.branch||approvalArgs.commitSha!==expected.secondParentSha||runtimeState?.consumed===true||review?.status!=="completed"||review?.result?.commitSha!==expected.secondParentSha||reviewed?.commitSha!==expected.secondParentSha||reviewed?.reviewHash!==expected.reviewHash||paths.join("|")!==expectedPaths.join("|")||!Array.isArray(reviewed?.entries)||reviewed.entries.length!==expectedPaths.length||reviewed.entries.some(entry=>!expectedPaths.includes(safePath(entry.path))||entry.status!=="committed"||!SHA.test(entry.contentHash||"")))throw new SelfDevelopmentError("diverged_delivery_integration_recovery_precondition_failed","Only the exact unconsumed divergent approved delivery may enter integration review.");
    if(!verifyRemote)throw new SelfDevelopmentError("diverged_delivery_integration_verification_unavailable","Exact remote-tip verification is required.",503);
    const remote=await verifyRemote({repository:expected.repository,branch:expected.branch,requiredAncestors:[expected.minimumFirstParentSha]}),firstParentSha=remote?.currentTip;
    if(!SHA.test(firstParentSha||"")||remote?.ancestors?.[expected.minimumFirstParentSha]!==true||firstParentSha===expected.secondParentSha)throw new SelfDevelopmentError("diverged_delivery_integration_remote_changed","The feature branch tip is not a verified descendant of the approved integration-recovery infrastructure.");
    const base=current.metadata.steps.length;if(base!==expected.currentStep)throw new SelfDevelopmentError("diverged_delivery_integration_history_changed","The immutable task plan no longer ends at the reviewed boundary.");
    const continuation=[
      {type:"integrate_commit",input:{tool:"git_integrate_reviewed_commit",arguments:{branch:expected.branch,firstParentSha,secondParentSha:expected.secondParentSha,mergeBaseSha:expected.mergeBaseSha,message:"Integrate reviewed Nova composer change",paths:expected.allowedPaths,reviewedChangeSet:reviewed}},idempotencyIdentity:`integration:${firstParentSha}:${expected.secondParentSha}`},
      {type:"review_commit",input:{tool:"repo_review_commit",arguments:{commitSha:"$CURRENT_COMMIT",firstParentSha,secondParentSha:expected.secondParentSha,paths:expected.allowedPaths}},idempotencyIdentity:`integration-review:${firstParentSha}:${expected.secondParentSha}`},
      {type:"push",input:{tool:"git_push",arguments:{branch:expected.branch,commitSha:"$CURRENT_COMMIT"}},idempotencyIdentity:`integration-push:${firstParentSha}:${expected.secondParentSha}`},
    ],now=clock().toISOString(),activeContinuation=createActiveContinuation({task:current,startStep:base,plannedSteps:expected.maxContinuationSteps,repairLimit:0,recoveryClass:expected.recoveryClass,runtimeStartedAt:now,runtimeMinutes:expected.runtimeMinutes}),record={recoveryClass:expected.recoveryClass,fromStateVersion:current.stateVersion,toStateVersion:current.stateVersion+1,taskId:current.id,supersededApprovalId:expected.approvalId,supersededApprovalCommitSha:expected.secondParentSha,oldApprovalConsumed:false,firstParentSha,minimumFirstParentSha:expected.minimumFirstParentSha,secondParentSha:expected.secondParentSha,mergeBaseSha:expected.mergeBaseSha,reviewHash:expected.reviewHash,allowedPaths:expected.allowedPaths,maxContinuationSteps:expected.maxContinuationSteps,runtimeMinutes:expected.runtimeMinutes,recoveredAt:now},metadata={...current.metadata,steps:[...current.metadata.steps,...continuation],autoDispatch:true,requiredCapability:"repo_mutate_local",approvedDeliveryRuntime:null,activeContinuation,continuationHistory:[...(current.metadata?.continuationHistory||[]),activeContinuation],supersededDeliveryApproval:{approvalId:expected.approvalId,commitSha:expected.secondParentSha,reason:"branch_divergence_requires_integration_review",supersededAt:now},divergedApprovedDeliveryIntegrationRecoveryHistory:[...(current.metadata?.divergedApprovedDeliveryIntegrationRecoveryHistory||[]),record]};
    const updated=await storage.updateAutonomyTask(current.id,ownerId,{status:"waiting_for_worker",currentStep:base,currentPhase:"integrate_commit",nextRunAt:now,startedAt:now,completedAt:null,errorCode:null,blockedReason:"Waiting for deterministic reviewed integration.",approvalState:null,metadata,leaseOwner:null,leaseToken:null,leaseExpiresAt:null},current.stateVersion);if(!updated)throw new SelfDevelopmentError("version_conflict","Task changed during integration recovery.");
    await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_diverged_delivery_integration_recovered",status:"waiting_for_worker",summary:"The divergent approved delivery was retired and a deterministic integration review continuation opened.",metadata:{taskId:current.id,...record}});return{task:updated,recovery:record,idempotent:false};
  }
  return Object.freeze({
    structure,
    plan,
    create,
    get,
    repair,
    requestEscalatedRepair,
    recoverEscalatedRepair,
    recoverFullTestHandoffOverflow,
    recoverFullTestFailure,
    recoverTestRunnerInfrastructure,
    resumeFullTestContinuationRuntime,
    recoverDivergedApprovedDeliveryIntegration,
    replanDiscoveryOnly,
    recoverImplementationPlan,
    recoverImplementationSchema,
    recoverFocusedTestSchema,
    recoverStaleBasePatchConflict,
    recoverHandsCommitMismatch,
    recoverHandsWorkingTreeDirty,
    recoverRepositoryContextFailure,
    recoverPlanLifecycle,
    recoverFocusedTestEvidence,
    recoverCreateConflict,
    recoverCreateConflictBudget,
    recoverReview,
    supersedeCommit,
    attestDelivery,
  });
}

export const SELF_DEVELOPMENT_DEFAULTS = Object.freeze({
  repository: REPOSITORY,
  branch: BRANCH,
  maxRepairIterations: 3,
  runtimeBudgetMinutes: 60,
});
