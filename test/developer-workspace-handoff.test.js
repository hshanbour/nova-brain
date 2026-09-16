import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { createApi } from "../src/http/api.js";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";
import {
  buildDeveloperWorkspaceHandoffBundle,
  createDeveloperWorkspaceHandoff,
  REAL_DEVELOPER_ALLOWED_PATHS,
  REAL_DEVELOPER_BASE_SHA,
  REAL_DEVELOPER_BRANCH,
  REAL_DEVELOPER_PREVIEW_BRANCH,
  REAL_DEVELOPER_REPOSITORY,
  REAL_DEVELOPER_TASK_ID,
  REAL_DEVELOPER_WORKSPACE_ROOT,
} from "../src/autonomy/developer-workspace-handoff.js";
import { createDeterministicDeveloperProvider } from "../src/providers/developer-session-providers.js";

const OWNER = "owner";
const ADMIN = "a".repeat(40);
const SECRET = "sk-test-secret-never-serialize";

function hash(value) { return createHash("sha256").update(value).digest("hex"); }

function fakeWorkspace({ status = null } = {}) {
  const contents = new Map([
    ...REAL_DEVELOPER_ALLOWED_PATHS.map((path, index) => [path, Buffer.from(index === 0 ? "dirty\r\nbytes\r\n" : `dirty-${index}\n`)]),
    ["package.json", Buffer.from('{"type":"module"}\n')],
    ["src/app.js", Buffer.from("export const app = true;\n")],
  ]);
  const tracked = [...contents.keys()].filter((path) => path !== "test/composer-voice-console.integration.test.js");
  const dirtyStatus = REAL_DEVELOPER_ALLOWED_PATHS.map((path) => `${path === "test/composer-voice-console.integration.test.js" ? "??" : " M"} ${path}\0`).join("");
  const git = async (_root, args) => {
    const key = args.join(" ");
    if (key === "rev-parse --show-toplevel") return `${REAL_DEVELOPER_WORKSPACE_ROOT}\n`;
    if (key === "remote get-url origin") return "git@github.com:hshanbour/nova-brain.git\n";
    if (key === "branch --show-current") return `${REAL_DEVELOPER_BRANCH}\n`;
    if (key === "rev-parse HEAD") return `${REAL_DEVELOPER_BASE_SHA}\n`;
    if (key === "ls-files -z") return `${tracked.join("\0")}\0`;
    if (key === "status --porcelain=v1 -z --untracked-files=all") return status ?? dirtyStatus;
    throw new Error(`unexpected git command: ${key}`);
  };
  const read = async (absolute) => {
    const normalized = absolute.replaceAll("\\", "/");
    const path = [...contents.keys()].find((candidate) => normalized.endsWith(`/${candidate}`));
    if (!path) throw new Error(`missing fake file ${absolute}`);
    return contents.get(path);
  };
  const stat = async () => ({ isFile: () => true, isSymbolicLink: () => false });
  return { contents, git, read, stat };
}

async function bundle(options) {
  const fixture = fakeWorkspace(options);
  return buildDeveloperWorkspaceHandoffBundle({ root: REAL_DEVELOPER_WORKSPACE_ROOT, git: fixture.git, read: fixture.read, stat: fixture.stat });
}

function environment(overrides = {}) {
  return { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: REAL_DEVELOPER_PREVIEW_BRANCH, OPENAI_API_KEY: SECRET, OPENAI_MODEL: "gpt-5.2-codex", ...overrides };
}

function serviceFixture({ providerScript, providerOverride } = {}) {
  const storage = createInMemoryStorage();
  const provider = providerOverride || createDeterministicDeveloperProvider(providerScript || [{ providerSessionId: "provider-real-1", status: "running", changedPaths: [] }]);
  const configurations = [];
  const service = createDeveloperWorkspaceHandoff({
    environment: environment(), storage, ownerId: OWNER,
    taskReader: async () => ({ stateVersion: 451, status: "blocked", branch: REAL_DEVELOPER_BRANCH, currentCommit: REAL_DEVELOPER_BASE_SHA, repairIteration: 3 }),
    providerFactory(configuration) { configurations.push(configuration); return provider; },
    idFactory: () => "real-session-1", clock: () => new Date("2026-09-16T12:00:00.000Z"),
  });
  return { storage, provider, configurations, service };
}

function request({ body, authorized = true, url = "/api/admin/developer-sessions/real/microphone/start" }) {
  const stream = Readable.from([JSON.stringify(body)]);
  stream.method = "POST";
  stream.url = url;
  stream.headers = { "content-type": "application/json", ...(authorized ? { authorization: `Bearer ${ADMIN}` } : {}) };
  return stream;
}

function response() {
  let body = "";
  return { statusCode: 0, setHeader() {}, end(value = "") { body += value; }, get json() { return body ? JSON.parse(body) : null; } };
}

function api(service, developerSessionSmoke = null) {
  return createApi({
    agent: { tools: { list: () => [] }, run: async () => ({}) },
    config: { allowedOrigins: [], maxBodyBytes: 64 * 1024, developerWorkspaceHandoffMaxBodyBytes: 3 * 1024 * 1024, workerAdminToken: ADMIN },
    storage: { provider: "memory", durable: false }, initialize: async () => {}, ownerId: OWNER,
    developerWorkspaceHandoff: service, developerSessionSmoke, logger: { info() {}, error() {} },
  });
}

test("manifest preserves exact dirty bytes and deterministic hashes", async () => {
  const fixture = fakeWorkspace();
  const first = await buildDeveloperWorkspaceHandoffBundle({ root: REAL_DEVELOPER_WORKSPACE_ROOT, git: fixture.git, read: fixture.read, stat: fixture.stat });
  const second = await buildDeveloperWorkspaceHandoffBundle({ root: REAL_DEVELOPER_WORKSPACE_ROOT, git: fixture.git, read: fixture.read, stat: fixture.stat });
  assert.deepEqual(first, second);
  const css = first.manifest.entries.find((entry) => entry.path === "assets/console.css");
  assert.equal(css.sha256, hash(Buffer.from("dirty\r\nbytes\r\n")));
  assert.equal(Buffer.from(first.files.find((file) => file.path === css.path).data, "base64").toString(), "dirty\r\nbytes\r\n");
  assert.deepEqual(first.manifest.dirtyPaths, [...REAL_DEVELOPER_ALLOWED_PATHS].sort());
  for (const path of REAL_DEVELOPER_ALLOWED_PATHS) {
    assert.equal(first.manifest.entries.find((entry) => entry.path === path).sha256, hash(fixture.contents.get(path)));
  }
});

test("manifest rejects clean remote fallback and unrelated dirty paths", async () => {
  await assert.rejects(() => bundle({ status: "" }), (error) => error.code === "WORKSPACE_INTEGRITY_FAILED");
  await assert.rejects(() => bundle({ status: ` M package.json\0` }), (error) => error.code === "WORKSPACE_INTEGRITY_FAILED");
});

test("real start materializes official inline environment files and pre-agent integrity verification", async () => {
  const handoff = await bundle();
  const { service, configurations } = serviceFixture();
  const session = await service.start(handoff);
  assert.equal(session.taskId, REAL_DEVELOPER_TASK_ID);
  assert.equal(session.policy.baseSha, REAL_DEVELOPER_BASE_SHA);
  assert.deepEqual(session.policy.allowedPaths, REAL_DEVELOPER_ALLOWED_PATHS);
  assert.equal(session.policy.dryRun, false);
  assert.equal(session.policy.approvalPolicy.allowPush, false);
  assert.equal(session.policy.approvalPolicy.allowDeploy, false);
  assert.ok(["package.json", "package-lock.json"].every((path) => session.policy.forbiddenPaths.includes(path)));
  const hosted = configurations[0].environment;
  assert.equal(hosted.type, "openai_hosted");
  assert.deepEqual(hosted.network, { access: "disabled" });
  assert.equal(hosted.files.length, 3);
  assert.ok(hosted.files.every((file) => file.type === "inline" && file.path.startsWith("/workspace/")));
  assert.ok(hosted.files.some((file) => file.path === "/workspace/.nova-handoff/workspace.tar.gz"));
  assert.ok(hosted.files.some((file) => file.path === "/workspace/.nova-handoff/manifest.json"));
  assert.equal(session.policy.metadata.hostedFileCount, 3);
  assert.match(session.policy.metadata.archiveSha256, /^[a-f0-9]{64}$/);
  assert.match(hosted.setup_commands[0].command, /verify\.mjs/);
  assert.doesNotMatch(JSON.stringify(session), /dirty\\r|sk-test-secret/);
});

test("verification-only route materializes an immutable workspace and persists proof without starting engineering", async () => {
  const calls = [];
  const provider = {
    name: "agents_api",
    async start() { throw new Error("engineering start must not be called"); },
    async verifyWorkspace(input) {
      calls.push(structuredClone(input));
      return {
        providerSessionId: "provider-verification-1",
        status: "completed",
        result: {
          sessionId: "provider-verification-1",
          environmentId: "env-verification-1",
          outcome: "workspace_integrity_verified",
        },
        changedPaths: [],
      };
    },
  };
  const handoff = await bundle();
  const { service, configurations, storage } = serviceFixture({ providerOverride: provider });
  const session = await service.verify(handoff);

  assert.equal(session.status, "completed");
  assert.equal(session.policy.dryRun, true);
  assert.equal(session.policy.metadata.mode, "workspace_materialization_verification");
  assert.equal(session.changedPaths.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].policy.goal.includes("Continue Nova's microphone repair"), false);
  assert.equal(calls[0].policy.approvalPolicy.allowPush, false);
  assert.equal(calls[0].policy.approvalPolicy.allowDeploy, false);
  assert.equal(configurations[0].environment.network.access, "disabled");
  assert.equal(configurations[0].environment.files.length, 3);
  const verifier = configurations[0].environment.files.find((file) => file.path.endsWith("/verify.mjs"));
  const source = Buffer.from(verifier.data, "base64").toString();
  assert.match(source, /modeForPath:path=>0o400/);
  assert.match(source, new RegExp(handoff.manifest.manifestHash));
  assert.equal(session.policy.metadata.hostedFileCount, 3);
  assert.match(session.policy.metadata.archiveSha256, /^[a-f0-9]{64}$/);
  assert.equal((await storage.getDeveloperSession("real-session-1", OWNER)).result.outcome, "workspace_integrity_verified");
});

test("protected verification route is authenticated, distinct from start and accepts only exact bundles", async () => {
  const calls = [];
  const service = {
    async verify(value) { calls.push({ method: "verify", value }); return { id: "verification-1", status: "completed" }; },
    async start(value) { calls.push({ method: "start", value }); return { id: "start-1", status: "running" }; },
  };
  const application = api(service);
  const handoff = await bundle();
  const denied = response();
  await application.handle(request({ body: handoff, authorized: false, url: "/api/admin/developer-sessions/real/microphone/verify-workspace" }), denied);
  assert.equal(denied.statusCode, 401);
  assert.equal(calls.length, 0);

  const verified = response();
  await application.handle(request({ body: handoff, url: "/api/admin/developer-sessions/real/microphone/verify-workspace" }), verified);
  assert.equal(verified.statusCode, 201);
  assert.equal(calls[0].method, "verify");

  const started = response();
  await application.handle(request({ body: handoff }), started);
  assert.equal(started.statusCode, 201);
  assert.equal(calls[1].method, "start");
});

test("verification route remains distinct from the existing smoke route", async () => {
  const calls = [];
  const workspace = {
    async verify() { calls.push("workspace.verify"); return { id: "verification-1", status: "completed" }; },
  };
  const smoke = {
    async start() { calls.push("smoke.start"); return { id: "smoke-1", status: "running" }; },
  };
  const application = api(workspace, smoke);
  const verified = response();
  await application.handle(request({ body: await bundle(), url: "/api/admin/developer-sessions/real/microphone/verify-workspace" }), verified);
  assert.equal(verified.statusCode, 201);
  const smoked = response();
  await application.handle(request({ body: {}, url: "/api/admin/developer-sessions/smoke/start" }), smoked);
  assert.equal(smoked.statusCode, 201);
  assert.deepEqual(calls, ["workspace.verify", "smoke.start"]);
});

test("verification reads but cannot mutate the bound real-task state", async () => {
  const durableTask = Object.freeze({ stateVersion: 451, status: "blocked", branch: REAL_DEVELOPER_BRANCH, currentCommit: REAL_DEVELOPER_BASE_SHA, repairIteration: 3 });
  let reads = 0;
  const provider = {
    name: "agents_api",
    async verifyWorkspace() {
      return { providerSessionId: "provider-verification-1", status: "completed", result: { outcome: "workspace_integrity_verified" }, changedPaths: [] };
    },
  };
  const storage = createInMemoryStorage();
  const service = createDeveloperWorkspaceHandoff({
    environment: environment(), storage, ownerId: OWNER, providerFactory: () => provider,
    taskReader: async () => { reads += 1; return durableTask; },
    idFactory: () => "verification-1",
  });
  await service.verify(await bundle());
  assert.equal(reads, 1);
  assert.deepEqual(durableTask, { stateVersion: 451, status: "blocked", branch: REAL_DEVELOPER_BRANCH, currentCommit: REAL_DEVELOPER_BASE_SHA, repairIteration: 3 });
});

test("verification rejects manifest drift and the wrong Preview without invoking the provider", async () => {
  let providerCalls = 0;
  const provider = {
    name: "agents_api",
    async verifyWorkspace() { providerCalls += 1; return { providerSessionId: "unexpected", status: "completed", result: {}, changedPaths: [] }; },
  };
  const original = await bundle();
  const changed = structuredClone(original);
  changed.files[0].data = Buffer.from("drift").toString("base64");
  const { service } = serviceFixture({ providerOverride: provider });
  await assert.rejects(() => service.verify(changed), (error) => error.code === "WORKSPACE_INTEGRITY_FAILED");
  assert.equal(providerCalls, 0);

  const storage = createInMemoryStorage();
  const wrongPreview = createDeveloperWorkspaceHandoff({
    environment: environment({ VERCEL_GIT_COMMIT_REF: "main" }), storage, ownerId: OWNER,
    providerFactory: () => provider,
    taskReader: async () => ({ stateVersion: 451, status: "blocked", branch: REAL_DEVELOPER_BRANCH, currentCommit: REAL_DEVELOPER_BASE_SHA, repairIteration: 3 }),
  });
  await assert.rejects(() => wrongPreview.verify(original), (error) => error.code === "developer_workspace_preview_only");
  assert.equal(providerCalls, 0);
});

test("tampered bytes, unexpected paths and caller scope widening fail closed", async () => {
  const original = await bundle();
  for (const mutate of [
    (value) => { value.files[0].data = Buffer.from("tampered").toString("base64"); },
    (value) => { value.extraTaskId = "other"; },
    (value) => { value.manifest.authorizedMutationPaths.push("package.json"); },
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    const { service } = serviceFixture();
    await assert.rejects(() => service.start(changed), (error) => error.code === "WORKSPACE_INTEGRITY_FAILED");
  }
});

test("reported ninth-file and package mutations are rejected by the adapter", async () => {
  for (const changedPath of ["README.md", "package.json", "package-lock.json"] ) {
    const { service } = serviceFixture({ providerScript: [{ providerSessionId: "provider-real-1", status: "completed", result: { outcome: "done" }, changedPaths: [changedPath] }] });
    const handoff = await bundle();
    await assert.rejects(() => service.start(handoff), (error) => error.code === "developer_provider_scope_violation");
  }
  const { service } = serviceFixture({ providerScript: [{ providerSessionId: "provider-real-1", status: "completed", result: { outcome: "done" }, changedPaths: ["../escape"] }] });
  const failed = await service.start(await bundle());
  assert.equal(failed.status, "failed");
  assert.equal(failed.changedPaths.length, 0);
});

test("protected real route is authenticated and caller cannot widen fixed task scope", async () => {
  const handoff = await bundle();
  const { service } = serviceFixture();
  const application = api(service);
  const denied = response();
  await application.handle(request({ body: handoff, authorized: false }), denied);
  assert.equal(denied.statusCode, 401);
  const widened = response();
  await application.handle(request({ body: { ...handoff, taskId: "other" } }), widened);
  assert.equal(widened.statusCode, 400);
  assert.equal(widened.json.code, "WORKSPACE_INTEGRITY_FAILED");
  const accepted = response();
  await application.handle(request({ body: handoff }), accepted);
  assert.equal(accepted.statusCode, 201);
  assert.equal(accepted.json.session.taskId, REAL_DEVELOPER_TASK_ID);
});

test("real handoff rejects the wrong Preview and any change to the durable v451 task binding", async () => {
  const handoff = await bundle();
  const storage = createInMemoryStorage();
  const provider = createDeterministicDeveloperProvider([{ providerSessionId: "unused", status: "running", changedPaths: [] }]);
  const wrongPreview = createDeveloperWorkspaceHandoff({ environment: environment({ VERCEL_GIT_COMMIT_REF: "main" }), storage, ownerId: OWNER, providerFactory: () => provider, taskReader: async () => ({ stateVersion: 451 }) });
  await assert.rejects(() => wrongPreview.start(handoff), (error) => error.code === "developer_workspace_preview_only");
  const changedTask = createDeveloperWorkspaceHandoff({ environment: environment(), storage, ownerId: OWNER, providerFactory: () => provider, taskReader: async () => ({ stateVersion: 452, status: "blocked", branch: REAL_DEVELOPER_BRANCH, currentCommit: REAL_DEVELOPER_BASE_SHA, repairIteration: 3 }) });
  await assert.rejects(() => changedTask.start(handoff), (error) => error.code === "developer_workspace_task_binding_changed");
});

test("excluded workspace paths never enter the materialization request", async () => {
  const handoff = await bundle();
  assert.equal(handoff.manifest.entries.some((entry) => /(^|\/)(?:\.git|node_modules|\.env|\.cache)(\/|$)/i.test(entry.path)), false);
  assert.equal(handoff.files.some((file) => /(^|\/)(?:\.git|node_modules|\.env|\.cache)(\/|$)/i.test(file.path)), false);
});
