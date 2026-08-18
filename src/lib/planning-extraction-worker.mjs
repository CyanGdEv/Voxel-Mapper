import { extractPlanningDocument } from "./planning-vector-extractor.mjs";
import { loadPlanningPdfJsRuntime } from "./planning-pdfjs-runtime.mjs";
import { reclassifyPlanningDocumentFromContent } from "./planning-document-content-classifier.mjs";
import { enrichPlanningRideStructureEvidence } from "./planning-ride-structure-enrichment.mjs";
import { enrichPlanningLegendEvidence } from "./planning-legend-enrichment.mjs";
import { enrichPlanningTextEvidence } from "./planning-text-evidence.mjs";
import { fusePlanningObjectSchedules } from "./planning-object-schedule-fusion.mjs";

const DEFAULT_CONCURRENCY = 2;
const EXTRACTOR_CLASS_ALIASES = new Map([
  ["site-plan", "site_plan"],
  ["location-plan", "location_plan"],
  ["floor-plan", "floor_plan"],
  ["roof-plan", "roof_plan"],
  ["ride-layout", "ride_layout"],
  ["landscape", "landscape_plan"],
  ["demolition", "demolition_plan"],
  ["design-access", "design_access"]
]);

export async function processPlanningExtractionShard(catalog, options = {}) {
  const shardIndex = Number(options.shardIndex ?? 0);
  const items = (catalog?.extractionQueue || []).filter((item) => Number(item.shard) === shardIndex);
  const concurrency = clampInt(options.concurrency ?? DEFAULT_CONCURRENCY, 1, 8);
  const needsPdf = items.some((item) => String(item.contentType || "").toLowerCase() === "application/pdf" || /\.pdf$/i.test(item.objectPath || ""));
  const pdfEngine = needsPdf ? (options.pdfEngine || await loadPlanningPdfJsRuntime()) : options.pdfEngine;
  const extractionOptions = { ...options, pdfEngine };
  const results = await mapLimit(items, concurrency, async (item) => {
    const extractionItem = { ...item, classification: normalizeExtractorClass(item.classification) };
    try {
      const extraction = await extractPlanningDocument(extractionItem, extractionOptions);
      // Council portals frequently expose opaque filenames/codes. Once PDF text
      // is available, weak unknown/supporting classifications may be promoted by
      // strong drawing-title/engineering phrases. This is semantic routing only:
      // it never bypasses georegistration, currentness, or authority gates.
      reclassifyPlanningDocumentFromContent(extraction, extractionItem.classification);
      // Ride-structure semantics need raw page text/vector paths, so run this
      // before compaction. Section/elevation support detail is removed from map
      // geometry here and retained once as non-spatial design templates.
      enrichPlanningRideStructureEvidence(extraction, extractionOptions);
      enrichPlanningLegendEvidence(extraction, extractionOptions);
      enrichPlanningTextEvidence(extraction, extractionOptions);
      const compact = compactPlanningExtraction(extraction);
      return { status: compact.status, item, extraction: compact };
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
    schemaVersion: 2,
    serialization: "normalized-evidence-single-copy",
    selectedShard: shardIndex,
    inputItems: items.length,
    extractedDocuments: results.filter((result) => result.status === "extracted").length,
    rasterOnlyDocuments: results.filter((result) => result.status === "raster-fallback-required").length,
    failedDocuments: failed.length,
    geometryCandidates: successful.reduce((sum, result) => sum + (result.extraction?.normalizedEvidence?.geometryCandidates?.length || 0), 0),
    verticalObservations: successful.reduce((sum, result) => sum + (result.extraction?.normalizedEvidence?.verticalObservations?.length || 0), 0),
    materialObservations: successful.reduce((sum, result) => sum + (result.extraction?.normalizedEvidence?.materialObservations?.length || 0), 0),
    legendEntries: successful.reduce((sum, result) => sum + (result.extraction?.normalizedEvidence?.legendEntries?.length || 0), 0),
    rideStructureTemplates: successful.reduce((sum, result) => sum + (result.extraction?.normalizedEvidence?.rideStructureTemplates?.length || 0), 0),
    planningObjectTextObservations: successful.reduce((sum, result) => sum + (result.extraction?.normalizedEvidence?.planningObjectTextObservations?.length || 0), 0),
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

/**
 * Drops PDF-renderer working data after semantic extraction has completed.
 * Geometry candidates, level/material observations, learned legend entries,
 * ride support/detail templates, title-block metadata, provenance and raster
 * fallback decisions remain in normalizedEvidence.
 *
 * The previous manifest serialized the same path commands in raw vector paths,
 * page-level candidates and normalized candidates. Large CAD-heavy applications
 * could therefore exceed V8's maximum string length during JSON.stringify even
 * though extraction itself succeeded.
 */
export function compactPlanningExtraction(extraction) {
  if (!extraction) return extraction;
  const contentHash = extraction.contentHash || null;
  const normalized = extraction.normalizedEvidence || {};
  const drawingMetadata = (normalized.drawingMetadata || []).map((metadata) => ({
    ...metadata,
    contentHash: metadata?.contentHash || contentHash
  }));
  const pages = (extraction.pages || []).map((page) => ({
    pageNumber: page.pageNumber,
    widthPt: page.widthPt ?? null,
    heightPt: page.heightPt ?? null,
    rotation: page.rotation ?? 0,
    text: page.text ? {
      itemCount: page.text.itemCount ?? page.text.items?.length ?? 0,
      characterCount: page.text.characterCount ?? 0,
      truncated: Boolean(page.text.truncated)
    } : null,
    vector: page.vector ? {
      pathCount: page.vector.pathCount ?? page.vector.paths?.length ?? 0,
      imagePaintOps: page.vector.imagePaintOps ?? 0,
      truncated: Boolean(page.vector.truncated)
    } : null,
    metadata: page.metadata ? { ...page.metadata, contentHash: page.metadata.contentHash || contentHash } : null,
    legend: page.legend ? {
      schemaVersion: page.legend.schemaVersion || 1,
      status: page.legend.status || null,
      counts: page.legend.counts || null,
      terrainPolicy: page.legend.terrainPolicy || null
    } : null,
    rasterFallback: page.rasterFallback || null
  }));
  return {
    ...extraction,
    pages,
    normalizedEvidence: {
      ...normalized,
      drawingMetadata
    },
    serialization: {
      schemaVersion: 1,
      mode: "normalized-evidence-single-copy",
      rawTextItemsRetained: false,
      rawVectorPathsRetained: false,
      duplicatePageEvidenceRetained: false,
      rideStructureTemplatesRetained: true,
      planningObjectScheduleEvidenceRetained: true
    }
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
      if (!byHash.has(extraction.contentHash)) byHash.set(extraction.contentHash, compactPlanningExtraction(extraction));
    }
  }
  const extractedDocuments = [...byHash.values()].sort((a, b) => a.contentHash.localeCompare(b.contentHash));
  const geometryCandidates = extractedDocuments.flatMap((document) => document.normalizedEvidence?.geometryCandidates || []);
  const verticalObservations = extractedDocuments.flatMap((document) => document.normalizedEvidence?.verticalObservations || []);
  const materialObservations = extractedDocuments.flatMap((document) => document.normalizedEvidence?.materialObservations || []);
  const legendEntries = extractedDocuments.flatMap((document) => document.normalizedEvidence?.legendEntries || []);
  const rideStructureTemplates = dedupeRideStructureTemplates(extractedDocuments.flatMap((document) => document.normalizedEvidence?.rideStructureTemplates || []));
  const drawingMetadata = extractedDocuments.flatMap((document) =>
    (document.normalizedEvidence?.drawingMetadata || []).map((metadata) => ({
      ...metadata,
      contentHash: metadata?.contentHash || document.contentHash
    }))
  );
  const normalizedEvidence = {
    schemaVersion: 2,
    coordinateSpace: "pdf-user-space-points",
    georegistrationStatus: "required",
    worldGeometryReady: false,
    geometryCandidates,
    verticalObservations,
    materialObservations,
    legendEntries,
    rideStructureTemplates,
    drawingMetadata
  };
  const planningObjectScheduleFusion = fusePlanningObjectSchedules(normalizedEvidence);
  const fallback = dedupeFallback(rasterFallbackQueue);
  return {
    schemaVersion: 2,
    method: "vector-first-planning-drawing-extraction",
    coordinateSpace: "pdf-user-space-points",
    georegistrationStatus: "required",
    worldGeometryReady: false,
    serialization: "normalized-evidence-single-copy",
    inputShardManifests: values.length,
    documentCount: extractedDocuments.length,
    geometryCandidateCount: geometryCandidates.length,
    verticalObservationCount: verticalObservations.length,
    materialObservationCount: materialObservations.length,
    legendEntryCount: legendEntries.length,
    rideStructureTemplateCount: rideStructureTemplates.length,
    planningObjectScheduleObservationCount: drawingMetadata.reduce((sum, metadata) => sum + (metadata?.planningObjectTextObservations?.length || 0), 0),
    planningObjectScheduleFusion,
    rasterFallbackPages: fallback.length,
    failures,
    documents: extractedDocuments.map(documentSummary),
    normalizedEvidence,
    rasterFallbackQueue: fallback
  };
}

export function normalizeExtractorClass(value) {
  const raw = String(value || "unknown").trim().toLowerCase();
  return EXTRACTOR_CLASS_ALIASES.get(raw) || raw.replaceAll("-", "_");
}

function documentSummary(document) {
  return {
    schemaVersion: document.schemaVersion || 1,
    contentHash: document.contentHash,
    objectPath: document.objectPath || null,
    contentType: document.contentType || null,
    classification: document.classification || "unknown",
    acquisitionClassification: document.acquisitionClassification || null,
    contentClassification: document.contentClassification || null,
    applicationKeys: document.applicationKeys || [],
    acquisitionShard: document.acquisitionShard ?? null,
    status: document.status || null,
    method: document.method || null,
    pageCount: document.pageCount || 0,
    vectorPageCount: document.vectorPageCount || 0,
    textPageCount: document.textPageCount || 0,
    rasterFallbackPageCount: document.rasterFallbackPageCount || 0,
    legendEntryCount: document.normalizedEvidence?.legendEntries?.length || 0,
    rideStructureTemplateCount: document.normalizedEvidence?.rideStructureTemplates?.length || 0,
    planningObjectScheduleObservationCount: (document.normalizedEvidence?.drawingMetadata || []).reduce((sum, metadata) => sum + (metadata?.planningObjectTextObservations?.length || 0), 0),
    rideStructureExtraction: document.rideStructureExtraction || null,
    planningObjectExtraction: document.planningObjectExtraction || null,
    pages: (document.pages || []).map((page) => ({
      pageNumber: page.pageNumber,
      widthPt: page.widthPt ?? null,
      heightPt: page.heightPt ?? null,
      rotation: page.rotation ?? 0,
      text: page.text || null,
      vector: page.vector || null,
      metadata: page.metadata || null,
      legend: page.legend || null,
      rasterFallback: page.rasterFallback || null
    })),
    warnings: document.warnings || []
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

function dedupeRideStructureTemplates(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const key = value?.id || `${value?.contentHash || ""}:${value?.pageNumber || 0}:${value?.component || ""}:${value?.supportCode || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result.sort((a, b) => String(a.contentHash || "").localeCompare(String(b.contentHash || "")) || Number(a.pageNumber || 0) - Number(b.pageNumber || 0) || String(a.id || "").localeCompare(String(b.id || "")));
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
