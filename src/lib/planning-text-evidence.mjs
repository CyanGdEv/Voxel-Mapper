import { enrichPlanningObjectEvidence } from "./planning-object-extractor.mjs";
import { enrichPlanningPedestrianEvidence } from "./planning-pedestrian-enrichment.mjs";
import { extractPlanningMaterialObservations } from "./planning-material-normalizer.mjs";

const TITLE_STATUS_PATTERNS = [
  ["as-built", /\b(?:status|purpose(?:\s+of\s+issue)?)\s*[:#-]?\s*(?:as[- ]?built|record)\b|\bas[- ]?built\b/i],
  ["existing", /\b(?:status|purpose(?:\s+of\s+issue)?)\s*[:#-]?\s*existing\b/i],
  ["construction", /\b(?:status|purpose(?:\s+of\s+issue)?)\s*[:#-]?\s*(?:for\s+)?construction\b|\bfor\s+construction\b/i],
  ["tender", /\b(?:status|purpose(?:\s+of\s+issue)?)\s*[:#-]?\s*(?:for\s+)?tender\b|\bfor\s+tender\b/i],
  ["planning", /\b(?:status|purpose(?:\s+of\s+issue)?)\s*[:#-]?\s*(?:for\s+)?planning\b|\bfor\s+planning\b/i],
  ["approved", /\b(?:status|purpose(?:\s+of\s+issue)?)\s*[:#-]?\s*approved\b/i],
  ["proposed", /\b(?:status|purpose(?:\s+of\s+issue)?)\s*[:#-]?\s*proposed\b/i],
  ["preliminary", /\b(?:status|purpose(?:\s+of\s+issue)?)\s*[:#-]?\s*preliminary\b/i],
  ["superseded", /\b(?:status|purpose(?:\s+of\s+issue)?)\s*[:#-]?\s*(?:superseded|obsolete)\b/i],
  ["withdrawn", /\b(?:status|purpose(?:\s+of\s+issue)?)\s*[:#-]?\s*(?:withdrawn|cancelled|canceled)\b/i]
];

// PDF text extraction frequently flattens title-block columns into reading
// order rather than preserving field/value adjacency. In that form a header
// sequence such as "DRAWING STATUS ... REV CHECKED" can be misread by a broad
// regex as drawingNumber=STATUS and revision=CHECKED. These are field labels,
// never useful revision-lineage identifiers, so reject them before authority
// resolution. When a genuine value appears later in the flattened text, scan
// forward and recover that value instead.
const TITLE_BLOCK_HEADER_VALUES = new Set([
  "APPROVED", "CHECK", "CHECKED", "CLIENT", "DATE", "DRAWING", "DRAWN",
  "DWG", "NO", "NUMBER", "PROJECT", "PURPOSE", "REV", "REVISION", "SCALE",
  "SHEET", "STATUS", "TITLE"
]);

export function enrichPlanningTextEvidence(extraction, options = {}) {
  if (!extraction?.pages?.length || !extraction?.normalizedEvidence) return extraction;
  const additions = [];
  const metadata = [];
  for (const page of extraction.pages) {
    // Use the single canonical planning-material normalizer here too. The old
    // text-enrichment pass had a second, weaker regex table that could emit a
    // generic material (for example stone/concrete/asphalt) beside the more
    // specific canonical result (paving stones/old concrete/light asphalt),
    // making downstream path material association ambiguous or wrong.
    const found = extractMaterialObservationsAcrossRuns(
      page.text?.items || [],
      page.pageNumber,
      extraction.contentHash,
      options
    );
    const existing = page.materialObservations || [];
    const merged = dedupeMaterials([...existing, ...found]);
    page.materialObservations = merged;
    additions.push(...merged);

    page.metadata = enrichDrawingLifecycleMetadata(page.metadata, page.text?.items || [], page.pageNumber);
    if (page.metadata) metadata.push(page.metadata);
  }
  extraction.normalizedEvidence.materialObservations = dedupeMaterials(additions);
  extraction.normalizedEvidence.drawingMetadata = metadata;

  // Pedestrian/plaza semantics require raw page text + vector bounds. Run this
  // before compactPlanningExtraction drops those heavy PDF working arrays, so
  // the sharded production bundle retains the semantic result without retaining
  // raw text/vector payloads.
  enrichPlanningPedestrianEvidence(extraction, options);

  // The universal object pass consumes the final page-local text/material/level
  // evidence while raw PDF coordinates are still available. It only annotates
  // candidates/templates and schedule metadata; it never grants authority or
  // changes topology/terrain semantics.
  enrichPlanningObjectEvidence(extraction, options);
  return extraction;
}

export function enrichDrawingLifecycleMetadata(existing, textItems, pageNumber = 1) {
  const text = (textItems || []).map((item) => String(item?.text || "").trim()).filter(Boolean).join(" ").replace(/\s+/g, " ");
  if (!text && !existing) return null;
  const drawingNumber = sanitizeTitleBlockIdentifier(existing?.drawingNumber) || detectDrawingNumber(text);
  const revision = sanitizeTitleBlockIdentifier(existing?.revision) || detectDrawingRevision(text);
  const status = existing?.status || detectTitleStatus(text);
  const issueDate = existing?.issueDate || detectIssueDate(text);
  if (!existing && !drawingNumber && !revision && !status && !issueDate) return null;
  return {
    ...(existing || { pageNumber, scaleDenominator: null, drawingNumber: null, revision: null, source: "pdf-text-title-block" }),
    pageNumber,
    drawingNumber: drawingNumber || null,
    revision: revision || null,
    status: status || null,
    issueDate: issueDate || null,
    lifecycleSource: status || issueDate ? "pdf-text-title-block-enrichment" : existing?.lifecycleSource || null
  };
}

/**
 * Compatibility export retained for callers/tests. Material recognition is now
 * delegated to the canonical normalizer so every extraction path uses the same
 * specificity, deduplication and confidence policy.
 */
export function extractMaterialObservationsAcrossRuns(textItems, pageNumber = 1, contentHash = null, options = {}) {
  return extractPlanningMaterialObservations(textItems, pageNumber, contentHash, options);
}

function detectDrawingNumber(text) {
  return firstUsableTitleBlockMatch(
    text,
    /\b(?:drawing|dwg)\s*(?:no\.?|number|ref\.?)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{2,})/ig
  );
}

function detectDrawingRevision(text) {
  return firstUsableTitleBlockMatch(
    text,
    /\b(?:rev(?:ision)?\.?)\s*[:#-]?\s*([A-Z0-9]{1,8})\b/ig
  );
}

function firstUsableTitleBlockMatch(text, pattern) {
  for (const match of String(text || "").matchAll(pattern)) {
    const value = sanitizeTitleBlockIdentifier(match[1]);
    if (value) return value;
  }
  return null;
}

function sanitizeTitleBlockIdentifier(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const canonical = text.toUpperCase().replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, "");
  if (!canonical || TITLE_BLOCK_HEADER_VALUES.has(canonical)) return null;
  return text;
}

function detectTitleStatus(text) {
  for (const [status, pattern] of TITLE_STATUS_PATTERNS) if (pattern.test(text)) return status;
  return null;
}

function detectIssueDate(text) {
  const labelled = String(text || "").match(/\b(?:issue\s+date|drawing\s+date|date)\s*[:#-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4}-\d{1,2}-\d{1,2})\b/i);
  if (!labelled) return null;
  const value = labelled[1];
  if (/^\d{4}-/.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const parts = value.split(/[\/-]/).map(Number);
  if (parts.length !== 3) return null;
  let [day, month, year] = parts;
  if (year < 100) year += year >= 70 ? 1900 : 2000;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString();
}

function dedupeMaterials(values) {
  const byKey = new Map();
  for (const value of values || []) {
    const key = `${value.contentHash || ""}:${value.pageNumber || 0}:${value.material}:${round(value.xPt, 1)}:${round(value.yPt, 1)}`;
    const previous = byKey.get(key);
    if (!previous || (value.confidence || 0) > (previous.confidence || 0) || String(value.raw || "").length < String(previous.raw || "").length) {
      byKey.set(key, value);
    }
  }
  return [...byKey.values()].sort((a, b) => (a.pageNumber || 0) - (b.pageNumber || 0) || (b.confidence || 0) - (a.confidence || 0) || String(a.material).localeCompare(String(b.material)));
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, places = 2) {
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** places;
  return Math.round(Number(value) * factor) / factor;
}

function clampInt(value, min, max) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : min;
}
