import { timingSafeEqual } from "node:crypto";
const BRANCH = "feat/nova-brain-mvp-foundation",
  PLAN_VERSION = "worker-runtime-v1-live-continuation",
  SHA = /^[a-f0-9]{40}$/;
const STATUSES = new Set([
  "queued",
  "waiting",
  "waiting_for_worker",
  "blocked",
  "failed",
]);
export class TaskMigrationError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = "TaskMigrationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}
export function authorizeWorkerAdmin(request, token) {
  if (!token)
    throw new TaskMigrationError(
      "migration_not_allowed",
      "Worker administration is not configured.",
      503,
    );
  const header = String(request.headers?.authorization || ""),
    supplied = header.startsWith("Bearer ") ? header.slice(7) : "",
    left = Buffer.from(supplied),
    right = Buffer.from(token);
  if (left.length !== right.length || !timingSafeEqual(left, right))
    throw new TaskMigrationError(
      "unauthorized",
      "Worker administrator authorization is required.",
      401,
    );
  return { actorType: "scoped_server_admin" };
}
export function createTaskMigrationService({
  storage,
  ownerId,
  approvedBranch = BRANCH,
  clock = () => new Date(),
}) {
  async function inspect(taskId) {
    const task = await storage.getAutonomyTask(taskId, ownerId);
    if (!task)
      throw new TaskMigrationError("task_not_found", "Task not found.", 404);
    return sanitise(task);
  }
  async function migrate(input, actor = { actorType: "scoped_server_admin" }) {
    validate(input, approvedBranch);
    const task = await storage.getAutonomyTask(input.taskId, ownerId);
    if (!task)
      throw new TaskMigrationError("task_not_found", "Task not found.", 404);
    if (task.branch !== input.expectedBranch)
      throw new TaskMigrationError(
        "branch_mismatch",
        "Task branch does not match.",
      );
    if (
      task.metadata?.migrationPlanVersion === PLAN_VERSION &&
      task.currentCommit === input.targetCommit &&
      task.status !== "failed"
    )
      return { task: sanitise(task), idempotent: true };
    if (task.currentCommit !== input.expectedCommit)
      throw new TaskMigrationError(
        "commit_binding_mismatch",
        "Task commit binding does not match.",
      );
    if (!STATUSES.has(task.status))
      throw new TaskMigrationError(
        "task_state_mismatch",
        "Task state cannot be migrated.",
      );
    if(task.status==="failed"&&task.errorCode!=="invalid_handoff_result")
      throw new TaskMigrationError("task_state_mismatch","Only the bounded handoff protocol failure may be resumed by this migration.");
    if (task.leaseToken && new Date(task.leaseExpiresAt || 0) > clock())
      throw new TaskMigrationError(
        "active_lease_conflict",
        "Task has an active lease.",
      );
    if (!task.checkpoint?.completedSteps?.includes("1:inspect_repo"))
      throw new TaskMigrationError(
        "invalid_migration_plan",
        "Completed repository inspection is required.",
      );
    const plan=continuationPlan(input.targetCommit),next=plan[task.currentStep],requiredCapability=next?.type==="run_focused_tests"||next?.type==="run_full_tests"?"test_local":next?.type==="inspect_diff"?"repo_read_remote":"repo_mutate_local";
    const migrated = await storage.migrateAutonomyTask({
      taskId: input.taskId,
      ownerId,
      expectedVersion: task.stateVersion,
      expectedBranch: input.expectedBranch,
      expectedCommit: input.expectedCommit,
      targetCommit: input.targetCommit,
      runtimeMinutes: input.runtimeMinutes,
      plan,
      requiredCapability,
      planVersion: PLAN_VERSION,
      actorType: actor.actorType,
      oldRuntimeMinutes: task.maxRuntimeMinutes,
      oldPlanVersion: task.metadata?.migrationPlanVersion || null,
    });
    if (!migrated) {
      const latest = await storage.getAutonomyTask(input.taskId, ownerId);
      if (latest?.stateVersion !== task.stateVersion)
        throw new TaskMigrationError(
          "version_conflict",
          "Task version changed while migration was being applied.",
        );
      throw new TaskMigrationError(
        "task_state_mismatch",
        "Task changed while migration was being applied.",
      );
    }
    return { task: sanitise(migrated), idempotent: false };
  }
  return Object.freeze({ inspect, migrate, planVersion: PLAN_VERSION });
}
function validate(input, branch) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TaskMigrationError(
      "invalid_migration_plan",
      "Structured migration input is required.",
      400,
    );
  const allowed = new Set([
    "taskId",
    "migrationType",
    "expectedBranch",
    "expectedCommit",
    "targetCommit",
    "runtimeMinutes",
    "planVersion",
  ]);
  for (const key of Object.keys(input))
    if (!allowed.has(key))
      throw new TaskMigrationError(
        "migration_not_allowed",
        `Unsupported migration field: ${key}.`,
        400,
      );
  if (
    input.migrationType !== "repair_worker_runtime_v1_continuation" ||
    input.planVersion !== PLAN_VERSION
  )
    throw new TaskMigrationError(
      "migration_not_allowed",
      "Migration type or plan version is not allowlisted.",
      400,
    );
  if (
    input.expectedBranch !== branch ||
    ["main", "master"].includes(input.expectedBranch)
  )
    throw new TaskMigrationError(
      "production_target_forbidden",
      "Only the approved feature branch may be migrated.",
      403,
    );
  if (
    !SHA.test(input.expectedCommit || "") ||
    !SHA.test(input.targetCommit || "")
  )
    throw new TaskMigrationError(
      "invalid_migration_plan",
      "Exact commit SHAs are required.",
      400,
    );
  if (
    !Number.isInteger(input.runtimeMinutes) ||
    input.runtimeMinutes < 15 ||
    input.runtimeMinutes > 120
  )
    throw new TaskMigrationError(
      "invalid_migration_plan",
      "Runtime budget must be 15-120 minutes.",
      400,
    );
}
function continuationPlan(commit) {
  const marker = "docs/worker-runtime-live-acceptance.md";
  return [
    {
      type: "inspect_repo",
      input: {
        tool: "repo_list",
        arguments: { path: "src/autonomy", limit: 20 },
      },
    },
    {
      type: "apply_patch",
      input: {
        tool: "repo_apply_patch",
        arguments: {
          branch: BRANCH,
          files: [
            {
              path: marker,
              content: `# Worker Runtime live acceptance\n\nDurable capability handoff validated from ${commit}.\n`,
            },
          ],
        },
      },
    },
    {
      type: "run_focused_tests",
      input: {
        tool: "test_run",
        arguments: {
          files: [
            "test/worker-runtime.test.js",
            "test/storage.test.js",
            "test/api.test.js",
            "test/hands-runtime.test.js",
          ],
          timeoutMs: 180000,
        },
      },
    },
    {
      type: "run_full_tests",
      input: { tool: "test_run_full", arguments: { timeoutMs: 180000 } },
    },
    {
      type: "inspect_diff",
      input: { tool: "repo_diff", arguments: { paths: [marker] } },
    },
    {
      type: "commit",
      input: {
        tool: "git_commit",
        arguments: {
          branch: BRANCH,
          message: "Complete live Worker capability handoff",
          paths: [marker],
        },
      },
    },
    {
      type: "push",
      input: {
        tool: "git_push",
        arguments: { branch: BRANCH, commitSha: "$CURRENT_COMMIT" },
      },
    },
    {
      type: "deploy_preview",
      input: {
        tool: "preview_deploy",
        arguments: { branch: BRANCH, commitSha: "$CURRENT_COMMIT" },
      },
    },
    { type: "wait", input: { delayMs: 5000 } },
    {
      type: "verify_preview",
      input: {
        tool: "deployment_status",
        arguments: { commitSha: "$CURRENT_COMMIT" },
      },
    },
    {
      type: "summarize",
      input: { summary: "Worker Runtime V1 live capability handoff complete." },
    },
  ];
}
function sanitise(task) {
  return {
    ...task,
    metadata: {
      planVersion: task.metadata?.migrationPlanVersion || null,
      requiredCapability: task.metadata?.requiredCapability || null,
      stepCount: task.metadata?.steps?.length || 0,
    },
    leaseToken: task.leaseToken ? "[ACTIVE]" : null,
  };
}
