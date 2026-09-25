import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RISK_LEVELS } from "../policy/action-policy.js";

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

function runProcess(command, args, { cwd, env, input, signal, onLine } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], signal });
    let stdout = "", stderr = "", pending = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) if (line.trim()) onLine?.(line);
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (pending.trim()) onLine?.(pending);
      if (code === 0) resolvePromise({ stdout, stderr, code });
      else reject(Object.assign(new Error("Codex coding execution failed."), { code: signal?.aborted ? "coding_executor_cancelled" : "coding_executor_failed", safeDiagnostics: { exitCode: code, stderrBytes: Buffer.byteLength(stderr), stdoutBytes: Buffer.byteLength(stdout) } }));
    });
    child.stdin.end(input || "");
  });
}

function safeEnvironment(environment) {
  const keep = ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "CODEX_HOME"];
  return Object.fromEntries(keep.filter((key) => typeof environment[key] === "string" && environment[key]).map((key) => [key, environment[key]]));
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

export function createCodexCliRunner({ executable = "codex", environment = process.env, spawnProcess = runProcess, gitProcess = runProcess, clock = () => new Date() } = {}) {
  return async function run(job, { root, repository, branch, signal, onProgress } = {}) {
    const cwd = resolve(root);
    const env = safeEnvironment(environment);
    const git = async (...args) => (await gitProcess("git", ["-c", `safe.directory=${cwd}`, "-C", cwd, ...args], { cwd, env, signal })).stdout.trim();
    const [top, remote, actualBranch, head, dirty] = await Promise.all([
      git("rev-parse", "--show-toplevel"), git("remote", "get-url", "origin"), git("branch", "--show-current"), git("rev-parse", "HEAD"), git("status", "--porcelain=v1", "--untracked-files=all"),
    ]);
    if (resolve(top).toLowerCase() !== cwd.toLowerCase() || normalizeRemote(remote) !== repository || actualBranch !== branch || head !== job.repository.baseline) {
      throw Object.assign(new Error("The local coding workspace does not match the bound repository baseline."), { code: "coding_workspace_binding_changed" });
    }
    if (dirty) throw Object.assign(new Error("The local coding workspace must be clean before delegation."), { code: "coding_workspace_dirty" });
    const temporary = await mkdtemp(join(tmpdir(), "nova-codex-job-"));
    const schemaPath = join(temporary, "result.schema.json");
    const resultPath = join(temporary, "result.json");
    await writeFile(schemaPath, JSON.stringify(RESULT_SCHEMA), { encoding: "utf8", mode: 0o600 });
    const usage = {};
    const startedAt = clock().toISOString();
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
      const resultText = await readFile(resultPath, "utf8");
      if (Buffer.byteLength(resultText) > 131_072 || /(?:sk-[A-Za-z0-9_-]{16,}|(?:api[_-]?key|password|passcode|bearer|authorization)\s*[:=]\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i.test(resultText)) {
        throw Object.assign(new Error("Codex returned an unsafe or oversized structured result."), { code: "coding_result_unsafe" });
      }
      const parsed = JSON.parse(resultText);
      const [finalSha, finalBranch, finalRemote, finalDirty, ancestry] = await Promise.all([
        git("rev-parse", "HEAD"), git("branch", "--show-current"), git("remote", "get-url", "origin"), git("status", "--porcelain=v1", "--untracked-files=all"),
        git("merge-base", "--is-ancestor", job.repository.baseline, "HEAD").then(() => "yes", () => "no"),
      ]);
      if (finalBranch !== branch || normalizeRemote(finalRemote) !== repository || ancestry !== "yes") throw Object.assign(new Error("Codex changed the repository authority binding."), { code: "coding_result_binding_changed" });
      if (finalDirty) throw Object.assign(new Error("Codex returned with uncommitted workspace changes."), { code: "coding_result_uncommitted" });
      if (parsed.pushOccurred || parsed.deploymentOccurred) throw Object.assign(new Error("Codex exceeded the local-commit delivery boundary."), { code: "coding_delivery_boundary_violated" });
      if (parsed.status === "completed" && (!SHA.test(finalSha) || finalSha === job.repository.baseline || parsed.finalLocalSha !== finalSha)) {
        throw Object.assign(new Error("A completed coding job must return the exact new local commit."), { code: "coding_result_commit_invalid" });
      }
      const filesChanged = finalSha === job.repository.baseline ? [] : (await git("diff", "--name-only", `${job.repository.baseline}..${finalSha}`)).split(/\r?\n/).filter(Boolean).map((path) => path.replaceAll("\\", "/"));
      if (JSON.stringify([...new Set(parsed.filesChanged)].sort()) !== JSON.stringify([...new Set(filesChanged)].sort())) {
        throw Object.assign(new Error("Codex result files do not match the committed diff."), { code: "coding_result_files_mismatch" });
      }
      return Object.freeze({
        ...parsed,
        commitSha: parsed.finalLocalSha,
        filesChanged,
        pushOccurred: false,
        deploymentOccurred: false,
        usage: Object.keys(usage).length ? usage : null,
        executor: { type: "codex_cli", startedAt, completedAt: clock().toISOString(), billing: "codex_account_separate_from_nova_api_budget" },
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  };
}

export function registerCodexExecutorTool(registry, { root, repository, branch, runner = createCodexCliRunner(), activity } = {}) {
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
      const emit = async (phase, summary) => activity?.({ job, context, phase, summary });
      await emit("inspecting", "Codex is inspecting the bound project.");
      const result = await runner(job, { root, repository, branch, signal: context.signal, onProgress: emit });
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
