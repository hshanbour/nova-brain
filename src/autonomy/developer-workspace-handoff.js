import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, relative, sep } from "node:path";
import { createDeveloperSessionAdapter } from "./developer-session-adapter.js";
import { createAgentsApiDeveloperProvider } from "../providers/developer-session-providers.js";
import { createDeterministicWorkspaceArchive, extractVerifiedWorkspaceArchive } from "./workspace-archive.js";
import {
  createDeveloperDependencyHostedFiles,
  validateDeveloperDependencyHandoffBundle,
} from "./developer-dependency-handoff.js";

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_FILE_BYTES = 7 * 1024 * 1024;
const MAX_WORKSPACE_BYTES = 2 * 1024 * 1024;
const WORKSPACE_DESTINATION = "/workspace/nova-brain";
const HANDOFF_DESTINATION = "/workspace/.nova-handoff";
const WORKSPACE_ARCHIVE_PATH = `${HANDOFF_DESTINATION}/workspace.tar.gz`;

export const REAL_DEVELOPER_TASK_ID = "selfdev_1a8f17abea3f043813fc4b5fc5db0e36";
export const REAL_DEVELOPER_REPOSITORY = "hshanbour/nova-brain";
export const REAL_DEVELOPER_BRANCH = "feat/nova-brain-mvp-foundation";
export const REAL_DEVELOPER_BASE_SHA = "911c1bc472e6017fac65146dd14298966a11c26f";
export const REAL_DEVELOPER_RECOVERY_BASE_SHA = "1509b7ec6eec689cd0b3030074c9f3ffba63379f";
export const REAL_DEVELOPER_PREVIEW_BRANCH = "stage13/control-plane-approved-delivery-runtime";
export const REAL_DEVELOPER_WORKSPACE_ROOT = "C:/Users/hamod/Documents/Codex/2026-08-28/we-are-continuing-the-nova-brain/work/nova-brain-microphone-task";
export const REAL_DEVELOPER_ALLOWED_PATHS = Object.freeze([
  "assets/console.css",
  "assets/console.js",
  "assets/voice-input.js",
  "index.html",
  "test/composer-dictation.test.js",
  "test/composer-voice-console.integration.test.js",
  "test/console-static.test.js",
  "test/voice-input.test.js",
]);
export const REAL_DEVELOPER_PROTECTED_PATHS = Object.freeze([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

const HISTORICAL_HANDOFF = Object.freeze({
  baseSha: REAL_DEVELOPER_BASE_SHA,
  dirtyPaths: Object.freeze([...REAL_DEVELOPER_ALLOWED_PATHS].sort()),
  mode: "real_task_workspace_handoff",
});
const CLEAN_RECOVERY_HANDOFF = Object.freeze({
  baseSha: REAL_DEVELOPER_RECOVERY_BASE_SHA,
  dirtyPaths: Object.freeze([]),
  mode: "real_task_clean_recovery_handoff",
});
const HANDOFF_CONTRACTS = Object.freeze([HISTORICAL_HANDOFF, CLEAN_RECOVERY_HANDOFF]);

export class DeveloperWorkspaceHandoffError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = "DeveloperWorkspaceHandoffError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode = 409) {
  throw new DeveloperWorkspaceHandoffError(code, message, statusCode);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalRoot(value) {
  return String(value || "").replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
}

function repoPath(value) {
  const path = String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!path || path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.split("/").includes("..")) {
    fail("WORKSPACE_INTEGRITY_FAILED", "Workspace contains an invalid repository path.");
  }
  return path;
}

function excludedPath(path) {
  const parts = path.toLowerCase().split("/");
  return parts.some((part) => [".git", "node_modules", ".vercel", ".next", ".cache", "coverage", "tmp", "temp"].includes(part))
    || /(^|\/)\.env(?:\.|$)/i.test(path)
    || /\.(?:pem|key|p12|pfx|log)$/i.test(path);
}

function exactKeys(value, allowed) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.includes(key));
}

function manifestPayload(manifest) {
  const { manifestHash, ...payload } = manifest;
  return payload;
}

function manifestHash(manifest) {
  return sha256(JSON.stringify(manifestPayload(manifest)));
}

function parseNul(value) {
  return String(value || "").split("\0").filter(Boolean);
}

function parseStatus(value) {
  const entries = [];
  const fields = parseNul(value);
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    const status = field.slice(0, 2);
    const path = repoPath(field.slice(3));
    entries.push({ status, path });
    if (status[0] === "R" || status[0] === "C") index += 1;
  }
  return entries;
}

async function defaultGit(root, args) {
  const { stdout } = await execFileAsync("git", ["-c", `safe.directory=${root}`, "-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

function normalizeRemote(value) {
  const text = String(value || "").trim().replace(/\.git$/, "");
  const match = text.match(/(?:github\.com[:/])([^/]+\/[^/]+)$/i);
  return match ? match[1] : text;
}

async function buildWorkspaceHandoffBundle({
  root = REAL_DEVELOPER_WORKSPACE_ROOT,
  git = defaultGit,
  read = readFile,
  stat = lstat,
} = {}, contract) {
  const absoluteRoot = resolve(root);
  const [topLevel, repository, branch, head, trackedRaw, statusRaw] = await Promise.all([
    git(absoluteRoot, ["rev-parse", "--show-toplevel"]),
    git(absoluteRoot, ["remote", "get-url", "origin"]),
    git(absoluteRoot, ["branch", "--show-current"]),
    git(absoluteRoot, ["rev-parse", "HEAD"]),
    git(absoluteRoot, ["ls-files", "-z"]),
    git(absoluteRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  ]);
  if (canonicalRoot(topLevel.trim()) !== canonicalRoot(absoluteRoot)
    || canonicalRoot(absoluteRoot) !== canonicalRoot(REAL_DEVELOPER_WORKSPACE_ROOT)
    || normalizeRemote(repository) !== REAL_DEVELOPER_REPOSITORY
    || branch.trim() !== REAL_DEVELOPER_BRANCH
    || head.trim().toLowerCase() !== contract.baseSha) {
    fail("WORKSPACE_INTEGRITY_FAILED", "Local workspace identity does not match the real Nova task.");
  }
  const statuses = parseStatus(statusRaw);
  const dirtyPaths = statuses.map((item) => item.path).sort();
  const expectedDirty = [...contract.dirtyPaths];
  if (JSON.stringify(dirtyPaths) !== JSON.stringify(expectedDirty)) {
    fail("WORKSPACE_INTEGRITY_FAILED", contract.dirtyPaths.length
      ? "The exact eight-file dirty workspace is required; clean-remote fallback and unrelated drift are forbidden."
      : "The recovery workspace must be clean; dirty or untracked paths are forbidden.");
  }
  const tracked = parseNul(trackedRaw).map(repoPath);
  const paths = [...new Set([...tracked, ...dirtyPaths])].filter((path) => !excludedPath(path)).sort();
  const dirtySet = new Set(dirtyPaths);
  const files = [];
  const entries = [];
  let totalBytes = 0;
  for (const path of paths) {
    const absolute = resolve(absoluteRoot, ...path.split("/"));
    if (relative(absoluteRoot, absolute).split(sep).includes("..")) fail("WORKSPACE_INTEGRITY_FAILED", "Workspace path escaped the canonical root.");
    const info = await stat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) fail("WORKSPACE_INTEGRITY_FAILED", "Workspace handoff supports regular files only.");
    const bytes = await read(absolute);
    if (bytes.length > MAX_FILE_BYTES) fail("WORKSPACE_INTEGRITY_FAILED", "Workspace file exceeds the bounded handoff size.");
    totalBytes += bytes.length;
    if (totalBytes > MAX_WORKSPACE_BYTES) fail("WORKSPACE_INTEGRITY_FAILED", "Workspace exceeds the bounded handoff size.");
    entries.push(Object.freeze({ path, size: bytes.length, sha256: sha256(bytes), dirty: dirtySet.has(path) }));
    files.push(Object.freeze({ path, data: bytes.toString("base64") }));
  }
  const manifest = {
    version: 1,
    taskId: REAL_DEVELOPER_TASK_ID,
    repository: REAL_DEVELOPER_REPOSITORY,
    branch: REAL_DEVELOPER_BRANCH,
    baseSha: contract.baseSha,
    workspaceRoot: absoluteRoot.replaceAll("\\", "/"),
    workspaceDestination: WORKSPACE_DESTINATION,
    entries,
    dirtyPaths,
    authorizedMutationPaths: [...REAL_DEVELOPER_ALLOWED_PATHS],
    protectedPaths: [...REAL_DEVELOPER_PROTECTED_PATHS],
    totalBytes,
  };
  manifest.manifestHash = manifestHash(manifest);
  return Object.freeze({ manifest: Object.freeze(manifest), files: Object.freeze(files) });
}

export function buildDeveloperWorkspaceHandoffBundle(options = {}) {
  return buildWorkspaceHandoffBundle(options, HISTORICAL_HANDOFF);
}

export function buildDeveloperRecoveryWorkspaceHandoffBundle(options = {}) {
  return buildWorkspaceHandoffBundle(options, CLEAN_RECOVERY_HANDOFF);
}

function validateBundle(input, contract) {
  if (!exactKeys(input, ["manifest", "files"]) || !exactKeys(input.manifest, [
    "version", "taskId", "repository", "branch", "baseSha", "workspaceRoot", "workspaceDestination",
    "entries", "dirtyPaths", "authorizedMutationPaths", "protectedPaths", "totalBytes", "manifestHash",
  ]) || !Array.isArray(input.files) || !Array.isArray(input.manifest.entries)) {
    fail("WORKSPACE_INTEGRITY_FAILED", "Workspace handoff envelope is invalid.", 400);
  }
  const manifest = structuredClone(input.manifest);
  if (manifest.version !== 1 || manifest.taskId !== REAL_DEVELOPER_TASK_ID || manifest.repository !== REAL_DEVELOPER_REPOSITORY
    || manifest.branch !== REAL_DEVELOPER_BRANCH || manifest.baseSha !== contract.baseSha
    || canonicalRoot(manifest.workspaceRoot) !== canonicalRoot(REAL_DEVELOPER_WORKSPACE_ROOT)
    || manifest.workspaceDestination !== WORKSPACE_DESTINATION || !SHA256.test(manifest.manifestHash)
    || manifest.manifestHash !== manifestHash(manifest)
    || JSON.stringify(manifest.dirtyPaths) !== JSON.stringify(contract.dirtyPaths)
    || JSON.stringify(manifest.authorizedMutationPaths) !== JSON.stringify(REAL_DEVELOPER_ALLOWED_PATHS)
    || JSON.stringify(manifest.protectedPaths) !== JSON.stringify(REAL_DEVELOPER_PROTECTED_PATHS)) {
    fail("WORKSPACE_INTEGRITY_FAILED", "Workspace manifest bindings do not match the real Nova task.");
  }
  const entries = manifest.entries;
  const sorted = [...entries].sort((a, b) => String(a.path) < String(b.path) ? -1 : String(a.path) > String(b.path) ? 1 : 0);
  if (JSON.stringify(entries) !== JSON.stringify(sorted) || entries.length !== input.files.length || entries.length === 0) {
    fail("WORKSPACE_INTEGRITY_FAILED", "Workspace manifest file set is incomplete or non-canonical.");
  }
  let totalBytes = 0;
  const materials = entries.map((entry, index) => {
    if (!exactKeys(entry, ["path", "size", "sha256", "dirty"]) || !exactKeys(input.files[index], ["path", "data"])) {
      fail("WORKSPACE_INTEGRITY_FAILED", "Workspace file evidence is invalid.");
    }
    const path = repoPath(entry.path);
    if (excludedPath(path) || path !== input.files[index].path || !Number.isInteger(entry.size) || entry.size < 0
      || entry.size > MAX_FILE_BYTES || !SHA256.test(entry.sha256) || typeof entry.dirty !== "boolean"
      || typeof input.files[index].data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.files[index].data)) {
      fail("WORKSPACE_INTEGRITY_FAILED", "Workspace file evidence failed validation.");
    }
    const bytes = Buffer.from(input.files[index].data, "base64");
    totalBytes += bytes.length;
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256 || entry.dirty !== manifest.dirtyPaths.includes(path)) {
      fail("WORKSPACE_INTEGRITY_FAILED", "Workspace file bytes do not match the manifest.");
    }
    return { path, data: bytes };
  });
  if (totalBytes !== manifest.totalBytes || totalBytes > MAX_WORKSPACE_BYTES) fail("WORKSPACE_INTEGRITY_FAILED", "Workspace byte total does not match the manifest.");
  return { manifest, materials };
}

function verificationSource({ readOnly = false, archiveSha256, expectedManifestHash, contract } = {}) {
  return `import{createHash}from"node:crypto";import{readFile,readdir,stat,chmod,mkdir,writeFile}from"node:fs/promises";import{resolve,dirname,relative,sep}from"node:path";import{gunzipSync}from"node:zlib";const root=${JSON.stringify(WORKSPACE_DESTINATION)},manifest=JSON.parse(await readFile(${JSON.stringify(`${HANDOFF_DESTINATION}/manifest.json`)},"utf8")),claimed=manifest.manifestHash;delete manifest.manifestHash;const manifestHash=createHash("sha256").update(JSON.stringify(manifest)).digest("hex");if(claimed!==${JSON.stringify(expectedManifestHash)}||claimed!==manifestHash||manifest.taskId!==${JSON.stringify(REAL_DEVELOPER_TASK_ID)}||manifest.repository!==${JSON.stringify(REAL_DEVELOPER_REPOSITORY)}||manifest.branch!==${JSON.stringify(REAL_DEVELOPER_BRANCH)}||manifest.baseSha!==${JSON.stringify(contract.baseSha)}||manifest.workspaceDestination!==root||JSON.stringify(manifest.dirtyPaths)!==${JSON.stringify(JSON.stringify(contract.dirtyPaths))}||JSON.stringify(manifest.authorizedMutationPaths)!==${JSON.stringify(JSON.stringify(REAL_DEVELOPER_ALLOWED_PATHS))}||JSON.stringify(manifest.protectedPaths)!==${JSON.stringify(JSON.stringify(REAL_DEVELOPER_PROTECTED_PATHS))}||manifest.entries.some(entry=>entry.dirty!==manifest.dirtyPaths.includes(entry.path)))throw new Error("WORKSPACE_INTEGRITY_FAILED");const extractVerifiedWorkspaceArchive=${extractVerifiedWorkspaceArchive.toString()};const archive=await readFile(${JSON.stringify(WORKSPACE_ARCHIVE_PATH)});await extractVerifiedWorkspaceArchive({archive,root,entries:manifest.entries,archiveSha256:${JSON.stringify(archiveSha256)},createHash,gunzipSync,mkdir,writeFile,readFile,readdir,stat,chmod,resolve,dirname,relative,sep,modeForPath:path=>${readOnly ? "0o400" : "manifest.authorizedMutationPaths.includes(path)?0o600:0o400"}});console.log("NOVA_WORKSPACE_INTEGRITY_OK:"+claimed);`;
}

export function createDeveloperWorkspaceHandoff({ environment = process.env, storage, ownerId, providerFactory = createAgentsApiDeveloperProvider, taskReader, idFactory, clock } = {}) {
  if (!storage?.saveDeveloperSession || !storage?.getDeveloperSession) fail("developer_workspace_storage_required", "Durable developer session storage is required.", 503);
  const assertPreview = () => {
    if (environment.VERCEL_ENV !== "preview" || environment.VERCEL_GIT_COMMIT_REF !== REAL_DEVELOPER_PREVIEW_BRANCH) {
      fail("developer_workspace_preview_only", "Real workspace handoff is restricted to the approved Preview branch.", 403);
    }
    if (!environment.OPENAI_API_KEY) fail("developer_workspace_openai_key_missing", "OPENAI_API_KEY is not configured.", 503);
    if (!(environment.NOVA_DEVELOPER_MODEL || environment.OPENAI_MODEL)) fail("developer_workspace_model_missing", "An inline developer agent model is not configured.", 503);
  };
  const readTask = taskReader || ((id) => storage.getAutonomyTask(id, ownerId));
  const sessionStore = { get: (id) => storage.getDeveloperSession(id, ownerId), save: (record) => storage.saveDeveloperSession(record, ownerId) };
  const adapterFor = (provider) => createDeveloperSessionAdapter({ providers: { agents_api: provider }, defaultProvider: "agents_api", sessionStore, ...(idFactory ? { idFactory } : {}), ...(clock ? { clock } : {}) });
  const passiveProvider = () => providerFactory({ apiKey: environment.OPENAI_API_KEY, agent: { model: environment.NOVA_DEVELOPER_MODEL || environment.OPENAI_MODEL }, environment: { type: "openai_hosted", network: { access: "disabled" }, files: [] } });
  const boundTask = async () => {
    const task = await readTask(REAL_DEVELOPER_TASK_ID);
    if (!task || task.stateVersion !== 451 || task.status !== "blocked" || task.branch !== REAL_DEVELOPER_BRANCH
      || task.currentCommit !== REAL_DEVELOPER_BASE_SHA || task.repairIteration !== 3) {
      fail("developer_workspace_task_binding_changed", "The real Nova task is no longer at its exact v451 handoff boundary.");
    }
  };
  const contractForMode = (mode) => HANDOFF_CONTRACTS.find((contract) => contract.mode === mode) || null;
  const assertBoundRealSession = async (sessionId) => {
    const record = await storage.getDeveloperSession(sessionId, ownerId);
    const contract = contractForMode(record?.policy?.metadata?.mode);
    if (!record || record.taskId !== REAL_DEVELOPER_TASK_ID || record.provider !== "agents_api"
      || record.providerSessionId == null || !contract
      || record.policy?.baseSha !== contract.baseSha || record.policy?.repository?.slug !== REAL_DEVELOPER_REPOSITORY
      || record.policy?.repository?.branch !== REAL_DEVELOPER_BRANCH
      || JSON.stringify(record.policy?.allowedPaths) !== JSON.stringify(REAL_DEVELOPER_ALLOWED_PATHS)) {
      fail("developer_workspace_session_binding_changed", "The developer session is not bound to the exact real Nova workspace handoff.");
    }
    return { record, contract };
  };
  const materializingProvider = ({ manifest, materials, readOnly, contract }) => {
    const archive = createDeterministicWorkspaceArchive(materials);
    const archiveSha256 = sha256(archive);
    const hostedFiles = [
      { type: "inline", path: WORKSPACE_ARCHIVE_PATH, data: archive.toString("base64") },
      { type: "inline", path: `${HANDOFF_DESTINATION}/manifest.json`, data: Buffer.from(JSON.stringify(manifest)).toString("base64") },
      { type: "inline", path: `${HANDOFF_DESTINATION}/verify.mjs`, data: Buffer.from(verificationSource({ readOnly, archiveSha256, expectedManifestHash: manifest.manifestHash, contract })).toString("base64") },
    ];
    return {
      archiveSha256,
      hostedFileCount: hostedFiles.length,
      provider: providerFactory({
        apiKey: environment.OPENAI_API_KEY,
        agent: { model: environment.NOVA_DEVELOPER_MODEL || environment.OPENAI_MODEL, instructions: readOnly ? "Perform no agent work. This session exists only to provision and verify an immutable workspace." : "Act only as Nova's bounded implementation harness. Preserve the supplied workspace, do not change file or directory permissions, and obey its exact mutation and approval policy." },
        environment: {
          type: "openai_hosted",
          network: { access: "disabled" },
          files: hostedFiles,
          setup_commands: [{ command: `node ${HANDOFF_DESTINATION}/verify.mjs`, cwd: "/workspace" }],
          packages: { npm: [], python: [], system: [] },
        },
      }),
    };
  };
  const start = async (input, contract, { goal, acceptanceCriteria }) => {
    assertPreview();
    await boundTask();
    const { manifest, materials } = validateBundle(input, contract);
    const packaged = materializingProvider({ manifest, materials, readOnly: false, contract });
    return adapterFor(packaged.provider).startDeveloperSession({
      taskId: REAL_DEVELOPER_TASK_ID,
      goal,
      acceptanceCriteria,
      repository: { slug: REAL_DEVELOPER_REPOSITORY, branch: REAL_DEVELOPER_BRANCH, workspace: WORKSPACE_DESTINATION },
      baseSha: contract.baseSha,
      allowedPaths: [...REAL_DEVELOPER_ALLOWED_PATHS],
      forbiddenPaths: [...REAL_DEVELOPER_PROTECTED_PATHS, ".git", "node_modules", ".env"],
      approvalPolicy: { requireFor: ["commit", "push", "deploy", "scope_change", "dependency_change", "external_action"], allowPush: false, allowDeploy: false },
      metadata: { mode: contract.mode, manifestHash: manifest.manifestHash, archiveSha256: packaged.archiveSha256, hostedFileCount: packaged.hostedFileCount, workspaceRoot: manifest.workspaceRoot, materializedFileCount: manifest.entries.length, taskStateVersion: 451 },
      dryRun: false,
    });
  };
  return Object.freeze({
    async start(input) {
      return start(input, HISTORICAL_HANDOFF, {
        goal: "Continue Nova's microphone repair from the exact materialized local workspace. Nova owns diagnosis, planning, implementation, testing, and review.",
        acceptanceCriteria: ["Use only the exact materialized workspace bytes.", "Modify only the eight authorized paths.", "Do not modify dependencies, commit, push, deploy, or widen scope."],
      });
    },
    async startRecovery(input) {
      return start(input, CLEAN_RECOVERY_HANDOFF, {
        goal: "Reapply Nova's reviewed microphone browser-acceptance repair from the exact clean feature workspace and publish immutable delivery artifacts.",
        acceptanceCriteria: ["Begin from the exact clean recovery base.", "Modify only the eight authorized paths.", "Run the bounded focused tests and fresh Nova review.", "Publish immutable reviewed changed-file artifacts before delivery readiness.", "Do not modify dependencies, commit, push, deploy, or widen scope."],
      });
    },
    async verify(input) {
      assertPreview();
      await boundTask();
      const { manifest, materials } = validateBundle(input, HISTORICAL_HANDOFF);
      const packaged = materializingProvider({ manifest, materials, readOnly: true, contract: HISTORICAL_HANDOFF });
      const provider = packaged.provider;
      return adapterFor(provider).verifyDeveloperWorkspace({
        taskId: REAL_DEVELOPER_TASK_ID,
        goal: "Verify the exact materialized Nova workspace and stop without submitting developer work.",
        acceptanceCriteria: ["Materialize exactly the canonical manifest.", "Verify every file and hash in the hosted environment.", "Submit no engineering instruction and perform no product mutation."],
        repository: { slug: REAL_DEVELOPER_REPOSITORY, branch: REAL_DEVELOPER_BRANCH, workspace: WORKSPACE_DESTINATION },
        baseSha: REAL_DEVELOPER_BASE_SHA,
        allowedPaths: [...REAL_DEVELOPER_ALLOWED_PATHS],
        forbiddenPaths: [...REAL_DEVELOPER_PROTECTED_PATHS, ".git", "node_modules", ".env"],
        approvalPolicy: { requireFor: [], allowPush: false, allowDeploy: false },
        metadata: { mode: "workspace_materialization_verification", manifestHash: manifest.manifestHash, archiveSha256: packaged.archiveSha256, hostedFileCount: packaged.hostedFileCount, workspaceRoot: manifest.workspaceRoot, materializedFileCount: manifest.entries.length, totalBytes: manifest.totalBytes, dirtyPaths: [...manifest.dirtyPaths], taskStateVersion: 451 },
        dryRun: true,
      });
    },
    async get(sessionId) { assertPreview(); return adapterFor(passiveProvider()).getDeveloperSession({ sessionId }); },
    async reconcile(sessionId) { assertPreview(); await boundTask(); await assertBoundRealSession(sessionId); return adapterFor(passiveProvider()).reconcileDeveloperSession({ sessionId }); },
    async materializeDependencies(sessionId, input) {
      assertPreview();
      await boundTask();
      const { record } = await assertBoundRealSession(sessionId);
      const environmentId = record.evidence?.environmentId;
      if (typeof environmentId !== "string" || !environmentId) {
        fail("developer_workspace_environment_binding_missing", "The existing provider environment identity is unavailable.");
      }
      const expectedPackageLock = await readFile(new URL("../../package-lock.json", import.meta.url));
      const bundle = validateDeveloperDependencyHandoffBundle(input, { expectedPackageLock });
      const files = createDeveloperDependencyHostedFiles(bundle);
      const existingCount = Number(record.policy?.metadata?.hostedFileCount || 0);
      if (existingCount + files.length >= 50) fail("developer_workspace_file_limit", "Dependency handoff would exceed the hosted environment file limit.");
      return adapterFor(passiveProvider()).materializeDeveloperDependencies({
        sessionId,
        environmentId,
        files,
        verificationInstruction: "Run exactly `node /workspace/.nova-dependency-handoff/verify.mjs`. Do not inspect, edit, or test product code. Do not run any other command. Return only the final NOVA_DEPENDENCY_INTEGRITY_OK marker or the bounded failure code.",
        metadata: {
          packageLockSha256: bundle.manifest.packageLockSha256,
          dependencyArchiveSha256: bundle.manifest.dependencyArchiveSha256,
          dependencyManifestHash: bundle.manifest.dependencyManifestHash,
          dependencyFileCount: bundle.manifest.fileCount,
          dependencyBytes: bundle.manifest.totalBytes,
          addedHostedFileCount: files.length,
          hostedFileCountAfter: existingCount + files.length,
        },
      });
    },
    async verifyArtifact(sessionId, artifactId, expectedSha256) {
      assertPreview();
      await boundTask();
      const { record } = await assertBoundRealSession(sessionId);
      if (!SHA256.test(String(expectedSha256 || ""))) {
        fail("developer_artifact_hash_invalid", "A full expected artifact SHA-256 is required.", 400);
      }
      const provider = passiveProvider();
      if (typeof provider.verifyArtifact !== "function") {
        fail("developer_artifact_verification_unavailable", "The developer provider does not support artifact verification.", 503);
      }
      try {
        return await provider.verifyArtifact({
          providerSessionId: record.providerSessionId,
          artifactId,
          expectedSha256,
        });
      } catch (error) {
        if (error?.code === "developer_provider_session_mismatch") {
          fail(error.code, "Artifact identity does not belong to the bound provider session.");
        }
        if (error?.code === "developer_artifact_integrity_failed") {
          fail(error.code, "Artifact content failed SHA-256 verification.");
        }
        fail("developer_artifact_verification_failed", "Artifact verification failed closed.", 502);
      }
    },
    async resume(sessionId, input = {}) { assertPreview(); return adapterFor(passiveProvider()).resumeDeveloperSession({ sessionId, approvalDecision: input.approvalDecision, additionalInstruction: input.additionalInstruction }); },
    async cancel(sessionId) { assertPreview(); return adapterFor(passiveProvider()).cancelDeveloperSession({ sessionId }); },
  });
}
