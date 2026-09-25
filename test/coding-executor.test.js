import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codingSpecificationHash, createCodingExecutorService, immutableCodingSpecification } from "../src/autonomy/coding-executor.js";
import { createCodexCliRunner, registerCodexExecutorTool } from "../src/tools/codex-executor-tool.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";
import { createWorkerRuntime } from "../src/autonomy/worker-runtime.js";
import { createAutoDispatchService } from "../src/autonomy/auto-dispatch.js";
import { createLocalWorkerHandoff } from "../src/autonomy/local-worker-handoff.js";
import { createCodingProgressReporter, createPersistentLocalWorker } from "../src/autonomy/persistent-local-worker.js";

const runFile = promisify(execFile);
const OWNER = "owner";
const BASE = "a".repeat(40);

function harness({ prepared = false } = {}) {
  const canonical = immutableCodingSpecification(request({ approval: undefined }));
  const tasks = new Map([["parent-1", { id: "parent-1", ownerId: OWNER, projectId: "nova-brain", branch: "feature", currentCommit: BASE, status: "planning", stateVersion: 1, taskType: prepared ? "coding_orchestration" : "project", metadata: prepared ? { codingDelegation: { version: 1, codingJob: canonical, codingJobHash: codingSpecificationHash(canonical) } } : {} }]]);
  const steps = new Map();
  const activities = [];
  let createRace = false;
  const storage = {
    async getAutonomyTask(id) { return structuredClone(tasks.get(id) || null); },
    async appendActivity(value) { activities.push(structuredClone(value)); return value; },
  };
  const runtime = {
    async create(input) {
      const task = { ...structuredClone(input), status: "queued", stateVersion: 1, currentCommit: input.startingCommit, currentStep: 0, checkpoint: {} };
      tasks.set(task.id, task);
      steps.set(task.id, []);
      if (createRace) { createRace = false; throw Object.assign(new Error("duplicate key"), { code: "23505" }); }
      return structuredClone(task);
    },
    async get(id) { const task = tasks.get(id); if (!task) throw new Error("missing"); return structuredClone(task); },
    async steps(id) { return structuredClone(steps.get(id) || []); },
    async control(id, action) { const task = tasks.get(id); task.status = action === "cancel" ? "cancelled" : task.status; return structuredClone(task); },
  };
  const service = createCodingExecutorService({ runtime, storage, ownerId: OWNER, bindings: [{ projectId: "nova-brain", workspaceId: "nova-brain", repository: "hshanbour/nova-brain", branch: "feature" }] });
  return { service, tasks, steps, activities, runtime, storage, raceNextCreate() { createRace = true; } };
}

function request(overrides = {}) {
  return {
    jobId: "job-1",
    parentTaskId: "parent-1",
    objective: "Implement the approved accessibility improvement.",
    acceptanceCriteria: ["Keyboard behaviour is covered."],
    constraints: ["Preserve existing behaviour."],
    repository: { slug: "hshanbour/nova-brain", branch: "feature", baseline: BASE },
    projectId: "nova-brain",
    workspaceId: "nova-brain",
    delivery: { boundary: "local_commit", allowPush: false, allowDeploy: false },
    approval: { buildApproved: true, approvalId: "approval-1" },
    verification: ["Run focused tests."],
    ...overrides,
  };
}

test("approved coding delegation creates one durable parent-linked Codex task", async () => {
  const { service, tasks, activities } = harness();
  const first = await service.create(request());
  const second = await service.create(request());
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(first.task.id, second.task.id);
  assert.equal(first.task.taskType, "coding_delegation");
  assert.equal(first.task.metadata.parentTaskId, "parent-1");
  assert.equal(first.task.metadata.requiredCapability, "codex_local");
  assert.equal(first.task.metadata.steps[0].input.tool, "codex_execute");
  assert.deepEqual(first.task.metadata.codingJob.delivery, { boundary: "local_commit", allowPush: false, allowDeploy: false });
  assert.equal(tasks.size, 2);
  assert.equal(activities.at(-1).action, "coding_job_prepared");
  assert.doesNotMatch(JSON.stringify(first), /api[_ -]?key|bearer\s+/i);
});

test("terminal coding failure creates one deterministic approved successor without mutating its predecessor", async () => {
  const fixture = harness({ prepared: true });
  const first = await fixture.service.create(request());
  const predecessor = fixture.tasks.get(first.task.id);
  delete predecessor.metadata.codingRetry; // Exact legacy shape from the first deployed executor generation.
  delete predecessor.metadata.codingSpecificationHash;
  Object.assign(predecessor, { status: "failed", stateVersion: 4, errorCode: "coding_executor_failed", completedAt: "2026-09-25T00:00:00.000Z" });
  Object.assign(fixture.tasks.get("parent-1"), { status: "failed", stateVersion: 5, currentPhase: "approval" });
  const before = structuredClone(predecessor);
  assert.equal(fixture.tasks.size, 2); // A terminal task never retries itself automatically.
  const approvalReplay = await fixture.service.create(request());
  assert.equal(approvalReplay.duplicate, true);
  assert.equal(approvalReplay.task.id, first.task.id);
  assert.equal(fixture.tasks.size, 2);
  const retryInput = request({ approval: { buildApproved: true, approvalId: "approval-2" } });
  const successor = await fixture.service.create(retryInput);
  const duplicate = await fixture.service.create(retryInput);
  assert.equal(successor.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(successor.task.id, duplicate.task.id);
  assert.notEqual(successor.task.id, first.task.id);
  assert.deepEqual(fixture.tasks.get(first.task.id), before);
  assert.equal(successor.task.metadata.parentTaskId, "parent-1");
  assert.equal(successor.task.metadata.codingRetry.predecessorTaskId, first.task.id);
  assert.equal(successor.task.metadata.codingRetry.predecessorStateVersion, 4);
  assert.equal(successor.task.metadata.codingRetry.generation, 1);
  assert.equal(successor.task.metadata.codingRetry.specificationHash, codingSpecificationHash(retryInput));
  assert.equal(successor.task.metadata.codingSpecificationHash, codingSpecificationHash(retryInput));
  assert.equal(successor.task.metadata.codingJob.approval.approvalId, "approval-2");
  assert.equal(fixture.tasks.size, 3);
  Object.assign(fixture.tasks.get(successor.task.id), { status: "failed", stateVersion: 4, errorCode: "coding_executor_failed" });
  const retryApprovalReplay = await fixture.service.create(retryInput);
  assert.equal(retryApprovalReplay.task.id, successor.task.id);
  assert.equal(fixture.tasks.size, 3);
  const secondSuccessor = await fixture.service.create(request({ approval: { buildApproved: true, approvalId: "approval-3" } }));
  assert.notEqual(secondSuccessor.task.id, successor.task.id);
  assert.equal(secondSuccessor.task.metadata.codingRetry.predecessorTaskId, successor.task.id);
  assert.equal(secondSuccessor.task.metadata.codingRetry.generation, 2);
});

test("blocked and cancelled coding jobs are successor-eligible while completed and expired jobs remain idempotent", async () => {
  for (const status of ["blocked", "cancelled"]) {
    const fixture = harness(), first = await fixture.service.create(request());
    Object.assign(fixture.tasks.get(first.task.id), { status, stateVersion: 3 });
    const successor = await fixture.service.create(request({ approval: { buildApproved: true, approvalId: `approval-${status}` } }));
    assert.notEqual(successor.task.id, first.task.id);
    assert.equal(successor.task.metadata.codingRetry.predecessorTaskId, first.task.id);
  }
  for (const status of ["completed", "expired"]) {
    const fixture = harness(), first = await fixture.service.create(request());
    Object.assign(fixture.tasks.get(first.task.id), { status, stateVersion: 3 });
    const replay = await fixture.service.create(request({ approval: { buildApproved: true, approvalId: `approval-${status}` } }));
    assert.equal(replay.duplicate, true);
    assert.equal(replay.task.id, first.task.id);
    assert.equal(fixture.tasks.size, 2);
  }
});

test("terminal successor lineage survives restart and a concurrent retry converges on one child", async () => {
  const fixture = harness({ prepared: true }), first = await fixture.service.create(request());
  Object.assign(fixture.tasks.get(first.task.id), { status: "failed", stateVersion: 5, errorCode: "executor_failed" });
  fixture.raceNextCreate();
  const retryInput = request({ approval: { buildApproved: true, approvalId: "approval-race" } });
  const raced = await fixture.service.create(retryInput);
  assert.equal(raced.duplicate, true);
  assert.equal(fixture.tasks.size, 3);
  const restarted = createCodingExecutorService({ runtime: fixture.runtime, storage: fixture.storage, ownerId: OWNER, bindings: [{ projectId: "nova-brain", workspaceId: "nova-brain", repository: "hshanbour/nova-brain", branch: "feature" }] });
  const replay = await restarted.create(retryInput);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.task.id, raced.task.id);
  assert.equal(fixture.tasks.size, 3);
});

test("prepared specification remains approval-stable across parent lifecycle changes and rejects semantic mutation", async () => {
  const { service, tasks } = harness({ prepared: true });
  const exact = request({ approval: undefined });
  const validated = await service.validatePrepared(exact);
  assert.equal(validated.specificationHash, codingSpecificationHash(exact));
  Object.assign(tasks.get("parent-1"), { status: "waiting_for_approval", stateVersion: 7, currentPhase: "approval", updatedAt: new Date().toISOString(), approvalState: { approvalId: "approval-1", approved: false } });
  const first = await service.create(request());
  const duplicate = await service.create(request());
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(first.task.metadata.parentTaskId, "parent-1");
  assert.deepEqual(first.task.metadata.codingJob.delivery, { boundary: "local_commit", allowPush: false, allowDeploy: false });
  for (const changed of [
    { objective: "Changed objective." },
    { acceptanceCriteria: ["Different acceptance."] },
    { constraints: ["Different authority."] },
    { repository: { slug: "hshanbour/nova-brain", branch: "feature", baseline: "b".repeat(40) } },
    { delivery: { boundary: "local_commit", allowPush: true, allowDeploy: false } },
    { verification: ["Different verification."] },
  ]) await assert.rejects(service.validatePrepared({ ...exact, ...changed }), error => ["coding_parent_specification_changed", "coding_parent_binding_changed", "coding_delivery_boundary_rejected"].includes(error.code));
});

test("a durable coding delegation routes exactly once to the bounded local Codex worker", async () => {
  const storage = createInMemoryStorage();
  await storage.initialize({ owner: { id: OWNER }, projects: [{ id: "nova-brain", name: "Nova Brain" }] });
  const registry = createToolRegistry();
  const runtime = createWorkerRuntime({ storage, ownerId: OWNER, toolRegistry: registry, approvedBranch: "feature", approvedRepository: "hshanbour/nova-brain" });
  const parent = await runtime.create({ id: "parent-1", title: "Parent", objective: "Coordinate the project.", taskType: "project", projectId: "nova-brain", branch: "feature", startingCommit: BASE });
  const service = createCodingExecutorService({ runtime, storage, ownerId: OWNER, bindings: [{ projectId: "nova-brain", workspaceId: "nova-brain", repository: "hshanbour/nova-brain", branch: "feature" }] });
  const created = await service.create(request({ parentTaskId: parent.id }));
  const dispatch = await createAutoDispatchService({ storage, ownerId: OWNER, approvedBranch: "feature", approvedRepository: "hshanbour/nova-brain" }).next({ workerId: "local-worker", branch: "feature" });
  assert.equal(dispatch.dispatched, true);
  assert.equal(dispatch.task.id, created.task.id);
  assert.equal(dispatch.task.mode, "local_handoff");
  assert.equal(dispatch.task.stepType, "delegate_coding");
  const handoff = await createLocalWorkerHandoff({ storage, ownerId: OWNER, approvedBranch: "feature" }).claim({
    taskId: created.task.id,
    workerId: "local-worker",
    capabilities: ["codex_local"],
    expectedBranch: "feature",
    expectedCommit: BASE,
    repositoryRoot: "C:/bound",
    runtimeVersion: "c".repeat(40),
    idempotencyKey: "coding-claim-1",
  });
  assert.equal(handoff.claimed, true);
  assert.equal(handoff.handoff.tool, "codex_execute");
  assert.ok(Date.parse(handoff.handoff.deadline) - Date.now() > 60 * 60 * 1000);
});

test("coding handoff preserves one canonical durable task ID through progress, execution, and completion", async () => {
  const storage = createInMemoryStorage();
  await storage.initialize({ owner: { id: OWNER }, projects: [{ id: "nova-brain", name: "Nova Brain" }] });
  const runtime = createWorkerRuntime({ storage, ownerId: OWNER, toolRegistry: createToolRegistry(), approvedBranch: "feature", approvedRepository: "hshanbour/nova-brain" });
  const parent = await runtime.create({ id: "parent-1", title: "Parent", objective: "Coordinate the project.", taskType: "project", projectId: "nova-brain", branch: "feature", startingCommit: BASE });
  const service = createCodingExecutorService({ runtime, storage, ownerId: OWNER, bindings: [{ projectId: "nova-brain", workspaceId: "nova-brain", repository: "hshanbour/nova-brain", branch: "feature" }] });
  const created = await service.create(request({ parentTaskId: parent.id }));
  const dispatch = createAutoDispatchService({ storage, ownerId: OWNER, approvedBranch: "feature", approvedRepository: "hshanbour/nova-brain" });
  const handoffs = createLocalWorkerHandoff({ storage, ownerId: OWNER, approvedBranch: "feature" });
  const calls = [];
  const client = { async request(path, body) {
    calls.push({ path, body });
    if (path.endsWith("/next")) return dispatch.next(body);
    if (path.endsWith("/claim")) return handoffs.claim(body);
    const progress = path.match(/^\/api\/admin\/coding-jobs\/([^/]+)\/progress$/);
    if (progress) return service.progress(decodeURIComponent(progress[1]), body);
    const complete = path.match(/^\/api\/admin\/worker\/handoff\/([^/]+)\/complete$/);
    if (complete) return handoffs.complete(decodeURIComponent(complete[1]), body);
    const fail = path.match(/^\/api\/admin\/worker\/handoff\/([^/]+)\/fail$/);
    if (fail) return handoffs.fail(decodeURIComponent(fail[1]), body);
    throw new Error(`Unexpected request: ${path}`);
  } };
  let executionContext = null;
  const report = createCodingProgressReporter(client);
  const registry = { async execute(name, _job, context) {
    assert.equal(name, "codex_execute");
    executionContext = context;
    await report({ context, phase: "inspecting", summary: "Codex is inspecting the bound project." });
    return { ok: true, status: "completed", summary: "Done", finalLocalSha: "b".repeat(40), filesChanged: ["src/a.js"], tests: [], limitations: [], pushOccurred: false, deploymentOccurred: false, approvalsRequiredNext: ["push"] };
  } };
  const worker = createPersistentLocalWorker({ client, root: "C:/bound", repository: "hshanbour/nova-brain", branch: "feature", runtimeVersion: "c".repeat(40), workerId: "local-worker", registry });
  const completed = await worker.runOnce();
  assert.equal(completed.status, "queued");
  assert.equal(executionContext.taskId, created.task.id);
  assert.equal(calls.find((call) => call.path.includes("/coding-jobs/")).path, `/api/admin/coding-jobs/${created.task.id}/progress`);
  assert.equal(calls.find((call) => call.path.endsWith("/complete")).body.taskId, created.task.id);
  assert.equal((await runtime.get(created.task.id)).metadata.parentTaskId, parent.id);
  assert.equal((await runtime.steps(created.task.id))[0].status, "completed");
});

test("invalid coding task identity fails before progress or Codex execution", async () => {
  let requested = false;
  const report = createCodingProgressReporter({ async request() { requested = true; } });
  await assert.rejects(report({ context: { taskId: undefined, handoffId: "handoff" }, phase: "inspecting", summary: "Inspecting." }), (error) => error.code === "coding_task_identity_invalid");
  await assert.rejects(report({ context: { taskId: "[object Object]", handoffId: "handoff" }, phase: "inspecting", summary: "Inspecting." }), (error) => error.code === "coding_task_identity_invalid");
  assert.equal(requested, false);
  const registry = createToolRegistry();
  let executed = false;
  registerCodexExecutorTool(registry, { root: "C:/bound", repository: "hshanbour/nova-brain", branch: "feature", runner: async () => { executed = true; } });
  await assert.rejects(registry.execute("codex_execute", request(), { taskId: null }), (error) => error.code === "coding_task_identity_invalid");
  assert.equal(executed, false);
});

test("invalid claimed coding identity fails its handoff before executor launch", async () => {
  const calls = [];
  let executed = false;
  const task = { id: "not-a-coding-task", branch: "feature", expectedCommit: BASE, stateVersion: 1, mode: "local_handoff", stepType: "delegate_coding" };
  const client = { async request(path, body) {
    calls.push({ path, body });
    if (path.endsWith("/next")) return { dispatched: true, task };
    if (path.endsWith("/claim")) return { claimed: true, handoff: { handoffId: "handoff-1", taskId: task.id, stepId: "1:delegate_coding", stepType: "delegate_coding", branch: "feature", expectedCommit: BASE, tool: "codex_execute", arguments: request() } };
    if (path.endsWith("/fail")) return { status: "failed" };
    throw new Error(`Unexpected request: ${path}`);
  } };
  const worker = createPersistentLocalWorker({ client, root: "C:/bound", repository: "hshanbour/nova-brain", branch: "feature", workerId: "local-worker", registry: { async execute() { executed = true; } } });
  await assert.rejects(worker.runOnce(), (error) => error.code === "coding_task_identity_invalid");
  assert.equal(executed, false);
  assert.equal(calls.find((call) => call.path.endsWith("/fail")).body.taskId, task.id);
  assert.equal(calls.find((call) => call.path.endsWith("/fail")).body.error.code, "coding_task_identity_invalid");
});

test("coding delegation rejects untrusted repository, Main, stale parent, unapproved mutation, and identity conflicts", async () => {
  const { service, tasks } = harness();
  await assert.rejects(service.create(request({ repository: { slug: "other/repo", branch: "feature", baseline: BASE } })), (error) => error.code === "coding_repository_binding_rejected");
  await assert.rejects(service.create(request({ repository: { slug: "hshanbour/nova-brain", branch: "main", baseline: BASE } })), (error) => error.code === "coding_repository_binding_rejected");
  await assert.rejects(service.create(request({ approval: { buildApproved: false, approvalId: "approval-1" } })), (error) => error.code === "coding_build_approval_required");
  await assert.rejects(service.create(request({ delivery: { boundary: "production", allowPush: true, allowDeploy: true } })), (error) => error.code === "coding_delivery_boundary_rejected");
  const first = await service.create(request());
  Object.assign(tasks.get(first.task.id), { status: "failed", stateVersion: 3 });
  await assert.rejects(service.create(request({ objective: "A different objective." })), (error) => error.code === "coding_job_identity_conflict");
});

test("structured executor results survive restart and active cancellation fails closed", async () => {
  const { service, tasks, steps, activities } = harness();
  const created = await service.create(request());
  const task = tasks.get(created.task.id);
  task.status = "running";
  task.leaseOwner = "local:worker";
  task.leaseToken = "opaque";
  await assert.rejects(service.cancel(task.id), (error) => error.code === "coding_job_active_not_cancellable");
  task.metadata.localHandoff = { id: "handoff-1" };
  await service.progress(task.id, { handoffId: "handoff-1", phase: "implementing", summary: "Codex is implementing the approved change." });
  assert.equal(activities.at(-1).action, "coding_executor_implementing");
  await assert.rejects(service.progress(task.id, { handoffId: "wrong", phase: "testing", summary: "Testing." }), (error) => error.code === "coding_progress_stale");
  task.status = "completed";
  task.leaseOwner = null;
  task.leaseToken = null;
  steps.set(task.id, [{ stepType: "delegate_coding", status: "completed", result: { status: "completed", summary: "Done", finalLocalSha: "b".repeat(40), filesChanged: ["src/a.js"], tests: [{ command: "npm test", status: "passed" }], limitations: [], pushOccurred: false, deploymentOccurred: false, approvalsRequiredNext: ["push"] } }]);
  const restarted = createCodingExecutorService({ runtime: { ...service, get: async (id) => structuredClone(tasks.get(id)), steps: async (id) => structuredClone(steps.get(id) || []), create: async () => { throw new Error("unused"); }, control: async () => { throw new Error("unused"); } }, storage: { getAutonomyTask: async (id) => structuredClone(tasks.get(id) || null) }, ownerId: OWNER, bindings: [{ projectId: "nova-brain", workspaceId: "nova-brain", repository: "hshanbour/nova-brain", branch: "feature" }] });
  const value = await restarted.get(task.id);
  assert.equal(value.result.finalLocalSha, "b".repeat(40));
  assert.equal(value.result.pushOccurred, false);
  assert.equal(value.result.deploymentOccurred, false);
  assert.deepEqual(value.result.approvalsRequiredNext, ["push"]);
});

test("Codex CLI runner binds repository, strips secrets, verifies the local commit, and reports only measured usage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nova-codex-runner-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runFile("git", ["init", "-b", "feature"], { cwd: root });
  await runFile("git", ["config", "user.email", "nova@example.invalid"], { cwd: root });
  await runFile("git", ["config", "user.name", "Nova Test"], { cwd: root });
  await writeFile(join(root, "source.js"), "export const value = 1;\n");
  await runFile("git", ["add", "source.js"], { cwd: root });
  await runFile("git", ["commit", "-m", "baseline"], { cwd: root });
  await runFile("git", ["remote", "add", "origin", "https://github.com/hshanbour/nova-brain.git"], { cwd: root });
  const baseline = (await runFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const gitExecutable = process.platform === "win32" ? (await runFile("where.exe", ["git"])).stdout.split(/\r?\n/).find(Boolean) : (await runFile("which", ["git"])).stdout.trim();
  let observed;
  const runner = createCodexCliRunner({
    executable: process.execPath,
    gitExecutable,
    environment: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, OPENAI_API_KEY: "must-not-leak" },
    async authProcess(command, args) { assert.equal(command, process.execPath);assert.deepEqual(args, ["login", "status"]);return { stdout: "", stderr: "", code: 0 }; },
    async spawnProcess(command, args, options) {
      observed = { command, args, env: options.env, input: options.input };
      await writeFile(join(root, "source.js"), "export const value = 2;\n");
      await runFile("git", ["add", "source.js"], { cwd: root });
      await runFile("git", ["commit", "-m", "implement change"], { cwd: root });
      const finalSha = (await runFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
      const output = { status: "completed", summary: "Implemented and tested.", repository: "hshanbour/nova-brain", baseline, finalLocalSha: finalSha, filesChanged: ["source.js"], tests: [{ command: "node --test", status: "passed", summary: null }], limitations: [], pushOccurred: false, deploymentOccurred: false, approvalsRequiredNext: ["push"], failure: null };
      await writeFile(args[args.indexOf("--output-last-message") + 1], JSON.stringify(output));
      options.onLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 25 } }));
      return { stdout: "", stderr: "", code: 0 };
    },
  });
  const result = await runner(request({ repository: { slug: "hshanbour/nova-brain", branch: "feature", baseline } }), { root, repository: "hshanbour/nova-brain", branch: "feature" });
  assert.equal(result.status, "completed");
  assert.equal(observed.command, process.execPath);
  assert.deepEqual(result.filesChanged, ["source.js"]);
  assert.deepEqual(result.usage, { input_tokens: 100, output_tokens: 25 });
  assert.equal(result.executor.billing, "codex_account_separate_from_nova_api_budget");
  assert.equal("OPENAI_API_KEY" in observed.env, false);
  assert.doesNotMatch(observed.input, /must-not-leak/);
  assert.ok(observed.args.includes("--ephemeral"));
  assert.ok(observed.args.includes("--ignore-user-config"));
  assert.ok(observed.args.includes("workspace-write"));
});

test("executor preflight fails safely for missing executables, workspace, or authentication", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nova-codex-preflight-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = join(root, "missing.exe"), missingWorkspace = join(root, "missing-workspace");
  const base = { executable: process.execPath, gitExecutable: process.execPath, authProcess: async () => ({ stdout: "", stderr: "", code: 0 }), spawnProcess: async () => { throw new Error("must not launch"); }, gitProcess: async () => { throw new Error("must not launch"); } };
  await assert.rejects(createCodexCliRunner({ ...base, executable: missing })(request(), { root, repository: "hshanbour/nova-brain", branch: "feature" }), (error) => error.code === "coding_executor_codex_executable_missing");
  await assert.rejects(createCodexCliRunner({ ...base, gitExecutable: missing })(request(), { root, repository: "hshanbour/nova-brain", branch: "feature" }), (error) => error.code === "coding_executor_git_executable_missing");
  await assert.rejects(createCodexCliRunner(base)(request(), { root: missingWorkspace, repository: "hshanbour/nova-brain", branch: "feature" }), (error) => error.code === "coding_executor_workspace_missing");
  let launched = false;
  const authFailure = createCodexCliRunner({ ...base, authProcess: async () => { throw Object.assign(new Error("not logged in"), { safeDiagnostics: { exitCode: 1 } }); }, spawnProcess: async () => { launched = true; } });
  await assert.rejects(authFailure(request(), { root, repository: "hshanbour/nova-brain", branch: "feature" }), (error) => error.code === "coding_executor_auth_unavailable" && error.safeDiagnostics.exitCode === 1);
  assert.equal(launched, false);
});

test("Codex tool fails closed with a machine-readable result without broad authority", async () => {
  const registry = createToolRegistry();
  registerCodexExecutorTool(registry, { root: "C:/bound", repository: "hshanbour/nova-brain", branch: "feature", runner: async () => ({ status: "blocked", summary: "Tests failed.", repository: "hshanbour/nova-brain", baseline: BASE, finalLocalSha: null, filesChanged: [], tests: [{ command: "npm test", status: "failed" }], limitations: ["Repair requires user approval."], pushOccurred: false, deploymentOccurred: false, approvalsRequiredNext: ["retry"], failure: { code: "tests_failed", message: "Focused tests failed." } }) });
  await assert.rejects(registry.execute("codex_execute", request(), { taskId: "coding_" + "a".repeat(32) }), (error) => {
    assert.equal(error.code, "tests_failed");
    assert.equal(error.safeDiagnostics.codingResult.status, "blocked");
    assert.equal(error.safeDiagnostics.codingResult.pushOccurred, false);
    assert.equal(error.safeDiagnostics.codingResult.deploymentOccurred, false);
    return true;
  });
});
