const WEAK_CLASSES = new Set(["unknown", "supporting"]);

const RULES = Object.freeze([
  {
    classification: "ride_layout",
    confidence: 0.99,
    patterns: [
      /\b(?:roller\s+coaster|coaster|ride)\s+(?:track\s+)?layout\b/i,
      /\b(?:track|ride)\s+(?:centre|center)\s*line\b/i,
      /\b(?:roller\s+coaster|coaster|ride)\s+track\s+plan\b/i,
      /\btrack\s+layout\s+(?:plan|drawing)\b/i,
      /\brunning\s+rail(?:s)?\b/i
    ]
  },
  {
    classification: "section",
    confidence: 0.96,
    patterns: [
      /\b(?:roller\s+coaster|coaster|ride|track)\s+(?:longitudinal\s+|cross\s+)?section(?:s)?\b/i,
      /\b(?:longitudinal|track)\s+section(?:s)?\b/i,
      /\bsection\s+[a-z0-9]+[-–—][a-z0-9]+\b/i
    ]
  },
  {
    classification: "elevation",
    confidence: 0.95,
    patterns: [
      /\b(?:roller\s+coaster|coaster|ride|track)\s+elevation(?:s)?\b/i,
      /\b(?:north|south|east|west|front|rear|side)\s+elevation(?:s)?\b/i,
      /\belevation\s+drawing(?:s)?\b/i
    ]
  },
  {
    classification: "landscape_plan",
    confidence: 0.94,
    patterns: [
      /\b(?:hard|soft)\s+landscape\s+(?:plan|layout)\b/i,
      /\blandscape\s+(?:site\s+)?plan\b/i,
      /\bplanting\s+plan\b/i
    ]
  },
  {
    classification: "site_plan",
    confidence: 0.93,
    patterns: [
      /\bproposed\s+site\s+plan\b/i,
      /\bgeneral\s+arrangement\s+(?:plan|drawing)\b/i,
      /\bmaster\s*plan\b/i
    ]
  }
]);

const RIDE_LEVEL_PATTERNS = Object.freeze([
  /\b(track\s+level|track\s+r\.?l\.?|top\s+of\s+rail|rail\s+level|tor)\s*[:=]?\s*([+-]?\d{1,4}(?:\.\d{1,4})?)\s*m?\s*aod\b/ig,
  /\b([+-]?\d{1,4}(?:\.\d{1,4})?)\s*m?\s*aod\s*(track\s+level|track\s+r\.?l\.?|top\s+of\s+rail|rail\s+level|tor)\b/ig
]);

/**
 * Conservatively upgrades an acquisition-time weak classification after PDF
 * text has actually been extracted. This never overrides an explicit strong
 * document class and never grants planning/current-state authority.
 */
export function reclassifyPlanningDocumentFromContent(extraction, acquisitionClassification = null) {
  if (!extraction) return { changed: false, classification: normalizeClass(acquisitionClassification), reason: "no-extraction" };
  const current = normalizeClass(extraction.classification || acquisitionClassification);
  if (!WEAK_CLASSES.has(current)) {
    const rideLevelObservationsAdded = current === "ride_layout" ? enrichRideLevelObservations(extraction) : 0;
    return {
      changed: false,
      classification: current,
      confidence: 1,
      reason: "strong-acquisition-classification",
      rideLevelObservationsAdded
    };
  }

  const pages = (extraction.pages || []).map((page) => ({
    pageNumber: Number(page?.pageNumber || 1),
    text: pageText(page),
    titleText: titleLikeText(page)
  }));
  let best = null;
  for (const page of pages) {
    for (const rule of RULES) {
      const evidence = matchRule(rule, page);
      if (!evidence) continue;
      const candidate = {
        classification: rule.classification,
        confidence: evidence.titleLike ? rule.confidence : Math.max(0.88, rule.confidence - 0.05),
        pageNumber: page.pageNumber,
        matchedText: evidence.text,
        titleLike: evidence.titleLike
      };
      if (!best || candidate.confidence > best.confidence) best = candidate;
    }
  }

  if (!best) return { changed: false, classification: current, confidence: 0, reason: "no-strong-content-signal" };
  extraction.acquisitionClassification = current;
  extraction.classification = best.classification;
  extraction.contentClassification = {
    schemaVersion: 1,
    method: "extracted-pdf-text-strong-signal",
    previousClassification: current,
    classification: best.classification,
    confidence: best.confidence,
    pageNumber: best.pageNumber,
    titleLike: best.titleLike,
    matchedText: best.matchedText.slice(0, 180),
    authorityGranted: false
  };
  propagateClassification(extraction, best.classification);
  const rideLevelObservationsAdded = best.classification === "ride_layout" ? enrichRideLevelObservations(extraction) : 0;
  extraction.contentClassification.rideLevelObservationsAdded = rideLevelObservationsAdded;
  return { changed: true, ...extraction.contentClassification };
}

function matchRule(rule, page) {
  for (const pattern of rule.patterns) {
    const titleMatch = page.titleText.match(pattern);
    if (titleMatch) return { titleLike: true, text: titleMatch[0] };
  }
  // Ride layout is deliberately stricter in body text. A report merely saying
  // “roller coaster” must not become map geometry; require a track-specific
  // engineering phrase and vector drawing content.
  if (rule.classification !== "ride_layout") return null;
  for (const pattern of rule.patterns) {
    const match = page.text.match(pattern);
    if (match) return { titleLike: false, text: match[0] };
  }
  return null;
}

function enrichRideLevelObservations(extraction) {
  extraction.normalizedEvidence ||= {};
  const existing = extraction.normalizedEvidence.verticalObservations || [];
  const additions = [];
  for (const page of extraction.pages || []) {
    for (const item of page?.text?.items || []) {
      const raw = String(item?.text ?? item?.str ?? "").trim();
      if (!raw) continue;
      for (const pattern of RIDE_LEVEL_PATTERNS) {
        pattern.lastIndex = 0;
        for (const match of raw.matchAll(pattern)) {
          const forward = /^(?:track|top|rail|tor)/i.test(String(match[1] || ""));
          const labelRaw = forward ? match[1] : match[2];
          const valueRaw = forward ? match[2] : match[1];
          const valueM = Number(valueRaw);
          if (!Number.isFinite(valueM)) continue;
          additions.push({
            contentHash: extraction.contentHash || null,
            pageNumber: Number(page?.pageNumber || 1),
            xPt: finiteOrNull(item?.xPt ?? item?.x),
            yPt: finiteOrNull(item?.yPt ?? item?.y),
            label: normalizeRideLevelLabel(labelRaw),
            valueM,
            datum: "AOD",
            raw: match[0],
            confidence: 0.95,
            source: "pdf-text-explicit-ride-level-aod",
            classification: "ride_layout",
            georegistrationRequired: true,
            worldGeometryAuthority: false
          });
        }
      }
    }
  }
  extraction.normalizedEvidence.verticalObservations = dedupeVerticalObservations([...existing, ...additions]);
  return Math.max(0, extraction.normalizedEvidence.verticalObservations.length - existing.length);
}

function pageText(page) {
  return (page?.text?.items || []).map((item) => String(item?.text ?? item?.str ?? "").trim()).filter(Boolean).join(" ");
}

function titleLikeText(page) {
  const items = (page?.text?.items || []).filter((item) => String(item?.text ?? item?.str ?? "").trim());
  if (!items.length) return "";
  const height = Number(page?.heightPt || 0);
  const width = Number(page?.widthPt || 0);
  const titleCandidates = items.filter((item) => {
    const x = Number(item?.xPt ?? item?.x ?? NaN);
    const y = Number(item?.yPt ?? item?.y ?? NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !width || !height) return false;
    // CAD title blocks are commonly along the lower/right margins. Also retain
    // unusually large text when the extractor exposes font height/size.
    const size = Number(item?.fontSizePt ?? item?.height ?? item?.fontSize ?? 0);
    return x >= width * 0.58 || y <= height * 0.22 || y >= height * 0.78 || size >= 12;
  });
  const selected = titleCandidates.length ? titleCandidates : items.slice(0, Math.min(30, items.length));
  return selected.map((item) => String(item?.text ?? item?.str ?? "")).join(" ");
}

function propagateClassification(extraction, classification) {
  for (const candidate of extraction?.normalizedEvidence?.geometryCandidates || []) candidate.classification = classification;
  for (const observation of extraction?.normalizedEvidence?.verticalObservations || []) observation.classification = classification;
  for (const observation of extraction?.normalizedEvidence?.materialObservations || []) observation.classification = classification;
  for (const metadata of extraction?.normalizedEvidence?.drawingMetadata || []) metadata.classification = classification;
  for (const page of extraction?.pages || []) {
    if (page?.metadata) page.metadata.classification = classification;
  }
}

function dedupeVerticalObservations(values) {
  const byKey = new Map();
  for (const entry of values || []) {
    const key = `${entry.contentHash || ""}:${entry.pageNumber || 1}:${round(entry.xPt, 1)}:${round(entry.yPt, 1)}:${String(entry.label || "").toUpperCase()}:${round(entry.valueM, 3)}`;
    const previous = byKey.get(key);
    if (!previous || Number(entry.confidence || 0) > Number(previous.confidence || 0)) byKey.set(key, entry);
  }
  return [...byKey.values()];
}

function normalizeRideLevelLabel(value) {
  const text = String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
  if (/^TOR$/.test(text)) return "TOR";
  if (/TOP OF RAIL/.test(text)) return "TOP OF RAIL";
  if (/RAIL LEVEL/.test(text)) return "RAIL LEVEL";
  if (/TRACK\s+R\.?L\.?/.test(text)) return "TRACK RL";
  return "TRACK LEVEL";
}

function finiteOrNull(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function round(value, places = 3) { const number = Number(value); if (!Number.isFinite(number)) return null; const factor = 10 ** places; return Math.round(number * factor) / factor; }
function normalizeClass(value) {
  return String(value || "unknown").trim().toLowerCase().replace(/[\s-]+/g, "_");
}
