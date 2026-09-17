import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  CANONICAL_GZIP_OS_BYTE,
  canonicalizeGzipOsByte,
  createDeterministicWorkspaceArchive,
  extractVerifiedWorkspaceArchive,
} from "../src/autonomy/workspace-archive.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const files = [
  { path: "assets/console.js", data: Buffer.from("console.log('exact');\r\n") },
  { path: "test/binary.dat", data: Buffer.from([0, 1, 2, 255]) },
];
const entries = files.map(({ path, data }) => ({ path, size: data.length, sha256: digest(data), dirty: true }));

async function extract(archive, expected = entries) {
  const parent = await mkdtemp(resolve(tmpdir(), "nova-workspace-archive-"));
  const root = resolve(parent, "workspace");
  try {
    const result = await extractVerifiedWorkspaceArchive({
      archive, root, entries: expected, archiveSha256: digest(archive), createHash, gunzipSync,
      mkdir, writeFile, readFile, readdir, stat, chmod, resolve, dirname, relative, sep,
      modeForPath: () => 0o400,
    });
    return {
      result,
      bytes: Object.fromEntries(await Promise.all(expected.map(async ({ path }) => [path, await readFile(resolve(root, path))]))),
    };
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function mutateFirstHeader(archive, mutate) {
  const tar = gunzipSync(archive);
  mutate(tar.subarray(0, 512));
  tar.fill(0x20, 148, 156);
  const checksum = tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0).toString(8);
  tar.write(`${checksum.padStart(6, "0")}\0 `, 148, 8, "ascii");
  return gzipSync(tar, { level: 9, mtime: 0 });
}

function renameFirstEntry(archive, path) {
  return mutateFirstHeader(archive, (header) => {
    header.fill(0, 0, 100);
    header.write(path, 0, 100, "utf8");
  });
}

test("deterministic tar.gz preserves exact bytes and paths through verified extraction", async () => {
  const first = createDeterministicWorkspaceArchive(files);
  const second = createDeterministicWorkspaceArchive([...files].reverse());
  assert.deepEqual(first, second);
  const extracted = await extract(first);
  assert.equal(extracted.result.fileCount, files.length);
  for (const file of files) assert.deepEqual(extracted.bytes[file.path], file.data);
});

test("gzip OS byte is canonical and byte-identical across simulated Windows and Linux variants", () => {
  const canonical = createDeterministicWorkspaceArchive(files);
  assert.equal(canonical[9], CANONICAL_GZIP_OS_BYTE);

  const windows = Buffer.from(canonical);
  windows[9] = 10;
  const linux = Buffer.from(canonical);
  linux[9] = 3;
  const windowsBefore = Buffer.from(windows);

  assert.deepEqual(canonicalizeGzipOsByte(windows), canonicalizeGzipOsByte(linux));
  assert.equal(digest(windows), digest(linux));
  assert.deepEqual(gunzipSync(windows), gunzipSync(windowsBefore));
  assert.deepEqual(
    [...windowsBefore.keys()].filter((index) => windowsBefore[index] !== windows[index]),
    [9],
  );
});

test("153 workspace files remain one deterministic archive entry before hosted materialization", async () => {
  const workspace = Array.from({ length: 153 }, (_, index) => ({
    path: `tree/file-${String(index).padStart(3, "0")}.txt`,
    data: Buffer.from(`exact-${index}\r\n`),
  }));
  const expected = workspace.map(({ path, data }) => ({ path, size: data.length, sha256: digest(data), dirty: indexFor(path) < 8 }));
  function indexFor(path) { return Number(path.match(/(\d+)\.txt$/)[1]); }
  const archive = createDeterministicWorkspaceArchive(workspace);
  const extracted = await extract(archive, expected);
  assert.equal(extracted.result.fileCount, 153);
  for (const file of workspace) assert.deepEqual(extracted.bytes[file.path], file.data);
});

test("archive construction rejects traversal, absolute paths, links and duplicate entries", () => {
  for (const unsafe of [
    [{ path: "../escape", data: Buffer.from("x") }],
    [{ path: "/absolute", data: Buffer.from("x") }],
    [{ path: "C:/absolute", data: Buffer.from("x") }],
    [{ path: "link", type: "symlink", data: Buffer.from("target") }],
    [{ path: "same", data: Buffer.from("a") }, { path: "same", data: Buffer.from("b") }],
  ]) assert.throws(() => createDeterministicWorkspaceArchive(unsafe), (error) => error.code === "WORKSPACE_INTEGRITY_FAILED");
});

test("verified extraction rejects traversal, absolute paths and unsafe tar links", async () => {
  const archive = createDeterministicWorkspaceArchive(files);
  for (const unsafe of [
    renameFirstEntry(archive, "../escape.js"),
    renameFirstEntry(archive, "/absolute.js"),
    mutateFirstHeader(archive, (header) => { header[156] = "2".charCodeAt(0); }),
  ]) await assert.rejects(() => extract(unsafe), (error) => error.code === "WORKSPACE_INTEGRITY_FAILED");
});

test("verified extraction rejects unexpected, missing and hash-mismatched files", async () => {
  const archive = createDeterministicWorkspaceArchive(files);
  const unexpected = createDeterministicWorkspaceArchive([...files, { path: "unexpected.js", data: Buffer.from("x") }]);
  const missing = createDeterministicWorkspaceArchive(files.slice(0, 1));
  const wrongHash = structuredClone(entries);
  wrongHash[0].sha256 = "0".repeat(64);
  await assert.rejects(() => extract(unexpected), (error) => error.code === "WORKSPACE_INTEGRITY_FAILED");
  await assert.rejects(() => extract(missing), (error) => error.code === "WORKSPACE_INTEGRITY_FAILED");
  await assert.rejects(() => extract(archive, wrongHash), (error) => error.code === "WORKSPACE_INTEGRITY_FAILED");
});
