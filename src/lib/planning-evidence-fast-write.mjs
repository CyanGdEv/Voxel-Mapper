import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

/**
 * Writes the same page-stream contract as planning-evidence-bundle's
 * writeEvidencePageStreams, but serializes each already-materialized page
 * array in one bounded write. Revision/authority stages already hold these
 * page arrays in memory, so per-record stream backpressure adds listeners and
 * syscalls without reducing peak evidence memory. Keeping the writer here
 * makes the optimization isolated and easy to equivalence-test.
 */
export async function writeEvidencePageStreamsFast(bundleRoot, pageEntry, evidence, prefix = null) {
  const root = path.resolve(bundleRoot);
  await mkdir(path.join(root, "pages"), { recursive: true });
  const stem = prefix || `${safeName(pageEntry.contentHash)}-p${Number(pageEntry.pageNumber || 1)}`;
  const result = { ...pageEntry };
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
    const payload = `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
    await writeFile(path.join(root, relative), payload, "utf8");
    result[fileKey] = relative;
  }
  result.drawingMetadata = evidence?.drawingMetadata || pageEntry.drawingMetadata || [];
  return result;
}

function safeName(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "unknown";
}
