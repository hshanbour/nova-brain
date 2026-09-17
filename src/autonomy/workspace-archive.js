import { gzipSync } from "node:zlib";

const BLOCK_SIZE = 512;
export const CANONICAL_GZIP_OS_BYTE = 3;

function fail() {
  throw Object.assign(new Error("WORKSPACE_INTEGRITY_FAILED"), { code: "WORKSPACE_INTEGRITY_FAILED" });
}

function canonicalArchivePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/")
    || /^[A-Za-z]:/.test(value) || value.split("/").some((part) => !part || part === "." || part === "..")
    || Buffer.byteLength(value) > 100) fail();
  return value;
}

function writeOctal(header, offset, length, value) {
  const octal = Number(value).toString(8);
  if (!Number.isSafeInteger(Number(value)) || Number(value) < 0 || octal.length > length - 1) fail();
  header.write(`${octal.padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function tarHeader(path, size) {
  const header = Buffer.alloc(BLOCK_SIZE);
  header.write(canonicalArchivePath(path), 0, 100, "utf8");
  writeOctal(header, 100, 8, 0o444);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8);
  header.write(`${checksum.padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

export function canonicalizeGzipOsByte(archive) {
  if (!Buffer.isBuffer(archive) || archive.length < 10
    || archive[0] !== 0x1f || archive[1] !== 0x8b || archive[2] !== 0x08) fail();
  archive[9] = CANONICAL_GZIP_OS_BYTE;
  return archive;
}

export function createDeterministicWorkspaceArchive(files) {
  if (!Array.isArray(files) || files.length === 0) fail();
  const sorted = files.map((file) => {
    if (!file || typeof file !== "object" || Array.isArray(file) || (file.type && file.type !== "file")) fail();
    return { path: canonicalArchivePath(file.path), data: Buffer.from(file.data) };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (new Set(sorted.map(({ path }) => path)).size !== sorted.length) fail();
  const chunks = [];
  for (const file of sorted) {
    chunks.push(tarHeader(file.path, file.data.length), file.data);
    const padding = (BLOCK_SIZE - (file.data.length % BLOCK_SIZE)) % BLOCK_SIZE;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2));
  return canonicalizeGzipOsByte(gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 }));
}

export async function extractVerifiedWorkspaceArchive({
  archive, root, entries, archiveSha256, createHash, gunzipSync, mkdir, writeFile,
  readFile, readdir, stat, chmod, resolve, dirname, relative, sep, modeForPath,
}) {
  const reject = () => { throw Object.assign(new Error("WORKSPACE_INTEGRITY_FAILED"), { code: "WORKSPACE_INTEGRITY_FAILED" }); };
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const safePath = (value) => {
    if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/")
      || /^[A-Za-z]:/.test(value) || value.split("/").some((part) => !part || part === "." || part === "..")) reject();
    const absolute = resolve(root, value);
    if (!absolute.startsWith(`${resolve(root)}${sep}`)) reject();
    return { path: value, absolute };
  };
  if (!Buffer.isBuffer(archive) || digest(archive) !== archiveSha256 || !Array.isArray(entries) || entries.length === 0) reject();
  const expected = new Map();
  let maxTarBytes = 1024;
  for (const entry of entries) {
    const { path } = safePath(entry?.path);
    if (expected.has(path) || !Number.isSafeInteger(entry?.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry?.sha256 || "")) reject();
    expected.set(path, entry);
    maxTarBytes += 512 + entry.size + ((512 - (entry.size % 512)) % 512);
  }
  let tar;
  try { tar = gunzipSync(archive, { maxOutputLength: maxTarBytes }); } catch { reject(); }
  if (!Buffer.isBuffer(tar) || tar.length > maxTarBytes || tar.length % 512 !== 0) reject();
  await mkdir(root, { recursive: true });
  const seen = new Set();
  let offset = 0;
  let ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) { ended = true; break; }
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const storedChecksum = Number.parseInt(header.subarray(148, 156).toString("ascii").replace(/\0.*$/, "").trim(), 8);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    const type = header[156];
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const combined = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim(), 8);
    if (!Number.isSafeInteger(storedChecksum) || storedChecksum !== actualChecksum || (type !== 0 && type !== 48)
      || !Number.isSafeInteger(size) || size < 0) reject();
    const { path, absolute } = safePath(combined);
    const entry = expected.get(path);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (!entry || seen.has(path) || entry.size !== size || dataEnd > tar.length) reject();
    const data = tar.subarray(dataStart, dataEnd);
    if (digest(data) !== entry.sha256) reject();
    await mkdir(dirname(absolute), { recursive: true });
    try { await writeFile(absolute, data, { flag: "wx", mode: 0o600 }); } catch { reject(); }
    seen.add(path);
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!ended || seen.size !== expected.size || [...expected.keys()].some((path) => !seen.has(path))) reject();
  if (tar.subarray(offset).some((byte) => byte !== 0)) reject();
  const actualPaths = [];
  const directories = [root];
  const walk = async (directory) => {
    for (const name of await readdir(directory)) {
      const full = resolve(directory, name);
      const info = await stat(full);
      if (info.isDirectory()) { directories.push(full); await walk(full); }
      else if (info.isFile()) actualPaths.push(relative(root, full).replaceAll("\\", "/"));
      else reject();
    }
  };
  await walk(root);
  actualPaths.sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify([...expected.keys()].sort())) reject();
  for (const path of actualPaths) {
    const bytes = await readFile(resolve(root, path));
    const entry = expected.get(path);
    if (bytes.length !== entry.size || digest(bytes) !== entry.sha256) reject();
    await chmod(resolve(root, path), modeForPath(path));
  }
  for (const directory of directories.reverse()) await chmod(directory, 0o500);
  return { fileCount: actualPaths.length, paths: actualPaths };
}
