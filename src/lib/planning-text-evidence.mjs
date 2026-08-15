const MATERIAL_PATTERNS = [
  ["weathered_asphalt", /\bweathered[\s_-]*(?:asphalt|tarmac|bitmac)\b/i],
  ["fresh_black_asphalt", /\b(?:new|fresh|black)(?:[\s_-]*black)?[\s_-]*(?:asphalt|tarmac|bitmac)\b/i],
  ["red_tarmac", /\bred[\s_-]*(?:tarmac|asphalt|bitmac)\b/i],
  ["resin_bound_beige", /\b(?:beige|buff)[\s_-]*resin(?:[\s_-]*bound)?\b|\bresin(?:[\s_-]*bound)?[\s_-]*(?:beige|buff)\b/i],
  ["resin_bound_grey", /\bgr(?:e|a)y[\s_-]*resin(?:[\s_-]*bound)?\b|\bresin(?:[\s_-]*bound)?[\s_-]*gr(?:e|a)y\b/i],
  ["concrete", /\bconcrete\b/i],
  ["brick", /\bbrick(?:work|[\s_-]*paving|[\s_-]*pavers?)?\b/i],
  ["stone", /\b(?:natural[\s_-]*)?stone\b|\bgranite\b/i],
  ["timber", /\btimber\b|\bwood(?:en)?\b/i],
  ["steel", /\bsteel\b/i],
  ["glass", /\bglass\b|\bglazing\b/i],
  ["slate_roof", /\bslate(?:[\s_-]*roof)?\b/i],
  ["clay_tile_roof", /\bclay[\s_-]*tiles?\b|\broof[\s_-]*tiles?\b/i],
  ["metal_roof", /\b(?:metal|zinc|aluminium|aluminum)[\s_-]*(?:roof|cladding|sheet)\b/i],
  ["gravel", /\bgravel\b|\bchippings\b/i],
  ["grass", /\bgrass\b|\bturf\b/i]
];

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

export function enrichPlanningTextEvidence(extraction, options = {}) {
  if (!extraction?.pages?.length || !extraction?.normalizedEvidence) return extraction;
  const additions = [];
  const metadata = [];
  for (const page of extraction.pages) {
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
  return extraction;
}

export function enrichDrawingLifecycleMetadata(existing, textItems, pageNumber = 1) {
  const text = (textItems || []).map((item) => String(item?.text || "").trim()).filter(Boolean).join(" ").replace(/\s+/g, " ");
  if (!text && !existing) return null;
  const status = existing?.status || detectTitleStatus(text);
  const issueDate = existing?.issueDate || detectIssueDate(text);
  if (!existing && !status && !issueDate) return null;
  return {
    ...(existing || { pageNumber, scaleDenominator: null, drawingNumber: null, revision: null, source: "pdf-text-title-block" }),
    pageNumber,
    status: status || null,
    issueDate: issueDate || null,
    lifecycleSource: status || issueDate ? "pdf-text-title-block-enrichment" : existing?.lifecycleSource || null
  };
}

export function extractMaterialObservationsAcrossRuns(textItems, pageNumber = 1, contentHash = null, options = {}) {
  const maxWindow = clampInt(options.materialTextWindow ?? 5, 2, 12);
  const maxLineDeltaPt = Number(options.materialLineDeltaPt ?? 4);
  const items = (textItems || []).filter((item) => String(item?.text || "").trim());
  const observations = [];

  for (let start = 0; start < items.length; start += 1) {
    let phrase = "";
    const anchor = items[start];
    for (let end = start; end < Math.min(items.length, start + maxWindow); end += 1) {
      const current = items[end];
      if (end > start && !sameLogicalLine(anchor, current, maxLineDeltaPt)) break;
      phrase = `${phrase} ${String(current.text || "").trim()}`.trim().replace(/\s+/g, " ");
      if (!phrase) continue;
      for (const [material, pattern] of MATERIAL_PATTERNS) {
        if (!pattern.test(phrase)) continue;
        observations.push({
          contentHash,
          pageNumber,
          xPt: finiteOrNull(anchor.xPt),
          yPt: finiteOrNull(anchor.yPt),
          material,
          raw: phrase,
          confidence: end === start ? 0.76 : 0.74,
          source: end === start ? "pdf-text-material-label" : "pdf-text-adjacent-run-material-label",
          textItemStart: start,
          textItemEnd: end,
          georegistrationRequired: true
        });
      }
    }
  }
  return dedupeMaterials(observations);
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

function sameLogicalLine(anchor, current, maxLineDeltaPt) {
  const ay = Number(anchor?.yPt), cy = Number(current?.yPt);
  if (!Number.isFinite(ay) || !Number.isFinite(cy)) return true;
  const anchorFont = Number(anchor?.fontSizePt || anchor?.heightPt || 0);
  const currentFont = Number(current?.fontSizePt || current?.heightPt || 0);
  const tolerance = Math.max(maxLineDeltaPt, Math.min(12, Math.max(anchorFont, currentFont) * 0.45));
  return Math.abs(ay - cy) <= tolerance;
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
