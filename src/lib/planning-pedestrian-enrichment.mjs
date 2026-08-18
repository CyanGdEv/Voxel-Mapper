const ELIGIBLE_CLASSES = new Set(["site_plan", "landscape_plan"]);
const DEFAULT_LABEL_RADIUS_PT = 55;
const DEFAULT_MAX_NEARBY_TEXT = 8;

const PEDESTRIAN_AREA = /\b(plaza|forecourt|concourse|courtyard|public\s+realm|pedestrian\s+(?:area|zone|space)|paved\s+(?:area|zone|space)|hardstanding|terrace)\b/i;
const PEDESTRIAN_ROUTE = /\b(footpath|footway|walkway|pedestrian\s+(?:route|path)|access\s+path|entrance\s+path|exit\s+path|queue\s+(?:line|path|route)|queueing\s+area)\b/i;
const ROAD_ROUTE = /\b(service\s+road|access\s+road|carriageway|roadway|vehicular\s+access)\b/i;

/**
 * Adds conservative path/plaza semantics while PDF page text and vector bounds
 * are still available. The pass does not grant authority: it only tells the
 * later current-state compiler what a labelled site/landscape shape represents.
 */
export function enrichPlanningPedestrianEvidence(extraction, options = {}) {
  const candidates = extraction?.normalizedEvidence?.geometryCandidates || [];
  const pages = new Map((extraction?.pages || []).map((page) => [Number(page?.pageNumber || 1), page]));
  const counts = { path: 0, plaza: 0, road: 0, ambiguous: 0, unlabeled: 0 };
  const matches = [];

  for (const candidate of candidates) {
    const classification = normalizeClass(candidate?.classification);
    if (!ELIGIBLE_CLASSES.has(classification)) continue;
    if (candidate.kind || candidate.featureKind || candidate.rideStructureEvidence) continue;
    const page = pages.get(Number(candidate.pageNumber || 1));
    const nearby = nearbyText(candidate, page?.text?.items || [], options);
    if (!nearby.length) { counts.unlabeled += 1; continue; }
    const text = nearby.map((entry) => entry.text).join(" ");
    const hits = [];
    if (ROAD_ROUTE.test(text)) hits.push({ kind: "road", subtype: "planning_access_road", semantic: "site-edge-or-route", confidence: 0.96 });
    if (PEDESTRIAN_AREA.test(text)) hits.push({ kind: "path", subtype: "pedestrian_plaza", semantic: "site-feature-or-building-footprint", confidence: 0.97, area: true });
    if (PEDESTRIAN_ROUTE.test(text)) hits.push({ kind: "path", subtype: "pedestrian_route", semantic: candidate.closed ? "site-feature-or-building-footprint" : "site-edge-or-route", confidence: 0.96 });
    const uniqueKinds = new Set(hits.map((hit) => hit.kind));
    if (!hits.length) { counts.unlabeled += 1; continue; }
    if (uniqueKinds.size > 1) { counts.ambiguous += 1; continue; }
    const winner = hits.sort((a, b) => b.confidence - a.confidence)[0];
    if (winner.area && candidate.closed !== true) {
      counts.ambiguous += 1;
      continue;
    }
    applyPedestrianSemantic(candidate, winner, nearby);
    counts[winner.kind === "road" ? "road" : winner.subtype === "pedestrian_plaza" ? "plaza" : "path"] += 1;
    matches.push({
      candidateId: candidate.id || null,
      pageNumber: candidate.pageNumber || 1,
      kind: winner.kind,
      subtype: winner.subtype,
      confidence: winner.confidence,
      nearbyText: nearby.map((entry) => entry.text).slice(0, 5)
    });
  }

  const summary = {
    schemaVersion: 1,
    status: counts.path + counts.plaza + counts.road ? "enriched" : "no-pedestrian-semantics",
    counts,
    matches: matches.slice(0, Math.max(1, Number(options.maxPlanningPedestrianQaMatches || 250))),
    policy: {
      eligibleClasses: [...ELIGIBLE_CLASSES],
      nearbyLabelRequired: true,
      plazaRequiresClosedGeometry: true,
      ambiguousRoadPedestrianLabelsFailClosed: true,
      authorityGranted: false,
      terrainGeometryMutable: false,
      terrainElevationMutable: false
    }
  };
  extraction.pedestrianExtraction = summary;
  return summary;
}

function applyPedestrianSemantic(candidate, result, nearby) {
  const tags = {
    ...(candidate.tags || candidate.properties?.tags || {}),
    "planning:pedestrian_semantic": result.subtype,
    "terrain:geometry_mutable": "no"
  };
  candidate.kind = result.kind;
  candidate.featureKind = result.kind;
  candidate.subtype = result.subtype;
  candidate.semantic = result.semantic;
  candidate.tags = tags;
  candidate.label = nearby[0]?.text || candidate.label || null;
  candidate.properties = {
    ...(candidate.properties || {}),
    kind: result.kind,
    subtype: result.subtype,
    label: candidate.label,
    tags
  };
  candidate.confidence = Math.max(Number(candidate.confidence || 0), result.confidence);
  candidate.pedestrianEvidence = {
    schemaVersion: 1,
    source: "planning-pdf-nearby-pedestrian-label",
    confidence: result.confidence,
    nearbyText: nearby.map((entry) => entry.text).slice(0, 8),
    worldGeometryAuthority: false,
    georegistrationRequired: true,
    temporalResolutionRequired: true,
    terrainGeometryMutable: false,
    terrainElevationMutable: false
  };
}

function nearbyText(candidate, items, options) {
  const bounds = candidate?.boundsPt;
  if (!bounds) return [];
  const radius = Math.max(5, Number(options.planningPedestrianLabelRadiusPt) || DEFAULT_LABEL_RADIUS_PT);
  const limit = Math.max(1, Math.floor(Number(options.maxPlanningPedestrianNearbyText) || DEFAULT_MAX_NEARBY_TEXT));
  const cx = (Number(bounds.minX) + Number(bounds.maxX)) / 2;
  const cy = (Number(bounds.minY) + Number(bounds.maxY)) / 2;
  const values = [];
  for (const item of items || []) {
    const text = String(item?.text || "").trim();
    const x = Number(item?.xPt), y = Number(item?.yPt);
    if (!text || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const dx = x < bounds.minX ? bounds.minX - x : x > bounds.maxX ? x - bounds.maxX : 0;
    const dy = y < bounds.minY ? bounds.minY - y : y > bounds.maxY ? y - bounds.maxY : 0;
    const edgeDistance = Math.hypot(dx, dy);
    if (edgeDistance > radius) continue;
    values.push({ text, edgeDistance, centerDistance: Math.hypot(x - cx, y - cy) });
  }
  values.sort((a, b) => a.edgeDistance - b.edgeDistance || a.centerDistance - b.centerDistance || a.text.localeCompare(b.text));
  return values.slice(0, limit);
}

function normalizeClass(value) { return String(value || "unknown").trim().toLowerCase().replace(/[\s-]+/g, "_"); }
