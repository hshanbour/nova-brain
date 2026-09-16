import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import {
  buildDeveloperDependencyHandoffBundle,
  createDeveloperDependencyHostedFiles,
  DEVELOPER_DEPENDENCY_HANDOFF,
  validateDeveloperDependencyHandoffBundle,
} from "../src/autonomy/developer-dependency-handoff.js";
import { extractVerifiedWorkspaceArchive } from "../src/autonomy/workspace-archive.js";
import { REAL_DEVELOPER_WORKSPACE_ROOT } from "../src/autonomy/developer-workspace-handoff.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");

async function actualBundle() {
  return buildDeveloperDependencyHandoffBundle({
    root: REAL_DEVELOPER_WORKSPACE_ROOT,
    npmVersion: async () => "11.8.0",
  });
}

test("dependency bundle is deterministic, lock-bound, bounded, and resolves the required installed package", async () => {
  const [first, second, lock] = await Promise.all([
    actualBundle(), actualBundle(), readFile(join(REAL_DEVELOPER_WORKSPACE_ROOT, "package-lock.json")),
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.manifest.packageLockSha256, digest(lock));
  assert.deepEqual(first.manifest.packages, [{
    path: "@neondatabase/serverless",
    name: "@neondatabase/serverless",
    version: "1.1.0",
    resolved: "https://registry.npmjs.org/@neondatabase/serverless/-/serverless-1.1.0.tgz",
    integrity: "sha512-r3ZZhRjEcfEdKIZnoB1RusNgvHuaBRqfCzV4Gi+5A9yUX0S4HTws/ASWqt13wL4y4I+0rqsWGdA2w7EQXHi3+Q==",
  }]);
  assert.deepEqual(first.manifest.requiredPackages, ["@neondatabase/serverless"]);
  assert.ok(first.manifest.fileCount > 0 && first.manifest.fileCount <= DEVELOPER_DEPENDENCY_HANDOFF.maxFiles);
  assert.ok(first.manifest.totalBytes > 0 && first.manifest.totalBytes <= DEVELOPER_DEPENDENCY_HANDOFF.maxBytes);
  const validated = validateDeveloperDependencyHandoffBundle(first, { expectedPackageLock: lock });
  assert.equal(validated.manifest.dependencyArchiveSha256, digest(validated.archive));
  assert.equal(createDeveloperDependencyHostedFiles(validated).length, 3);
});

test("dependency archive round trip preserves exact bytes outside product mutation scope", async () => {
  const packagePath = join(REAL_DEVELOPER_WORKSPACE_ROOT, "package.json");
  const lockPath = join(REAL_DEVELOPER_WORKSPACE_ROOT, "package-lock.json");
  const before = [digest(await readFile(packagePath)), digest(await readFile(lockPath))];
  const built = await actualBundle();
  const lock = await readFile(lockPath);
  const validated = validateDeveloperDependencyHandoffBundle(built, { expectedPackageLock: lock });
  const root = await mkdtemp(join(tmpdir(), "nova-dependencies-"));
  try {
    const result = await extractVerifiedWorkspaceArchive({
      archive: validated.archive,
      root,
      entries: validated.manifest.entries,
      archiveSha256: validated.manifest.dependencyArchiveSha256,
      createHash,
      gunzipSync,
      mkdir,
      writeFile,
      readFile,
      readdir,
      stat,
      chmod,
      resolve,
      dirname,
      relative,
      sep,
      modeForPath: () => 0o400,
    });
    assert.equal(result.fileCount, validated.manifest.fileCount);
    for (const entry of validated.manifest.entries) {
      assert.equal(digest(await readFile(resolve(root, ...entry.path.split("/")))), entry.sha256);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.deepEqual([digest(await readFile(packagePath)), digest(await readFile(lockPath))], before);
});

test("dependency validation rejects lock drift, unsafe paths, and archive drift", async () => {
  const built = await actualBundle();
  const lock = await readFile(join(REAL_DEVELOPER_WORKSPACE_ROOT, "package-lock.json"));
  for (const mutate of [
    (value) => { value.manifest.packageLockSha256 = "0".repeat(64); },
    (value) => { value.manifest.entries[0].path = "../package.json"; },
    (value) => { value.archive = Buffer.from("drift").toString("base64"); },
    (value) => { value.manifest.requiredPackages = ["made-up-package"]; },
    (value) => { value.manifest.packages[0].integrity = "sha512-tampered"; },
  ]) {
    const changed = structuredClone(built);
    mutate(changed);
    assert.throws(() => validateDeveloperDependencyHandoffBundle(changed, { expectedPackageLock: lock }), (error) => error.code === "DEPENDENCY_INTEGRITY_FAILED");
  }
});

test("dependency packaging rejects missing packages and installed-lock inconsistency", async () => {
  await assert.rejects(() => buildDeveloperDependencyHandoffBundle({
    root: REAL_DEVELOPER_WORKSPACE_ROOT,
    stat: async () => ({ isFile: () => false, isSymbolicLink: () => false }),
    npmVersion: async () => "11.8.0",
  }), (error) => error.code === "DEPENDENCY_INTEGRITY_FAILED");

  const read = async (path) => {
    const bytes = await readFile(path);
    if (!String(path).replaceAll("\\", "/").endsWith("/node_modules/.package-lock.json")) return bytes;
    const value = JSON.parse(bytes.toString("utf8"));
    value.packages["node_modules/@neondatabase/serverless"].integrity = "sha512-drift";
    return Buffer.from(JSON.stringify(value));
  };
  await assert.rejects(() => buildDeveloperDependencyHandoffBundle({
    root: REAL_DEVELOPER_WORKSPACE_ROOT,
    read,
    npmVersion: async () => "11.8.0",
  }), (error) => error.code === "DEPENDENCY_INTEGRITY_FAILED");
});

test("hosted dependency verifier is setup-only and preserves product scope", async () => {
  const built = await actualBundle();
  const lock = await readFile(join(REAL_DEVELOPER_WORKSPACE_ROOT, "package-lock.json"));
  const hosted = createDeveloperDependencyHostedFiles(validateDeveloperDependencyHandoffBundle(built, { expectedPackageLock: lock }));
  assert.equal(hosted.length, 3);
  assert.ok(hosted.every((file) => file.path.startsWith("/workspace/.nova-dependency-handoff/")));
  const verifier = Buffer.from(hosted.find((file) => file.path.endsWith("verify.mjs")).data, "base64").toString();
  assert.match(verifier, /NOVA_DEPENDENCY_INTEGRITY_OK/);
  assert.match(verifier, /node_modules/);
  assert.match(verifier, /package-lock\.json/);
  assert.match(verifier, /\.nova-handoff\/manifest\.json/);
  assert.doesNotMatch(verifier, /Continue Nova|npm install|https?:\/\//);
});
