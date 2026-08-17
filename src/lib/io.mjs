import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { once } from "node:events";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { UserError } from "./errors.mjs";

let tempWriteSequence = 0;
const CHUNKED_JSON_FORMAT = "voxel-chunked-json-v1";
const CHUNKED_JSON_ITEMS_PER_FILE = 5_000;

export async function ensureDir(directory) {
  await mkdir(directory, { recursive: true });
  return directory;
}

export async function readJson(filename) {
  try {
    const parsed = JSON.parse(await readFile(filename, "utf8"));
    return parsed?.__chunkedJson?.format === CHUNKED_JSON_FORMAT
      ? await hydrateChunkedJson(filename, parsed)
      : parsed;
  } catch (error) {
    if (error instanceof SyntaxError) throw new UserError(`Invalid JSON in ${filename}: ${error.message}`);
    throw error;
  }
}

export async function writeJson(filename, value, spaces = 2) {
  try {
    return await writeText(filename, `${JSON.stringify(value, null, spaces)}\n`);
  } catch (error) {
    if (!isInvalidStringLength(error)) throw error;
    return writeChunkedJson(filename, value, spaces);
  }
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
  tempWriteSequence += 1;
  return `${filename}.tmp-${process.pid}-${tempWriteSequence}`;
}

async function writeChunkedJson(filename, value, spaces) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new RangeError(`JSON artifact ${filename} exceeds the runtime string limit and cannot be top-level chunked`);
  }
  const absolute = path.resolve(filename);
  const bundleName = `${path.basename(absolute)}.chunks`;
  const bundle = path.join(path.dirname(absolute), bundleName);
  const tempBundle = nextTempFilename(bundle);
  await rm(tempBundle, { recursive: true, force: true });
  await mkdir(tempBundle, { recursive: true });

  const pointer = {};
  const arrays = {};
  try {
    for (const [key, entry] of Object.entries(value)) {
      if (!Array.isArray(entry)) {
        pointer[key] = entry;
        continue;
      }
      arrays[key] = await writeArrayChunks(tempBundle, safeChunkStem(key), entry);
    }
    pointer.__chunkedJson = {
      format: CHUNKED_JSON_FORMAT,
      schemaVersion: 1,
      bundlePath: bundleName,
      arrays
    };
    let pointerText;
    try {
      pointerText = `${JSON.stringify(pointer, null, spaces)}\n`;
    } catch (error) {
      throw new RangeError(`JSON artifact ${filename} still exceeds the runtime string limit after top-level arrays were chunked: ${error?.message || error}`);
    }
    await rm(bundle, { recursive: true, force: true });
    await rename(tempBundle, bundle);
    await writeText(absolute, pointerText);
    return filename;
  } catch (error) {
    await rm(tempBundle, { recursive: true, force: true });
    throw error;
  }
}

async function writeArrayChunks(bundle, stem, values) {
  const files = [];
  for (let offset = 0, chunkIndex = 0; offset < values.length; offset += CHUNKED_JSON_ITEMS_PER_FILE, chunkIndex += 1) {
    const filename = `${stem}-${String(chunkIndex).padStart(4, "0")}.ndjson`;
    const fullPath = path.join(bundle, filename);
    const stream = createWriteStream(fullPath, { encoding: "utf8" });
    const hash = createHash("sha256");
    let byteLength = 0;
    const end = Math.min(values.length, offset + CHUNKED_JSON_ITEMS_PER_FILE);
    for (let index = offset; index < end; index += 1) {
      const line = `${JSON.stringify(values[index])}\n`;
      hash.update(line);
      byteLength += Buffer.byteLength(line);
      if (!stream.write(line)) await once(stream, "drain");
    }
    stream.end();
    await once(stream, "finish");
    files.push({
      file: filename,
      count: end - offset,
      byteLength,
      sha256: hash.digest("hex")
    });
  }
  return {
    format: "ndjson",
    count: values.length,
    itemsPerFile: CHUNKED_JSON_ITEMS_PER_FILE,
    files
  };
}

async function hydrateChunkedJson(filename, pointer) {
  const absolute = path.resolve(filename);
  const root = path.dirname(absolute);
  const bundle = safeArtifactChild(root, pointer.__chunkedJson.bundlePath, "chunk bundle");
  const hydrated = { ...pointer };
  delete hydrated.__chunkedJson;
  for (const [key, descriptor] of Object.entries(pointer.__chunkedJson.arrays || {})) {
    hydrated[key] = await readArrayChunks(bundle, key, descriptor);
  }
  return hydrated;
}

async function readArrayChunks(bundle, key, descriptor) {
  const expected = Number(descriptor?.count || 0);
  const files = Array.isArray(descriptor?.files) ? descriptor.files : [];
  if (expected > 0 && files.length === 0) throw new UserError(`Chunked JSON array ${key} declares ${expected} records but has no files`);
  const values = [];
  for (const file of files) {
    const fullPath = safeArtifactChild(bundle, file?.file, `${key} chunk`);
    const input = createReadStream(fullPath, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    const hash = createHash("sha256");
    let count = 0;
    for await (const line of lines) {
      if (!line.trim()) continue;
      hash.update(`${line}\n`);
      values.push(JSON.parse(line));
      count += 1;
    }
    if (count !== Number(file?.count || 0)) {
      throw new UserError(`Chunked JSON array ${key} file ${file?.file} count mismatch: expected ${file?.count}, got ${count}`);
    }
    if (file?.sha256 && hash.digest("hex") !== file.sha256) {
      throw new UserError(`Chunked JSON array ${key} file ${file?.file} checksum mismatch`);
    }
  }
  if (values.length !== expected) {
    throw new UserError(`Chunked JSON array ${key} count mismatch: expected ${expected}, got ${values.length}`);
  }
  return values;
}

function safeArtifactChild(root, child, label) {
  if (!child) throw new UserError(`Chunked JSON ${label} path is missing`);
  const base = path.resolve(root);
  const resolved = path.resolve(base, child);
  const relative = path.relative(base, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new UserError(`Chunked JSON ${label} escapes its artifact root`);
  return resolved;
}

function safeChunkStem(value) {
  return String(value || "array").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "array";
}

function isInvalidStringLength(error) {
  return error instanceof RangeError && /invalid string length/i.test(String(error.message || error));
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

export async function cachedBinary({ cacheDir, key, noCache, fetcher, extension = ".bin" }) {
  const suffix = String(extension).startsWith(".") ? extension : `.${extension}`;
  const filename = path.join(cacheDir, `${sha256(key)}${suffix}`);
  if (!noCache && await exists(filename)) return { data: null, cacheHit: true, filename };
  const data = await fetcher();
  await writeBinary(filename, data);
  return { data, cacheHit: false, filename };
}

export async function fetchJson(url, init = {}, { timeoutMs = 120_000, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const body = await response.text();
      if (!response.ok) throw new UserError(`HTTP ${response.status} from ${new URL(url).host}`, body.slice(0, 500));
      try {
        return JSON.parse(body);
      } catch {
        throw new UserError(`Expected JSON from ${new URL(url).host}`, body.slice(0, 500));
      }
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 750 * (2 ** attempt)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export async function fetchBinary(url, init = {}, { timeoutMs = 180_000, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        const body = await response.text();
        throw new UserError(`HTTP ${response.status} from ${new URL(url).host}`, body.slice(0, 500));
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 750 * (2 ** attempt)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}
