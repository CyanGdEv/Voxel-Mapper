import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { once } from "node:events";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { createGunzip, createGzip } from "node:zlib";
import { UserError } from "./errors.mjs";

let tempWriteSequence = 0;
const CHUNKED_JSON_FORMAT = "voxel-chunked-json-gzip-v1";
const DEFAULT_CHUNK_ARRAY_ITEMS = 50_000;

export async function ensureDir(directory) {
  await mkdir(directory, { recursive: true });
  return directory;
}

export async function readJson(filename) {
  try {
    if (await isGzipFile(filename)) return await readChunkedJson(filename);
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new UserError(`Invalid JSON in ${filename}: ${error.message}`);
    throw error;
  }
}

export async function writeJson(filename, value, spaces = 2) {
  if (shouldChunkJson(value)) return writeChunkedJson(filename, value);
  try {
    return await writeText(filename, `${JSON.stringify(value, null, spaces)}\n`);
  } catch (error) {
    if (!isInvalidStringLength(error)) throw error;
    return writeChunkedJson(filename, value);
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

function shouldChunkJson(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  const configured = Math.floor(Number(process.env.VOXEL_CHUNKED_JSON_ARRAY_ITEMS || DEFAULT_CHUNK_ARRAY_ITEMS));
  const threshold = Number.isFinite(configured) ? Math.max(1, configured) : DEFAULT_CHUNK_ARRAY_ITEMS;
  return Object.values(value).some((entry) => Array.isArray(entry) && entry.length >= threshold);
}

async function writeChunkedJson(filename, value) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new RangeError(`JSON artifact ${filename} exceeds the runtime string limit and cannot be top-level chunked`);
  }
  const arrays = {};
  const metadata = {};
  for (const [key, entry] of Object.entries(value)) {
    if (Array.isArray(entry)) arrays[key] = entry;
    else metadata[key] = entry;
  }
  let header;
  try {
    header = JSON.stringify({
      __chunkedJson: {
        format: CHUNKED_JSON_FORMAT,
        schemaVersion: 1,
        arrays: Object.fromEntries(Object.entries(arrays).map(([key, entries]) => [key, entries.length]))
      },
      metadata
    });
  } catch (error) {
    throw new RangeError(`JSON artifact ${filename} still exceeds the runtime string limit after top-level arrays were isolated: ${error?.message || error}`);
  }

  await ensureDir(path.dirname(filename));
  const temp = nextTempFilename(filename);
  const output = createWriteStream(temp);
  const gzip = createGzip({ level: 6 });
  gzip.pipe(output);
  const completion = once(output, "finish");
  const failure = Promise.race([
    once(gzip, "error").then(([error]) => { throw error; }),
    once(output, "error").then(([error]) => { throw error; })
  ]);
  try {
    await writeGzipLine(gzip, header);
    for (const [key, entries] of Object.entries(arrays)) {
      for (const entry of entries) await writeGzipLine(gzip, JSON.stringify([key, entry]));
    }
    gzip.end();
    await Promise.race([completion, failure]);
    await rename(temp, filename);
    return filename;
  } catch (error) {
    output.destroy();
    gzip.destroy();
    throw error;
  }
}

async function writeGzipLine(stream, line) {
  if (!stream.write(`${line}\n`)) await once(stream, "drain");
}

async function readChunkedJson(filename) {
  const input = createReadStream(filename);
  const gunzip = createGunzip();
  input.pipe(gunzip);
  const lines = readline.createInterface({ input: gunzip, crlfDelay: Infinity });
  let header = null;
  let values = null;
  const counts = {};
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (!header) {
      header = JSON.parse(line);
      if (header?.__chunkedJson?.format !== CHUNKED_JSON_FORMAT || !header?.metadata || typeof header.metadata !== "object") {
        throw new UserError(`Unsupported chunked JSON container in ${filename}`);
      }
      values = { ...header.metadata };
      for (const key of Object.keys(header.__chunkedJson.arrays || {})) {
        values[key] = [];
        counts[key] = 0;
      }
      continue;
    }
    const record = JSON.parse(line);
    if (!Array.isArray(record) || record.length !== 2 || !Object.hasOwn(values, record[0]) || !Array.isArray(values[record[0]])) {
      throw new UserError(`Invalid chunked JSON record in ${filename}`);
    }
    values[record[0]].push(record[1]);
    counts[record[0]] += 1;
  }
  if (!header || !values) throw new UserError(`Chunked JSON container ${filename} is empty`);
  for (const [key, expected] of Object.entries(header.__chunkedJson.arrays || {})) {
    if (counts[key] !== Number(expected)) {
      throw new UserError(`Chunked JSON array ${key} count mismatch in ${filename}: expected ${expected}, got ${counts[key]}`);
    }
  }
  return values;
}

async function isGzipFile(filename) {
  const handle = await open(filename, "r");
  try {
    const bytes = Buffer.alloc(2);
    const { bytesRead } = await handle.read(bytes, 0, 2, 0);
    return bytesRead === 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  } finally {
    await handle.close();
  }
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
