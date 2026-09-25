import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodingExecutorService } from "../src/autonomy/coding-executor.js";
import { createCodexCliRunner, registerCodexExecutorTool } from "../src/tools/codex-executor-tool.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";
import { createWorkerRuntime } from "../src/autonomy/worker-runtime.js";
import { createAutoDispatchService } from "../src/autonomy/auto-dispatch.js";
import { createLocalWorkerHandoff } from "../src/autonomy/local-worker-handoff.js";

const runFile = promisify(execFile);
const OWNER = "owner";
const BASE = "a".repeat(40);

function harness() {
  const tasks = new Map([["parent-1", { id: "parent-1", ownerId: OWNER, projectId: "nova-brain", branch: "feature", currentCommit: BASE, status: "planning" }]]);
  const steps = new Map();
  const activities = [];
  const storage = {
    async getAutonomyTask(id) { return structuredClone(tasks.get(id) || null); },
    async appendActivity(value) { activities.push(structuredClone(value)); return value; },
  };
  const runtime = {
    async create(input) {
      const task = { ...structuredClone(input), status: "queued", stateVersion: 1, currentCommit: input.startingCommit, currentStep: 0, checkpoint: {} };
      tasks.set(task.id, task);
      steps.set(task.id, []);
      return structuredClone(task);
    },
    async get(id) { const task = tasks.get(id); if (!task) throw new Error("missing"); return structuredClone(task); },
    async steps(id) { return structuredClone(steps.get(id) || []); },
    async control(id, action) { const task = tasks.get(id); task.status = action === "cancel" ? "cancelled" : task.status; return structuredClone(task); },
  };
  const service = createCodingExecutorService({ runtime, storage, ownerId: OWNER, bindings: [{ projectId: "nova-brain", workspaceId: "nova-brain", repository: "hshanbour/nova-brain", branch: "feature" }] });
  return { service, tasks, steps, activities };
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

test("coding delegation rejects untrusted repository, Main, stale parent, unapproved mutation, and identity conflicts", async () => {
  const { service } = harness();
  await assert.rejects(service.create(request({ repository: { slug: "other/repo", branch: "feature", baseline: BASE } })), (error) => error.code === "coding_repository_binding_rejected");
  await assert.rejects(service.create(request({ repository: { slug: "hshanbour/nova-brain", branch: "main", baseline: BASE } })), (error) => error.code === "coding_repository_binding_rejected");
  await assert.rejects(service.create(request({ approval: { buildApproved: false, approvalId: "approval-1" } })), (error) => error.code === "coding_build_approval_required");
  await assert.rejects(service.create(request({ delivery: { boundary: "production", allowPush: true, allowDeploy: true } })), (error) => error.code === "coding_delivery_boundary_rejected");
  await service.create(request());
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
  let observed;
  const runner = createCodexCliRunner({
    environment: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, OPENAI_API_KEY: "must-not-leak" },
    async spawnProcess(_command, args, options) {
      observed = { args, env: options.env, input: options.input };
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
  assert.deepEqual(result.filesChanged, ["source.js"]);
  assert.deepEqual(result.usage, { input_tokens: 100, output_tokens: 25 });
  assert.equal(result.executor.billing, "codex_account_separate_from_nova_api_budget");
  assert.equal("OPENAI_API_KEY" in observed.env, false);
  assert.doesNotMatch(observed.input, /must-not-leak/);
  assert.ok(observed.args.includes("--ephemeral"));
  assert.ok(observed.args.includes("--ignore-user-config"));
  assert.ok(observed.args.includes("workspace-write"));
});

test("Codex tool fails closed with a machine-readable result without broad authority", async () => {
  const registry = createToolRegistry();
  registerCodexExecutorTool(registry, { root: "C:/bound", repository: "hshanbour/nova-brain", branch: "feature", runner: async () => ({ status: "blocked", summary: "Tests failed.", repository: "hshanbour/nova-brain", baseline: BASE, finalLocalSha: null, filesChanged: [], tests: [{ command: "npm test", status: "failed" }], limitations: ["Repair requires user approval."], pushOccurred: false, deploymentOccurred: false, approvalsRequiredNext: ["retry"], failure: { code: "tests_failed", message: "Focused tests failed." } }) });
  await assert.rejects(registry.execute("codex_execute", request(), {}), (error) => {
    assert.equal(error.code, "tests_failed");
    assert.equal(error.safeDiagnostics.codingResult.status, "blocked");
    assert.equal(error.safeDiagnostics.codingResult.pushOccurred, false);
    assert.equal(error.safeDiagnostics.codingResult.deploymentOccurred, false);
    return true;
  });
});
