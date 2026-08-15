import { extractPlanningDocument } from "./planning-vector-extractor.mjs";

const DEFAULT_CONCURRENCY = 2;

export async function processPlanningExtractionShard(catalog, options = {}) {
  const shardIndex = Number(options.shardIndex ?? 0);
  const items = (catalog?.extractionQueue || []).filter((item) => Number(item.shard) === shardIndex);
  const concurrency = clampInt(options.concurrency ?? DEFAULT_CONCURRENCY, 1, 8);
  const results = await mapLimit(items, concurrency, async (item) => {
    try {
      const extraction = await extractPlanningDocument(item, options);
      return { status: extraction.status, item, extraction };
    } catch (error) {
      if (options.strictPlanningExtraction) throw error;
      return {
        status: "failed",
        item,
        error: error?.message || String(error),
        extraction: null
      };
    }
  });

  const successful = results.filter((result) => result.status === "extracted" || result.status === "raster-fallback-required");
  const failed = results.filter((result) => result.status === "failed");
  const rasterFallbackQueue = successful.flatMap((result) => result.extraction?.rasterFallbackQueue || []);
  return {
    schemaVersion: 1,
    selectedShard: shardIndex,
    inputItems: items.length,
    extractedDocuments: results.filter((result) => result.status === "extracted").length,
    rasterOnlyDocuments: results.filter((result) => result.status === "raster-fallback-required").length,
    failedDocuments: failed.length,
    geometryCandidates: successful.reduce((sum, result) => sum + (result.extraction?.normalizedEvidence?.geometryCandidates?.length || 0), 0),
    verticalObservations: successful.reduce((sum, result) => sum + (result.extraction?.normalizedEvidence?.verticalObservations?.length || 0), 0),
    materialObservations: successful.reduce((sum, result) => sum + (result.extraction?.normalizedEvidence?.materialObservations?.length || 0), 0),
    rasterFallbackPages: rasterFallbackQueue.length,
    failures: failed.map((result) => ({
      contentHash: result.item?.contentHash || null,
      objectPath: result.item?.objectPath || null,
      error: result.error
    })),
    rasterFallbackQueue,
    results
  };
}

export function mergePlanningExtractionManifests(manifests) {
  const values = Array.isArray(manifests) ? manifests : [manifests].filter(Boolean);
  const byHash = new Map();
  const failures = [];
  const rasterFallbackQueue = [];
  for (const manifest of values) {
    failures.push(...(manifest?.failures || []));
    rasterFallbackQueue.push(...(manifest?.rasterFallbackQueue || []));
    for (const result of manifest?.results || []) {
      const extraction = result?.extraction;
      if (!extraction?.contentHash) continue;
      if (!byHash.has(extraction.contentHash)) byHash.set(extraction.contentHash, extraction);
    }
  }
  const documents = [...byHash.values()].sort((a, b) => a.contentHash.localeCompare(b.contentHash));
  const geometryCandidates = documents.flatMap((document) => document.normalizedEvidence?.geometryCandidates || []);
  const verticalObservations = documents.flatMap((document) => document.normalizedEvidence?.verticalObservations || []);
  const materialObservations = documents.flatMap((document) => document.normalizedEvidence?.materialObservations || []);
  const drawingMetadata = documents.flatMap((document) => document.normalizedEvidence?.drawingMetadata || []);
  const fallback = dedupeFallback(rasterFallbackQueue);
  return {
    schemaVersion: 1,
    method: "vector-first-planning-drawing-extraction",
    coordinateSpace: "pdf-user-space-points",
    georegistrationStatus: "required",
    worldGeometryReady: false,
    inputShardManifests: values.length,
    documentCount: documents.length,
    geometryCandidateCount: geometryCandidates.length,
    verticalObservationCount: verticalObservations.length,
    materialObservationCount: materialObservations.length,
    rasterFallbackPages: fallback.length,
    failures,
    documents,
    normalizedEvidence: {
      schemaVersion: 1,
      coordinateSpace: "pdf-user-space-points",
      georegistrationStatus: "required",
      worldGeometryReady: false,
      geometryCandidates,
      verticalObservations,
      materialObservations,
      drawingMetadata
    },
    rasterFallbackQueue: fallback
  };
}

function dedupeFallback(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const key = `${value.contentHash || ""}:${value.pageNumber || 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result.sort((a, b) => (b.priority || 0) - (a.priority || 0) || String(a.contentHash).localeCompare(String(b.contentHash)) || (a.pageNumber || 0) - (b.pageNumber || 0));
}

async function mapLimit(values, limit, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function clampInt(value, min, max) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : min;
}
