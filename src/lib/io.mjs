import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { UserError } from "./errors.mjs";

let tempWriteSequence = 0;

export async function ensureDir(directory) {
  await mkdir(directory, { recursive: true });
  return directory;
}

export async function readJson(filename) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new UserError(`Invalid JSON in ${filename}: ${error.message}`);
    throw error;
  }
}

export async function writeJson(filename, value, spaces = 2) {
  return writeText(filename, `${JSON.stringify(value, null, spaces)}\n`);
}

export async function writeText(filename, value) {
  await ensureDir(path.dirname(filename));
  const temp = nextTempFilename(filename);
  await writeFile(temp, value);
  await rename(temp, filename);
  return filename;
}

export async function writeBinary(filename, value) {
  await ensureDir(path.dirname(filename));
  const temp = nextTempFilename(filename);
  await writeFile(temp, value);
  await rename(temp, filename);
  return filename;
}

function nextTempFilename(filename) {
  // Multiple planning workers can legitimately resolve different source URLs
  // to identical content hashes at the same time. A process-id-only temporary
  // name makes those atomic writes collide with each other. Give every write a
  // unique in-process staging path; final rename remains atomic and converges
  // safely when the destination bytes/content hash are identical.
  tempWriteSequence += 1;
  return `${filename}.tmp-${process.pid}-${tempWriteSequence}`;
}

export function slugify(value) {
  return String(value || "theme-park")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase() || "theme-park";
}

export function sha256(value) {
  const bytes = typeof value === "string" || Buffer.isBuffer(value) || ArrayBuffer.isView(value)
    ? value
    : value instanceof ArrayBuffer ? new Uint8Array(value) : JSON.stringify(value);
  return createHash("sha256").update(bytes).digest("hex");
}

export async function sha256File(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

export async function exists(filename) {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function cachedJson({ cacheDir, key, noCache, fetcher }) {
  const filename = path.join(cacheDir, `${sha256(key)}.json`);
  if (!noCache && await exists(filename)) return { data: await readJson(filename), cacheHit: true, filename };
  const data = await fetcher();
  await writeJson(filename, data);
  return { data, cacheHit: false, filename };
}
