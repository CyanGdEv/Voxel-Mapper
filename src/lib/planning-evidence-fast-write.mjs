import path from "node:path";
import { mkdir, open } from "node:fs/promises";

const DEFAULT_BATCH_BYTES = 4 * 1024 * 1024;

/**
 * Writes the same page-stream contract as planning-evidence-bundle's
 * writeEvidencePageStreams without constructing a page-sized serialization
 * payload in memory. Production planning pages can contain tens of megabytes
 * of geometry before V8 expands them into objects, so serializing every record
 * into an array and joining the whole page temporarily multiplies peak memory.
 *
 * This writer keeps serialization bounded: records are JSON encoded into a
 * small batch, written through a FileHandle, then released before the next
 * batch is built. FileHandle writes also avoid accumulating EventEmitter
 * listeners while preserving deterministic record order and the existing
 * NDJSON page-stream contract.
 */
export async function writeEvidencePageStreamsFast(bundleRoot, pageEntry, evidence, prefix = null, options = {}) {
  const root = path.resolve(bundleRoot);
  await mkdir(path.join(root, "pages"), { recursive: true });
  const stem = prefix || `${safeName(pageEntry.contentHash)}-p${Number(pageEntry.pageNumber || 1)}`;
  const result = { ...pageEntry };
  const maxBatchBytes = normalizeBatchBytes(options.maxBatchBytes);
  const groups = [
    ["geometryCandidates", "geometryFile", "geometryCount", "geometry"],
    ["verticalObservations", "verticalFile", "verticalCount", "vertical"],
    ["materialObservations", "materialFile", "materialCount", "material"],
    ["rideStructureTemplates", "templateFile", "rideStructureTemplateCount", "ride-structure-template"]
  ];

  for (const [arrayKey, fileKey, countKey, suffix] of groups) {
    const values = evidence?.[arrayKey] || [];
    result[countKey] = values.length;
    if (!values.length) {
      result[fileKey] = null;
      continue;
    }

    const relative = `pages/${stem}.${suffix}.ndjson`;
    await writeNdjsonBatched(path.join(root, relative), values, maxBatchBytes);
    result[fileKey] = relative;
  }

  result.drawingMetadata = evidence?.drawingMetadata || pageEntry.drawingMetadata || [];
  return result;
}

async function writeNdjsonBatched(filename, values, maxBatchBytes) {
  const handle = await open(filename, "w");
  try {
    let parts = [];
    let bytes = 0;

    for (const value of values) {
      const line = `${JSON.stringify(value)}\n`;
      const lineBytes = Buffer.byteLength(line, "utf8");

      if (parts.length && bytes + lineBytes > maxBatchBytes) {
        await handle.write(parts.join(""), null, "utf8");
        parts = [];
        bytes = 0;
      }

      // A single record may legitimately exceed the preferred batch size. In
      // that case write it directly so the batching layer never duplicates a
      // giant record in an additional aggregate string.
      if (!parts.length && lineBytes > maxBatchBytes) {
        await handle.write(line, null, "utf8");
        continue;
      }

      parts.push(line);
      bytes += lineBytes;
    }

    if (parts.length) await handle.write(parts.join(""), null, "utf8");
  } finally {
    await handle.close();
  }
}

function normalizeBatchBytes(value) {
  const parsed = Number(value ?? DEFAULT_BATCH_BYTES);
  if (!Number.isFinite(parsed)) return DEFAULT_BATCH_BYTES;
  return Math.max(16 * 1024, Math.min(16 * 1024 * 1024, Math.floor(parsed)));
}

function safeName(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "unknown";
}
