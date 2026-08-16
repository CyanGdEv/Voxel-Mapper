const RIDE_DRAWING_CLASSES = new Set(["ride_layout", "site_plan", "elevation", "section"]);
const PLAN_CLASSES = new Set(["ride_layout", "site_plan"]);
const TEMPLATE_CLASSES = new Set(["elevation", "section"]);
const DEFAULT_LABEL_RADIUS_PT = 90;
const DEFAULT_MAX_NEARBY_TEXT = 12;

/**
 * Adds ride-specific semantics to otherwise generic planning vectors while they
 * are still in PDF page space. This pass never grants spatial/temporal/world
 * authority. Its only job is to keep distinct ride components distinct so a
 * support brace, footing or sound enclosure cannot later masquerade as the
 * ride centreline simply because it came from a ride-layout drawing.
 *
 * Plan/site geometry remains eligible for the normal georegistration and
 * current-state gates. Section/elevation geometry is retained separately as a
 * non-spatial support/design template; it must never be treated as overhead
 * map geometry.
 */
export function enrichPlanningRideStructureEvidence(extraction, options = {}) {
  if (!extraction?.normalizedEvidence) return emptySummary("no-normalized-evidence");
  const candidates = extraction.normalizedEvidence.geometryCandidates || [];
  const pageIndex = new Map((extraction.pages || []).map((page) => [Number(page.pageNumber || 1), page]));
  const templates = [];
  const counts = {
    rideTrack: 0,
    rideSupport: 0,
    soundTunnel: 0,
    catwalk: 0,
    platform: 0,
    accessDetail: 0,
    stationOrBuilding: 0,
    templates: 0,
    unresolved: 0
  };

  for (const candidate of candidates) {
    const classification = normalizeClass(candidate.classification);
    if (!RIDE_DRAWING_CLASSES.has(classification)) continue;
    const page = pageIndex.get(Number(candidate.pageNumber || 1));
    const vector = page?.vector?.paths?.[candidate.vectorPathIndex] || null;
    const nearby = nearbyTextForCandidate(candidate, page?.text?.items || [], options);
    const joined = nearby.map((entry) => entry.text).join(" ");
    const classificationResult = classifyRideStructureText(joined, {
      closed: Boolean(candidate.closed),
      classification,
      vector
    });
    if (!classificationResult) {
      counts.unresolved += 1;
      continue;
    }

    const supportCode = extractSupportCode(nearby, classificationResult);
    const explicitHeightM = extractExplicitHeightM(joined);
    const evidence = {
      schemaVersion: 1,
      role: classificationResult.role,
      subtype: classificationResult.subtype,
      supportCode,
      nearbyText: nearby.map((entry) => entry.text).slice(0, 8),
      confidence: classificationResult.confidence,
      source: "planning-pdf-ride-structure-semantic-enrichment",
      terrainGeometryMutable: false,
      terrainElevationMutable: false,
      worldGeometryAuthority: false
    };

    // Section/elevation linework is a side view, not plan geometry. Keep it as
    // a template that can later be linked to an authoritative plan-view anchor
    // by an exact support/design code, but do not feed it to map reconciliation.
    if (TEMPLATE_CLASSES.has(classification)) {
      templates.push(buildTemplate(candidate, vector, evidence, page, explicitHeightM));
      candidate.rideStructureTemplateOnly = true;
      candidate.spatialAuthorityEligible = false;
      candidate.worldGeometryAuthority = false;
      candidate.semantic = `ride-structure-template-${classificationResult.subtype}`;
      candidate.rideStructureEvidence = evidence;
      counts.templates += 1;
      continue;
    }

    if (!PLAN_CLASSES.has(classification)) continue;
    const tags = {
      ...(candidate.tags || candidate.properties?.tags || {}),
      "ride_structure:type": classificationResult.subtype,
      "ride_structure:source": "planning-pdf",
      "terrain:geometry_mutable": "no"
    };
    if (supportCode) tags["ride_structure:support_code"] = supportCode;
    if (classificationResult.enclosure) tags["ride_structure:enclosure"] = "yes";
    if (classificationResult.soundTunnel) tags["ride_structure:sound_tunnel"] = "yes";

    candidate.kind = classificationResult.kind;
    candidate.featureKind = classificationResult.kind;
    candidate.subtype = classificationResult.subtype;
    candidate.semantic = classificationResult.semantic;
    candidate.tags = tags;
    candidate.properties = {
      ...(candidate.properties || {}),
      kind: classificationResult.kind,
      subtype: classificationResult.subtype,
      tags,
      ...(explicitHeightM != null ? { height_m: explicitHeightM } : {})
    };
    if (explicitHeightM != null) candidate.heightM = explicitHeightM;
    candidate.rideStructureEvidence = evidence;
    candidate.confidence = Math.max(Number(candidate.confidence || 0), classificationResult.confidence);

    if (classificationResult.kind === "ride_track") counts.rideTrack += 1;
    else if (classificationResult.kind === "ride_support") counts.rideSupport += 1;
    else if (classificationResult.subtype === "sound_tunnel") counts.soundTunnel += 1;
    else if (classificationResult.subtype === "ride_catwalk") counts.catwalk += 1;
    else if (classificationResult.subtype === "ride_platform") counts.platform += 1;
    else if (classificationResult.subtype === "ride_access_detail") counts.accessDetail += 1;
    else counts.stationOrBuilding += 1;
  }

  // Template-only candidates must not enter the map-geometry compiler. Their
  // commands are preserved once in rideStructureTemplates instead.
  extraction.normalizedEvidence.geometryCandidates = candidates.filter((candidate) => !candidate.rideStructureTemplateOnly);
  extraction.normalizedEvidence.rideStructureTemplates = dedupeTemplates([
    ...(extraction.normalizedEvidence.rideStructureTemplates || []),
    ...templates
  ]);
  extraction.rideStructureExtraction = {
    schemaVersion: 1,
    status: Object.values(counts).some(Boolean) ? "enriched" : "no-ride-structure-semantics",
    counts,
    templateCount: extraction.normalizedEvidence.rideStructureTemplates.length,
    policy: {
      planGeometryRequiresGeoregistration: true,
      templateGeometryIsNeverMapGeometry: true,
      temporalCurrentStateStillRequired: true,
      terrainGeometryMutable: false,
      inferredSupportsAreFallbackOnly: true
    }
  };
  return extraction.rideStructureExtraction;
}

export function classifyRideStructureText(value, context = {}) {
  const text = normalizeText(value);
  if (!text) return null;

  // Enclosures first: generic "tunnel" must not collapse a built sound/noise
  // structure into the terrain-tunnel semantics used by the ride profile.
  if (/\b(sound|acoustic|noise)\s+(attenuation\s+)?(tunnel|enclosure|housing)\b|\b(themed|theme)\s+(tunnel|enclosure)\b|\bsound\s*proof(?:ed|ing)?\s+(tunnel|enclosure)\b/.test(text)) {
    return result("structure", "sound_tunnel", "ride-sound-tunnel-enclosure", 0.99, { enclosure: true, soundTunnel: true });
  }
  if (/\b(ride|track)\s+enclosure\b|\benclosed\s+(track|ride)\b/.test(text)) {
    return result("structure", "ride_enclosure", "ride-track-enclosure", 0.96, { enclosure: true });
  }

  if (/\b(pad\s+foundation|pad\s+footing|footing|footer|pile\s+cap|base\s+plate|foundation\s+pad)\b/.test(text)) {
    return result("ride_support", "support_footing", "ride-support-footing", 0.99);
  }
  if (/\b(cross\s*brace|diagonal\s+brace|bracing|brace|tie\s+member)\b/.test(text)) {
    return result("ride_support", "support_brace", "ride-support-brace", 0.98);
  }
  if (/\b(portal\s+frame|support\s+frame|support\s+bent|bent\s+frame|trestle|support\s+gantry)\b/.test(text)) {
    return result("ride_support", "support_frame", "ride-support-frame", 0.99);
  }
  if (/\b(support\s+column|support\s+post|support\s+pier|column\s+support|upright\s+support|ride\s+support)\b/.test(text)) {
    return result("ride_support", "support_column", "ride-support-column", 0.99);
  }
  // "support" by itself is accepted only on ride drawings and only after the
  // more specific support types above have had a chance to classify it.
  if (context.classification === "ride_layout" && /\bsupports?\b/.test(text)) {
    return result("ride_support", context.closed ? "support_footprint" : "support_member", "ride-support-member", 0.94);
  }

  if (/\b(catwalk|maintenance\s+walkway|track\s+walkway|evacuation\s+walkway)\b/.test(text)) {
    return result("structure", "ride_catwalk", "ride-catwalk", 0.98);
  }
  if (/\b(maintenance\s+platform|access\s+platform|service\s+platform|operator\s+platform)\b/.test(text)) {
    return result("structure", "ride_platform", "ride-maintenance-platform", 0.97);
  }
  if (/\b(access\s+stair|staircase|stairs?|ladder|handrail|guardrail|balustrade)\b/.test(text)) {
    return result("structure", "ride_access_detail", "ride-access-detail", 0.94);
  }
  if (/\b(ride\s+station|station\s+building|maintenance\s+building|maintenance\s+shed|ride\s+building)\b/.test(text)) {
    return result("structure", "ride_building", "ride-building-structure", 0.96);
  }

  if (/\b(track\s+centre\s*line|track\s+center\s*line|ride\s+centre\s*line|ride\s+center\s*line|track\s+layout|ride\s+track|running\s+rail)\b/.test(text)) {
    return result("ride_track", "ride_track_centerline", "ride-track-centerline", 0.99);
  }
  return null;
}

export function extractSupportCode(textItems, classification = null) {
  const texts = Array.isArray(textItems) ? textItems.map((entry) => typeof entry === "string" ? entry : entry?.text) : [textItems];
  const combined = texts.filter(Boolean).join(" ");
  const specific = combined.match(/\b(?:SUP(?:PORT)?|FRAME|BENT|COLUMN|COL|FOOTING|FTG)\s*[-:#]?\s*([A-Z]{0,2}\d{1,3}[A-Z]?)\b/i);
  if (specific) return normalizeCode(`${specific[0].match(/^[A-Za-z]+/)?.[0] || "S"}-${specific[1]}`);
  if (classification?.kind !== "ride_support") return null;
  const short = combined.match(/\b(S|SUP|F|B|C)\s*[-]?\s*(\d{1,3}[A-Z]?)\b/i);
  return short ? normalizeCode(`${short[1]}-${short[2]}`) : null;
}

function nearbyTextForCandidate(candidate, items, options) {
  const radius = finite(options.rideStructureLabelRadiusPt, DEFAULT_LABEL_RADIUS_PT);
  const max = Math.max(1, Math.floor(finite(options.maxRideStructureNearbyText, DEFAULT_MAX_NEARBY_TEXT)));
  const bounds = candidate.boundsPt;
  if (!bounds) return [];
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const ranked = [];
  for (const item of items || []) {
    const x = Number(item.xPt), y = Number(item.yPt);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const dx = x < bounds.minX ? bounds.minX - x : x > bounds.maxX ? x - bounds.maxX : 0;
    const dy = y < bounds.minY ? bounds.minY - y : y > bounds.maxY ? y - bounds.maxY : 0;
    const edgeDistance = Math.hypot(dx, dy);
    const centerDistance = Math.hypot(x - cx, y - cy);
    if (edgeDistance > radius) continue;
    ranked.push({ ...item, edgeDistance, centerDistance });
  }
  ranked.sort((a, b) => a.edgeDistance - b.edgeDistance || a.centerDistance - b.centerDistance || String(a.text).localeCompare(String(b.text)));
  return ranked.slice(0, max);
}

function buildTemplate(candidate, vector, evidence, page, explicitHeightM) {
  return {
    id: `${candidate.id}:template`,
    contentHash: candidate.contentHash || null,
    pageNumber: candidate.pageNumber || 1,
    classification: normalizeClass(candidate.classification),
    component: evidence.subtype,
    supportCode: evidence.supportCode || null,
    commands: candidate.commands || vector?.commands || [],
    boundsPt: candidate.boundsPt || vector?.bounds || null,
    paint: candidate.paint || vector?.paint || null,
    lineWidthPt: vector?.lineWidthPt ?? null,
    strokeColor: vector?.strokeColor || null,
    fillColor: vector?.fillColor || null,
    dash: vector?.dash || [],
    explicitHeightM,
    scaleDenominator: page?.metadata?.scaleDenominator ?? null,
    nearbyText: evidence.nearbyText,
    confidence: evidence.confidence,
    coordinateSpace: "pdf-template-space",
    spatialAuthorityEligible: false,
    worldGeometryAuthority: false,
    temporalResolutionRequired: true,
    linkageRequired: true,
    source: "planning-pdf-ride-structure-template"
  };
}

function extractExplicitHeightM(text) {
  const match = String(text || "").match(/\b(?:height|ht\.?|overall\s+height)\s*[:=]?\s*([0-9]{1,3}(?:\.[0-9]{1,3})?)\s*m\b/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 && value < 250 ? value : null;
}

function result(kind, subtype, semantic, confidence, extra = {}) {
  return { role: kind === "ride_track" ? "track" : kind === "ride_support" ? "support" : "structure", kind, subtype, semantic, confidence, ...extra };
}

function normalizeClass(value) { return String(value || "unknown").toLowerCase().trim().replace(/[\s-]+/g, "_"); }
function normalizeText(value) { return String(value || "").toLowerCase().replace(/[_/]+/g, " ").replace(/[^a-z0-9.:-]+/g, " ").replace(/\s+/g, " ").trim(); }
function normalizeCode(value) { return String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || null; }
function finite(value, fallback) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
function dedupeTemplates(values) {
  const seen = new Set();
  return (values || []).filter((entry) => {
    const key = entry.id || `${entry.contentHash}:${entry.pageNumber}:${entry.component}:${entry.supportCode || ""}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
function emptySummary(status) { return { schemaVersion: 1, status, counts: {}, templateCount: 0 }; }
