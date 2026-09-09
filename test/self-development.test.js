import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";
import { createWorkerRuntime } from "../src/autonomy/worker-runtime.js";
import {
  createSelfDevelopmentService,
  isExactMissingBranchSchemaDiagnostic,
  resolveSemanticPlanApplyState,
  SELF_DEVELOPMENT_DEFAULTS,
} from "../src/autonomy/self-development.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import { registerSelfDevelopmentTools } from "../src/autonomy/self-development-tools.js";
import { ApprovalRequiredError } from "../src/policy/action-policy.js";
import { createAgent } from "../src/agent/agent.js";
import {bindImplementationPlan,planLifecycleMetadata} from "../src/autonomy/self-development-plan-lifecycle.js";

const OWNER = "owner",
  SHA = "a".repeat(40),
  NEW_SHA = "c".repeat(40),
  BRANCH = SELF_DEVELOPMENT_DEFAULTS.branch,
  DELIVERY_FIX = "58ab99b426fed92d8e36e8493718b4fc62935d08";
const input = (overrides = {}) => ({
  userGoal: "Improve a harmless developer document from natural language",
  startingCommit: SHA,
  acceptanceCriteria: [
    "Marker is updated",
    "Tests pass",
    "Preview health passes",
  ],
  scope: {
    paths: ["docs/self-development-live-acceptance.md"],
    searchTerms: ["self development"],
    patch: {
      files: [
        {
          path: "docs/self-development-live-acceptance.md",
          content: "# Self-Development V1 acceptance\n",
        },
      ],
    },
    focusedTests: ["test/self-development.test.js"],
  },
  ...overrides,
});

test("missing-branch recovery diagnostic accepts only the exact safe structural contract",()=>{
  const exact={tool:"repo_apply_patch",fieldPath:"repo_apply_patch.branch",validationCode:"required_field_missing",received:{type:"missing"}};
  exact.expected={type:"required"};assert.equal(isExactMissingBranchSchemaDiagnostic(exact),true);
  for(const changed of [{...exact,tool:"git_commit"},{...exact,fieldPath:"repo_apply_patch.files"},{...exact,validationCode:"invalid_type"},{...exact,received:{type:"string"}},null])assert.equal(isExactMissingBranchSchemaDiagnostic(changed),false);
});

test("missing-branch recovery accepts only the exact historical diagnostic with authoritative apply bridge context",()=>{
  const historical={expected:"required",received:"missing",fieldPath:"repo_apply_patch.branch",validationCode:"required_field_missing"},context={stepType:"apply_patch",templateTool:"repo_apply_patch"};
  assert.equal(isExactMissingBranchSchemaDiagnostic(historical,context),true);
  for(const changedContext of [{stepType:"run_full_tests",templateTool:"repo_apply_patch"},{stepType:"apply_patch",templateTool:"git_commit"},{}])assert.equal(isExactMissingBranchSchemaDiagnostic(historical,changedContext),false);
  for(const changed of [{...historical,expected:"object"},{...historical,received:"string"},{...historical,fieldPath:"repo_apply_patch.files"},{...historical,validationCode:"invalid_type"}])assert.equal(isExactMissingBranchSchemaDiagnostic(changed,context),false);
});
async function fixture({
  capabilities,
  execute,
  verifyRemote,
  compareRemoteEvidence,
  verifyDeployment,
  currentCommit = SHA,
} = {}) {
  let now = new Date("2026-01-01T00:00:00Z");
  const storage = createInMemoryStorage({ clock: () => new Date(now) });
  await storage.initialize({
    owner: { id: OWNER, fullName: "Owner" },
    projects: [{ id: "nova-brain", name: "Nova" }],
  });
  const calls = [],
    toolRegistry = {
      async execute(name, args, context) {
        calls.push({ name, args, context });
        if (execute) return execute(name, args, context);
        if (name === "git_commit")
          return { ok: true, commitSha: "b".repeat(40) };
        if (name === "preview_deploy")
          return {
            ok: true,
            deploymentId: "dpl_self",
            url: "self.preview",
            status: "READY",
          };
        return { ok: true, name };
      },
    };
  const runtime = createWorkerRuntime({
    storage,
    ownerId: OWNER,
    toolRegistry,
    clock: () => new Date(now),
    workerId: "self-worker",
    capabilities: capabilities || [
      "repo_read_remote",
      "reasoning",
      "repo_mutate_local",
      "test_local",
      "github_write",
      "vercel_preview",
      "scheduler",
    ],
    approvedBranch: BRANCH,
  });
  const service = createSelfDevelopmentService({
    runtime,
    storage,
    ownerId: OWNER,
    currentCommit,
    clock: () => new Date(now),
    verifyRemote,
    compareRemoteEvidence,
    verifyDeployment,
  });
  return {
    storage,
    runtime,
    service,
    calls,
    advance(ms) {
      now = new Date(now.getTime() + ms);
    },
  };
}
const rejects = (promise, code) =>
  assert.rejects(promise, (error) => error.code === code);

test("natural-language request becomes a structured self-development task", async () => {
  const f = await fixture(),
    value = f.service.structure(input());
  assert.equal(value.kind, "self_development_task");
  assert.match(value.userGoal, /natural language/);
});
test("target repository and feature branch are bound by default", async () => {
  const f = await fixture(),
    value = f.service.structure(input());
  assert.equal(value.repository, "hshanbour/nova-brain");
  assert.equal(value.targetBranch, BRANCH);
});
test("real chat-style goal resolves deployed commit project branch and safe defaults", async () => {
  const f = await fixture(),
    created = await f.service.create({
      userGoal: "Improve composer dictation infrastructure",
      targetProject: "nova-test-project",
    });
  assert.equal(created.task.projectId, "nova-brain");
  assert.equal(created.task.branch, BRANCH);
  assert.equal(created.task.startingCommit, SHA);
  assert.equal(created.task.status, "queued");
  assert.ok(created.request.acceptanceCriteria.length);
  assert.equal(
    created.plan.some((step) => step.type === "apply_patch"),
    false,
  );
});
test("identical chat create retries return the same durable task", async () => {
  const f = await fixture(),
    request = { userGoal: "Inspect one harmless integration improvement" },
    first = await f.service.create(request),
    retry = await f.service.create(request);
  assert.equal(first.idempotent, false);
  assert.equal(retry.idempotent, true);
  assert.equal(retry.task.id, first.task.id);
  assert.equal((await f.storage.listAutonomyTasks(OWNER)).length, 1);
});
test("known Nova project aliases resolve but unrelated projects fail before Postgres", async () => {
  const f = await fixture();
  for (const targetProject of [
    "nova-brain",
    "Nova Brain",
    "hshanbour/nova-brain",
    "nova-test-project",
  ])
    assert.equal(
      f.service.structure({ userGoal: "Inspect", targetProject }).targetProject,
      "nova-brain",
    );
  assert.throws(
    () =>
      f.service.structure({ userGoal: "Inspect", targetProject: "sharp-cuts" }),
    (error) => error.code === "project_not_found",
  );
});
test("malformed chat scope and budgets fail with structured codes", async () => {
  const f = await fixture();
  assert.throws(
    () => f.service.structure({ userGoal: "Inspect", scope: { paths: "src" } }),
    (error) => error.code === "invalid_scope",
  );
  assert.throws(
    () =>
      f.service.structure({ userGoal: "Inspect", runtimeBudgetMinutes: 14 }),
    (error) => error.code === "invalid_runtime_budget",
  );
  assert.throws(
    () => f.service.structure({ userGoal: "Inspect", maxRepairIterations: 4 }),
    (error) => error.code === "invalid_repair_limit",
  );
});
test("main is rejected", async () => {
  const f = await fixture();
  assert.throws(
    () => f.service.structure(input({ targetBranch: "main" })),
    (e) => e.code === "branch_not_allowed",
  );
});
test("master is rejected", async () => {
  const f = await fixture();
  assert.throws(
    () => f.service.structure(input({ targetBranch: "master" })),
    (e) => e.code === "branch_not_allowed",
  );
});
test("Production is rejected", async () => {
  const f = await fixture();
  assert.throws(
    () => f.service.structure(input({ environment: "production" })),
    (e) => e.code === "production_target_forbidden",
  );
});
test("another repository is rejected", async () => {
  const f = await fixture();
  assert.throws(
    () => f.service.structure(input({ repository: "hshanbour/other" })),
    (e) => e.code === "repository_not_resolved",
  );
});
test("repository inspection and search occur before mutation", async () => {
  const f = await fixture(),
    plan = f.service.plan(f.service.structure(input())),
    patch = plan.findIndex((x) => x.type === "apply_patch");
  assert.ok(plan.findIndex((x) => x.type === "inspect_repo") < patch);
  assert.ok(plan.findIndex((x) => x.type === "search_code") < patch);
});
test("repository inspection uses the valid Hands root and does not read a new patch target", async () => {
  const f = await fixture(),
    plan = f.service.plan(f.service.structure(input()));
  assert.equal(plan[0].input.arguments.path, ".");
  assert.equal(
    plan.some(
      (x) =>
        x.type === "read_files" &&
        x.input.arguments.path === "docs/self-development-live-acceptance.md",
    ),
    false,
  );
});
test("planner emits bounded contracts for every step", async () => {
  const f = await fixture(),
    plan = f.service.plan(f.service.structure(input()));
  assert.ok(plan.length < 100);
  assert.ok(
    plan.every(
      (x) =>
        x.capability &&
        x.expectedOutput &&
        x.successCondition &&
        x.retryClassification &&
        x.idempotencyIdentity,
    ),
  );
});
test("planner reuses only safe Hands tool names", async () => {
  const f = await fixture(),
    names = f.service
      .plan(f.service.structure(input()))
      .map((x) => x.input?.tool)
      .filter(Boolean);
  for (const name of names)
    assert.ok(
      [
        "repo_list",
        "repo_search",
        "repo_read",
        "repo_apply_patch",
        "test_run",
        "test_run_full",
        "repo_diff",
        "git_commit",
        "git_push",
        "preview_deploy",
        "preview_verify",
        "self_development_protected_change",
      ].includes(name),
    );
});
test("Worker Runtime is the durable task system", async () => {
  const f = await fixture(),
    created = await f.service.create(input());
  assert.equal(created.task.taskType, "self_development");
  assert.equal((await f.runtime.get(created.task.id)).id, created.task.id);
});
test("bounded patch includes only declared files", async () => {
  const f = await fixture(),
    request = f.service.structure(input()),
    step = f.service.plan(request).find((x) => x.type === "apply_patch");
  assert.deepEqual(step.input.arguments.files, request.scope.patch.files);
});
test("focused tests are planned", async () => {
  const f = await fixture(),
    step = f.service
      .plan(f.service.structure(input()))
      .find((x) => x.type === "run_focused_tests");
  assert.deepEqual(step.input.arguments.files, [
    "test/self-development.test.js",
  ]);
});
test("full tests are planned", async () => {
  const f = await fixture();
  assert.equal(
    f.service
      .plan(f.service.structure(input()))
      .filter((x) => x.type === "run_full_tests").length,
    1,
  );
});
test("diff inspection is file-scoped", async () => {
  const f = await fixture(),
    step = f.service
      .plan(f.service.structure(input()))
      .find((x) => x.type === "inspect_diff");
  assert.deepEqual(step.input.arguments.paths, [
    "docs/self-development-live-acceptance.md",
  ]);
});
test("local commit is branch and path bound", async () => {
  const f = await fixture(),
    step = f.service
      .plan(f.service.structure(input()))
      .find((x) => x.type === "commit");
  assert.equal(step.input.arguments.branch, BRANCH);
  assert.deepEqual(step.input.arguments.paths, [
    "docs/self-development-live-acceptance.md",
  ]);
});
test("push requests exact current commit approval", async () => {
  const f = await fixture(),
    step = f.service
      .plan(f.service.structure(input()))
      .find((x) => x.type === "push");
  assert.equal(step.approvalRequired, true);
  assert.equal(step.input.arguments.commitSha, "$CURRENT_COMMIT");
});
test("Preview verification is terminal-gated and exact-commit bound", async () => {
  const f = await fixture(),
    plan = f.service.plan(f.service.structure(input())),
    verify = plan.find((x) => x.type === "verify_preview");
  assert.equal(verify.input.arguments.commitSha, "$CURRENT_COMMIT");
  assert.equal(verify.input.arguments.deploymentId, "$DEPLOYMENT_ID");
  assert.ok(
    plan.indexOf(verify) < plan.findIndex((x) => x.type === "summarize"),
  );
});
test("new commit placeholders prevent stale approval reuse", async () => {
  const f = await fixture(),
    plan = f.service.plan(f.service.structure(input()));
  assert.equal(
    plan.find((x) => x.type === "push").input.arguments.commitSha,
    "$CURRENT_COMMIT",
  );
  assert.equal(
    plan.find((x) => x.type === "deploy_preview").input.arguments.commitSha,
    "$CURRENT_COMMIT",
  );
});
test("recoverable failure gets one evidence-based repair plan", async () => {
  const f = await fixture(),
    created = await f.service.create(input());
  let failed = await f.storage.updateAutonomyTask(created.task.id, OWNER, {
    status: "failed",
    errorCode: "test_failed",
  });
  const result = await f.service.repair(failed.id, {
    evidence: "Focused assertion changed after inspected output",
    patch: input().scope.patch,
    focusedTests: input().scope.focusedTests,
  });
  assert.equal(result.task.repairIteration, 1);
  assert.equal(result.task.status, "queued");
  assert.equal(
    result.task.metadata.steps[result.task.currentStep].type,
    "inspect_failure",
  );
});
test("a step-zero planner failure repairs the same task by reinspecting before mutation", async () => {
  const f = await fixture(),
    created = await f.service.create(input());
  await f.storage.updateAutonomyTask(created.task.id, OWNER, {
    status: "failed",
    errorCode: "invalid_input",
  });
  const result = await f.service.repair(created.task.id, {
      evidence: "Hands requires the normalized repository root",
      patch: input().scope.patch,
      focusedTests: input().scope.focusedTests,
    }),
    tail = result.task.metadata.steps.slice(result.task.currentStep);
  assert.equal(result.task.id, created.task.id);
  assert.ok(
    tail.findIndex((x) => x.type === "inspect_repo") <
      tail.findIndex((x) => x.type === "apply_patch"),
  );
  assert.equal(
    tail.find((x) => x.type === "inspect_repo").input.arguments.path,
    ".",
  );
});
test("identical failed repair evidence cannot repeat", async () => {
  const f = await fixture(),
    created = await f.service.create(input()),
    args = {
      evidence: "Same bounded evidence",
      patch: input().scope.patch,
      focusedTests: input().scope.focusedTests,
    };
  await f.storage.updateAutonomyTask(created.task.id, OWNER, {
    status: "failed",
    errorCode: "test_failed",
  });
  await f.service.repair(created.task.id, args);
  await f.storage.updateAutonomyTask(created.task.id, OWNER, {
    status: "failed",
    errorCode: "test_failed",
  });
  await rejects(
    f.service.repair(created.task.id, args),
    "identical_repair_rejected",
  );
});
test("repair limit stops safely", async () => {
  const f = await fixture(),
    created = await f.service.create(input({ maxRepairIterations: 1 }));
  await f.storage.updateAutonomyTask(created.task.id, OWNER, {
    status: "failed",
    errorCode: "test_failed",
    repairIteration: 1,
  });
  const result = await f.service.repair(created.task.id, {
    evidence: "New evidence",
    patch: input().scope.patch,
  });
  assert.equal(result.repairLimitReached, true);
  assert.equal(result.task.errorCode, "repair_limit_reached");
});
test("protected runtime changes are high risk", async () => {
  const f = await fixture(),
    value = f.service.structure(
      input({
        scope: {
          ...input().scope,
          paths: ["src/autonomy/worker-runtime.js"],
          patch: {
            files: [
              { path: "src/autonomy/worker-runtime.js", content: "bounded" },
            ],
          },
        },
      }),
    );
  assert.equal(value.riskLevel, "high");
});
test("protected changes require exact strong approval before patch", async () => {
  const f = await fixture(),
    plan = f.service.plan(
      f.service.structure(
        input({
          scope: {
            ...input().scope,
            paths: ["src/policy/action-policy.js"],
            patch: {
              files: [
                { path: "src/policy/action-policy.js", content: "bounded" },
              ],
            },
          },
        }),
      ),
    ),
    guard = plan.findIndex((x) => x.type === "authorize_protected_change"),
    patch = plan.findIndex((x) => x.type === "apply_patch");
  assert.ok(guard >= 0 && guard < patch);
  assert.equal(plan[guard].approvalRequired, true);
});
test("approval enforcement cannot be silently disabled", async () => {
  const f = await fixture(),
    plan = f.service.plan(
      f.service.structure(
        input({
          scope: {
            ...input().scope,
            paths: ["src/policy/action-policy.js"],
            patch: {
              files: [
                {
                  path: "src/policy/action-policy.js",
                  content: "disable approvals",
                },
              ],
            },
          },
        }),
      ),
    );
  assert.equal(
    plan.some((x) => x.input?.tool === "self_development_protected_change"),
    true,
  );
});
test("secrets are redacted from durable request metadata", async () => {
  const f = await fixture(),
    created = await f.service.create({
      ...input(),
      apiToken: "never",
      scope: { ...input().scope, metadata: { secret: "never" } },
    });
  assert.doesNotMatch(
    JSON.stringify(await f.runtime.get(created.task.id)),
    /"never"/,
  );
});
test("task survives runtime restart through durable storage", async () => {
  const f = await fixture(),
    created = await f.service.create(input()),
    runtime = createWorkerRuntime({
      storage: f.storage,
      ownerId: OWNER,
      toolRegistry: { execute: async () => ({ ok: true }) },
      capabilities: ["repo_read_remote", "reasoning"],
      approvedBranch: BRANCH,
    }),
    service = createSelfDevelopmentService({
      runtime,
      storage: f.storage,
      ownerId: OWNER,
    });
  assert.equal((await service.get(created.task.id)).task.id, created.task.id);
});
test("completed step replay is idempotent", async () => {
  const f = await fixture(),
    created = await f.service.create(input());
  await f.runtime.tickTask(created.task.id, { idempotencyKey: "one" });
  await f.storage.updateAutonomyTask(created.task.id, OWNER, {
    status: "queued",
    currentStep: 0,
    nextRunAt: "2026-01-01T00:00:00Z",
  });
  const replay = await f.runtime.tickTask(created.task.id, {
    idempotencyKey: "two",
  });
  assert.equal(replay.idempotent, true);
  assert.equal(
    (await f.runtime.steps(created.task.id)).filter(
      (x) => x.stepId === "1:inspect_repo",
    ).length,
    1,
  );
});
test("Self-Development Activity is complete and secret-free", async () => {
  const f = await fixture(),
    created = await f.service.create(input()),
    activity = await f.storage.listActivity(OWNER, {
      runId: created.task.id,
      limit: 20,
    }),
    actions = activity.map((x) => x.action);
  assert.ok(actions.includes("self_development_request_received"));
  assert.ok(actions.includes("self_development_scope_resolved"));
  assert.ok(actions.includes("self_development_plan_created"));
  assert.doesNotMatch(JSON.stringify(activity), /token|password.*never/i);
});
test("terminal completion cannot precede Preview verification", async () => {
  const f = await fixture(),
    created = await f.service.create(input());
  const verifyIndex = created.plan.findIndex(
    (x) => x.type === "verify_preview",
  );
  await f.storage.updateAutonomyTask(created.task.id, OWNER, {
    status: "queued",
    currentStep: verifyIndex,
  });
  assert.notEqual((await f.runtime.get(created.task.id)).status, "completed");
});
test("task-bound self-development execution does not advance another task", async () => {
  const f = await fixture(),
    requested = await f.service.create(input()),
    other = await f.service.create(input({ userGoal: "Another goal" }));
  await f.runtime.tickTask(requested.task.id);
  assert.equal((await f.runtime.get(other.task.id)).currentStep, 0);
});
test("discovery-only request performs no mutation", async () => {
  const f = await fixture(),
    request = f.service.structure(
      input({
        scope: {
          paths: [],
          searchTerms: ["architecture"],
          patch: { files: [] },
          focusedTests: [],
        },
      }),
    ),
    plan = f.service.plan(request);
  assert.equal(
    plan.some((x) =>
      ["apply_patch", "commit", "push", "deploy_preview"].includes(x.type),
    ),
    false,
  );
});
test("self-development tools expose create get repair and protected guard", async () => {
  const f = await fixture(),
    registry = createToolRegistry();
  registerSelfDevelopmentTools(registry, { service: f.service });
  const names = registry.list().map((x) => x.name);
  for (const name of [
    "self_development_create",
    "self_development_get",
    "self_development_repair",
    "self_development_protected_change",
  ])
    assert.ok(names.includes(name));
});
test("chat tool contract requires only a natural-language goal and schedules durable continuation", async () => {
  const f = await fixture(),
    registry = createToolRegistry();
  registerSelfDevelopmentTools(registry, { service: f.service });
  const tool = registry
    .list()
    .find((item) => item.name === "self_development_create");
  assert.deepEqual(tool.inputSchema.required, ["userGoal"]);
  const result = await registry.execute("self_development_create", {
    userGoal: "Inspect the composer dictation integration",
  });
  assert.match(result.task.id, /^selfdev_/);
  assert.equal(result.task.status, "queued");
  assert.deepEqual(result.dispatch, { status: "scheduled", durable: true });
  assert.equal(result.task.metadata.autoDispatch, true);
});
test("real agent chat creates one inspectable durable task and can close the harmless probe", async () => {
  const f = await fixture(),
    registry = createToolRegistry();
  registerSelfDevelopmentTools(registry, { service: f.service });
  let turn = 0;
  const modelProvider = {
      name: "chat-probe",
      async generate({ toolResults }) {
        if (turn++ === 0)
          return {
            type: "tool_calls",
            toolCalls: [
              {
                id: "self-create",
                name: "self_development_create",
                arguments: {
                  userGoal: "Inspect the composer dictation integration",
                },
              },
            ],
          };
        assert.equal(toolResults[0].output.ok, true);
        return {
          type: "final",
          message: `Created ${toolResults[0].output.result.task.id}`,
        };
      },
    },
    agent = createAgent({
      storage: f.storage,
      ownerId: OWNER,
      modelProvider,
      toolRegistry: registry,
    }),
    result = await agent.run({
      message: "Improve Nova's composer dictation microphone infrastructure",
      conversationId: "self-development-chat-probe",
    }),
    created = result.toolCalls[0].result.task;
  assert.match(result.message, new RegExp(created.id));
  assert.equal((await f.service.get(created.id)).task.status, "queued");
  const cancelled = await f.runtime.control(created.id, "cancel");
  assert.equal(cancelled.status, "cancelled");
  assert.equal((await f.storage.listAutonomyTasks(OWNER)).length, 1);
});

const discoveredPath = "docs/self-development-live-acceptance.md";
const candidates = () => [discoveredPath, "test/self-development.test.js"];
async function completedDiscoveryFixture({
  goal = "Implement a harmless documentation improvement",
} = {}) {
  const f = await fixture({
      execute(name) {
        if (name === "repo_list")
          return {
            ok: true,
            files: [
              ...candidates(),
              "src/autonomy/worker-runtime.js",
              "assets/voice-control.js",
            ],
          };
        if (name === "repo_search") return { ok: true, matches: [] };
        return { ok: true };
      },
    }),
    created = await f.service.create({ userGoal: goal });
  for (let index = 0; index < created.plan.length; index++)
    await f.runtime.tickTask(created.task.id, {
      idempotencyKey: `discovery-${index}`,
    });
  const task = await f.runtime.get(created.task.id);
  assert.equal(task.status, "completed");
  return {
    ...f,
    created,
    task,
    input: {
      expectedVersion: task.stateVersion,
      runtimeBudgetMinutes: 60,
      candidatePaths: candidates(),
    },
  };
}

test("completed discovery-only task is replanned in place from durable evidence", async () => {
  const f = await completedDiscoveryFixture(),
    before = (await f.runtime.steps(f.task.id)).map((step) => step.stepId),
    result = await f.service.replanDiscoveryOnly(f.task.id, f.input),
    after = await f.runtime.steps(f.task.id);
  assert.equal(result.task.id, f.task.id);
  assert.equal(result.task.status, "queued");
  assert.equal(result.task.currentStep, 4);
  assert.deepEqual(
    after.map((step) => step.stepId),
    before,
  );
  assert.deepEqual(result.continuationSteps.slice(0, 4), [
    "read_files",
    "read_files",
    "plan_implementation",
    "apply_patch",
  ]);
  assert.ok(result.continuationSteps.includes("review_commit"));
  assert.ok(result.continuationSteps.includes("push"));
  assert.equal(result.task.metadata.autoDispatch, true);
});
test("replan preserves completed checkpoints and resets only the bounded runtime window", async () => {
  const f = await completedDiscoveryFixture(),
    checkpoint = f.task.checkpoint,
    repairIteration = f.task.repairIteration,
    result = await f.service.replanDiscoveryOnly(f.task.id, {
      ...f.input,
      runtimeBudgetMinutes: 90,
    });
  assert.deepEqual(
    result.task.checkpoint.completedSteps,
    checkpoint.completedSteps,
  );
  assert.equal(result.task.repairIteration, repairIteration);
  assert.equal(result.task.maxRuntimeMinutes, 90);
  assert.equal(result.task.completedAt, null);
  assert.ok(
    result.task.metadata.discoveryOnlyReplanHistory[0].previousCompletedAt,
  );
});
test("replan requires exact monotonic state version", async () => {
  const f = await completedDiscoveryFixture();
  await rejects(
    f.service.replanDiscoveryOnly(f.task.id, {
      ...f.input,
      expectedVersion: f.task.stateVersion - 1,
    }),
    "version_conflict",
  );
});
test("replan rejects discovery-only goals that did not request implementation", async () => {
  const f = await completedDiscoveryFixture({
    goal: "Inspect the harmless documentation architecture",
  });
  await rejects(
    f.service.replanDiscoveryOnly(f.task.id, f.input),
    "discovery_replan_precondition_failed",
  );
});
test("replan rejects caller-supplied final patch content and unbounded candidates", async () => {
  const f = await completedDiscoveryFixture();
  await rejects(
    f.service.replanDiscoveryOnly(f.task.id, {
      ...f.input,
      scope: {
        patch: { files: [{ path: discoveredPath, content: "caller patch" }] },
      },
    }),
    "replan_invalid",
  );
  await rejects(
    f.service.replanDiscoveryOnly(f.task.id, {
      ...f.input,
      candidatePaths: Array.from(
        { length: 13 },
        (_, index) => `docs/${index}.md`,
      ),
    }),
    "replan_scope_empty",
  );
});
test("replan requires every candidate in durable discovery evidence", async () => {
  const f = await completedDiscoveryFixture();
  await rejects(
    f.service.replanDiscoveryOnly(f.task.id, {
      ...f.input,
      candidatePaths: ["assets/console.js", "test/self-development.test.js"],
    }),
    "replan_scope_not_discovered",
  );
});
test("replan rejects protected Voice/runtime architecture and Production or main lineage", async () => {
  for (const path of [
    "src/autonomy/worker-runtime.js",
    "assets/voice-control.js",
  ]) {
    const f = await completedDiscoveryFixture();
    await rejects(
      f.service.replanDiscoveryOnly(f.task.id, {
        ...f.input,
        candidatePaths: [path, "test/self-development.test.js"],
      }),
      "replan_protected_scope",
    );
  }
  const f = await completedDiscoveryFixture();
  await f.storage.updateAutonomyTask(f.task.id, OWNER, { branch: "main" });
  const changed = await f.runtime.get(f.task.id);
  await rejects(
    f.service.replanDiscoveryOnly(f.task.id, {
      ...f.input,
      expectedVersion: changed.stateVersion,
    }),
    "discovery_replan_precondition_failed",
  );
});
test("replan rejects tasks with mutation or delivery evidence", async () => {
  for (const type of ["apply_patch", "commit", "push", "deploy_preview"]) {
    const f = await completedDiscoveryFixture();
    await f.storage.recordAutonomyStep({
      taskId: f.task.id,
      stepId: `extra:${type}`,
      stepType: type,
      capability: "test",
      operationFingerprint: type,
      status: "completed",
      result: { ok: true },
    });
    await rejects(
      f.service.replanDiscoveryOnly(f.task.id, f.input),
      "discovery_replan_precondition_failed",
    );
  }
});
test("replan rejects any prior approval for the same durable task", async () => {
  const f = await completedDiscoveryFixture();
  await f.storage.createApproval({
    id: "prior-replan-approval",
    ownerId: OWNER,
    projectId: "nova-brain",
    runId: f.task.id,
    tool: "git_push",
    arguments: { branch: BRANCH, commitSha: "b".repeat(40) },
  });
  await rejects(
    f.service.replanDiscoveryOnly(f.task.id, f.input),
    "discovery_replan_precondition_failed",
  );
});
test("replan is not repeatable after the same task has been reopened", async () => {
  const f = await completedDiscoveryFixture(),
    first = await f.service.replanDiscoveryOnly(f.task.id, f.input);
  await rejects(
    f.service.replanDiscoveryOnly(f.task.id, {
      ...f.input,
      expectedVersion: first.task.stateVersion,
    }),
    "discovery_replan_precondition_failed",
  );
});
test("replan audit is durable and secret-free", async () => {
  const f = await completedDiscoveryFixture(),
    result = await f.service.replanDiscoveryOnly(f.task.id, f.input),
    activity = await f.storage.listActivity(OWNER, {
      runId: f.task.id,
      limit: 20,
    }),
    event = activity.find(
      (item) =>
        item.action ===
        "self_development_replanned_after_discovery_only_completion",
    );
  assert.equal(event.status, "queued");
  assert.equal(event.metadata.scopeHash, result.scopeHash);
  assert.doesNotMatch(JSON.stringify(event), /Replanned acceptance/);
});
test("synthetic replanned task auto-dispatches one evidence read without mutation or unrelated advancement", async () => {
  const f = await completedDiscoveryFixture(),
    other = await f.service.create({
      userGoal: "Inspect an unrelated safe area",
    }),
    result = await f.service.replanDiscoveryOnly(f.task.id, f.input),
    beforeOther = await f.runtime.get(other.task.id);
  await f.runtime.tickTask(result.task.id, {
    idempotencyKey: "synthetic-replan-read",
  });
  const advanced = await f.runtime.get(result.task.id),
    afterOther = await f.runtime.get(other.task.id);
  assert.equal(advanced.currentStep, 5);
  assert.equal(
    f.calls.filter((call) => call.name === "repo_apply_patch").length,
    0,
  );
  assert.equal(afterOther.currentStep, beforeOther.currentStep);
  assert.equal(
    (await f.runtime.steps(f.task.id)).filter(
      (step) => step.stepType === "read_files",
    ).length,
    1,
  );
});
test("exact planner-format recovery preserves read evidence and auto-dispatches the same pre-mutation task", async () => {
  const f = await completedDiscoveryFixture(),
    replanned = await f.service.replanDiscoveryOnly(f.task.id, f.input);
  for (const [index, path] of candidates().entries())
    await f.storage.recordAutonomyStep({
      taskId: f.task.id,
      stepId: `${5 + index}:read_files`,
      stepType: "read_files",
      capability: "repo_read_remote",
      operationFingerprint: `read-${path}`,
      status: "completed",
      input: { arguments: { path } },
      result: { path, content: `content:${path}`, truncated: false },
    });
  await f.storage.recordAutonomyStep({
    taskId: f.task.id,
    stepId: "7:plan_implementation",
    stepType: "plan_implementation",
    capability: "reasoning",
    operationFingerprint: "invalid-plan",
    status: "failed",
    errorCode: "implementation_plan_invalid",
    result: {
      message: "invalid",
      diagnostics: {
        validationIssues: ["files_invalid"],
        outputShapeHash: "f".repeat(64),
      },
    },
  });
  const failed = await f.storage.updateAutonomyTask(f.task.id, OWNER, {
      status: "failed",
      currentStep: 6,
      errorCode: "implementation_plan_invalid",
      checkpoint: {
        ...replanned.task.checkpoint,
        completedSteps: [
          ...replanned.task.checkpoint.completedSteps,
          "5:read_files",
          "6:read_files",
        ],
      },
    }),
    recovered = await f.service.recoverImplementationPlan(f.task.id, {
      expectedVersion: failed.stateVersion,
    });
  assert.equal(recovered.task.id, f.task.id);
  assert.equal(recovered.task.status, "queued");
  assert.equal(recovered.task.currentStep, 6);
  assert.equal(recovered.task.metadata.autoDispatch, true);
  assert.deepEqual(
    recovered.task.checkpoint.completedSteps,
    failed.checkpoint.completedSteps,
  );
  assert.deepEqual(
    recovered.task.metadata.implementationPlanRecoveryHistory[0]
      .validationIssues,
    ["files_invalid"],
  );
  assert.equal(
    (await f.runtime.steps(f.task.id)).some(
      (step) => step.stepType === "apply_patch",
    ),
    false,
  );
});
test("planner-format recovery rejects version conflicts and any mutation or approval evidence", async () => {
  const f = await completedDiscoveryFixture(),
    replanned = await f.service.replanDiscoveryOnly(f.task.id, f.input);
  for (const [index, path] of candidates().entries())
    await f.storage.recordAutonomyStep({
      taskId: f.task.id,
      stepId: `${5 + index}:read_files`,
      stepType: "read_files",
      capability: "repo_read_remote",
      operationFingerprint: `evidence-${path}`,
      status: "completed",
      result: { path, content: "read", truncated: false },
    });
  await f.storage.recordAutonomyStep({
    taskId: f.task.id,
    stepId: "7:plan_implementation",
    stepType: "plan_implementation",
    capability: "reasoning",
    operationFingerprint: "bad-plan",
    status: "failed",
    errorCode: "implementation_plan_invalid",
  });
  const failed = await f.storage.updateAutonomyTask(f.task.id, OWNER, {
    status: "failed",
    currentStep: 6,
    errorCode: "implementation_plan_invalid",
  });
  await rejects(
    f.service.recoverImplementationPlan(f.task.id, {
      expectedVersion: failed.stateVersion - 1,
    }),
    "version_conflict",
  );
  await f.storage.recordAutonomyStep({
    taskId: f.task.id,
    stepId: "unsafe:apply_patch",
    stepType: "apply_patch",
    capability: "repo_mutate_local",
    operationFingerprint: "unsafe",
    status: "completed",
  });
  await rejects(
    f.service.recoverImplementationPlan(f.task.id, {
      expectedVersion: failed.stateVersion,
    }),
    "implementation_plan_recovery_precondition_failed",
  );
  assert.equal(replanned.task.id, f.task.id);
});
test("implementation bridge schema recovery appends one bounded replan and is idempotent", async () => {
  const f=await completedDiscoveryFixture(), planStep={type:"plan_implementation",capability:"reasoning",input:{tool:"self_development_plan_implementation",arguments:{taskId:f.task.id,candidatePaths:candidates(),currentCommit:f.task.currentCommit}},idempotencyIdentity:"plan"}, patchStep={type:"apply_patch",capability:"repo_mutate_local",input:{tool:"repo_apply_patch",arguments:{branch:BRANCH,currentCommit:"$CURRENT_COMMIT",files:"$IMPLEMENTATION_FILES"}},idempotencyIdentity:"patch"}, testStep={type:"run_focused_tests",capability:"test_local",input:{tool:"test_run",arguments:{files:"$IMPLEMENTATION_TESTS"}},idempotencyIdentity:"test"};
  await f.storage.updateAutonomyTask(f.task.id,OWNER,{maxSteps:6,metadata:{...(await f.runtime.get(f.task.id)).metadata,steps:[planStep,patchStep,testStep],autoDispatch:true}});
  await f.storage.recordAutonomyStep({taskId:f.task.id,stepId:"1:plan_implementation",stepType:"plan_implementation",capability:"reasoning",operationFingerprint:"valid-plan",status:"completed",result:{implementationPlan:{files:[{path:candidates()[0],operation:"replace",content:"new",expectedContent:"old"}],focusedTests:[{path:candidates()[1],kind:"existing"}]}}});
  await f.storage.recordAutonomyStep({taskId:f.task.id,stepId:"2:apply_patch",stepType:"apply_patch",capability:"repo_mutate_local",operationFingerprint:"schema-failure",status:"failed",errorCode:"schema_mismatch",result:{message:"Unknown tool argument: repo_apply_patch.currentCommit"}});
  const failed=await f.storage.updateAutonomyTask(f.task.id,OWNER,{status:"failed",currentStep:1,currentPhase:"plan_implementation",errorCode:"schema_mismatch",maxSteps:6}), recovered=await f.service.recoverImplementationSchema(f.task.id,{expectedVersion:failed.stateVersion});
  assert.equal(recovered.task.id,f.task.id);assert.equal(recovered.task.status,"queued");assert.equal(recovered.task.currentStep,3);assert.equal(recovered.task.maxSteps,failed.maxSteps);assert.equal(recovered.task.metadata.steps[3].type,"plan_implementation");assert.equal(recovered.task.metadata.autoDispatch,true);assert.equal(recovered.task.metadata.implementationSchemaRecoveryHistory[0].fieldPath,"repo_apply_patch.currentCommit");
  const duplicate=await f.service.recoverImplementationSchema(f.task.id,{expectedVersion:failed.stateVersion});assert.equal(duplicate.idempotent,true);assert.equal(duplicate.task.metadata.steps.length,6);
});

test("exact missing repair branch recovery requeues only the canonical immutable patch and is idempotent",async()=>{
  const f=await completedDiscoveryFixture(),oldPlan={type:"plan_implementation",capability:"reasoning",input:{tool:"self_development_plan_implementation",arguments:{taskId:f.task.id,candidatePaths:candidates(),currentCommit:f.task.currentCommit}},idempotencyIdentity:"old-plan"},oldPatch={type:"apply_patch",capability:"repo_mutate_local",input:{tool:"repo_apply_patch",arguments:{branch:BRANCH,files:"$IMPLEMENTATION_FILES"}},idempotencyIdentity:"old-patch"},oldFull={type:"run_full_tests",capability:"test_local",input:{tool:"test_run_full",arguments:{}},idempotencyIdentity:"old-full"},repairPlan={type:"plan_repair",capability:"reasoning",input:{tool:"self_development_plan_implementation",arguments:{taskId:f.task.id,candidatePaths:candidates(),currentCommit:f.task.currentCommit}},idempotencyIdentity:"repair-plan"},patchStep={type:"apply_patch",capability:"repo_mutate_local",input:{tool:"repo_apply_patch",arguments:{files:"$IMPLEMENTATION_FILES",expectedCommit:"$CURRENT_COMMIT"}},idempotencyIdentity:"repair-patch"},testStep={type:"run_focused_tests",capability:"test_local",input:{tool:"test_run",arguments:{files:"$IMPLEMENTATION_TESTS"}},idempotencyIdentity:"repair-test"},implementationPlan={files:[{path:candidates()[0],operation:"replace",content:"new",expectedContent:"old"}],focusedTests:[{path:candidates()[1],kind:"existing"}]};
  await f.storage.updateAutonomyTask(f.task.id,OWNER,{metadata:{...(await f.runtime.get(f.task.id)).metadata,steps:[oldPlan,oldPatch,oldFull,repairPlan,patchStep,testStep],autoDispatch:true}});
  for(const record of [{stepId:"1:plan_implementation",stepType:"plan_implementation",result:{implementationPlan}},{stepId:"2:apply_patch",stepType:"apply_patch",result:{ok:true,files:[candidates()[0]]}},{stepId:"3:run_full_tests",stepType:"run_full_tests",result:{ok:true,exitCode:0}},{stepId:"4:plan_repair",stepType:"plan_repair",result:{implementationPlan}}])await f.storage.recordAutonomyStep({taskId:f.task.id,capability:"reasoning",operationFingerprint:record.stepId,status:"completed",...record});
  await f.storage.recordAutonomyStep({taskId:f.task.id,stepId:"5:apply_patch",stepType:"apply_patch",capability:"repo_mutate_local",operationFingerprint:"repair-patch",status:"failed",errorCode:"schema_mismatch",result:{message:"Tool input failed schema validation.",diagnostics:{tool:"repo_apply_patch",schemaVersion:"1",fieldPath:"repo_apply_patch.branch",expected:{type:"required"},received:{type:"missing"},validationCode:"required_field_missing",validationLayer:"hands_tool_registry",payloadProvenance:"server_handoff_arguments"}}});
  const failed=await f.storage.updateAutonomyTask(f.task.id,OWNER,{status:"failed",currentStep:4,errorCode:"schema_mismatch"}),recovered=await f.service.recoverImplementationSchema(f.task.id,{expectedVersion:failed.stateVersion}),step=recovered.task.metadata.steps[recovered.task.currentStep];
  assert.equal(recovered.task.id,f.task.id);assert.equal(recovered.task.status,"queued");assert.equal(recovered.task.maxSteps,failed.maxSteps);assert.equal(recovered.task.metadata.requiredCapability,"repo_mutate_local");assert.equal(recovered.task.metadata.activeContinuation.recoveryClass,"repair_apply_patch_schema_binding");assert.deepEqual(step.input.arguments,{branch:"$TASK_BRANCH",currentCommit:"$CURRENT_COMMIT",files:"$IMPLEMENTATION_FILES",planProvenance:"$IMPLEMENTATION_PLAN_PROVENANCE"});assert.equal(recovered.task.metadata.implementationSchemaRecoveryHistory.at(-1).fieldPath,"repo_apply_patch.branch");const duplicate=await f.service.recoverImplementationSchema(f.task.id,{expectedVersion:failed.stateVersion});assert.equal(duplicate.idempotent,true);assert.equal(duplicate.task.metadata.steps.length,recovered.task.metadata.steps.length);
});

test("stale-base patch conflict advances only to an exact descendant and refreshes evidence", async () => {
  const verifyRemote=async()=>({currentTip:NEW_SHA,ancestors:{[SHA]:true,[NEW_SHA]:true}}),f=await fixture({currentCommit:NEW_SHA,verifyRemote});
  await f.storage.createAutonomyTask({id:"stale-base",ownerId:OWNER,projectId:"nova-brain",title:"Stale base",objective:"Composer dictation",taskType:"self_development",branch:BRANCH,startingCommit:SHA,maxSteps:10,maxRuntimeMinutes:60,metadata:{steps:[{type:"plan_implementation",capability:"reasoning",input:{tool:"self_development_plan_implementation",arguments:{taskId:"stale-base",candidatePaths:["assets/voice-input.js","test/voice-input.test.js"],currentCommit:SHA}},idempotencyIdentity:"plan"},{type:"apply_patch",capability:"repo_mutate_local",input:{tool:"repo_apply_patch",arguments:{branch:BRANCH,currentCommit:"$CURRENT_COMMIT",files:"$IMPLEMENTATION_FILES"}},idempotencyIdentity:"patch"},{type:"run_focused_tests",capability:"test_local",input:{tool:"test_run",arguments:{files:"$IMPLEMENTATION_TESTS"}},idempotencyIdentity:"tests"}],autoDispatch:true,selfDevelopment:{userGoal:"Implement composer dictation",acceptanceCriteria:["Works"]}}});
  await f.storage.recordAutonomyStep({taskId:"stale-base",stepId:"1:plan_implementation",stepType:"plan_implementation",capability:"reasoning",operationFingerprint:"plan",status:"completed",result:{implementationPlan:{files:[{path:"assets/voice-input.js",operation:"replace",content:"new",expectedContent:"old"},{path:"test/voice-input.test.js",operation:"replace",content:"test",expectedContent:"old test"}],focusedTests:[{path:"test/voice-input.test.js",kind:"existing"}],evidencePaths:["assets/voice-input.js","test/voice-input.test.js"]}}});
  await f.storage.recordAutonomyStep({taskId:"stale-base",stepId:"2:apply_patch",stepType:"apply_patch",capability:"repo_mutate_local",operationFingerprint:"patch",status:"failed",errorCode:"patch_conflict",result:{message:"Expected existing content does not match assets/voice-input.js."}});
  const failed=await f.storage.updateAutonomyTask("stale-base",OWNER,{status:"failed",currentStep:1,currentPhase:"plan_implementation",errorCode:"patch_conflict"}),recovered=await f.service.recoverStaleBasePatchConflict("stale-base",{expectedVersion:failed.stateVersion,workspace:{head:NEW_SHA,clean:true}});
  assert.equal(recovered.task.id,"stale-base");assert.equal(recovered.task.currentCommit,NEW_SHA);assert.equal(recovered.previousBaseCommit,SHA);assert.deepEqual(recovered.invalidatedEvidencePaths,["assets/voice-input.js","test/voice-input.test.js"]);assert.equal(recovered.task.metadata.steps[3].type,"read_files");assert.equal(recovered.task.metadata.steps[4].type,"read_files");assert.equal(recovered.task.metadata.steps[5].input.arguments.currentCommit,NEW_SHA);assert.equal(recovered.task.metadata.selfDevelopmentImplementationPlan,null);assert.equal(recovered.task.metadata.autoDispatch,true);assert.ok(recovered.task.maxSteps<=100);assert.ok(recovered.task.stateVersion>failed.stateVersion);
  const duplicate=await f.service.recoverStaleBasePatchConflict("stale-base",{expectedVersion:failed.stateVersion,workspace:{head:NEW_SHA,clean:true}});assert.equal(duplicate.idempotent,true);
});

test("stale-base recovery rejects divergence and dirty workspace attestations", async () => {
  for(const [workspace,ancestors,code] of [[{head:NEW_SHA,clean:false},{[SHA]:true,[NEW_SHA]:true},"stale_base_recovery_invalid"],[{head:NEW_SHA,clean:true},{[SHA]:false,[NEW_SHA]:true},"base_revision_ancestry_mismatch"]]){
    const f=await fixture({currentCommit:NEW_SHA,verifyRemote:async()=>({currentTip:NEW_SHA,ancestors})});await f.storage.createAutonomyTask({id:"reject-base",ownerId:OWNER,projectId:"nova-brain",title:"Reject",objective:"Composer",taskType:"self_development",branch:BRANCH,startingCommit:SHA,maxSteps:10,maxRuntimeMinutes:60,metadata:{steps:[{type:"plan_implementation",input:{arguments:{}},idempotencyIdentity:"p"},{type:"apply_patch",input:{arguments:{}},idempotencyIdentity:"a"}],selfDevelopment:{userGoal:"Implement",acceptanceCriteria:["safe"]}}});await f.storage.recordAutonomyStep({taskId:"reject-base",stepId:"1:plan_implementation",stepType:"plan_implementation",capability:"reasoning",operationFingerprint:"p",status:"completed",result:{implementationPlan:{files:[{path:"assets/voice-input.js"}],evidencePaths:["assets/voice-input.js"]}}});await f.storage.recordAutonomyStep({taskId:"reject-base",stepId:"2:apply_patch",stepType:"apply_patch",capability:"repo_mutate_local",operationFingerprint:"a",status:"failed",errorCode:"patch_conflict",result:{message:"Expected existing content does not match assets/voice-input.js."}});const failed=await f.storage.updateAutonomyTask("reject-base",OWNER,{status:"failed",currentStep:1,errorCode:"patch_conflict"});await rejects(f.service.recoverStaleBasePatchConflict("reject-base",{expectedVersion:failed.stateVersion,workspace}),code);
  }
});

test("focused-test evidence recovery preserves reads and exact same-task auto-dispatch", async () => {
  const f = await completedDiscoveryFixture(),
    replanned = await f.service.replanDiscoveryOnly(f.task.id, f.input);
  for (const [index, path] of candidates().entries())
    await f.storage.recordAutonomyStep({
      taskId: f.task.id,
      stepId: `${5 + index}:read_files`,
      stepType: "read_files",
      capability: "repo_read_remote",
      operationFingerprint: `focused-${path}`,
      status: "completed",
      result: { path, content: "read", truncated: false },
    });
  await f.storage.recordAutonomyStep({
    taskId: f.task.id,
    stepId: "7:plan_implementation",
    stepType: "plan_implementation",
    capability: "reasoning",
    operationFingerprint: "focused-plan",
    status: "failed",
    errorCode: "implementation_scope_violation",
    result: {
      diagnostics: {
        validationIssues: ["focused_test_evidence_rejected"],
        proposedPath: "test/voice-input.test.js",
        classification: "existing_file",
        rejectionCode: "focused_test_evidence_rejected",
        expansionRound: 1,
        plannerAttempt: 1,
      },
    },
  });
  const failed = await f.storage.updateAutonomyTask(f.task.id, OWNER, {
      status: "failed",
      currentStep: 6,
      errorCode: "implementation_scope_violation",
      checkpoint: {
        ...replanned.task.checkpoint,
        completedSteps: [
          ...replanned.task.checkpoint.completedSteps,
          "5:read_files",
          "6:read_files",
        ],
      },
    }),
    recovered = await f.service.recoverFocusedTestEvidence(f.task.id, {
      expectedVersion: failed.stateVersion,
    });
  assert.equal(recovered.task.id, f.task.id);
  assert.equal(recovered.task.status, "queued");
  assert.equal(recovered.task.currentStep, 6);
  assert.equal(recovered.task.metadata.autoDispatch, true);
  assert.deepEqual(
    recovered.task.checkpoint.completedSteps,
    failed.checkpoint.completedSteps,
  );
  assert.equal(
    (await f.runtime.steps(f.task.id)).some(
      (step) => step.stepType === "apply_patch",
    ),
    false,
  );
});
test("complete self-development lifecycle pauses for exact push approval and finishes only after Preview verification", async () => {
  let pushApproved = false;
  const counts = {};
  const approval = {
    id: "self-push-approval",
    tool: "git_push",
    arguments: { branch: BRANCH, commitSha: "b".repeat(40) },
    status: "pending",
  };
  const f = await fixture({
      execute(name, args) {
        counts[name] = (counts[name] || 0) + 1;
        if (name === "git_commit")
          return { ok: true, commitSha: "b".repeat(40) };
        if (name === "git_push" && !pushApproved)
          throw new ApprovalRequiredError(approval);
        if (name === "preview_deploy")
          return {
            ok: true,
            deploymentId: "dpl_self",
            url: "self.preview",
            status: "READY",
          };
        if (name === "preview_verify") {
          assert.equal(args.deploymentId, "dpl_self");
          assert.equal(args.commitSha, "b".repeat(40));
          return { ok: true, status: 200 };
        }
        return { ok: true };
      },
    }),
    created = await f.service.create(input());
  for (let i = 0; i < created.plan.length; i++) {
    const result = await f.runtime.tickTask(created.task.id, {
      idempotencyKey: `before-${i}`,
    });
    if (result.status === "waiting_for_approval") break;
  }
  let task = await f.runtime.get(created.task.id);
  assert.equal(task.status, "waiting_for_approval");
  assert.equal(task.currentCommit, "b".repeat(40));
  pushApproved = true;
  await f.runtime.resumeApproval(task.id, { ...approval, status: "approved" });
  for (let i = 0; i < created.plan.length; i++) {
    task = await f.runtime.get(task.id);
    if (task.status === "waiting") {
      f.advance(5000);
      await f.runtime.control(task.id, "resume");
    }
    if (task.status === "completed") break;
    await f.runtime.tickTask(task.id, { idempotencyKey: `after-${i}` });
  }
  task = await f.runtime.get(task.id);
  assert.equal(task.status, "completed");
  assert.equal(counts.git_push, 2);
  assert.equal(counts.preview_deploy, 1);
  assert.equal(counts.preview_verify, 1);
  assert.equal(
    (await f.runtime.steps(task.id)).filter((x) => x.stepType === "push")
      .length,
    1,
  );
  assert.ok(
    task.checkpoint.completedSteps.some((x) => x.endsWith(":verify_preview")),
  );
});
test("incomplete review recovery preserves the same task and invalidates stale approval", async () => {
  const f = await fixture(),
    created = await f.service.create(input()),
    sha = "b".repeat(40),
    approval = await f.storage.createApproval({
      id: "stale",
      ownerId: OWNER,
      projectId: "nova-brain",
      runId: created.task.id,
      tool: "git_push",
      arguments: { branch: BRANCH, commitSha: sha },
    });
  await f.storage.recordAutonomyStep({
    taskId: created.task.id,
    stepId: "8:inspect_diff",
    stepType: "inspect_diff",
    capability: "repo_read_remote",
    operationFingerprint: "empty",
    status: "completed",
    result: { ok: true, exitCode: 0, diff: "" },
  });
  await f.storage.updateAutonomyTask(created.task.id, OWNER, {
    status: "waiting_for_approval",
    currentStep: 9,
    currentPhase: "commit",
    currentCommit: sha,
    approvalState: {
      approvalId: approval.id,
      tool: "git_push",
      arguments: approval.arguments,
      branch: BRANCH,
      commitSha: sha,
    },
  });
  const recovered = await f.service.recoverReview(created.task.id, {
    approvalId: approval.id,
    expectedCommit: sha,
  });
  assert.equal(recovered.task.id, created.task.id);
  assert.equal(recovered.task.status, "waiting_for_worker");
  assert.equal(
    (await f.storage.getApproval(approval.id, OWNER)).status,
    "rejected",
  );
  assert.equal(recovered.task.metadata.steps[9].type, "review_commit");
});
test("reviewed unpushed commit is safely superseded on the current feature history", async () => {
  const f = await fixture(),
    created = await f.service.create(input()),
    old = "b".repeat(40),
    base = "c".repeat(40),
    approval = await f.storage.createApproval({
      id: "stale-reviewed",
      ownerId: OWNER,
      projectId: "nova-brain",
      runId: created.task.id,
      tool: "git_push",
      arguments: { branch: BRANCH, commitSha: old },
    });
  await f.storage.updateAutonomyTask(created.task.id, OWNER, {
    status: "waiting_for_approval",
    currentStep: 9,
    currentPhase: "review_commit",
    currentCommit: old,
    approvalState: {
      approvalId: approval.id,
      tool: "git_push",
      arguments: approval.arguments,
      branch: BRANCH,
      commitSha: old,
    },
  });
  const recovered = await f.service.supersedeCommit(created.task.id, {
    approvalId: approval.id,
    supersededCommit: old,
    baseCommit: base,
  });
  assert.equal(recovered.task.id, created.task.id);
  assert.equal(recovered.task.currentCommit, base);
  assert.equal(recovered.task.status, "waiting_for_worker");
  assert.equal(
    (await f.storage.getApproval(approval.id, OWNER)).status,
    "rejected",
  );
  assert.deepEqual(
    recovered.task.metadata.steps.slice(9, 13).map((x) => x.type),
    ["apply_patch", "inspect_diff", "commit", "review_commit"],
  );
  assert.deepEqual(recovered.task.metadata.supersededCommit, {
    sha: old,
    reason: "branch_history_safety",
    pushed: false,
  });
});
async function deliveryFixture({
  remote,
  deployment,
  approvalTool = "git_push",
  approvalSha,
} = {}) {
  const sha = "d".repeat(40),
    preCommitReviewHash = "a".repeat(64),
    finalCommitReviewHash = "b".repeat(64),
    preview = {
      id: "dpl_self",
      url: "self.preview",
      status: "READY",
      target: null,
      sha,
      branch: BRANCH,
    },
    f = await fixture({
      verifyRemote: async () =>
        remote || {
          currentTip: DELIVERY_FIX,
          ancestors: { [sha]: true, [DELIVERY_FIX]: true },
        },
      verifyDeployment: async () => ({ ...preview, ...deployment }),
    }),
    created = await f.service.create(input()),
    approval = await f.storage.createApproval({
      id: "delivery",
      ownerId: OWNER,
      projectId: "nova-brain",
      runId: created.task.id,
      tool: approvalTool,
      arguments: { branch: BRANCH, commitSha: approvalSha || sha },
    }),
    pushIndex = created.plan.findIndex((x) => x.type === "push");
  for (const step of [
    {
      id: "pre",
      type: "inspect_diff",
      result: { reviewedChangeSet: { reviewHash: preCommitReviewHash } },
    },
    {
      id: "commit",
      type: "commit",
      result: { commitSha: sha, reviewHash: preCommitReviewHash },
    },
    {
      id: "final",
      type: "review_commit",
      result: {
        commitSha: sha,
        reviewedChangeSet: { reviewHash: finalCommitReviewHash },
      },
    },
  ])
    await f.storage.recordAutonomyStep({
      taskId: created.task.id,
      stepId: `${pushIndex}:${step.id}`,
      stepType: step.type,
      capability: "repo_read_remote",
      operationFingerprint: step.id,
      status: "completed",
      result: step.result,
    });
  await f.storage.updateAutonomyTask(created.task.id, OWNER, {
    status: "waiting_for_approval",
    currentStep: pushIndex,
    currentCommit: sha,
    approvalState: { approvalId: approval.id, branch: BRANCH, commitSha: sha },
  });
  return {
    ...f,
    sha,
    preCommitReviewHash,
    finalCommitReviewHash,
    preview,
    created,
    approval,
    pushIndex,
    input: {
      approvalId: approval.id,
      branch: BRANCH,
      commitSha: sha,
      deploymentId: preview.id,
      deploymentUrl: preview.url,
      preCommitReviewHash,
      finalCommitReviewHash,
    },
  };
}
test("exact approved Self-Development delivery is attested once without duplicate push or Preview", async () => {
  const f = await deliveryFixture(),
    result = await f.service.attestDelivery(f.created.task.id, f.input),
    duplicate = await f.service.attestDelivery(f.created.task.id, f.input);
  assert.equal(result.task.status, "queued");
  assert.equal(result.task.currentStep, f.pushIndex + 2);
  assert.equal(duplicate.idempotent, true);
  assert.equal(
    (await f.storage.getApproval(f.approval.id, OWNER)).status,
    "approved",
  );
  const steps = await f.storage.listAutonomySteps(f.created.task.id);
  assert.equal(steps.filter((x) => x.stepType === "push").length, 1);
  assert.equal(steps.filter((x) => x.stepType === "deploy_preview").length, 1);
});
for (const [name, change, code] of [
  [
    "wrong final immutable review hash",
    { finalCommitReviewHash: "c".repeat(64) },
    "final_commit_review_binding_mismatch",
  ],
  [
    "wrong pre-commit review hash",
    { preCommitReviewHash: "c".repeat(64) },
    "pre_commit_review_binding_mismatch",
  ],
  [
    "missing pre-commit review hash",
    { preCommitReviewHash: undefined },
    "delivery_attestation_invalid",
  ],
  [
    "missing final immutable review hash",
    { finalCommitReviewHash: undefined },
    "delivery_attestation_invalid",
  ],
  [
    "swapped review hashes",
    { swap: true },
    "pre_commit_review_binding_mismatch",
  ],
])
  test(name, async () => {
    const f = await deliveryFixture(),
      candidate = { ...f.input };
    if (change.swap)
      [candidate.preCommitReviewHash, candidate.finalCommitReviewHash] = [
        candidate.finalCommitReviewHash,
        candidate.preCommitReviewHash,
      ];
    else Object.assign(candidate, change);
    await assert.rejects(
      () => f.service.attestDelivery(f.created.task.id, candidate),
      (error) => error.code === code,
    );
    assert.equal(
      (await f.storage.getApproval(f.approval.id, OWNER)).status,
      "pending",
    );
  });
for (const [name, options, code] of [
  [
    "accepted SHA missing from ancestry",
    {
      remote: { currentTip: DELIVERY_FIX, ancestors: { [DELIVERY_FIX]: true } },
    },
    "accepted_commit_ancestry_mismatch",
  ],
  [
    "attestation fix missing from ancestry",
    {
      remote: {
        currentTip: "e".repeat(40),
        ancestors: { ["d".repeat(40)]: true },
      },
    },
    "attestation_fix_ancestry_mismatch",
  ],
  [
    "divergent or rewritten history",
    { remote: { currentTip: "e".repeat(40), ancestors: {} } },
    "accepted_commit_ancestry_mismatch",
  ],
  [
    "wrong acceptance deployment SHA",
    { deployment: { sha: "e".repeat(40) } },
    "deployment_binding_mismatch",
  ],
  [
    "wrong acceptance deployment branch",
    { deployment: { branch: "other" } },
    "deployment_binding_mismatch",
  ],
  [
    "wrong approval SHA",
    { approvalSha: "e".repeat(40) },
    "delivery_attestation_precondition_failed",
  ],
  [
    "wrong approval action",
    { approvalTool: "other" },
    "delivery_attestation_precondition_failed",
  ],
])
  test(name, async () => {
    const f = await deliveryFixture(options);
    await assert.rejects(
      () => f.service.attestDelivery(f.created.task.id, f.input),
      (error) => error.code === code,
    );
    assert.equal(
      (await f.storage.getApproval(f.approval.id, OWNER)).status,
      "pending",
    );
  });
for (const tip of ["d".repeat(40), "f".repeat(40)])
  test(`delivery ancestry permits live tip ${tip[0]}`, async () => {
    const sha = "d".repeat(40),
      f = await deliveryFixture({
        remote: {
          currentTip: tip,
          ancestors: { [sha]: true, [DELIVERY_FIX]: true },
        },
      });
    assert.equal(
      (await f.service.attestDelivery(f.created.task.id, f.input)).task.status,
      "queued",
    );
  });
for (const [algorithm, diffHash] of [
  ["git_sha1", "a".repeat(40)],
  ["sha256", "a".repeat(64)],
])
test(`post-patch create-over-existing recovery preserves ${algorithm} evidence and schedules one read`, async () => {
  const f = await fixture(),
    created = await f.service.create(input()),
    target = "test/existing.test.js";
  for (const step of [
    {
      stepId: "old:plan",
      stepType: "plan_implementation",
      status: "completed",
      result: { ok: true },
    },
    {
      stepId: "old:patch",
      stepType: "apply_patch",
      status: "completed",
      result: { ok: true, files: [target] },
    },
    {
      stepId: "old:focused",
      stepType: "run_focused_tests",
      status: "completed",
      result: { ok: true },
    },
    {
      stepId: "old:full",
      stepType: "run_full_tests",
      status: "failed",
      errorCode: "test_failed",
      result: { code: "test_failed" },
    },
  ])
    await f.storage.recordAutonomyStep({
      taskId: created.task.id,
      capability: "bounded",
      operationFingerprint: step.stepId,
      ...step,
    });
  let current = await f.storage.getAutonomyTask(created.task.id, OWNER);
  await f.storage.updateAutonomyTask(
    current.id,
    OWNER,
    {
      status: "failed",
      errorCode: "test_failed",
      currentStep: 3,
      metadata: {
        ...current.metadata,
        selfDevelopmentImplementationPlan: {
          files: [{ path: target, operation: "create", content: "unsafe" }],
          focusedTests: [{ path: target, kind: "planned_new" }],
          evidencePaths: ["assets/input.js"],
          planHash: "p",
        },
        failedAttemptEvidence: {
          taskDiff: {
            semantic: "task_diff",
            algorithm,
            digest: diffHash,
            targetPath: target,
            expectedVersion: current.stateVersion + 1,
          },
        },
      },
    },
    current.stateVersion,
  );
  current = await f.storage.getAutonomyTask(current.id, OWNER);
  const service = createSelfDevelopmentService({
      runtime: f.runtime,
      storage: f.storage,
      ownerId: OWNER,
      currentCommit: SHA,
      resolvePathState: async () => ({
        existsInCommit: true,
        existsInWorktree: true,
      }),
    }),
    payload = {
      expectedVersion: current.stateVersion,
      targetPath: target,
      taskDiffHash: diffHash,
      workingTree: { clean: true, unrelatedChanges: false },
    };
  for (const invalid of [
    "a".repeat(39),
    "a".repeat(41),
    "a".repeat(63),
    "a".repeat(65),
    `${"a".repeat(diffHash.length - 1)}z`,
  ])
    await rejects(
      service.recoverCreateConflict(current.id, {
        ...payload,
        taskDiffHash: invalid,
      }),
      "create_conflict_recovery_invalid",
    );
  await rejects(
    service.recoverCreateConflict(current.id, {
      ...payload,
      taskDiffHash: "b".repeat(diffHash.length),
    }),
    "create_conflict_evidence_mismatch",
  );
  const result = await service.recoverCreateConflict(current.id, payload);
  assert.equal(result.task.id, current.id);
  assert.equal(result.task.status, "queued");
  assert.ok(result.task.stateVersion > current.stateVersion);
  assert.equal(
    result.task.metadata.authoritativePathStates[target].exists,
    true,
  );
  assert.equal(
    result.task.metadata.createConflictRecoveryHistory[0].taskDiffHash,
    diffHash,
  );
  assert.deepEqual(
    result.task.metadata.createConflictRecoveryHistory[0].taskDiffEvidence,
    { semantic: "task_diff", algorithm, digest: diffHash },
  );
  assert.ok(
    (await f.runtime.steps(current.id)).some(
      (step) => step.stepId === "old:full" && step.status === "failed",
    ),
  );
  const duplicate = await service.recoverCreateConflict(current.id, payload);
  assert.equal(duplicate.idempotent, true);
  assert.equal(duplicate.task.stateVersion, result.task.stateVersion);
  const failed = await f.storage.updateAutonomyTask(
    current.id,
    OWNER,
    {
      status: "failed",
      errorCode: "max_steps_reached",
      currentPhase: "create_conflict_evidence_read",
    },
    result.task.stateVersion,
  );
  const budget = await service.recoverCreateConflictBudget(current.id, {
    expectedVersion: failed.stateVersion,
  });
  assert.equal(budget.task.id, current.id);
  assert.equal(budget.task.currentStep, failed.currentStep);
  assert.ok(budget.maxSteps > failed.currentStep);
  assert.equal(budget.task.maxSteps, budget.maxSteps);
  assert.equal(budget.task.status, "queued");
  assert.equal(budget.task.metadata.autoDispatch, true);
  assert.equal(
    budget.task.metadata.createConflictRecoveryHistory.length,
    result.task.metadata.createConflictRecoveryHistory.length,
  );
  const duplicateBudget = await service.recoverCreateConflictBudget(current.id, {
    expectedVersion: failed.stateVersion,
  });
  assert.equal(duplicateBudget.idempotent, true);
  assert.equal(duplicateBudget.task.stateVersion, budget.task.stateVersion);
});
test("create-conflict recovery rejects wrong version missing evidence and missing tasks", async () => {
  const f = await fixture(),
    created = await f.service.create(input()),
    service = createSelfDevelopmentService({
      runtime: f.runtime,
      storage: f.storage,
      ownerId: OWNER,
      currentCommit: SHA,
      resolvePathState: async () => ({ existsInCommit: false }),
    }),
    payload = {
      expectedVersion: created.task.stateVersion,
      targetPath: "test/missing.test.js",
      taskDiffHash: "a".repeat(64),
      workingTree: { clean: true, unrelatedChanges: false },
    };
  await rejects(
    service.recoverCreateConflict(created.task.id, {
      ...payload,
      expectedVersion: payload.expectedVersion - 1,
    }),
    "version_conflict",
  );
  await rejects(
    service.recoverCreateConflict(created.task.id, payload),
    "create_conflict_evidence_missing",
  );
  await rejects(
    service.recoverCreateConflict("missing", payload),
    "task_not_found",
  );
});

test("Hands context mismatch recovery rebinds an exact descendant and is idempotent",async()=>{const verifyRemote=async()=>({currentTip:NEW_SHA,ancestors:{[SHA]:true,[NEW_SHA]:true}}),compareRemoteEvidence=async()=>({"assets/voice-input.js":{oldSha:"blob",newSha:"blob",equivalent:true}}),f=await fixture({currentCommit:NEW_SHA,verifyRemote,compareRemoteEvidence});await f.storage.createAutonomyTask({id:"hands-context",ownerId:OWNER,projectId:"nova-brain",title:"Context",objective:"Composer",taskType:"self_development",branch:BRANCH,startingCommit:SHA,currentCommit:SHA,maxSteps:4,maxRuntimeMinutes:60,metadata:{steps:[{type:"plan_implementation",input:{arguments:{}},idempotencyIdentity:"p"},{type:"apply_patch",input:{arguments:{}},idempotencyIdentity:"a"},{type:"run_focused_tests",input:{arguments:{}},idempotencyIdentity:"t"}],selfDevelopment:{userGoal:"Implement",acceptanceCriteria:["safe"]},selfDevelopmentImplementationPlan:{files:[{path:"assets/voice-input.js"}],evidencePaths:["assets/voice-input.js"]}}});await f.storage.recordAutonomyStep({taskId:"hands-context",stepId:"1:plan_implementation",stepType:"plan_implementation",capability:"reasoning",operationFingerprint:"p",status:"completed",result:{implementationPlan:{files:[{path:"assets/voice-input.js"}],evidencePaths:["assets/voice-input.js"]}}});await f.storage.recordAutonomyStep({taskId:"hands-context",stepId:"2:apply_patch",stepType:"apply_patch",capability:"repo_mutate_local",operationFingerprint:"a",status:"failed",errorCode:"commit_mismatch",result:{message:"Local checkout does not match the task-bound commit."}});const failed=await f.storage.updateAutonomyTask("hands-context",OWNER,{status:"failed",currentStep:1,currentPhase:"plan_implementation",errorCode:"commit_mismatch"}),workspace={root:"C:/controlled/nova-brain",gitTopLevel:"C:/controlled/nova-brain",head:NEW_SHA,clean:true},recovered=await f.service.recoverHandsCommitMismatch("hands-context",{expectedVersion:failed.stateVersion,workspace});assert.equal(recovered.task.id,"hands-context");assert.equal(recovered.task.startingCommit,SHA);assert.equal(recovered.task.currentCommit,NEW_SHA);assert.equal(recovered.previousCurrentCommit,SHA);assert.equal(recovered.newCurrentCommit,NEW_SHA);assert.deepEqual(recovered.invalidatedEvidencePaths,[]);assert.equal(recovered.task.status,"waiting_for_worker");assert.equal(recovered.task.metadata.handsContextRecoveryHistory[0].ancestryVerified,true);assert.equal(recovered.task.metadata.activeContinuation.startStep,3);assert.ok(recovered.task.metadata.activeContinuation.maxSteps<=30);assert.equal((await f.service.recoverHandsCommitMismatch("hands-context",{expectedVersion:failed.stateVersion,workspace})).idempotent,true);});

test("Hands descendant rebind preserves 141 lifetime steps and budgets only the 11-step active continuation",async()=>{const f=await fixture({currentCommit:NEW_SHA,verifyRemote:async()=>({currentTip:NEW_SHA,ancestors:{[SHA]:true,[NEW_SHA]:true}}),compareRemoteEvidence:async()=>({"assets/voice-input.js":{oldSha:"same",newSha:"same",equivalent:true}})}),templates=Array.from({length:141},(_,index)=>({type:"inspect_repo",input:{arguments:{}},idempotencyIdentity:`history-${index+1}`})),plan={files:[{path:"assets/voice-input.js",operation:"replace",expectedContent:"old\n",content:"new\n"}],evidencePaths:["assets/voice-input.js"],planHash:"repair-plan"};templates[118]={type:"plan_repair",input:{arguments:{}},idempotencyIdentity:"repair-plan"};templates[130]={type:"apply_patch",input:{arguments:{}},idempotencyIdentity:"failed-apply"};for(const[index,type]of [[131,"run_focused_tests"],[132,"run_full_tests"],[133,"inspect_diff"],[134,"commit"],[135,"review_commit"],[136,"push"],[137,"deploy_preview"],[138,"wait"],[139,"verify_preview"],[140,"summarize"]])templates[index]={type,input:{arguments:{}},idempotencyIdentity:`remaining-${index+1}`};await f.storage.createAutonomyTask({id:"long-hands-history",ownerId:OWNER,projectId:"nova-brain",title:"Context",objective:"Composer",taskType:"self_development",branch:BRANCH,startingCommit:SHA,currentCommit:SHA,maxSteps:100,maxRuntimeMinutes:60,metadata:{steps:templates,selfDevelopment:{userGoal:"Implement",acceptanceCriteria:["safe"]},selfDevelopmentImplementationPlan:plan}});await f.storage.recordAutonomyStep({taskId:"long-hands-history",stepId:"119:plan_repair",stepType:"plan_repair",capability:"reasoning",operationFingerprint:"repair-plan",status:"completed",result:{implementationPlan:plan}});await f.storage.recordAutonomyStep({taskId:"long-hands-history",stepId:"131:apply_patch",stepType:"apply_patch",capability:"repo_mutate_local",operationFingerprint:"failed-apply",status:"failed",errorCode:"commit_mismatch",result:{message:"Local checkout does not match the task-bound commit.",mutationApplied:false}});const failed=await f.storage.updateAutonomyTask("long-hands-history",OWNER,{status:"failed",currentStep:130,errorCode:"commit_mismatch"}),recovered=await f.service.recoverHandsCommitMismatch(failed.id,{expectedVersion:failed.stateVersion,workspace:{root:"C:/controlled/nova-brain",gitTopLevel:"C:/controlled/nova-brain",head:NEW_SHA,clean:true}});assert.equal(recovered.task.currentStep,141);assert.equal(recovered.task.metadata.steps.length,152);assert.equal(recovered.task.metadata.steps[141].type,"apply_patch");assert.equal(recovered.task.metadata.activeContinuation.startStep,141);assert.equal(recovered.task.metadata.activeContinuation.maxSteps,15);assert.equal(recovered.task.maxSteps,100);assert.deepEqual(recovered.task.metadata.steps.slice(0,141).map(step=>step.idempotencyIdentity),templates.map(step=>step.idempotencyIdentity));});

test("Hands recovery persistence failures expose only bounded stage diagnostics and leave the task unchanged",async()=>{const verifyRemote=async()=>({currentTip:NEW_SHA,ancestors:{[SHA]:true,[NEW_SHA]:true}}),compareRemoteEvidence=async()=>({"assets/voice-input.js":{oldSha:"same",newSha:"same",equivalent:true}}),f=await fixture({currentCommit:NEW_SHA,verifyRemote,compareRemoteEvidence}),plan={files:[{path:"assets/voice-input.js",operation:"replace",expectedContent:"old\n",content:"new\n"}],evidencePaths:["assets/voice-input.js"],planHash:"repair-plan"};await f.storage.createAutonomyTask({id:"persistence-diagnostic",ownerId:OWNER,projectId:"nova-brain",title:"Context",objective:"Composer",taskType:"self_development",branch:BRANCH,startingCommit:SHA,currentCommit:SHA,maxSteps:100,maxRuntimeMinutes:60,metadata:{steps:[{type:"plan_repair",input:{arguments:{}},idempotencyIdentity:"plan"},{type:"apply_patch",input:{arguments:{}},idempotencyIdentity:"apply"}],selfDevelopment:{userGoal:"Implement",acceptanceCriteria:["safe"]},selfDevelopmentImplementationPlan:plan}});await f.storage.recordAutonomyStep({taskId:"persistence-diagnostic",stepId:"1:plan_repair",stepType:"plan_repair",capability:"reasoning",operationFingerprint:"plan",status:"completed",result:{implementationPlan:plan}});await f.storage.recordAutonomyStep({taskId:"persistence-diagnostic",stepId:"2:apply_patch",stepType:"apply_patch",capability:"repo_mutate_local",operationFingerprint:"apply",status:"failed",errorCode:"commit_mismatch",result:{mutationApplied:false}});const failed=await f.storage.updateAutonomyTask("persistence-diagnostic",OWNER,{status:"failed",currentStep:1,errorCode:"commit_mismatch"}),storage={...f.storage,async updateAutonomyTask(){const error=Object.assign(new Error("contains secret-token-value"),{code:"postgres_write_failed"});throw error;}},service=createSelfDevelopmentService({runtime:f.runtime,storage,ownerId:OWNER,currentCommit:NEW_SHA,verifyRemote,compareRemoteEvidence});await assert.rejects(()=>service.recoverHandsCommitMismatch(failed.id,{expectedVersion:failed.stateVersion,workspace:{root:"C:/controlled/nova-brain",gitTopLevel:"C:/controlled/nova-brain",head:NEW_SHA,clean:true}}),error=>{assert.equal(error.code,"hands_context_recovery_persistence_failed");assert.deepEqual(error.safeDiagnostics,{recoveryRoute:"recover-hands-commit-mismatch",recoveryClass:"commit_mismatch_descendant_rebind",stage:"persistence",operation:"update_autonomy_task",taskId:failed.id,stepId:"2:apply_patch",stepType:"apply_patch",internalCode:"postgres_write_failed",mutationStarted:true,mutationCompleted:false});assert.doesNotMatch(JSON.stringify(error),/secret-token-value/);return true;});const unchanged=await f.storage.getAutonomyTask(failed.id,OWNER);assert.equal(unchanged.stateVersion,failed.stateVersion);assert.equal(unchanged.currentCommit,SHA);});

test("Hands descendant rebind accepts only exact task-owned dirty content and rebinds active plan provenance",async()=>{const f=await fixture({currentCommit:NEW_SHA,verifyRemote:async()=>({currentTip:NEW_SHA,ancestors:{[SHA]:true,[NEW_SHA]:true}}),compareRemoteEvidence:async()=>({"assets/voice-input.js":{oldSha:"same",newSha:"same",equivalent:true},"test/composer-dictation.test.js":{oldSha:"same-test",newSha:"same-test",equivalent:true}})}),files=[{path:"assets/voice-input.js",operation:"replace",expectedContent:"before\n",content:"after\n"},{path:"test/composer-dictation.test.js",operation:"replace",expectedContent:"old test\n",content:"test content\n"}],plain={files,evidencePaths:files.map(file=>file.path),planHash:"plan-hash"};await f.storage.createAutonomyTask({id:"task-owned-dirty",ownerId:OWNER,projectId:"nova-brain",title:"Context",objective:"Composer",taskType:"self_development",branch:BRANCH,startingCommit:SHA,currentCommit:SHA,maxSteps:5,maxRuntimeMinutes:60,metadata:{steps:[{type:"plan_repair",input:{arguments:{}},idempotencyIdentity:"p"},{type:"apply_patch",input:{arguments:{}},idempotencyIdentity:"a"},{type:"run_focused_tests",input:{arguments:{}},idempotencyIdentity:"t"}],selfDevelopment:{userGoal:"Implement",acceptanceCriteria:["safe"]},implementationPlanGenerations:[]}});let task=await f.storage.getAutonomyTask("task-owned-dirty",OWNER),plan={...plain,provenance:bindImplementationPlan({task,plan:plain,evidence:files.map(file=>({path:file.path,content:file.expectedContent})),readStepIds:["evidence"]})};await f.storage.updateAutonomyTask(task.id,OWNER,{metadata:{...planLifecycleMetadata(task,plan),steps:task.metadata.steps}});await f.storage.recordAutonomyStep({taskId:task.id,stepId:"1:plan_repair",stepType:"plan_repair",capability:"reasoning",operationFingerprint:"p",status:"completed",result:{implementationPlan:plan}});await f.storage.recordAutonomyStep({taskId:task.id,stepId:"2:apply_patch",stepType:"apply_patch",capability:"repo_mutate_local",operationFingerprint:"a",status:"failed",errorCode:"commit_mismatch",result:{message:"Local checkout does not match the task-bound commit.",mutationApplied:false}});const failed=await f.storage.updateAutonomyTask(task.id,OWNER,{status:"failed",currentStep:1,errorCode:"commit_mismatch"}),blob=value=>{const content=Buffer.from(value);return createHash("sha1").update(Buffer.from(`blob ${content.length}\0`)).update(content).digest("hex");},workspace={root:"C:/controlled/nova-brain",gitTopLevel:"C:/controlled/nova-brain",head:NEW_SHA,clean:false,changedFiles:files.map(file=>({path:file.path,hashAlgorithm:"git_sha1",hash:blob(file.expectedContent)}))},recovered=await f.service.recoverHandsCommitMismatch(task.id,{expectedVersion:failed.stateVersion,workspace});assert.equal(recovered.task.currentCommit,NEW_SHA);assert.equal(recovered.task.status,"waiting_for_worker");assert.notEqual(recovered.task.metadata.activeImplementationPlanGeneration,plan.provenance.generationId);assert.equal(recovered.task.metadata.selfDevelopmentImplementationPlan.provenance.currentCommit,NEW_SHA);assert.deepEqual(recovered.task.metadata.handsContextRecoveryHistory.at(-1).taskOwnedDirtyFiles,workspace.changedFiles.sort((a,b)=>a.path.localeCompare(b.path)));});

test("Hands descendant rebind rejects unrelated missing or mismatched dirty-file attestations",async()=>{for(const changedFiles of [[],[{path:"assets/voice-input.js",hashAlgorithm:"git_sha1",hash:"0".repeat(40)}],[{path:"unrelated.txt",hashAlgorithm:"git_sha1",hash:"0".repeat(40)}]]){const f=await fixture({currentCommit:NEW_SHA,verifyRemote:async()=>({currentTip:NEW_SHA,ancestors:{[SHA]:true,[NEW_SHA]:true}}),compareRemoteEvidence:async()=>({"assets/voice-input.js":{oldSha:"same",newSha:"same",equivalent:true}})}),files=[{path:"assets/voice-input.js",operation:"replace",expectedContent:"before\n",content:"after\n"}],plain={files,evidencePaths:["assets/voice-input.js"],planHash:"plan-hash"};await f.storage.createAutonomyTask({id:`dirty-reject-${changedFiles.length}-${changedFiles[0]?.path||"none"}`,ownerId:OWNER,projectId:"nova-brain",title:"Context",objective:"Composer",taskType:"self_development",branch:BRANCH,startingCommit:SHA,currentCommit:SHA,maxSteps:3,maxRuntimeMinutes:60,metadata:{steps:[{type:"plan_implementation",input:{arguments:{}},idempotencyIdentity:"p"},{type:"apply_patch",input:{arguments:{}},idempotencyIdentity:"a"}],selfDevelopment:{userGoal:"Implement",acceptanceCriteria:["safe"]},implementationPlanGenerations:[]}});let task=await f.storage.getAutonomyTask(`dirty-reject-${changedFiles.length}-${changedFiles[0]?.path||"none"}`,OWNER),plan={...plain,provenance:bindImplementationPlan({task,plan:plain,evidence:[{path:"assets/voice-input.js",content:"before\n"}]})};await f.storage.updateAutonomyTask(task.id,OWNER,{metadata:{...planLifecycleMetadata(task,plan),steps:task.metadata.steps}});await f.storage.recordAutonomyStep({taskId:task.id,stepId:"1:plan_implementation",stepType:"plan_implementation",capability:"reasoning",operationFingerprint:"p",status:"completed",result:{implementationPlan:plan}});await f.storage.recordAutonomyStep({taskId:task.id,stepId:"2:apply_patch",stepType:"apply_patch",capability:"repo_mutate_local",operationFingerprint:"a",status:"failed",errorCode:"commit_mismatch",result:{mutationApplied:false}});const failed=await f.storage.updateAutonomyTask(task.id,OWNER,{status:"failed",currentStep:1,errorCode:"commit_mismatch"});await rejects(f.service.recoverHandsCommitMismatch(task.id,{expectedVersion:failed.stateVersion,workspace:{root:"C:/controlled/nova-brain",gitTopLevel:"C:/controlled/nova-brain",head:NEW_SHA,clean:false,changedFiles}}),"hands_context_recovery_dirty_unproven");}});

test("Hands context recovery rejects divergence and refreshes changed evidence before replanning",async()=>{const changed=async()=>({"assets/voice-input.js":{oldSha:"old",newSha:"new",equivalent:false}}),diverged=await fixture({currentCommit:NEW_SHA,verifyRemote:async()=>({currentTip:NEW_SHA,ancestors:{[SHA]:false,[NEW_SHA]:true}}),compareRemoteEvidence:changed});await diverged.storage.createAutonomyTask({id:"diverged-context",ownerId:OWNER,projectId:"nova-brain",title:"Context",objective:"Composer",taskType:"self_development",branch:BRANCH,startingCommit:SHA,currentCommit:SHA,maxSteps:6,maxRuntimeMinutes:60,metadata:{steps:[{type:"plan_implementation",input:{arguments:{}},idempotencyIdentity:"p"},{type:"apply_patch",input:{arguments:{}},idempotencyIdentity:"a"}],selfDevelopment:{userGoal:"Implement",acceptanceCriteria:["safe"]}}});await diverged.storage.recordAutonomyStep({taskId:"diverged-context",stepId:"1:plan_implementation",stepType:"plan_implementation",capability:"reasoning",operationFingerprint:"p",status:"completed",result:{implementationPlan:{files:[{path:"assets/voice-input.js"}],evidencePaths:["assets/voice-input.js"]}}});await diverged.storage.recordAutonomyStep({taskId:"diverged-context",stepId:"2:apply_patch",stepType:"apply_patch",capability:"repo_mutate_local",operationFingerprint:"a",status:"failed",errorCode:"commit_mismatch",result:{message:"mismatch"}});const failed=await diverged.storage.updateAutonomyTask("diverged-context",OWNER,{status:"failed",currentStep:1,errorCode:"commit_mismatch"}),payload={expectedVersion:failed.stateVersion,workspace:{root:"C:/controlled/nova-brain",gitTopLevel:"C:/controlled/nova-brain",head:NEW_SHA,clean:true}};await rejects(diverged.service.recoverHandsCommitMismatch("diverged-context",payload),"hands_context_ancestry_mismatch");});
test("repository-context failure recovery composes descendant rebind and is idempotent",async()=>{const f=await fixture({currentCommit:NEW_SHA,verifyRemote:async()=>({currentTip:NEW_SHA,ancestors:{[SHA]:true,[NEW_SHA]:true}}),compareRemoteEvidence:async()=>({"assets/voice-input.js":{oldSha:"blob",newSha:"blob",equivalent:true}})});await f.storage.createAutonomyTask({id:"repository-context",ownerId:OWNER,projectId:"nova-brain",title:"Context",objective:"Composer",taskType:"self_development",branch:BRANCH,startingCommit:"c".repeat(40),currentCommit:SHA,maxSteps:4,maxRuntimeMinutes:60,metadata:{steps:[{type:"plan_implementation",input:{arguments:{}},idempotencyIdentity:"p"},{type:"apply_patch",input:{arguments:{}},idempotencyIdentity:"a"}],selfDevelopment:{userGoal:"Implement",acceptanceCriteria:["safe"]},selfDevelopmentImplementationPlan:{files:[{path:"assets/voice-input.js"}],evidencePaths:["assets/voice-input.js"]}}});await f.storage.recordAutonomyStep({taskId:"repository-context",stepId:"1:plan_implementation",stepType:"plan_implementation",capability:"reasoning",operationFingerprint:"p",status:"completed",result:{implementationPlan:{files:[{path:"assets/voice-input.js"}],evidencePaths:["assets/voice-input.js"]}}});await f.storage.recordAutonomyStep({taskId:"repository-context",stepId:"2:apply_patch",stepType:"apply_patch",capability:"repo_mutate_local",operationFingerprint:"a",status:"failed",errorCode:"repository_context_unproven",result:{message:"unproven"}});const failed=await f.storage.updateAutonomyTask("repository-context",OWNER,{status:"failed",currentStep:1,errorCode:"repository_context_unproven"}),payload={expectedVersion:failed.stateVersion,workspace:{root:"C:/controlled/nova-brain",gitTopLevel:"C:/controlled/nova-brain",head:NEW_SHA,clean:true}},recovered=await f.service.recoverRepositoryContextFailure("repository-context",payload);assert.equal(recovered.task.startingCommit,"c".repeat(40));assert.equal(recovered.task.currentCommit,NEW_SHA);assert.equal(recovered.task.status,"waiting_for_worker");assert.equal(recovered.task.metadata.handsContextRecoveryHistory.at(-1).recoveryClass,"repository_context_descendant_rebind");assert.ok(recovered.task.maxSteps<=100);assert.equal((await f.service.recoverRepositoryContextFailure("repository-context",payload)).idempotent,true);});

test("repository-context recovery resolves a non-adjacent latest semantic plan across inserted evidence",async()=>{const f=await fixture({currentCommit:NEW_SHA,verifyRemote:async()=>({currentTip:NEW_SHA,ancestors:{[SHA]:true,[NEW_SHA]:true}}),compareRemoteEvidence:async()=>({"assets/voice-input.js":{oldSha:"blob",newSha:"blob",equivalent:true}})}),steps=[{type:"inspect_repo"},{type:"plan_implementation",input:{arguments:{}},idempotencyIdentity:"latest-plan"},{type:"read_files"},{type:"read_files"},{type:"apply_patch",input:{arguments:{}},idempotencyIdentity:"failed-apply"},{type:"run_focused_tests"}];await f.storage.createAutonomyTask({id:"non-adjacent-context",ownerId:OWNER,projectId:"nova-brain",title:"Context",objective:"Composer",taskType:"self_development",branch:BRANCH,startingCommit:SHA,currentCommit:SHA,maxSteps:8,maxRuntimeMinutes:60,metadata:{steps,selfDevelopment:{userGoal:"Implement",acceptanceCriteria:["safe"]},selfDevelopmentImplementationPlan:{files:[{path:"assets/voice-input.js"}],evidencePaths:["assets/voice-input.js"]}}});await f.storage.recordAutonomyStep({taskId:"non-adjacent-context",stepId:"2:plan_implementation",stepType:"plan_implementation",capability:"reasoning",operationFingerprint:"latest-plan",status:"completed",result:{implementationPlan:{files:[{path:"assets/voice-input.js"}],evidencePaths:["assets/voice-input.js"]}}});for(const ordinal of [3,4])await f.storage.recordAutonomyStep({taskId:"non-adjacent-context",stepId:`${ordinal}:read_files`,stepType:"read_files",capability:"repo_read_remote",operationFingerprint:`read-${ordinal}`,status:"completed",result:{path:"assets/voice-input.js"}});await f.storage.recordAutonomyStep({taskId:"non-adjacent-context",stepId:"5:apply_patch",stepType:"apply_patch",capability:"repo_mutate_local",operationFingerprint:"failed-apply",status:"failed",errorCode:"repository_context_unproven",result:{message:"context rejected before mutation",mutationApplied:false}});const failed=await f.storage.updateAutonomyTask("non-adjacent-context",OWNER,{status:"failed",currentStep:4,errorCode:"repository_context_unproven"}),recovered=await f.service.recoverRepositoryContextFailure(failed.id,{expectedVersion:failed.stateVersion,workspace:{root:"C:/controlled/nova-brain",gitTopLevel:"C:/controlled/nova-brain",head:NEW_SHA,clean:true}}),record=recovered.task.metadata.handsContextRecoveryHistory.at(-1);assert.equal(record.plannedStepId,"2:plan_implementation");assert.equal(record.failedStepId,"5:apply_patch");assert.equal(record.semanticPlanOrdinal,2);assert.equal(record.semanticApplyOrdinal,5);assert.equal(recovered.task.id,failed.id);assert.equal(recovered.task.startingCommit,SHA);assert.ok(recovered.task.stateVersion>failed.stateVersion);assert.ok(recovered.task.maxSteps<=100);});

test("plan-lifecycle recovery preserves over-100 audit history and creates one bounded active generation",async()=>{const compared=[];const f=await fixture({currentCommit:NEW_SHA,verifyRemote:async()=>({currentTip:NEW_SHA,ancestors:{[SHA]:true,[NEW_SHA]:true}}),compareRemoteEvidence:async input=>{compared.push(input);return{"assets/voice-input.js":{oldSha:"old-blob",newSha:"new-blob",equivalent:false}};}}),steps=Array.from({length:105},(_,index)=>({type:"inspect_repo",input:{arguments:{}},idempotencyIdentity:`history-${index+1}`})),plan={files:[{path:"assets/voice-input.js",operation:"replace",expectedContent:"old\n",content:"new\n"}],evidencePaths:["assets/voice-input.js"],planHash:"legacy-plan"};steps[102]={type:"plan_implementation",input:{arguments:{taskId:"long-history"}},idempotencyIdentity:"legacy-plan"};steps[104]={type:"apply_patch",input:{arguments:{files:"$IMPLEMENTATION_FILES"}},idempotencyIdentity:"failed-apply"};await f.storage.createAutonomyTask({id:"long-history",ownerId:OWNER,projectId:"nova-brain",title:"Long history",objective:"Composer",taskType:"self_development",branch:BRANCH,startingCommit:SHA,currentCommit:SHA,maxSteps:100,maxRuntimeMinutes:60,metadata:{steps,selfDevelopment:{userGoal:"Implement",acceptanceCriteria:["safe"]},selfDevelopmentImplementationPlan:plan,implementationPlanGenerations:[{generationId:"legacy",authority:"active"}]}});await f.storage.recordAutonomyStep({taskId:"long-history",stepId:"103:plan_implementation",stepType:"plan_implementation",capability:"reasoning",operationFingerprint:"legacy-plan",status:"completed",result:{implementationPlan:plan}});await f.storage.recordAutonomyStep({taskId:"long-history",stepId:"105:apply_patch",stepType:"apply_patch",capability:"repo_mutate_local",operationFingerprint:"failed-apply",status:"failed",errorCode:"patch_conflict",result:{message:"Expected existing content does not match assets/voice-input.js.",mutationApplied:false}});const failed=await f.storage.updateAutonomyTask("long-history",OWNER,{status:"failed",currentStep:104,errorCode:"patch_conflict"}),recovered=await f.service.recoverPlanLifecycle(failed.id,{expectedVersion:failed.stateVersion,workspace:{root:"C:/controlled/nova-brain",gitTopLevel:"C:/controlled/nova-brain",head:NEW_SHA,clean:true}});assert.equal(recovered.task.id,failed.id);assert.equal(recovered.task.currentStep,105);assert.equal(recovered.task.metadata.steps.slice(0,105).map(step=>step.idempotencyIdentity).join("|"),steps.map(step=>step.idempotencyIdentity).join("|"));assert.equal(recovered.task.metadata.implementationPlanGenerations[0].authority,"superseded");assert.equal(recovered.task.metadata.selfDevelopmentImplementationPlan,null);assert.ok(recovered.task.metadata.activeContinuation.maxSteps<=30);assert.equal(recovered.task.metadata.activeContinuation.startStep,105);assert.equal(compared.length,1);assert.equal((await f.service.recoverPlanLifecycle(failed.id,{expectedVersion:failed.stateVersion,workspace:{root:"C:/controlled/nova-brain",gitTopLevel:"C:/controlled/nova-brain",head:NEW_SHA,clean:true}})).idempotent,true);});

test("semantic recovery fails closed for ambiguous unsuperseded plan history and reported mutation",()=>{const task={metadata:{steps:[{type:"plan_implementation"},{type:"apply_patch"}]}},plan={stepId:"1:plan_implementation",stepType:"plan_implementation",status:"completed",result:{implementationPlan:{files:[]}}},failed={stepId:"2:apply_patch",stepType:"apply_patch",status:"failed",errorCode:"repository_context_unproven",result:{mutationApplied:false}};assert.throws(()=>resolveSemanticPlanApplyState(task,[plan,{...plan},failed],"repository_context_unproven"),error=>error.code==="semantic_recovery_state_ambiguous");assert.throws(()=>resolveSemanticPlanApplyState(task,[plan,{...failed,result:{mutationApplied:true}}],"repository_context_unproven"),error=>error.code==="semantic_recovery_state_unresolved");});
