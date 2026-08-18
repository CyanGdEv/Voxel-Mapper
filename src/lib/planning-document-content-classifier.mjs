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

/**
 * Conservatively upgrades an acquisition-time weak classification after PDF
 * text has actually been extracted. This never overrides an explicit strong
 * document class and never grants planning/current-state authority.
 */
export function reclassifyPlanningDocumentFromContent(extraction, acquisitionClassification = null) {
  if (!extraction) return { changed: false, classification: normalizeClass(acquisitionClassification), reason: "no-extraction" };
  const current = normalizeClass(extraction.classification || acquisitionClassification);
  if (!WEAK_CLASSES.has(current)) {
    return { changed: false, classification: current, confidence: 1, reason: "strong-acquisition-classification" };
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

function normalizeClass(value) {
  return String(value || "unknown").trim().toLowerCase().replace(/[\s-]+/g, "_");
}
