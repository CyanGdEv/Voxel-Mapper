const MATERIAL_RULES = [
  rule("red_tarmac", "surface", 0.92, [
    /\bred\s*(?:asphalt|tarmac|bitmac|macadam)\b/i,
    /\bred(?:asphalt|tarmac|bitmac|macadam)\b/i
  ]),
  rule("resin_bound_beige", "surface", 0.92, [
    /\b(?:beige|buff|sand|sandy|gold(?:en)?)\s*resin(?:\s*-?\s*bound)?\b/i,
    /\bresin(?:\s*-?\s*bound)?\s*(?:beige|buff|sand|sandy|gold(?:en)?)\b/i,
    /\b(?:beige|buff|sand|sandy|gold(?:en)?)resin(?:bound)?\b/i,
    /\bresin(?:bound)?(?:beige|buff|sand|sandy|gold(?:en)?)\b/i
  ]),
  rule("resin_bound_grey", "surface", 0.92, [
    /\bgr(?:e|a)y\s*resin(?:\s*-?\s*bound)?\b/i,
    /\bresin(?:\s*-?\s*bound)?\s*gr(?:e|a)y\b/i,
    /\bgr(?:e|a)yresin(?:bound)?\b/i,
    /\bresin(?:bound)?gr(?:e|a)y\b/i
  ]),
  rule("fresh_black_asphalt", "surface", 0.9, [
    /\b(?:new|fresh|black|dark)\s*(?:black\s*)?(?:asphalt|tarmac|bitmac|macadam)\b/i,
    /\b(?:new|fresh|black|dark)(?:black)?(?:asphalt|tarmac|bitmac|macadam)\b/i
  ]),
  rule("light_asphalt", "surface", 0.9, [
    /\b(?:light|pale)\s*(?:gr(?:e|a)y\s*)?(?:asphalt|tarmac|bitmac|macadam)\b/i,
    /\blightgr(?:e|a)y(?:asphalt|tarmac|bitmac|macadam)\b/i,
    /\b(?:light|pale)(?:asphalt|tarmac|bitmac|macadam)\b/i
  ]),
  rule("weathered_asphalt", "surface", 0.86, [
    /\b(?:weathered|existing|old|aged|worn)\s*(?:asphalt|tarmac|bitmac|macadam)\b/i,
    /\b(?:weathered|existing|old|aged|worn)(?:asphalt|tarmac|bitmac|macadam)\b/i
  ]),
  rule("old_concrete", "surface", 0.88, [
    /\b(?:old|existing|weathered|aged|worn|stained)\s*concrete\b/i,
    /\b(?:old|existing|weathered|aged|worn|stained)concrete\b/i
  ]),
  rule("paving_stones", "surface", 0.88, [
    /\b(?:block\s*paving|paving\s*(?:slabs?|stones?|flags?|blocks?)|stone\s*pavers?|concrete\s*pavers?|flag\s*stones?|flagstones?|pavers?)\b/i,
    /\b(?:blockpaving|pavingslabs?|pavingstones?|pavingflags?|pavingblocks?|stonepavers?|concretepavers?|flagstones?|pavers?)\b/i
  ]),
  rule("concrete", "surface", 0.8, [
    /\b(?:concrete|cement(?:itious)?)\b/i
  ]),
  rule("brick", "surface", 0.82, [
    /\b(?:brick\s*paving|brick\s*pavers?|brickwork|bricks?)\b/i,
    /\b(?:brickpaving|brickpavers?)\b/i
  ]),
  rule("stone", "surface", 0.8, [
    /\b(?:natural\s*stone|granite|limestone|sandstone|cobble(?:stone)?s?|stone)\b/i
  ]),
  rule("timber", "surface", 0.8, [
    /\b(?:timber|wood(?:en)?|decking)\b/i
  ]),
  rule("gravel", "surface", 0.82, [
    /\b(?:gravel|chippings|aggregate\s*path|loose\s*aggregate|hoggin)\b/i
  ]),
  rule("sand", "surface", 0.8, [
    /\b(?:sand|sandy\s*surface|play\s*sand)\b/i
  ]),
  rule("grass", "surface", 0.82, [
    /\b(?:grass|turf|lawn)\b/i
  ]),
  rule("earth", "surface", 0.78, [
    /\b(?:earth|soil|topsoil|bare\s*ground|bare\s*earth|mud|earthworks\s*finish)\b/i
  ]),
  rule("weathered_asphalt", "surface", 0.72, [
    /\b(?:asphalt|tarmac|bitmac|macadam|bituminous\s*surfacing)\b/i
  ]),
  rule("steel", "structural", 0.78, [/\bsteel\b/i]),
  rule("glass", "structural", 0.78, [/\b(?:glass|glazing)\b/i]),
  rule("slate_roof", "roof", 0.82, [/\b(?:slate\s*roof|slate\s*tiles?|roof\s*slates?)\b/i]),
  rule("clay_tile_roof", "roof", 0.82, [/\b(?:clay\s*tiles?|roof\s*tiles?|clay\s*roof)\b/i]),
  rule("metal_roof", "roof", 0.82, [/\b(?:metal|zinc|aluminium|aluminum)\s*(?:roof|roofing|cladding|sheet(?:ing)?)\b/i])
];

const DEFAULT_LINE_TOLERANCE_PT = 3.5;
const DEFAULT_MAX_WINDOW_ITEMS = 4;
const DEFAULT_MAX_GAP_PT = 28;

/**
 * Converts raw planning drawing text into canonical material observations.
 * The recognizer is deterministic and deliberately conservative: it considers
 * only individual labels or short adjacent windows on the same drawing line.
 * It never joins text across separate lines/pages and never infers geometry.
 */
export function extractPlanningMaterialObservations(textItems, pageNumber = 1, contentHash = null, options = {}) {
  const items = normalizeItems(textItems);
  const observations = [];
  const windows = materialWindows(items, options);

  for (const window of windows) {
    const matches = classifyPlanningMaterialText(window.raw);
    for (const match of matches) {
      observations.push({
        contentHash,
        pageNumber,
        xPt: finiteOrNull(window.xPt),
        yPt: finiteOrNull(window.yPt),
        material: match.material,
        role: match.role,
        raw: window.raw,
        normalizedText: normalizeMaterialText(window.raw),
        confidence: roundConfidence(match.confidence * window.confidenceFactor),
        source: window.itemCount > 1 ? "pdf-text-material-window" : "pdf-text-material-label",
        evidenceItems: window.itemCount,
        evidenceItemIndices: [...window.itemIndices],
        georegistrationRequired: true
      });
    }
  }

  return dedupeMaterialObservations(observations);
}

/** Returns canonical material matches ordered from most specific to generic. */
export function classifyPlanningMaterialText(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const normalized = normalizeMaterialText(raw);
  const compact = normalized.replace(/\s+/g, "");
  const candidates = [];

  for (let ruleIndex = 0; ruleIndex < MATERIAL_RULES.length; ruleIndex += 1) {
    const entry = MATERIAL_RULES[ruleIndex];
    if (!entry.patterns.some((pattern) => pattern.test(normalized) || pattern.test(compact))) continue;
    if (candidates.some((candidate) => candidate.material === entry.material)) continue;
    candidates.push({
      material: entry.material,
      role: entry.role,
      confidence: entry.confidence,
      ruleIndex
    });
  }

  // Specific asphalt/concrete/paving rules suppress their generic fallback in
  // a single text window. A second pass below also suppresses weaker matches
  // produced by overlapping PDF text windows.
  const materials = new Set(candidates.map((entry) => entry.material));
  return candidates
    .filter((entry) => !(entry.material === "weathered_asphalt" && entry.confidence <= 0.72 && hasSpecificAsphalt(materials)))
    .filter((entry) => !(entry.material === "concrete" && materials.has("old_concrete")))
    .filter((entry) => !(entry.material === "stone" && materials.has("paving_stones") && /pav|flag|paver/i.test(normalized)))
    .sort((a, b) => b.confidence - a.confidence || a.ruleIndex - b.ruleIndex)
    .map(({ ruleIndex, ...entry }) => entry);
}

export function normalizeMaterialText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[,:;|]+/g, " ")
    .replace(/[_/]+/g, " ")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function materialWindows(items, options) {
  const lineTolerancePt = positive(options.materialLineTolerancePt, DEFAULT_LINE_TOLERANCE_PT);
  const maxWindowItems = Math.max(1, Math.min(8, Math.floor(positive(options.materialMaxWindowItems, DEFAULT_MAX_WINDOW_ITEMS))));
  const maxGapPt = positive(options.materialMaxGapPt, DEFAULT_MAX_GAP_PT);
  const lines = groupLines(items, lineTolerancePt);
  const result = [];

  for (const line of lines) {
    const ordered = [...line].sort((a, b) => finiteSort(a.xPt, b.xPt) || a.index - b.index);
    for (let start = 0; start < ordered.length; start += 1) {
      let raw = "";
      let previous = null;
      for (let end = start; end < ordered.length && end < start + maxWindowItems; end += 1) {
        const current = ordered[end];
        if (previous && !withinHorizontalGap(previous, current, maxGapPt)) break;
        raw = raw ? `${raw} ${current.text}` : current.text;
        const covered = ordered.slice(start, end + 1);
        result.push({
          raw,
          xPt: ordered[start].xPt,
          yPt: average(covered.map((entry) => entry.yPt)),
          itemCount: end - start + 1,
          itemIndices: covered.map((entry) => entry.index),
          confidenceFactor: end === start ? 1 : Math.max(0.88, 1 - 0.035 * (end - start))
        });
        previous = current;
      }
    }
  }
  return result;
}

function groupLines(items, tolerance) {
  const sorted = [...items].sort((a, b) => finiteSort(b.yPt, a.yPt) || finiteSort(a.xPt, b.xPt) || a.index - b.index);
  const lines = [];
  for (const item of sorted) {
    const line = lines.find((candidate) => Number.isFinite(item.yPt) && Number.isFinite(candidate.yPt) && Math.abs(item.yPt - candidate.yPt) <= tolerance);
    if (line) {
      line.items.push(item);
      line.yPt = average(line.items.map((entry) => entry.yPt));
    } else {
      lines.push({ yPt: item.yPt, items: [item] });
    }
  }
  return lines.map((line) => line.items);
}

function withinHorizontalGap(left, right, maxGapPt) {
  if (!Number.isFinite(left.xPt) || !Number.isFinite(right.xPt)) return false;
  const leftWidth = Number.isFinite(left.widthPt) ? Math.max(0, left.widthPt) : Math.max(4, left.text.length * ((left.fontSizePt || 8) * 0.45));
  const gap = right.xPt - (left.xPt + leftWidth);
  const adaptive = Math.max(maxGapPt, (left.fontSizePt || 0) * 2.2, (right.fontSizePt || 0) * 2.2);
  return gap <= adaptive && gap >= -Math.max(adaptive, leftWidth * 0.35);
}

function normalizeItems(values) {
  return (values || [])
    .map((item, index) => ({
      index,
      text: String(item?.text || item?.str || "").trim(),
      xPt: finiteOrNull(item?.xPt ?? item?.transform?.[4]),
      yPt: finiteOrNull(item?.yPt ?? item?.transform?.[5]),
      widthPt: finiteOrNull(item?.widthPt ?? item?.width),
      heightPt: finiteOrNull(item?.heightPt ?? item?.height),
      fontSizePt: finiteOrNull(item?.fontSizePt)
    }))
    .filter((item) => item.text);
}

function dedupeMaterialObservations(values) {
  const ordered = [...values].sort((a, b) =>
    Number(b.confidence || 0) - Number(a.confidence || 0) ||
    Number(b.evidenceItems || 0) - Number(a.evidenceItems || 0) ||
    finiteSort(a.xPt, b.xPt)
  );
  const result = [];
  const seen = new Set();

  for (const value of ordered) {
    const key = `${value.pageNumber}:${value.material}:${round(value.xPt, 1)}:${round(value.yPt, 1)}:${value.normalizedText}`;
    if (seen.has(key)) continue;
    if (result.some((accepted) => shadowsObservation(value, accepted))) continue;
    seen.add(key);
    result.push(value);
  }

  return result.sort((a, b) =>
    Number(a.pageNumber || 0) - Number(b.pageNumber || 0) ||
    finiteSort(b.yPt, a.yPt) ||
    finiteSort(a.xPt, b.xPt) ||
    Number(b.confidence || 0) - Number(a.confidence || 0)
  );
}

function shadowsObservation(candidate, accepted) {
  if (Number(candidate.pageNumber || 0) !== Number(accepted.pageNumber || 0)) return false;
  if (!overlappingEvidenceItems(candidate, accepted)) return false;

  // Same material from a shorter/weaker window is redundant.
  if (candidate.material === accepted.material && Number(candidate.confidence || 0) <= Number(accepted.confidence || 0)) return true;

  // A qualified asphalt label must beat a generic trailing `tarmac/asphalt`
  // token from the same PDF text run.
  if (candidate.material === "weathered_asphalt" && Number(candidate.confidence || 0) <= 0.72 &&
      ["red_tarmac", "fresh_black_asphalt", "light_asphalt"].includes(accepted.material)) return true;

  if (candidate.material === "concrete" && accepted.material === "old_concrete") return true;
  if (candidate.material === "stone" && accepted.material === "paving_stones") return true;
  if (candidate.material === "sand" && accepted.material === "resin_bound_beige") return true;
  return false;
}

function overlappingEvidenceItems(left, right) {
  const a = new Set(left.evidenceItemIndices || []);
  return (right.evidenceItemIndices || []).some((index) => a.has(index));
}

function hasSpecificAsphalt(materials) {
  return ["red_tarmac", "fresh_black_asphalt", "light_asphalt"].some((material) => materials.has(material));
}

function rule(material, role, confidence, patterns) {
  return { material, role, confidence, patterns };
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function average(values) {
  const numbers = values.map(Number).filter(Number.isFinite);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
}

function finiteSort(left, right) {
  if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
  if (Number.isFinite(left)) return -1;
  if (Number.isFinite(right)) return 1;
  return 0;
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

function roundConfidence(value) {
  return Math.max(0, Math.min(1, Math.round(Number(value || 0) * 1000) / 1000));
}
