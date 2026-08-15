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

export function enrichPlanningTextEvidence(extraction, options = {}) {
  if (!extraction?.pages?.length || !extraction?.normalizedEvidence) return extraction;
  const additions = [];
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
  }
  extraction.normalizedEvidence.materialObservations = dedupeMaterials(additions);
  return extraction;
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
