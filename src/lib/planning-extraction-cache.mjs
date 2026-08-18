import { createHash } from "node:crypto";

export const PLANNING_EXTRACTION_CACHE_VERSION = "v1-pdfjs-4.10.38";

export function buildPlanningExtractionImplementationFingerprint(sources = []) {
  const hash = createHash("sha256");
  hash.update(`${PLANNING_EXTRACTION_CACHE_VERSION}\n`);
  for (const source of sources || []) {
    hash.update(String(source?.name || "unknown"));
    hash.update("\0");
    hash.update(Buffer.isBuffer(source?.content) ? source.content : Buffer.from(String(source?.content || "")));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function buildPlanningExtractionShardCacheKey(catalog, shardIndex, implementationFingerprint) {
  const selectedShard = Number(shardIndex);
  const items = (catalog?.extractionQueue || [])
    .filter((item) => Number(item?.shard) === selectedShard)
    .map((item) => ({
      contentHash: item?.contentHash || null,
      objectPath: item?.objectPath || null,
      contentType: item?.contentType || null,
      classification: normalize(item?.classification || "unknown"),
      applicationKeys: [...(item?.applicationKeys || [])].map(String).sort(),
      acquisitionShard: Number.isFinite(Number(item?.acquisitionShard)) ? Number(item.acquisitionShard) : null
    }))
    .sort((a, b) => String(a.contentHash || "").localeCompare(String(b.contentHash || ""))
      || String(a.objectPath || "").localeCompare(String(b.objectPath || ""))
      || String(a.classification || "").localeCompare(String(b.classification || "")));

  const hash = createHash("sha256");
  hash.update(`${PLANNING_EXTRACTION_CACHE_VERSION}\n`);
  hash.update(String(implementationFingerprint || "unknown-implementation"));
  hash.update("\n");
  hash.update(JSON.stringify({ shard: selectedShard, items }));
  return hash.digest("hex");
}

function normalize(value) {
  return String(value || "unknown").trim().toLowerCase().replaceAll("-", "_");
}
