import { createHash } from "node:crypto";

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
export class SelfDevelopmentError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = "SelfDevelopmentError";
    this.code = code;
    this.statusCode = statusCode;
  }
}
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
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

export function createSelfDevelopmentService({
  runtime,
  storage,
  ownerId,
  approvedBranch = BRANCH,
  repository = REPOSITORY,
  currentCommit,
  verifyRemote,
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
    if (!["failed", "retrying"].includes(current.status))
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
    if (current.repairIteration >= limit) {
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
      repairSteps = plan(repairRequest).filter((step) =>
        allowed.includes(step.type),
      ),
      prefix = current.metadata.steps.slice(0, current.currentStep),
      inspection = annotation(
        prefix.length + 1,
        "inspect_failure",
        "reasoning",
        { failureCode: current.errorCode, evidenceHash: fingerprint },
        "Failure evidence classified",
        "Repair decision uses new evidence",
        { retry: "not_retryable" },
      ),
      steps = [...prefix, inspection, ...repairSteps];
    const updated = await storage.updateAutonomyTask(
      current.id,
      ownerId,
      {
        status: "queued",
        nextRunAt: clock().toISOString(),
        errorCode: null,
        completedAt: null,
        retryCount: 0,
        repairIteration: current.repairIteration + 1,
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
  return Object.freeze({
    structure,
    plan,
    create,
    get,
    repair,
    replanDiscoveryOnly,
    recoverImplementationPlan,
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
