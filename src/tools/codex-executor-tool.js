import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { RISK_LEVELS } from "../policy/action-policy.js";
import { requireCodingTaskId } from "../autonomy/coding-executor.js";

const SHA = /^[a-f0-9]{40}$/;
const MAX_ERROR_MESSAGE = 300;
const UNSAFE_ERROR_MESSAGE = /(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_-]{12,}|(?:api[_ -]?key|password|passcode|bearer|authorization|cookie|token|secret)\s*[:=]\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----|seed\s+phrase\s*[:=]\s*\S+|\b(?:prompt|source|repository)\s+(?:content|text)\b)/i;
const CODEX_COMMAND_ENVIRONMENT = Object.freeze([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "TEMP", "TMP",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA",
]);
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
    tests: { type: "array", items: { type: "object", additionalProperties: false, required: ["command", "status", "summary"], properties: { command: { type: "string" }, status: { type: "string", enum: ["passed", "failed", "not_run"] }, summary: { type: ["string", "null"] } } } },
    limitations: { type: "array", items: { type: "string" } },
    pushOccurred: { type: "boolean" },
    deploymentOccurred: { type: "boolean" },
    approvalsRequiredNext: { type: "array", items: { type: "string" } },
    failure: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" } } }] },
  },
});

const safeEventAtom = (value) => typeof value === "string" && /^[A-Za-z0-9_.:\[\]-]{1,120}$/.test(value) ? value : null;
const safeRefAtom = (value) => typeof value === "string" && /^[A-Za-z0-9._/-]{1,200}$/.test(value) ? value : null;
const safeErrorMessage = (value) => {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || /^[\[{]/.test(normalized) || UNSAFE_ERROR_MESSAGE.test(normalized)) return null;
  return normalized.slice(0, MAX_ERROR_MESSAGE);
};

function safeErrorDetails(event, type, itemType) {
  if (!["turn.failed", "error", "item.failed"].includes(type) && itemType !== "error") return null;
  const candidates = [event.error, event.item?.error, itemType === "error" ? event.item : null].filter((value) => value != null);
  let errorCategory = safeEventAtom(event.category), errorType = null, errorCode = null, errorParam = null, errorMessage = null;
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      errorMessage ||= safeErrorMessage(candidate);
      continue;
    }
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    errorCategory ||= safeEventAtom(candidate.category);
    errorType ||= safeEventAtom(candidate.type);
    errorCode ||= safeEventAtom(candidate.code);
    errorParam ||= safeEventAtom(candidate.param);
    errorMessage ||= safeErrorMessage(candidate.message);
  }
  errorCategory ||= safeEventAtom(type) || safeEventAtom(itemType);
  return { errorCategory, errorType, errorCode, errorParam, errorMessage };
}

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
    errorCategory: null,
    errorMessage: null,
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
      const error = safeErrorDetails(event, type, itemType);
      summary.errorType = error?.errorType || summary.errorType;
      summary.errorCode = error?.errorCode || summary.errorCode;
      summary.errorParam = error?.errorParam || summary.errorParam;
      summary.errorCategory = error?.errorCategory || summary.errorCategory;
      summary.errorMessage = error?.errorMessage || summary.errorMessage;
    },
    diagnostics() { return { ...summary }; },
  };
}

export function runCodexProcess(command, args, { cwd, env, input, signal, onLine, onSpawn } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], signal });
    let stdout = "", stderr = "", pending = "", settled = false;
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
    child.once("error", (error) => { if (!settled) { settled = true; reject(error); } });
    child.once("spawn", async () => {
      try { await onSpawn?.({ pid: child.pid }); child.stdin.end(input || ""); }
      catch (error) { if (!settled) { settled = true; child.kill(); reject(error); } }
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (pending.trim()) { trace.record(pending); onLine?.(pending); }
      if (code === 0) resolvePromise({ stdout, stderr, code });
      else reject(Object.assign(new Error("Codex coding execution failed."), { code: signal?.aborted ? "coding_executor_cancelled" : "coding_executor_failed", safeDiagnostics: { exitCode: code, exitCategory: signal?.aborted ? "cancelled" : "process_exit_nonzero", resultCategory: "structured_result_unavailable", executorLaunched: true, stderrBytes: Buffer.byteLength(stderr), stdoutBytes: Buffer.byteLength(stdout), ...trace.diagnostics() } }));
    });
  });
}

function safeEnvironment(environment, gitExecutable) {
  const keep = ["PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "CODEX_HOME"];
  const result = Object.fromEntries(keep.filter((key) => typeof environment[key] === "string" && environment[key]).map((key) => [key, environment[key]]));
  const gitDirectory = dirname(gitExecutable), seen = new Set(), entries = [gitDirectory, ...String(environment.PATH || environment.Path || "").split(delimiter)].filter((entry) => {
    const value = String(entry || "").trim(), identity = process.platform === "win32" ? value.toLowerCase() : value;
    if (!value || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  result.PATH = entries.join(delimiter);
  return result;
}

function codexCommandEnvironmentArgs() {
  return [
    "-c", 'shell_environment_policy.inherit="all"',
    "-c", "shell_environment_policy.ignore_default_excludes=false",
    ...CODEX_COMMAND_ENVIRONMENT.flatMap((name) => ["-c", `shell_environment_policy.filters.${name}="include"`]),
  ];
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

function requireOwnerApproval(job) {
  if (job?.approval?.buildApproved !== true || typeof job.approval.approvalId !== "string" || !job.approval.approvalId.trim()) {
    throw Object.assign(new Error("The coding job does not carry verified owner approval."), {
      code: "coding_executor_owner_approval_unverified",
      safeDiagnostics: { stage: "approval_preflight", executorLaunched: false },
    });
  }
  return true;
}

function prompt(job, { ownerApprovalVerified }) {
  return JSON.stringify({
    contract: "nova_codex_coding_job_v1",
    role: "You are Codex, Nova's bounded coding executor. Inspect, implement, test, review, and create one local commit when successful.",
    executionAuthorization: { ownerApprovalVerified },
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

function isTestCommand(command) {
  return /\b(?:npm|pnpm|yarn)(?:\.cmd|\.exe)?\s+(?:run\s+)?test\b|\bnode(?:\.exe)?\s+--test\b|\bpytest(?:\.exe)?\b|\bcargo(?:\.exe)?\s+test\b|\bgo(?:\.exe)?\s+test\b/i.test(command);
}

export function createCodexCliRunner({ executable = "codex", gitExecutable = "git", environment = process.env, spawnProcess = runCodexProcess, gitProcess = runCodexProcess, authProcess = runCodexProcess, clock = () => new Date() } = {}) {
  return async function run(job, { root, repository, branch, taskId, signal, onProgress } = {}) {
    taskId = requireCodingTaskId(taskId);
    const ownerApprovalVerified = requireOwnerApproval(job);
    const sourceRoot = resolve(root);
    if (isAbsolute(executable)) await requireLocalPath(executable, { kind: "codex_executable" });
    await requireLocalPath(gitExecutable, { kind: "git_executable" });
    const env = safeEnvironment(environment, gitExecutable);
    await requireLocalPath(sourceRoot, { kind: "workspace", directory: true });
    try {
      await authProcess(executable, ["login", "status"], { cwd: sourceRoot, env, signal });
    } catch (cause) {
      throw Object.assign(new Error("Codex authentication is unavailable to the persistent worker."), { code: "coding_executor_auth_unavailable", safeDiagnostics: { resource: "codex_auth", exitCode: cause?.safeDiagnostics?.exitCode ?? null }, cause });
    }
    const gitAt = async (cwd, args, { cleanup = false, safeDirectories = [cwd] } = {}) => {
      try {
        return (await gitProcess(gitExecutable, [...safeDirectories.flatMap((path) => ["-c", `safe.directory=${path}`]), "-C", cwd, ...args], { cwd: sourceRoot, env, signal: cleanup ? undefined : signal })).stdout.trim();
      } catch (cause) {
        if (cause?.code === "ENOENT") throw Object.assign(new Error("The bound Git executable became unavailable."), { code: "coding_executor_git_executable_missing", safeDiagnostics: { resource: "git_executable", pathExists: false }, cause });
        throw cause;
      }
    };
    const sourceGit = (...args) => gitAt(sourceRoot, args);
    const [top, sourceGitDirectory, remote, actualBranch, sourceHead] = await Promise.all([
      sourceGit("rev-parse", "--show-toplevel"), sourceGit("rev-parse", "--absolute-git-dir"), sourceGit("remote", "get-url", "origin"), sourceGit("branch", "--show-current"), sourceGit("rev-parse", "HEAD"),
    ]);
    await requireLocalPath(resolve(sourceGitDirectory), { kind: "git_directory", directory: true });
    const sourceBinding = { topLevelMatches: resolve(top).toLowerCase() === sourceRoot.toLowerCase(), repositoryMatches: normalizeRemote(remote) === repository, branchMatches: actualBranch === branch };
    if (!sourceBinding.topLevelMatches || !sourceBinding.repositoryMatches || !sourceBinding.branchMatches) {
      throw Object.assign(new Error("The local coding workspace does not match the trusted repository binding."), { code: "coding_workspace_binding_changed", safeDiagnostics: { stage: "repository_preflight", ...sourceBinding, executorLaunched: false } });
    }
    const temporary = await mkdtemp(join(tmpdir(), "nova-codex-job-"));
    const cwd = join(temporary, "workspace");
    const schemaPath = join(temporary, "result.schema.json");
    const resultPath = join(temporary, "result.json");
    const usage = {};
    const startedAt = clock().toISOString();
    let disposableRepositoryCreated = false;
    const localRef = `refs/nova/coding-jobs/${taskId}`;
    const exportRef = `refs/nova/coding-exports/${taskId}`;
    let sourceArtifactRefRecovered=false;
    try {
      if(job.trustedArtifact){
        const artifact=job.trustedArtifact;
        try{await sourceGit("cat-file","-e",`${artifact.commitSha}^{commit}`);}catch(cause){throw Object.assign(new Error("The trusted historical artifact commit is unavailable locally."),{code:"coding_executor_artifact_unavailable",safeDiagnostics:{stage:"artifact_preflight",sourceTaskId:artifact.sourceTaskId,commitExists:false,executorLaunched:false},cause});}
        let resolved=null;
        try{resolved=await sourceGit("rev-parse","--verify",artifact.artifactRef);}catch{}
        if(resolved&&resolved!==artifact.commitSha)throw Object.assign(new Error("The trusted historical artifact ref points to a different commit."),{code:"coding_executor_artifact_ref_mismatch",safeDiagnostics:{stage:"artifact_preflight",sourceTaskId:artifact.sourceTaskId,commitExists:true,refMatches:false,executorLaunched:false}});
        if(!resolved){
          try{await sourceGit("update-ref",artifact.artifactRef,artifact.commitSha,"0".repeat(40));sourceArtifactRefRecovered=true;}catch(cause){throw Object.assign(new Error("The trusted historical artifact ref could not be recovered from its durable exact commit."),{code:"coding_executor_artifact_ref_unavailable",safeDiagnostics:{stage:"artifact_preflight",sourceTaskId:artifact.sourceTaskId,commitExists:true,refMatches:false,executorLaunched:false},cause});}
        }
      }
      try {
        await sourceGit("cat-file", "-e", `${job.repository.baseline}^{commit}`);
      } catch (cause) {
        throw Object.assign(new Error("The approved coding baseline is unavailable in the trusted repository."), { code: "coding_executor_baseline_unavailable", safeDiagnostics: { stage: "workspace_preflight", expectedBaseline: job.repository.baseline, executorLaunched: false }, cause });
      }
      try {
        await gitAt(sourceRoot, ["clone", "--no-hardlinks", "--no-checkout", "--", sourceRoot, cwd], { safeDirectories: [sourceRoot, resolve(sourceGitDirectory)] });
        disposableRepositoryCreated = true;
      } catch (cause) {
        throw Object.assign(new Error("The disposable coding repository could not be created."), { code: "coding_executor_workspace_prepare_failed", safeDiagnostics: { stage: "repository_clone", expectedBaseline: job.repository.baseline, executorLaunched: false }, cause });
      }
      const git = (...args) => gitAt(cwd, args);
      try {
        await git("remote", "set-url", "origin", remote);
        await git("config", "user.name", "Nova Coding Executor");
        await git("config", "user.email", "nova-coding@nova.invalid");
        await git("checkout", "--detach", job.repository.baseline);
      } catch (cause) {
        throw Object.assign(new Error("The disposable coding repository could not be bound to the approved baseline."), { code: "coding_executor_workspace_prepare_failed", safeDiagnostics: { stage: "repository_checkout", expectedBaseline: job.repository.baseline, executorLaunched: false }, cause });
      }
      const [isolatedHead, isolatedBranch, isolatedRemote, isolatedDirty] = await Promise.all([
        git("rev-parse", "HEAD"), git("rev-parse", "--abbrev-ref", "HEAD"), git("remote", "get-url", "origin"), git("status", "--porcelain=v1", "--untracked-files=all"),
      ]);
      const isolatedTop = await git("rev-parse", "--show-toplevel");
      if (isolatedHead !== job.repository.baseline || isolatedBranch !== "HEAD" || isolatedRemote !== remote || normalizeRemote(isolatedRemote) !== repository || isolatedDirty || resolve(isolatedTop).toLowerCase() !== resolve(cwd).toLowerCase()) {
        throw Object.assign(new Error("The disposable coding repository does not match the approved immutable baseline."), { code: "coding_executor_workspace_prepare_failed", safeDiagnostics: { stage: "workspace_preparation", expectedBaseline: job.repository.baseline, actualHead: isolatedHead, detached: isolatedBranch === "HEAD", repositoryMatches: isolatedRemote === remote && normalizeRemote(isolatedRemote) === repository, clean: !isolatedDirty, independentGitMetadata: true, executorLaunched: false } });
      }
      await writeFile(schemaPath, JSON.stringify(RESULT_SCHEMA), { encoding: "utf8", mode: 0o600 });
      try {
        await spawnProcess(executable, [
          "exec", "--json", "--ephemeral", "--ignore-user-config", "--approve-for-me",
          ...codexCommandEnvironmentArgs(),
          "--output-schema", schemaPath, "--output-last-message", resultPath, "-C", cwd, "-",
        ], {
          cwd,
          env,
          input: prompt(job, { ownerApprovalVerified }),
          signal,
          onSpawn: () => onProgress?.("executing", "Codex started and is waiting for its first bounded activity event."),
          onLine(line) {
            let event;
            try { event = JSON.parse(line); } catch { return; }
            const measured = usageFromEvent(event);
            if (measured) Object.assign(usage, measured);
            const type = String(event.type || "");
            const itemType = String(event.item?.type || "");
            const command = String(event.item?.command || event.command || "");
            if (/command|tool/.test(itemType) && isTestCommand(command)) onProgress?.("testing", "Codex is running the approved local verification.");
            else if (/command|tool/.test(itemType)) onProgress?.("implementing", "Codex is implementing in the bound project.");
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
      const [sourceHeadAfter, sourceBranchAfter] = await Promise.all([
        sourceGit("rev-parse", "HEAD"), sourceGit("branch", "--show-current"),
      ]);
      if (sourceHeadAfter !== sourceHead || sourceBranchAfter !== branch) {
        throw Object.assign(new Error("The trusted source workspace binding changed during isolated coding execution."), {
          code: "coding_source_workspace_changed",
          safeDiagnostics: {
            stage: "result_validation",
            headUnchanged: sourceHeadAfter === sourceHead,
            branchUnchanged: sourceBranchAfter === branch,
            executorLaunched: true,
          },
        });
      }
      const bindingDiagnostics = {
        stage: "result_binding",
        expectedBaseline: job.repository.baseline,
        finalSha: SHA.test(finalSha) ? finalSha : null,
        finalBranch: safeRefAtom(finalBranch),
        detached: finalBranch === "HEAD",
        remoteMatches: finalRemote === isolatedRemote && normalizeRemote(finalRemote) === repository,
        ancestryMatches: ancestry === "yes",
        independentGitMetadata: true,
        clean: !finalDirty,
        executorLaunched: true,
      };
      if (!bindingDiagnostics.remoteMatches || !bindingDiagnostics.ancestryMatches) {
        throw Object.assign(new Error("Codex changed the repository authority binding."), { code: "coding_result_binding_changed", safeDiagnostics: bindingDiagnostics });
      }
      if (finalDirty) throw Object.assign(new Error("Codex returned with uncommitted workspace changes."), { code: "coding_result_uncommitted", safeDiagnostics: bindingDiagnostics });
      if (parsed.pushOccurred || parsed.deploymentOccurred) throw Object.assign(new Error("Codex exceeded the local-commit delivery boundary."), { code: "coding_delivery_boundary_violated" });
      if (parsed.status === "completed" && (!SHA.test(finalSha) || finalSha === job.repository.baseline || parsed.finalLocalSha !== finalSha)) {
        throw Object.assign(new Error("A completed coding job must return the exact new local commit."), { code: "coding_result_commit_invalid" });
      }
      const filesChanged = finalSha === job.repository.baseline ? [] : (await git("diff", "--name-only", `${job.repository.baseline}..${finalSha}`)).split(/\r?\n/).filter(Boolean).map((path) => path.replaceAll("\\", "/"));
      const reportedFiles = [...new Set(parsed.filesChanged)].sort();
      const authoritativeFiles = [...new Set(filesChanged)].sort();
      const filesChangedMatch = JSON.stringify(reportedFiles) === JSON.stringify(authoritativeFiles);
      try {
        let retained = null;
        try { retained = await sourceGit("rev-parse", "--verify", localRef); } catch {}
        if (retained && retained !== finalSha) throw Object.assign(new Error("conflicting retained ref"), { code: "coding_executor_commit_retention_conflict" });
        if (!retained) {
          const importRef = `refs/nova/coding-imports/${taskId}/${finalSha}`;
          await git("update-ref", exportRef, finalSha, "0".repeat(40));
          try {
            let staged = null;
            try { staged = await sourceGit("rev-parse", "--verify", importRef); } catch {}
            if (staged && staged !== finalSha) throw Object.assign(new Error("conflicting import ref"), { code: "coding_executor_commit_import_conflict" });
            if (!staged) await sourceGit("fetch", "--no-tags", "--no-write-fetch-head", cwd, `${exportRef}:${importRef}`);
            if (await sourceGit("rev-parse", "--verify", importRef) !== finalSha) throw Object.assign(new Error("imported staging ref mismatch"), { code: "coding_executor_commit_import_mismatch" });
            try { await sourceGit("update-ref", localRef, finalSha, "0".repeat(40)); }
            catch (cause) {
              const concurrent = await sourceGit("rev-parse", "--verify", localRef).catch(() => null);
              if (concurrent !== finalSha) throw cause;
            }
          } finally {
            await sourceGit("update-ref", "-d", importRef, finalSha).catch(() => {});
          }
        }
        const imported = await sourceGit("rev-parse", "--verify", localRef);
        if (imported !== finalSha) throw Object.assign(new Error("imported ref mismatch"), { code: "coding_executor_commit_retention_mismatch" });
      } catch (cause) {
        throw Object.assign(new Error("The verified disposable coding commit could not be retained."), { code: "coding_executor_commit_retention_failed", safeDiagnostics: { stage: "commit_import", finalSha: SHA.test(finalSha) ? finalSha : null, executorLaunched: true }, cause });
      }
      return Object.freeze({
        ...parsed,
        repository: job.repository.slug,
        baseline: job.repository.baseline,
        finalLocalSha: finalSha,
        commitSha: finalSha,
        filesChanged,
        pushOccurred: false,
        deploymentOccurred: false,
        usage: Object.keys(usage).length ? usage : null,
        executor: {
          type: "codex_cli",
          startedAt,
          completedAt: clock().toISOString(),
          billing: "codex_account_separate_from_nova_api_budget",
          localRef,
          ...(job.trustedArtifact?{trustedArtifact:{sourceTaskId:job.trustedArtifact.sourceTaskId,commitSha:job.trustedArtifact.commitSha,artifactRef:job.trustedArtifact.artifactRef,refRecovered:sourceArtifactRefRecovered}}:{}),
          resultConsistency: {
            filesChangedMatch,
            reportedFilesCount: reportedFiles.length,
            authoritativeFilesCount: authoritativeFiles.length,
          },
        },
      });
    } finally {
      if (disposableRepositoryCreated) await rm(cwd, { recursive: true, force: true }).catch(() => {});
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
      await emit("preparing", "Preparing the isolated coding environment.");
      const result = await executeRunner(job, { root, repository, branch, taskId: context.taskId, signal: context.signal, onProgress: emit });
      if (result.status !== "completed") {
        const error = new Error(result.failure?.message || result.summary || "Codex coding execution did not complete.");
        error.code = result.failure?.code || `coding_executor_${result.status}`;
        error.safeDiagnostics = { codingResult: result };
        throw error;
      }
      await emit("reviewing", "Codex completed implementation, tests, review, and a local commit.");
      return result;
    },
  });
}

export function codingJobFingerprint(job) {
  return createHash("sha256").update(JSON.stringify(job)).digest("hex");
}
