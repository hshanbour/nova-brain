import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createDeterministicWorkspaceArchive, extractVerifiedWorkspaceArchive } from "./workspace-archive.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_DEPENDENCY_FILES = 5_000;
const MAX_DEPENDENCY_BYTES = 20 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const DEPENDENCY_ROOT = "/workspace/nova-brain/node_modules";
const HANDOFF_ROOT = "/workspace/.nova-dependency-handoff";
const REQUIRED_PACKAGES = Object.freeze(["@neondatabase/serverless"]);

function fail(message = "Dependency handoff integrity validation failed.") {
  throw Object.assign(new Error(message), { code: "DEPENDENCY_INTEGRITY_FAILED" });
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function canonical(value) { return JSON.stringify(value); }
function manifestHash(manifest) { const { dependencyManifestHash, ...rest } = manifest; return sha256(canonical(rest)); }
function exactKeys(value, keys) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key)); }

function dependencyPath(value) {
  const path = String(value || "").replaceAll("\\", "/");
  if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path)
    || path.split("/").some((part) => !part || part === "." || part === "..")
    || Buffer.byteLength(path) > 100) fail();
  return path;
}

function packageRoots(lock) {
  if (!lock || lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object") fail("Unsupported or malformed package-lock.json.");
  return Object.entries(lock.packages)
    .filter(([path]) => path.startsWith("node_modules/"))
    .map(([path, entry]) => ({ path: dependencyPath(path.slice("node_modules/".length)), version: entry?.version }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function walkPackage(root, packagePath, io) {
  const packageRoot = resolve(root, "node_modules", ...packagePath.split("/"));
  const files = [];
  const walk = async (directory) => {
    const children = await io.readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const absolute = resolve(directory, child.name);
      const info = await io.lstat(absolute);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) fail("Dependency tree contains an unsafe link or special entry.");
      if (info.isDirectory()) await walk(absolute);
      else {
        const local = dependencyPath(relative(packageRoot, absolute).split(sep).join("/"));
        files.push({ path: dependencyPath(`${packagePath}/${local}`), data: await io.readFile(absolute) });
      }
    }
  };
  await walk(packageRoot);
  return files;
}

async function defaultNpmVersion() {
  const match = String(process.env.npm_config_user_agent || "").match(/(?:^|\s)npm\/([^\s]+)/);
  return match?.[1] || "unavailable";
}

export async function buildDeveloperDependencyHandoffBundle({
  root,
  read = readFile,
  stat = lstat,
  list = readdir,
  npmVersion = defaultNpmVersion,
  nodeVersion = process.versions.node,
} = {}) {
  if (!root) fail("A dependency workspace root is required.");
  const absoluteRoot = resolve(root);
  const packageLock = await read(join(absoluteRoot, "package-lock.json"));
  const lock = JSON.parse(packageLock.toString("utf8"));
  const installedLock = JSON.parse((await read(join(absoluteRoot, "node_modules", ".package-lock.json"))).toString("utf8"));
  const roots = packageRoots(lock);
  if (!roots.length) fail("The lockfile contains no installed dependencies.");
  const materials = [];
  const packages = [];
  for (const item of roots) {
    if (typeof item.version !== "string" || !item.version) fail("A lockfile package version is missing.");
    const lockPath = `node_modules/${item.path}`;
    const expectedLockEntry = lock.packages[lockPath];
    const installedLockEntry = installedLock.packages?.[lockPath];
    if (!installedLockEntry || installedLockEntry.version !== expectedLockEntry.version
      || installedLockEntry.resolved !== expectedLockEntry.resolved || installedLockEntry.integrity !== expectedLockEntry.integrity) {
      fail("The local installed dependency lock does not match package-lock.json.");
    }
    const installedManifestPath = join(absoluteRoot, "node_modules", ...item.path.split("/"), "package.json");
    const info = await stat(installedManifestPath);
    if (!info.isFile() || info.isSymbolicLink()) fail("An installed dependency manifest is missing or unsafe.");
    const installed = JSON.parse((await read(installedManifestPath)).toString("utf8"));
    if (installed.version !== item.version || typeof installed.name !== "string") fail("Installed dependencies do not match package-lock.json.");
    packages.push({ path: item.path, name: installed.name, version: installed.version, resolved: expectedLockEntry.resolved, integrity: expectedLockEntry.integrity });
    materials.push(...await walkPackage(absoluteRoot, item.path, { readFile: read, lstat: stat, readdir: list }));
  }
  for (const required of REQUIRED_PACKAGES) {
    if (!packages.some((item) => item.name === required)) fail(`Required dependency ${required} is not installed at its lockfile version.`);
  }
  materials.sort((a, b) => a.path.localeCompare(b.path));
  if (!materials.length || materials.length > MAX_DEPENDENCY_FILES) fail("Dependency file count exceeds the bounded handoff.");
  let totalBytes = 0;
  const entries = materials.map(({ path, data }) => {
    totalBytes += data.length;
    return { path, size: data.length, sha256: sha256(data) };
  });
  if (totalBytes > MAX_DEPENDENCY_BYTES) fail("Dependency bytes exceed the bounded handoff.");
  const archive = createDeterministicWorkspaceArchive(materials);
  if (archive.length > MAX_ARCHIVE_BYTES) fail("Dependency archive exceeds the bounded handoff.");
  const manifest = {
    version: 1,
    packageLockSha256: sha256(packageLock),
    dependencyArchiveSha256: sha256(archive),
    dependencyRoot: DEPENDENCY_ROOT,
    packages,
    requiredPackages: [...REQUIRED_PACKAGES],
    entries,
    fileCount: entries.length,
    totalBytes,
    archiveBytes: archive.length,
    lockfileVersion: lock.lockfileVersion,
    nodeVersion: String(nodeVersion),
    npmVersion: String(await npmVersion()),
  };
  manifest.dependencyManifestHash = manifestHash(manifest);
  return Object.freeze({ manifest: Object.freeze(manifest), archive: archive.toString("base64") });
}

export function validateDeveloperDependencyHandoffBundle(input, { expectedPackageLock } = {}) {
  if (!Buffer.isBuffer(expectedPackageLock) || !exactKeys(input, ["manifest", "archive"]) || !exactKeys(input?.manifest, [
    "version", "packageLockSha256", "dependencyArchiveSha256", "dependencyRoot", "packages", "requiredPackages",
    "entries", "fileCount", "totalBytes", "archiveBytes", "lockfileVersion", "nodeVersion", "npmVersion", "dependencyManifestHash",
  ]) || typeof input.archive !== "string") fail();
  const manifest = structuredClone(input.manifest);
  const archive = Buffer.from(input.archive, "base64");
  const expectedLock = JSON.parse(expectedPackageLock.toString("utf8"));
  const expectedPackages = packageRoots(expectedLock);
  if (manifest.version !== 1 || manifest.packageLockSha256 !== sha256(expectedPackageLock)
    || manifest.dependencyArchiveSha256 !== sha256(archive) || manifest.dependencyRoot !== DEPENDENCY_ROOT
    || manifest.dependencyManifestHash !== manifestHash(manifest) || !SHA256.test(manifest.dependencyManifestHash)
    || manifest.lockfileVersion !== expectedLock.lockfileVersion || manifest.archiveBytes !== archive.length
    || archive.length > MAX_ARCHIVE_BYTES || manifest.fileCount !== manifest.entries?.length
    || manifest.fileCount <= 0 || manifest.fileCount > MAX_DEPENDENCY_FILES || manifest.totalBytes > MAX_DEPENDENCY_BYTES
    || canonical(manifest.requiredPackages) !== canonical(REQUIRED_PACKAGES)
    || expectedPackages.length !== manifest.packages?.length) fail();
  for (const expected of expectedPackages) {
    const actual = manifest.packages.find((item) => item.path === expected.path);
    const lockEntry = expectedLock.packages[`node_modules/${expected.path}`];
    if (!actual || !exactKeys(actual, ["path", "name", "version", "resolved", "integrity"])
      || actual.version !== expected.version || actual.resolved !== lockEntry.resolved
      || actual.integrity !== lockEntry.integrity || typeof actual.name !== "string") fail();
  }
  for (const required of REQUIRED_PACKAGES) if (!manifest.packages.some((item) => item.name === required)) fail();
  let totalBytes = 0;
  const seen = new Set();
  for (const entry of manifest.entries) {
    const path = dependencyPath(entry?.path);
    if (seen.has(path) || !Number.isSafeInteger(entry?.size) || entry.size < 0 || !SHA256.test(entry?.sha256 || "")) fail();
    seen.add(path); totalBytes += entry.size;
  }
  if (totalBytes !== manifest.totalBytes) fail();
  return Object.freeze({ manifest: Object.freeze(manifest), archive });
}

export function createDeveloperDependencyHostedFiles(bundle) {
  const { manifest, archive } = bundle;
  const source = dependencyVerifierSource({ expectedManifestHash: manifest.dependencyManifestHash, expectedArchiveHash: manifest.dependencyArchiveSha256 });
  return Object.freeze([
    Object.freeze({ type: "inline", path: `${HANDOFF_ROOT}/dependencies.tar.gz`, data: archive.toString("base64") }),
    Object.freeze({ type: "inline", path: `${HANDOFF_ROOT}/manifest.json`, data: Buffer.from(JSON.stringify(manifest)).toString("base64") }),
    Object.freeze({ type: "inline", path: `${HANDOFF_ROOT}/verify.mjs`, data: Buffer.from(source).toString("base64") }),
  ]);
}

function dependencyVerifierSource({ expectedManifestHash, expectedArchiveHash }) {
  return `import{createHash}from"node:crypto";import{createRequire}from"node:module";import{readFile,readdir,stat,chmod,mkdir,writeFile}from"node:fs/promises";import{resolve,dirname,relative,sep}from"node:path";import{gunzipSync}from"node:zlib";const workspace="/workspace/nova-brain",root=${JSON.stringify(DEPENDENCY_ROOT)},handoff=${JSON.stringify(HANDOFF_ROOT)},digest=value=>createHash("sha256").update(value).digest("hex"),manifest=JSON.parse(await readFile(handoff+"/manifest.json","utf8")),claimed=manifest.dependencyManifestHash;delete manifest.dependencyManifestHash;if(claimed!==${JSON.stringify(expectedManifestHash)}||digest(Buffer.from(JSON.stringify(manifest)))!==claimed||manifest.dependencyArchiveSha256!==${JSON.stringify(expectedArchiveHash)}||manifest.dependencyRoot!==root)throw new Error("DEPENDENCY_INTEGRITY_FAILED");const lock=await readFile(workspace+"/package-lock.json"),archive=await readFile(handoff+"/dependencies.tar.gz");if(digest(lock)!==manifest.packageLockSha256||digest(archive)!==manifest.dependencyArchiveSha256)throw new Error("DEPENDENCY_INTEGRITY_FAILED");const productManifest=JSON.parse(await readFile("/workspace/.nova-handoff/manifest.json","utf8")),verifyProduct=async()=>{for(const entry of productManifest.entries){const bytes=await readFile(workspace+"/"+entry.path);if(bytes.length!==entry.size||digest(bytes)!==entry.sha256)throw new Error("DEPENDENCY_INTEGRITY_FAILED");}};await verifyProduct();const extractVerifiedWorkspaceArchive=${extractVerifiedWorkspaceArchive.toString()};await chmod(workspace,0o700);try{await extractVerifiedWorkspaceArchive({archive,root,entries:manifest.entries,archiveSha256:manifest.dependencyArchiveSha256,createHash,gunzipSync,mkdir,writeFile,readFile,readdir,stat,chmod,resolve,dirname,relative,sep,modeForPath:()=>0o400});const require=createRequire(workspace+"/package.json");for(const required of manifest.requiredPackages){const resolved=require.resolve(required);if(!resolved.startsWith(root+"/"))throw new Error("DEPENDENCY_INTEGRITY_FAILED");}await verifyProduct();}finally{await chmod(workspace,0o500);}console.log("NOVA_DEPENDENCY_INTEGRITY_OK:"+claimed);`;
}

export const DEVELOPER_DEPENDENCY_HANDOFF = Object.freeze({
  dependencyRoot: DEPENDENCY_ROOT,
  handoffRoot: HANDOFF_ROOT,
  requiredPackages: REQUIRED_PACKAGES,
  maxFiles: MAX_DEPENDENCY_FILES,
  maxBytes: MAX_DEPENDENCY_BYTES,
});
