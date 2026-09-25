import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { RISK_LEVELS } from "../policy/action-policy.js";
import { requireCodingTaskId } from "../autonomy/coding-executor.js";

const SHA = /^[a-f0-9]{40}$/;
const RESULT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "repository", "baseline", "finalLocalSha", "filesChanged", "tests", "limitations", "pushOccurred", "deploymentOccurred", "approvalsRequiredNext", "failure"],
  properties: {
    status: { type: "string", enum: ["completed", "blocked", "failed", "cancelled"] },
    summary: { type: "string" },
    repository: { type: "string" },
    baseline: { type: "string" },
    finalLocalSha: { type: ["string", "null"] },
    filesChanged: { type: "array", items: { type: "string" } },
    tests: { type: "array", items: { type: "object", additionalProperties: false, required: ["command", "status"], properties: { command: { type: "string" }, status: { type: "string", enum: ["passed", "failed", "not_run"] }, summary: { type: ["string", "null"] } } } },
    limitations: { type: "array", items: { type: "string" } },
    pushOccurred: { type: "boolean" },
    deploymentOccurred: { type: "boolean" },
    approvalsRequiredNext: { type: "array", items: { type: "string" } },
    failure: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" } } }] },
  },
});

const safeEventAtom = (value) => typeof value === "string" && /^[A-Za-z0-9_.:\[\]-]{1,120}$/.test(value) ? value : null;

function createCodexTraceSummary() {
  const summary = {
    jsonlEventCount: 0,
    jsonlParseErrors: 0,
    lastEventType: null,
    lastItemType: null,
    executorStage: "process_started",
    lastSuccessfulStage: "process_started",
    commandEvents: 0,
    fileChangeEvents: 0,
    testCommandEvents: 0,
    errorType: null,
    errorCode: null,
    errorParam: null,
  };
  return {
    record(line) {
      let event;
      try { event = JSON.parse(line); }
      catch { summary.jsonlParseErrors += 1; return; }
      if (!event || typeof event !== "object" || Array.isArray(event)) return;
      summary.jsonlEventCount += 1;
      const type = safeEventAtom(event.type);
      const itemType = safeEventAtom(event.item?.type);
      if (type) summary.lastEventType = type;
      if (itemType) summary.lastItemType = itemType;
      if (type === "thread.started") summary.executorStage = summary.lastSuccessfulStage = "session_started";
      if (type === "turn.started") summary.executorStage = summary.lastSuccessfulStage = "turn_started";
      if (itemType === "command_execution") {
        summary.commandEvents += 1;
        summary.executorStage = summary.lastSuccessfulStage = "repository_command";
        if (/^(?:npm|node|pnpm|yarn|pytest|cargo|go)(?:\.exe)?\s+(?:run\s+)?test\b/i.test(String(event.item?.command || "").trim())) {
          summary.testCommandEvents += 1;
          summary.executorStage = summary.lastSuccessfulStage = "test_command";
        }
      }
      if (["file_change", "file_write", "patch_apply"].includes(itemType)) {
        summary.fileChangeEvents += 1;
        summary.executorStage = summary.lastSuccessfulStage = "file_change";
      }
      if (type === "turn.completed") summary.executorStage = summary.lastSuccessfulStage = "turn_completed";
      if (type === "turn.failed" || type === "error" || type === "item.failed") summary.executorStage = "turn_failed";
      const error = event.error && typeof event.error === "object" ? event.error : event.item?.error && typeof event.item.error === "object" ? event.item.error : null;
      summary.errorType = safeEventAtom(error?.type) || summary.errorType;
      summary.errorCode = safeEventAtom(error?.code) || summary.errorCode;
      summary.errorParam = safeEventAtom(error?.param) || summary.errorParam;
    },
    diagnostics() { return { ...summary }; },
  };
}

export function runCodexProcess(command, args, { cwd, env, input, signal, onLine } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], signal });
    let stdout = "", stderr = "", pending = "";
    const trace = createCodexTraceSummary();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) if (line.trim()) { trace.record(line); onLine?.(line); }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (pending.trim()) { trace.record(pending); onLine?.(pending); }
      if (code === 0) resolvePromise({ stdout, stderr, code });
      else reject(Object.assign(new Error("Codex coding execution failed."), { code: signal?.aborted ? "coding_executor_cancelled" : "coding_executor_failed", safeDiagnostics: { exitCode: code, exitCategory: signal?.aborted ? "cancelled" : "process_exit_nonzero", resultCategory: "structured_result_unavailable", executorLaunched: true, stderrBytes: Buffer.byteLength(stderr), stdoutBytes: Buffer.byteLength(stdout), ...trace.diagnostics() } }));
    });
    child.stdin.end(input || "");
  });
}

function safeEnvironment(environment) {
  const keep = ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "CODEX_HOME"];
  return Object.fromEntries(keep.filter((key) => typeof environment[key] === "string" && environment[key]).map((key) => [key, environment[key]]));
}

async function requireLocalPath(path, { kind, directory = false } = {}) {
  const code = `coding_executor_${kind}_missing`;
  if (typeof path !== "string" || !isAbsolute(path)) throw Object.assign(new Error(`The ${kind.replaceAll("_", " ")} is not bound to an absolute local path.`), { code });
  try {
    const value = await stat(path);
    if (directory ? !value.isDirectory() : !value.isFile()) throw Object.assign(new Error("wrong path type"), { code: "ENOENT" });
  } catch (cause) {
    throw Object.assign(new Error(`The required ${kind.replaceAll("_", " ")} is unavailable.`), { code, safeDiagnostics: { resource: kind, pathExists: false }, cause });
  }
  return path;
}

function normalizeRemote(value) {
  const text = String(value || "").trim().replace(/\.git$/, "");
  return text.match(/(?:github\.com[:/])([^/]+\/[^/]+)$/i)?.[1] || text;
}

function parseStatus(value) {
  return String(value || "").split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).replaceAll("\\", "/"));
}

function prompt(job) {
  return JSON.stringify({
    contract: "nova_codex_coding_job_v1",
    role: "You are Codex, Nova's bounded coding executor. Inspect, implement, test, review, and create one local commit when successful.",
    authority: {
      repository: job.repository,
      workspaceId: job.workspaceId,
      deliveryBoundary: job.delivery,
      prohibitions: ["Do not push.", "Do not deploy.", "Do not modify Main or Production.", "Do not access secrets.", "Do not perform external customer actions."],
    },
    objective: job.objective,
    acceptanceCriteria: job.acceptanceCriteria,
    constraints: job.constraints,
    requestedVerification: job.verification,
    resultContract: "Return only the structured result required by the supplied JSON schema. Never infer success from prose or tests alone.",
  });
}

function usageFromEvent(event) {
  const usage = event?.usage || event?.response?.usage || event?.turn?.usage;
  if (!usage || typeof usage !== "object") return null;
  return Object.fromEntries(Object.entries(usage).filter(([, value]) => Number.isFinite(value)));
}

export function createCodexCliRunner({ executable = "codex", gitExecutable = "git", environment = process.env, spawnProcess = runCodexProcess, gitProcess = runCodexProcess, authProcess = runCodexProcess, clock = () => new Date() } = {}) {
  return async function run(job, { root, repository, branch, taskId, signal, onProgress } = {}) {
    taskId = requireCodingTaskId(taskId);
    const sourceRoot = resolve(root);
    const env = safeEnvironment(environment);
    if (isAbsolute(executable)) await requireLocalPath(executable, { kind: "codex_executable" });
    if (isAbsolute(gitExecutable)) await requireLocalPath(gitExecutable, { kind: "git_executable" });
    await requireLocalPath(sourceRoot, { kind: "workspace", directory: true });
    try {
      await authProcess(executable, ["login", "status"], { cwd: sourceRoot, env, signal });
    } catch (cause) {
      throw Object.assign(new Error("Codex authentication is unavailable to the persistent worker."), { code: "coding_executor_auth_unavailable", safeDiagnostics: { resource: "codex_auth", exitCode: cause?.safeDiagnostics?.exitCode ?? null }, cause });
    }
    const gitAt = async (cwd, args, { cleanup = false } = {}) => {
      try {
        return (await gitProcess(gitExecutable, ["-c", `safe.directory=${cwd}`, "-C", cwd, ...args], { cwd: sourceRoot, env, signal: cleanup ? undefined : signal })).stdout.trim();
      } catch (cause) {
        if (cause?.code === "ENOENT") throw Object.assign(new Error("The bound Git executable became unavailable."), { code: "coding_executor_git_executable_missing", safeDiagnostics: { resource: "git_executable", pathExists: false }, cause });
        throw cause;
      }
    };
    const sourceGit = (...args) => gitAt(sourceRoot, args);
    const [top, remote, actualBranch, sourceHead, dirty] = await Promise.all([
      sourceGit("rev-parse", "--show-toplevel"), sourceGit("remote", "get-url", "origin"), sourceGit("branch", "--show-current"), sourceGit("rev-parse", "HEAD"), sourceGit("status", "--porcelain=v1", "--untracked-files=all"),
    ]);
    const sourceBinding = { topLevelMatches: resolve(top).toLowerCase() === sourceRoot.toLowerCase(), repositoryMatches: normalizeRemote(remote) === repository, branchMatches: actualBranch === branch };
    if (!sourceBinding.topLevelMatches || !sourceBinding.repositoryMatches || !sourceBinding.branchMatches) {
      throw Object.assign(new Error("The local coding workspace does not match the trusted repository binding."), { code: "coding_workspace_binding_changed", safeDiagnostics: { stage: "repository_preflight", ...sourceBinding, executorLaunched: false } });
    }
    if (dirty) throw Object.assign(new Error("The local coding workspace must be clean before delegation."), { code: "coding_workspace_dirty", safeDiagnostics: { stage: "repository_preflight", sourceHead, clean: false, executorLaunched: false } });
    const temporary = await mkdtemp(join(tmpdir(), "nova-codex-job-"));
    const cwd = join(temporary, "workspace");
    const schemaPath = join(temporary, "result.schema.json");
    const resultPath = join(temporary, "result.json");
    const usage = {};
    const startedAt = clock().toISOString();
    let worktreeAdded = false;
    const localRef = `refs/nova/coding-jobs/${taskId}`;
    try {
      try {
        await sourceGit("cat-file", "-e", `${job.repository.baseline}^{commit}`);
      } catch (cause) {
        throw Object.assign(new Error("The approved coding baseline is unavailable in the trusted repository."), { code: "coding_executor_baseline_unavailable", safeDiagnostics: { stage: "workspace_preflight", expectedBaseline: job.repository.baseline, executorLaunched: false }, cause });
      }
      try {
        await sourceGit("worktree", "add", "--detach", cwd, job.repository.baseline);
        worktreeAdded = true;
      } catch (cause) {
        throw Object.assign(new Error("The isolated coding workspace could not be prepared."), { code: "coding_executor_workspace_prepare_failed", safeDiagnostics: { stage: "workspace_preparation", expectedBaseline: job.repository.baseline, executorLaunched: false }, cause });
      }
      const git = (...args) => gitAt(cwd, args);
      const [isolatedHead, isolatedBranch, isolatedRemote, isolatedDirty] = await Promise.all([
        git("rev-parse", "HEAD"), git("rev-parse", "--abbrev-ref", "HEAD"), git("remote", "get-url", "origin"), git("status", "--porcelain=v1", "--untracked-files=all"),
      ]);
      if (isolatedHead !== job.repository.baseline || isolatedBranch !== "HEAD" || normalizeRemote(isolatedRemote) !== repository || isolatedDirty) {
        throw Object.assign(new Error("The isolated coding workspace does not match the approved immutable baseline."), { code: "coding_executor_workspace_prepare_failed", safeDiagnostics: { stage: "workspace_preparation", expectedBaseline: job.repository.baseline, actualHead: isolatedHead, detached: isolatedBranch === "HEAD", repositoryMatches: normalizeRemote(isolatedRemote) === repository, clean: !isolatedDirty, executorLaunched: false } });
      }
      await writeFile(schemaPath, JSON.stringify(RESULT_SCHEMA), { encoding: "utf8", mode: 0o600 });
      try {
        await spawnProcess(executable, [
          "exec", "--json", "--ephemeral", "--ignore-user-config", "--sandbox", "workspace-write",
          "-c", "shell_environment_policy.inherit=none", "--output-schema", schemaPath, "--output-last-message", resultPath, "-C", cwd, "-",
        ], {
          cwd,
          env,
          input: prompt(job),
          signal,
          onLine(line) {
            let event;
            try { event = JSON.parse(line); } catch { return; }
            const measured = usageFromEvent(event);
            if (measured) Object.assign(usage, measured);
            const type = String(event.type || event.item?.type || "");
            const command = String(event.item?.command || event.command || "");
            if (/command|tool/.test(type) && /(?:^|\s)(?:npm|node|pnpm|yarn|pytest|cargo|go)\s+(?:run\s+)?test\b/i.test(command)) onProgress?.("testing", "Codex is running the approved local verification.");
            else if (/command|tool/.test(type)) onProgress?.("implementing", "Codex is implementing in the bound project.");
            else if (/turn\.started|thread\.started/.test(type)) onProgress?.("inspecting", "Codex is inspecting the bound project.");
          },
        });
      } catch (cause) {
        if (cause?.code === "ENOENT") throw Object.assign(new Error("The bound Codex executable became unavailable."), { code: "coding_executor_codex_executable_missing", safeDiagnostics: { resource: "codex_executable", pathExists: false }, cause });
        throw cause;
      }
      const resultText = await readFile(resultPath, "utf8");
      if (Buffer.byteLength(resultText) > 131_072 || /(?:sk-[A-Za-z0-9_-]{16,}|(?:api[_-]?key|password|passcode|bearer|authorization)\s*[:=]\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i.test(resultText)) {
        throw Object.assign(new Error("Codex returned an unsafe or oversized structured result."), { code: "coding_result_unsafe" });
      }
      const parsed = JSON.parse(resultText);
      const [finalSha, finalBranch, finalRemote, finalDirty, ancestry] = await Promise.all([
        git("rev-parse", "HEAD"), git("rev-parse", "--abbrev-ref", "HEAD"), git("remote", "get-url", "origin"), git("status", "--porcelain=v1", "--untracked-files=all"),
        git("merge-base", "--is-ancestor", job.repository.baseline, "HEAD").then(() => "yes", () => "no"),
      ]);
      if (finalBranch !== "HEAD" || normalizeRemote(finalRemote) !== repository || ancestry !== "yes") throw Object.assign(new Error("Codex changed the repository authority binding."), { code: "coding_result_binding_changed" });
      if (finalDirty) throw Object.assign(new Error("Codex returned with uncommitted workspace changes."), { code: "coding_result_uncommitted" });
      if (parsed.pushOccurred || parsed.deploymentOccurred) throw Object.assign(new Error("Codex exceeded the local-commit delivery boundary."), { code: "coding_delivery_boundary_violated" });
      if (parsed.status === "completed" && (!SHA.test(finalSha) || finalSha === job.repository.baseline || parsed.finalLocalSha !== finalSha)) {
        throw Object.assign(new Error("A completed coding job must return the exact new local commit."), { code: "coding_result_commit_invalid" });
      }
      const filesChanged = finalSha === job.repository.baseline ? [] : (await git("diff", "--name-only", `${job.repository.baseline}..${finalSha}`)).split(/\r?\n/).filter(Boolean).map((path) => path.replaceAll("\\", "/"));
      if (JSON.stringify([...new Set(parsed.filesChanged)].sort()) !== JSON.stringify([...new Set(filesChanged)].sort())) {
        throw Object.assign(new Error("Codex result files do not match the committed diff."), { code: "coding_result_files_mismatch" });
      }
      try {
        await sourceGit("update-ref", localRef, finalSha, "0".repeat(40));
      } catch (cause) {
        throw Object.assign(new Error("The verified local coding commit could not be retained."), { code: "coding_executor_commit_retention_failed", safeDiagnostics: { stage: "commit_retention", executorLaunched: true }, cause });
      }
      return Object.freeze({
        ...parsed,
        commitSha: parsed.finalLocalSha,
        filesChanged,
        pushOccurred: false,
        deploymentOccurred: false,
        usage: Object.keys(usage).length ? usage : null,
        executor: { type: "codex_cli", startedAt, completedAt: clock().toISOString(), billing: "codex_account_separate_from_nova_api_budget", localRef },
      });
    } finally {
      if (worktreeAdded) await gitAt(sourceRoot, ["worktree", "remove", "--force", cwd], { cleanup: true }).catch(() => {});
      await gitAt(sourceRoot, ["worktree", "prune"], { cleanup: true }).catch(() => {});
      await rm(temporary, { recursive: true, force: true });
    }
  };
}

export function registerCodexExecutorTool(registry, { root, repository, branch, runner, codexExecutable, gitExecutable, activity } = {}) {
  const executeRunner = runner || createCodexCliRunner({ executable: codexExecutable, gitExecutable });
  registry.register({
    name: "codex_execute",
    description: "Execute one approved, repository-bound coding job with Codex and return a structured local-commit result.",
    category: "coding_executor",
    capability: "execute",
    riskLevel: RISK_LEVELS.LOW_RISK_WRITE,
    autonomous: true,
    available: Boolean(root && repository && branch),
    configurationStatus: root && repository && branch ? "ready" : "configuration_required",
    inputSchema: { type: "object", additionalProperties: true },
    async execute(job, context = {}) {
      requireCodingTaskId(context.taskId);
      const emit = async (phase, summary) => activity?.({ job, context, phase, summary });
      await emit("inspecting", "Codex is inspecting the bound project.");
      const result = await executeRunner(job, { root, repository, branch, taskId: context.taskId, signal: context.signal, onProgress: emit });
      await emit(result.status === "completed" ? "reviewing" : result.status, result.status === "completed" ? "Codex completed implementation, tests, review, and a local commit." : result.summary);
      if (result.status !== "completed") {
        const error = new Error(result.failure?.message || result.summary || "Codex coding execution did not complete.");
        error.code = result.failure?.code || `coding_executor_${result.status}`;
        error.safeDiagnostics = { codingResult: result };
        throw error;
      }
      return result;
    },
  });
}

export function codingJobFingerprint(job) {
  return createHash("sha256").update(JSON.stringify(job)).digest("hex");
}
