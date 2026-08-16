import { resolvePlanningLegend } from "./planning-legend-resolver.mjs";

/**
 * Runs the page-local legend resolver after raw PDF vector/text extraction and
 * before planning text/temporal enrichment. This keeps the vector extractor a
 * low-level parser while making legend-derived materials first-class evidence
 * in the normal planning authority pipeline.
 */
export function enrichPlanningLegendEvidence(extraction, options = {}) {
  if (!extraction?.normalizedEvidence || !Array.isArray(extraction.pages)) return extraction;
  const contentHash = extraction.contentHash || null;
  const normalized = extraction.normalizedEvidence;
  const directNormalized = (normalized.materialObservations || []).filter((entry) => !isLegendDerived(entry));
  const inferred = [];
  const legendEntries = [];
  const pageSummaries = [];

  for (const page of extraction.pages) {
    const pageNumber = Number(page.pageNumber || 1);
    const directPageMaterials = (page.materialObservations || directNormalized.filter((entry) =>
      Number(entry.pageNumber || 1) === pageNumber && (!contentHash || !entry.contentHash || entry.contentHash === contentHash)
    )).filter((entry) => !isLegendDerived(entry));
    const legend = resolvePlanningLegend({
      pageNumber,
      contentHash,
      textItems: page.text?.items || [],
      vectorPaths: page.vector?.paths || [],
      geometryCandidates: page.geometryCandidates || [],
      materialObservations: directPageMaterials
    }, options);

    page.legend = legend;
    page.materialObservations = dedupeMaterials([...directPageMaterials, ...legend.materialObservations]);
    inferred.push(...legend.materialObservations);
    legendEntries.push(...legend.entries);
    pageSummaries.push({
      pageNumber,
      status: legend.status,
      legendEntries: legend.counts.legendEntries,
      acceptedEntries: legend.counts.acceptedEntries,
      inferredMaterialObservations: legend.counts.inferredMaterialObservations,
      conflicts: legend.counts.conflicts
    });
  }

  normalized.materialObservations = dedupeMaterials([...directNormalized, ...inferred]);
  normalized.legendEntries = legendEntries;
  normalized.legendResolution = {
    schemaVersion: 1,
    status: legendEntries.length ? "resolved-or-reviewed" : "no-legend-evidence",
    terrainGeometryMutable: false,
    pageCount: pageSummaries.length,
    legendEntryCount: legendEntries.length,
    acceptedEntryCount: legendEntries.filter((entry) => entry.propagationEligible && (entry.codeAccepted || entry.fillAccepted || entry.hatchAccepted)).length,
    inferredMaterialObservationCount: inferred.length,
    conflictCount: pageSummaries.reduce((sum, page) => sum + page.conflicts, 0),
    pages: pageSummaries
  };
  extraction.legendResolution = normalized.legendResolution;
  return extraction;
}

function isLegendDerived(entry) {
  return /^pdf-legend-/.test(String(entry?.source || ""));
}

function dedupeMaterials(values) {
  const ordered = [...(values || [])].sort((a, b) =>
    Number(b.confidence || 0) - Number(a.confidence || 0) ||
    sourcePriority(a.source) - sourcePriority(b.source) ||
    String(a.material || "").localeCompare(String(b.material || ""))
  );
  const seen = new Set();
  const result = [];
  for (const value of ordered) {
    const key = `${value.contentHash || ""}:${value.pageNumber || 0}:${value.material || ""}:${round(value.xPt, 1)}:${round(value.yPt, 1)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result.sort((a, b) =>
    String(a.contentHash || "").localeCompare(String(b.contentHash || "")) ||
    Number(a.pageNumber || 0) - Number(b.pageNumber || 0) ||
    finiteSort(b.yPt, a.yPt) || finiteSort(a.xPt, b.xPt) ||
    String(a.material || "").localeCompare(String(b.material || ""))
  );
}

function sourcePriority(source) {
  const value = String(source || "");
  if (value === "pdf-text-material-label") return 0;
  if (value === "pdf-text-material-window") return 1;
  if (value === "pdf-legend-code-material") return 2;
  if (value === "pdf-legend-fill-material") return 3;
  if (value === "pdf-legend-hatch-material") return 4;
  return 5;
}

function finiteSort(left, right) {
  if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
  if (Number.isFinite(left)) return -1;
  if (Number.isFinite(right)) return 1;
  return 0;
}

function round(value, places = 2) {
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** places;
  return Math.round(Number(value) * factor) / factor;
}
