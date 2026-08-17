import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import readline from "node:readline";

export const PLANNING_AUTHORITY_HANDOFF_FORMAT = "voxel-planning-authority-handoff-v1";
const STREAM_KEYS = Object.freeze([
  "geometryCandidates",
  "verticalObservations",
  "materialObservations",
  "rideStructureTemplates",
  "drawingMetadata"
]);
const DEFAULT_CHUNK_ITEMS = 5_000;

export async function writePlanningAuthorityHandoff(filename, authority, options = {}) {
  const pointerPath = path.resolve(filename);
  const bundleName = options.bundleName || `${path.basename(pointerPath, path.extname(pointerPath))}-bundle`;
  const bundleRoot = resolveChild(path.dirname(pointerPath), bundleName, "authority bundle");
  const chunkItems = clampInt(options.chunkItems ?? DEFAULT_CHUNK_ITEMS, 1, 50_000);
  await rm(bundleRoot, { recursive: true, force: true });
  await mkdir(bundleRoot, { recursive: true });

  const streams = {};
  for (const key of STREAM_KEYS) {
    streams[key] = await writeValueChunks(bundleRoot, key, authority?.[key] || [], chunkItems);
  }

  const metadata = {};
  for (const [key, value] of Object.entries(authority || {})) {
    if (!STREAM_KEYS.includes(key)) metadata[key] = value;
  }
  const pointer = {
    ...metadata,
    schemaVersion: Math.max(5, Number(metadata.schemaVersion || 0)),
    format: PLANNING_AUTHORITY_HANDOFF_FORMAT,
    sourceStorage: "chunked-ndjson-handoff",
    bundlePath: bundleName,
    streams
  };
  await writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`, "utf8");
  return pointer;
}

export async function loadPlanningAuthorityHandoff(filename) {
  const pointerPath = path.resolve(filename);
  const raw = JSON.parse(await readFile(pointerPath, "utf8"));
  if (raw?.format !== PLANNING_AUTHORITY_HANDOFF_FORMAT) return raw;
  const bundleRoot = resolveChild(path.dirname(pointerPath), raw.bundlePath || ".", "authority bundle");
  const result = { ...raw };
  for (const key of STREAM_KEYS) {
    result[key] = await readValueChunks(bundleRoot, key, raw.streams?.[key]);
  }
  return result;
}

export function isPlanningAuthorityHandoff(value) {
  return value?.format === PLANNING_AUTHORITY_HANDOFF_FORMAT;
}

async function writeValueChunks(bundleRoot, key, values, chunkItems) {
  const list = Array.isArray(values) ? values : [];
  const files = [];
  for (let offset = 0, chunkIndex = 0; offset < list.length; offset += chunkItems, chunkIndex += 1) {
    const filename = `${key}-${String(chunkIndex).padStart(4, "0")}.ndjson`;
    const fullPath = path.join(bundleRoot, filename);
    const stream = createWriteStream(fullPath, { encoding: "utf8" });
    const hash = createHash("sha256");
    let bytes = 0;
    const end = Math.min(list.length, offset + chunkItems);
    for (let index = offset; index < end; index += 1) {
      const line = `${JSON.stringify(list[index])}\n`;
      hash.update(line);
      bytes += Buffer.byteLength(line);
      if (!stream.write(line)) await once(stream, "drain");
    }
    stream.end();
    await once(stream, "finish");
    files.push({
      file: filename,
      count: end - offset,
      byteLength: bytes,
      sha256: hash.digest("hex")
    });
  }
  return {
    format: "ndjson",
    count: list.length,
    chunkItems,
    files
  };
}

async function readValueChunks(bundleRoot, key, descriptor) {
  const expectedCount = Number(descriptor?.count || 0);
  const files = Array.isArray(descriptor?.files) ? descriptor.files : [];
  if (expectedCount > 0 && files.length === 0) throw new Error(`Planning authority ${key} declares ${expectedCount} records but no chunks`);
  const result = [];
  for (const file of files) {
    const fullPath = resolveChild(bundleRoot, file?.file, `${key} chunk`);
    const input = createReadStream(fullPath, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    const hash = createHash("sha256");
    let count = 0;
    for await (const line of lines) {
      if (!line.trim()) continue;
      hash.update(`${line}\n`);
      result.push(JSON.parse(line));
      count += 1;
    }
    const digest = hash.digest("hex");
    if (Number(file?.count || 0) !== count) {
      throw new Error(`Planning authority ${key} chunk ${file?.file} count mismatch: expected ${file?.count}, got ${count}`);
    }
    if (file?.sha256 && digest !== file.sha256) {
      throw new Error(`Planning authority ${key} chunk ${file?.file} checksum mismatch`);
    }
  }
  if (result.length !== expectedCount) {
    throw new Error(`Planning authority ${key} count mismatch: expected ${expectedCount}, got ${result.length}`);
  }
  return result;
}

function resolveChild(root, child, label) {
  if (!child) throw new Error(`Planning ${label} path is missing`);
  const base = path.resolve(root);
  const resolved = path.resolve(base, child);
  const relative = path.relative(base, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Planning ${label} escapes its artifact root`);
  return resolved;
}

function clampInt(value, min, max) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}
