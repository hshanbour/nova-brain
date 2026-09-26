import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { codingSpecificationHash, createCodingExecutorService, immutableCodingSpecification } from "../src/autonomy/coding-executor.js";
import { createCodexCliRunner, registerCodexExecutorTool, runCodexProcess } from "../src/tools/codex-executor-tool.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";
import { createWorkerRuntime } from "../src/autonomy/worker-runtime.js";
import { createAutoDispatchService } from "../src/autonomy/auto-dispatch.js";
import { createLocalWorkerHandoff } from "../src/autonomy/local-worker-handoff.js";
import { createCodingProgressReporter, createPersistentLocalWorker } from "../src/autonomy/persistent-local-worker.js";

const runFile = promisify(execFile);
const OWNER = "owner";
const BASE = "a".repeat(40);

function assertStrictOutputSchema(schema, path = "result") {
  if (Array.isArray(schema?.anyOf)) schema.anyOf.forEach((entry, index) => assertStrictOutputSchema(entry, `${path}.anyOf[${index}]`));
  if (schema?.type === "object") {
    assert.equal(schema.additionalProperties, false, `${path}.additionalProperties`);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${path}.required`);
    for (const [name, property] of Object.entries(schema.properties)) assertStrictOutputSchema(property, `${path}.${name}`);
  }
  if (schema?.type === "array") assertStrictOutputSchema(schema.items, `${path}[]`);
}

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

test("compact creation handles reload one canonical stored job and ignore lifecycle-only parent changes", async () => {
  const fixture = harness({ prepared: true });
  const canonical = fixture.tasks.get("parent-1").metadata.codingDelegation.codingJob;
  const handle = { parentTaskId: "parent-1", specificationHash: codingSpecificationHash(canonical) };
  assert.deepEqual(await fixture.service.validateCreationHandle(handle), { ok: true, specificationHash: handle.specificationHash });
  Object.assign(fixture.tasks.get("parent-1"), {
    status: "waiting_for_approval",
    stateVersion: 9,
    currentPhase: "approval",
    updatedAt: "2026-09-25T12:00:00.000Z",
    approvalState: { approvalId: "approval-handle", approved: false },
  });
  const restarted = createCodingExecutorService({ runtime: fixture.runtime, storage: fixture.storage, ownerId: OWNER, bindings: [{ projectId: "nova-brain", workspaceId: "nova-brain", repository: "hshanbour/nova-brain", branch: "feature" }] });
  const first = await restarted.createFromHandle(handle, { approvalId: "approval-handle" });
  const duplicate = await restarted.createFromHandle(handle, { approvalId: "approval-handle" });
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(first.task.id, duplicate.task.id);
  assert.equal(first.task.metadata.codingJob.objective, canonical.objective);
  assert.equal(first.task.metadata.codingJob.approval.approvalId, "approval-handle");
  assert.deepEqual(first.task.metadata.steps[0].input.arguments, first.task.metadata.codingJob);
  assert.equal(fixture.tasks.size, 2);
});

test("compact creation handles fail closed for malformed, unknown, mismatched, or mutated canonical specifications", async () => {
  const fixture = harness({ prepared: true });
  const parent = fixture.tasks.get("parent-1"), canonical = parent.metadata.codingDelegation.codingJob;
  const handle = { parentTaskId: "parent-1", specificationHash: codingSpecificationHash(canonical) };
  await assert.rejects(fixture.service.validateCreationHandle({ parentTaskId: "parent-1" }), error => error.code === "coding_creation_handle_invalid" && error.safeDiagnostics?.fieldPath === "coding_job_create.specificationHash");
  await assert.rejects(fixture.service.validateCreationHandle({ ...handle, extra: "forbidden" }), error => error.code === "coding_creation_handle_invalid" && error.safeDiagnostics?.validationCode === "unsupported_field" && error.safeDiagnostics.argumentKeys.includes("extra"));
  await assert.rejects(fixture.service.validateCreationHandle({ ...handle, parentTaskId: "missing-parent" }), error => error.code === "coding_parent_task_not_found");
  await assert.rejects(fixture.service.validateCreationHandle({ ...handle, specificationHash: "b".repeat(64) }), error => error.code === "coding_parent_specification_changed");
  parent.metadata.codingDelegation.codingJob = { ...canonical, objective: "Mutated objective." };
  await assert.rejects(fixture.service.validateCreationHandle(handle), error => error.code === "coding_parent_specification_changed" && error.safeDiagnostics?.validationCode === "stored_specification_hash_mismatch");
  assert.equal(fixture.tasks.size, 1);
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

test("nonterminal progress stays separate while a structured Codex terminal result survives handoff failure intact", async () => {
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
  const codingResult = {
    status: "blocked",
    summary: "Focused verification could not complete.",
    repository: "hshanbour/nova-brain",
    baseline: BASE,
    finalLocalSha: null,
    filesChanged: [],
    tests: [{ command: "npm test", status: "failed", summary: "One focused assertion failed." }],
    limitations: ["A bounded repair needs a fresh decision."],
    pushOccurred: false,
    deploymentOccurred: false,
    approvalsRequiredNext: ["retry"],
    failure: { code: "tests_failed", message: "Focused tests failed." },
  };
  const registry = createToolRegistry();
  registerCodexExecutorTool(registry, {
    root: "C:/bound",
    repository: "hshanbour/nova-brain",
    branch: "feature",
    runner: async () => structuredClone(codingResult),
    activity: createCodingProgressReporter(client),
  });
  const worker = createPersistentLocalWorker({ client, root: "C:/bound", repository: "hshanbour/nova-brain", branch: "feature", runtimeVersion: "c".repeat(40), workerId: "local-worker", registry });
  await assert.rejects(worker.runOnce(), (error) => error.code === "tests_failed");
  const progressCalls = calls.filter((call) => call.path.includes("/coding-jobs/"));
  assert.deepEqual(progressCalls.map((call) => call.body.phase), ["inspecting"]);
  assert.equal(progressCalls.some((call) => ["blocked", "failed", "cancelled"].includes(call.body.phase)), false);
  assert.equal(calls.some((call) => call.path.endsWith("/complete")), false);
  const failure = calls.find((call) => call.path.endsWith("/fail"));
  assert.equal(failure.body.error.code, "tests_failed");
  assert.deepEqual(failure.body.error.diagnostics.codingResult, codingResult);
  const task = await runtime.get(created.task.id);
  const [step] = await runtime.steps(created.task.id);
  assert.equal(task.status, "failed");
  assert.equal(step.status, "failed");
  assert.deepEqual(step.result.diagnostics.codingResult, codingResult);
});

test("invalid coding task identity fails before progress or Codex execution", async () => {
  let requested = false;
  const report = createCodingProgressReporter({ async request() { requested = true; } });
  await assert.rejects(report({ context: { taskId: undefined, handoffId: "handoff" }, phase: "inspecting", summary: "Inspecting." }), (error) => error.code === "coding_task_identity_invalid");
  await assert.rejects(report({ context: { taskId: "[object Object]", handoffId: "handoff" }, phase: "inspecting", summary: "Inspecting." }), (error) => error.code === "coding_task_identity_invalid");
  for (const phase of ["blocked", "failed", "cancelled"]) await assert.rejects(report({ context: { taskId: `coding_${"a".repeat(32)}`, handoffId: "handoff" }, phase, summary: "Terminal." }), (error) => error.code === "coding_progress_invalid");
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

test("Codex CLI runner projects verified owner approval, emits a strict-compatible schema, and reaches a structured terminal result", async (t) => {
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
  await writeFile(join(root, "local-only.js"), "export const localOnly = true;\n");
  await runFile("git", ["add", "local-only.js"], { cwd: root });
  await runFile("git", ["commit", "-m", "newer local checkout"], { cwd: root });
  const sourceHead = (await runFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const gitExecutable = process.platform === "win32" ? (await runFile("where.exe", ["git"])).stdout.split(/\r?\n/).find(Boolean) : (await runFile("which", ["git"])).stdout.trim();
  let observed;
  const runner = createCodexCliRunner({
    executable: process.execPath,
    gitExecutable,
    environment: { PATH: process.platform === "win32" ? `${process.env.SYSTEMROOT}\\System32` : "/usr/bin", PATHEXT: process.env.PATHEXT, SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP, USERPROFILE: process.env.USERPROFILE, HOMEDRIVE: process.env.HOMEDRIVE, HOMEPATH: process.env.HOMEPATH, LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA, CODEX_HOME: process.env.CODEX_HOME, UNTRUSTED_TOOL_DIRECTORY: join(root, "untrusted-tools"), OPENAI_API_KEY: "must-not-leak", GITHUB_TOKEN: "must-not-leak", VERCEL_TOKEN: "must-not-leak" },
    async authProcess(command, args) { assert.equal(command, process.execPath);assert.deepEqual(args, ["login", "status"]);return { stdout: "", stderr: "", code: 0 }; },
    async spawnProcess(command, args, options) {
      const schema = JSON.parse(await readFile(args[args.indexOf("--output-schema") + 1], "utf8"));
      assertStrictOutputSchema(schema);
      observed = { command, args, env: options.env, input: options.input, cwd: options.cwd, schema };
      assert.notEqual(options.cwd, root);
      assert.equal((await runFile("git", ["rev-parse", "HEAD"], { cwd: options.cwd })).stdout.trim(), baseline);
      assert.equal((await runFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: options.cwd })).stdout.trim(), "HEAD");
      assert.equal((await runFile("git", ["status", "--short", "--branch"], { cwd: options.cwd, env: options.env })).stdout.includes("HEAD"), true);
      await assert.rejects(readFile(join(options.cwd, "local-only.js")));
      await writeFile(join(options.cwd, "source.js"), "export const value = 2;\n");
      await runFile("git", ["add", "source.js"], { cwd: options.cwd });
      await runFile("git", ["commit", "-m", "implement change"], { cwd: options.cwd });
      const finalSha = (await runFile("git", ["rev-parse", "HEAD"], { cwd: options.cwd })).stdout.trim();
      const output = { status: "completed", summary: "Implemented and tested.", repository: "hshanbour/nova-brain", baseline, finalLocalSha: finalSha, filesChanged: ["source.js"], tests: [{ command: "node --test", status: "passed", summary: null }], limitations: [], pushOccurred: false, deploymentOccurred: false, approvalsRequiredNext: ["push"], failure: null };
      await writeFile(args[args.indexOf("--output-last-message") + 1], JSON.stringify(output));
      options.onLine(JSON.stringify({ type: "turn.started" }));
      options.onLine(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "git status" } }));
      options.onLine(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "npm test" } }));
      options.onLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 25 } }));
      return { stdout: "", stderr: "", code: 0 };
    },
  });
  const taskId = `coding_${"c".repeat(32)}`;
  const progress = [];
  const result = await runner(request({
    repository: { slug: "hshanbour/nova-brain", branch: "feature", baseline },
    constraints: ["Stop before Codex starts unless and until the normal owner-approval process authorises it."],
  }), { root, repository: "hshanbour/nova-brain", branch: "feature", taskId, onProgress: (phase, summary) => progress.push({ phase, summary }) });
  assert.equal(result.status, "completed");
  assert.equal(observed.command, process.execPath);
  assert.deepEqual(observed.schema.properties.tests.items.required, ["command", "status", "summary"]);
  assert.deepEqual(observed.schema.properties.tests.items.properties.summary.type, ["string", "null"]);
  assert.deepEqual(result.filesChanged, ["source.js"]);
  assert.deepEqual(result.usage, { input_tokens: 100, output_tokens: 25 });
  assert.equal(result.executor.billing, "codex_account_separate_from_nova_api_budget");
  assert.deepEqual(progress.map(({ phase }) => phase), ["inspecting", "implementing", "testing"]);
  assert.equal("OPENAI_API_KEY" in observed.env, false);
  assert.equal("GITHUB_TOKEN" in observed.env, false);
  assert.equal("VERCEL_TOKEN" in observed.env, false);
  assert.equal("UNTRUSTED_TOOL_DIRECTORY" in observed.env, false);
  const projected = JSON.parse(observed.input);
  assert.deepEqual(projected.executionAuthorization, { ownerApprovalVerified: true });
  assert.equal("approval" in projected, false);
  assert.doesNotMatch(observed.input, /approval-1/);
  assert.match(projected.constraints[0], /Stop before Codex starts/);
  assert.equal(observed.env.PATH.split(delimiter)[0].toLowerCase(), dirname(gitExecutable).toLowerCase());
  assert.equal(observed.env.PATH.includes(join(root, "untrusted-tools")), false);
  assert.doesNotMatch(observed.input, /must-not-leak/);
  assert.ok(observed.args.includes("--ephemeral"));
  assert.ok(observed.args.includes("--ignore-user-config"));
  assert.ok(observed.args.includes("--approve-for-me"));
  assert.equal(observed.args.includes("--sandbox"), false);
  assert.equal(observed.args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  assert.equal(observed.args.includes("--add-dir"), false);
  const config = observed.args.filter((value, index) => observed.args[index - 1] === "-c");
  assert.ok(config.includes('shell_environment_policy.inherit="all"'));
  assert.ok(config.includes("shell_environment_policy.ignore_default_excludes=false"));
  for (const name of ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA"]) {
    assert.ok(config.includes(`shell_environment_policy.filters.${name}="include"`), name);
  }
  assert.equal(config.some((value) => /CODEX_HOME|OPENAI|GITHUB|VERCEL|TOKEN|SECRET|KEY/i.test(value)), false);
  assert.equal((await runFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim(), sourceHead);
  assert.equal((await runFile("git", ["status", "--porcelain=v1"], { cwd: root })).stdout.trim(), "");
  assert.equal((await runFile("git", ["rev-parse", `refs/nova/coding-jobs/${taskId}`], { cwd: root })).stdout.trim(), result.finalLocalSha);
  assert.equal(result.executor.localRef, `refs/nova/coding-jobs/${taskId}`);
  assert.equal(((await runFile("git", ["worktree", "list", "--porcelain"], { cwd: root })).stdout.match(/^worktree /gm) || []).length, 1);
});

test("Codex CLI runner fails closed before launch when server-verified owner approval is absent", async () => {
  let launched = false;
  const runner = createCodexCliRunner({
    executable: process.execPath,
    gitExecutable: process.execPath,
    async spawnProcess() { launched = true; throw new Error("must not launch"); },
  });
  await assert.rejects(
    runner(request({ approval: undefined, ownerApprovalVerified: true }), {
      root: process.cwd(),
      repository: "hshanbour/nova-brain",
      branch: "feature",
      taskId: `coding_${"d".repeat(32)}`,
    }),
    (error) => error.code === "coding_executor_owner_approval_unverified"
      && error.safeDiagnostics.stage === "approval_preflight"
      && error.safeDiagnostics.executorLaunched === false,
  );
  assert.equal(launched, false);
});

test("Codex process failures retain only bounded JSONL stage and error categories", async () => {
  const script = [
    `console.log(JSON.stringify({type:"thread.started"}))`,
    `console.log(JSON.stringify({type:"turn.started"}))`,
    `console.log(JSON.stringify({type:"item.completed",item:{type:"command_execution",command:"git status"}}))`,
    `console.log(JSON.stringify({type:"turn.failed",error:{type:"model_error",code:"request_failed",param:"model",message:"secret source content must not persist"}}))`,
    `process.exit(1)`,
  ].join(";");
  await assert.rejects(
    runCodexProcess(process.execPath, ["-e", script]),
    (error) => {
      assert.equal(error.code, "coding_executor_failed");
      assert.equal(error.safeDiagnostics.exitCode, 1);
      assert.equal(error.safeDiagnostics.exitCategory, "process_exit_nonzero");
      assert.equal(error.safeDiagnostics.resultCategory, "structured_result_unavailable");
      assert.equal(error.safeDiagnostics.executorLaunched, true);
      assert.equal(error.safeDiagnostics.stderrBytes, 0);
      assert.ok(error.safeDiagnostics.stdoutBytes > 0);
      assert.equal(error.safeDiagnostics.jsonlEventCount, 4);
      assert.equal(error.safeDiagnostics.jsonlParseErrors, 0);
      assert.equal(error.safeDiagnostics.lastEventType, "turn.failed");
      assert.equal(error.safeDiagnostics.lastItemType, "command_execution");
      assert.equal(error.safeDiagnostics.executorStage, "turn_failed");
      assert.equal(error.safeDiagnostics.lastSuccessfulStage, "repository_command");
      assert.equal(error.safeDiagnostics.commandEvents, 1);
      assert.equal(error.safeDiagnostics.fileChangeEvents, 0);
      assert.equal(error.safeDiagnostics.testCommandEvents, 0);
      assert.equal(error.safeDiagnostics.errorType, "model_error");
      assert.equal(error.safeDiagnostics.errorCode, "request_failed");
      assert.equal(error.safeDiagnostics.errorParam, "model");
      assert.equal(error.safeDiagnostics.errorCategory, "turn.failed");
      assert.equal(error.safeDiagnostics.errorMessage, null);
      assert.doesNotMatch(JSON.stringify(error.safeDiagnostics), /secret source content/);
      return true;
    },
  );
});

test("Codex process failures retain bounded string and item error messages without raw payloads or secrets", async () => {
  const longMessage = "x".repeat(500);
  const stringScript = [
    `console.log(JSON.stringify({type:"turn.started"}))`,
    `console.log(JSON.stringify({type:"turn.failed",error:"Provider connection was interrupted."}))`,
    `process.exit(1)`,
  ].join(";");
  await assert.rejects(
    runCodexProcess(process.execPath, ["-e", stringScript]),
    (error) => {
      assert.equal(error.safeDiagnostics.lastEventType, "turn.failed");
      assert.equal(error.safeDiagnostics.lastItemType, null);
      assert.equal(error.safeDiagnostics.executorStage, "turn_failed");
      assert.equal(error.safeDiagnostics.errorCategory, "turn.failed");
      assert.equal(error.safeDiagnostics.errorMessage, "Provider connection was interrupted.");
      assert.ok(error.safeDiagnostics.errorMessage.length <= 300);
      return true;
    },
  );

  const objectScript = `console.log(JSON.stringify({type:"item.completed",item:{type:"error",error:{category:"provider",type:"upstream_error",code:"request_failed",param:"model",message:"Provider request failed."}}}));process.exit(1)`;
  await assert.rejects(
    runCodexProcess(process.execPath, ["-e", objectScript]),
    (error) => {
      assert.equal(error.safeDiagnostics.lastEventType, "item.completed");
      assert.equal(error.safeDiagnostics.lastItemType, "error");
      assert.equal(error.safeDiagnostics.errorCategory, "provider");
      assert.equal(error.safeDiagnostics.errorType, "upstream_error");
      assert.equal(error.safeDiagnostics.errorCode, "request_failed");
      assert.equal(error.safeDiagnostics.errorParam, "model");
      assert.equal(error.safeDiagnostics.errorMessage, "Provider request failed.");
      return true;
    },
  );

  const boundedScript = `console.log(JSON.stringify({type:"item.completed",item:{type:"error",message:${JSON.stringify(longMessage)}}}));process.exit(1)`;
  await assert.rejects(
    runCodexProcess(process.execPath, ["-e", boundedScript]),
    (error) => {
      assert.equal(error.safeDiagnostics.errorCategory, "item.completed");
      assert.equal(error.safeDiagnostics.errorMessage.length, 300);
      assert.equal(error.safeDiagnostics.errorMessage, "x".repeat(300));
      return true;
    },
  );

  const secretScript = `console.log(JSON.stringify({type:"error",error:{message:"token=must-not-persist"}}));process.exit(1)`;
  await assert.rejects(
    runCodexProcess(process.execPath, ["-e", secretScript]),
    (error) => {
      assert.equal(error.safeDiagnostics.errorMessage, null);
      assert.doesNotMatch(JSON.stringify(error.safeDiagnostics), /must-not-persist/);
      return true;
    },
  );

  const payloadScript = `console.log(JSON.stringify({type:"turn.failed",error:"{\\\"upstream\\\":\\\"body\\\"}"}));process.exit(1)`;
  await assert.rejects(
    runCodexProcess(process.execPath, ["-e", payloadScript]),
    (error) => {
      assert.equal(error.safeDiagnostics.errorMessage, null);
      assert.doesNotMatch(JSON.stringify(error.safeDiagnostics), /upstream|body/);
      return true;
    },
  );
});

test("executor preflight fails safely for missing executables, workspace, or authentication", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nova-codex-preflight-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = join(root, "missing.exe"), missingWorkspace = join(root, "missing-workspace");
  const base = { executable: process.execPath, gitExecutable: process.execPath, authProcess: async () => ({ stdout: "", stderr: "", code: 0 }), spawnProcess: async () => { throw new Error("must not launch"); }, gitProcess: async () => { throw new Error("must not launch"); } };
  const taskId = `coding_${"d".repeat(32)}`;
  await assert.rejects(createCodexCliRunner({ ...base, executable: missing })(request(), { root, repository: "hshanbour/nova-brain", branch: "feature", taskId }), (error) => error.code === "coding_executor_codex_executable_missing");
  await assert.rejects(createCodexCliRunner({ ...base, gitExecutable: missing })(request(), { root, repository: "hshanbour/nova-brain", branch: "feature", taskId }), (error) => error.code === "coding_executor_git_executable_missing");
  await assert.rejects(createCodexCliRunner({ ...base, gitExecutable: "git" })(request(), { root, repository: "hshanbour/nova-brain", branch: "feature", taskId }), (error) => error.code === "coding_executor_git_executable_missing");
  await assert.rejects(createCodexCliRunner(base)(request(), { root: missingWorkspace, repository: "hshanbour/nova-brain", branch: "feature", taskId }), (error) => error.code === "coding_executor_workspace_missing");
  let launched = false;
  const authFailure = createCodexCliRunner({ ...base, authProcess: async () => { throw Object.assign(new Error("not logged in"), { safeDiagnostics: { exitCode: 1 } }); }, spawnProcess: async () => { launched = true; } });
  await assert.rejects(authFailure(request(), { root, repository: "hshanbour/nova-brain", branch: "feature", taskId }), (error) => error.code === "coding_executor_auth_unavailable" && error.safeDiagnostics.exitCode === 1);
  assert.equal(launched, false);
});

test("executor rejects an unavailable approved baseline before launching Codex and retains bounded diagnostics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nova-codex-missing-baseline-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runFile("git", ["init", "-b", "feature"], { cwd: root });
  await runFile("git", ["config", "user.email", "nova@example.invalid"], { cwd: root });
  await runFile("git", ["config", "user.name", "Nova Test"], { cwd: root });
  await writeFile(join(root, "source.js"), "export const value = 1;\n");
  await runFile("git", ["add", "source.js"], { cwd: root });
  await runFile("git", ["commit", "-m", "local baseline"], { cwd: root });
  await runFile("git", ["remote", "add", "origin", "https://github.com/hshanbour/nova-brain.git"], { cwd: root });
  const gitExecutable = process.platform === "win32" ? (await runFile("where.exe", ["git"])).stdout.split(/\r?\n/).find(Boolean) : (await runFile("which", ["git"])).stdout.trim();
  let launched = false;
  const runner = createCodexCliRunner({ executable: process.execPath, gitExecutable, authProcess: async () => ({ stdout: "", stderr: "", code: 0 }), spawnProcess: async () => { launched = true; } });
  await assert.rejects(
    runner(request({ repository: { slug: "hshanbour/nova-brain", branch: "feature", baseline: "f".repeat(40) } }), { root, repository: "hshanbour/nova-brain", branch: "feature", taskId: `coding_${"e".repeat(32)}` }),
    (error) => error.code === "coding_executor_baseline_unavailable" && error.safeDiagnostics.stage === "workspace_preflight" && error.safeDiagnostics.executorLaunched === false,
  );
  assert.equal(launched, false);
  assert.equal(((await runFile("git", ["worktree", "list", "--porcelain"], { cwd: root })).stdout.match(/^worktree /gm) || []).length, 1);
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
