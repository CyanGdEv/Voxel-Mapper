const ELIGIBLE_CLASSES = new Set(["site_plan", "landscape_plan", "ride_layout"]);
const DEFAULT_LABEL_RADIUS_PT = 55;
const DEFAULT_MAX_NEARBY_TEXT = 8;

const PEDESTRIAN_AREA = /\b(plaza|forecourt|concourse|courtyard|public\s+realm|pedestrian\s+(?:area|zone|space)|paved\s+(?:area|zone|space)|hardstanding|terrace)\b/i;
const PEDESTRIAN_ROUTE = /\b(footpath|footway|walkway|pedestrian\s+(?:route|path)|access\s+path|entrance\s+path|exit\s+path|queue\s+(?:line|path|route)|queueing\s+area)\b/i;
const ROAD_ROUTE = /\b(service\s+road|access\s+road|carriageway|roadway|vehicular\s+access)\b/i;
const PARKING_AREA = /\b(car\s+park|parking\s+(?:area|court|zone)|staff\s+parking|visitor\s+parking|coach\s+park)\b/i;
const PARKING_BAY = /\b(parking\s+(?:bay|space)|car\s+parking\s+space|disabled\s+(?:parking\s+)?bay|accessible\s+(?:parking\s+)?bay|coach\s+bay|ev\s+bay|electric\s+vehicle\s+bay|charging\s+bay)\b/i;
const PARKING_AISLE = /\b(parking\s+aisle|circulation\s+aisle|vehicle\s+aisle)\b/i;
const PARKING_ISLAND = /\b(parking\s+island|car\s+park\s+island|landscape\s+island)\b/i;

/**
 * Adds conservative path/plaza/parking semantics while PDF page text and vector
 * bounds are still available. The pass does not grant authority: it only tells
 * the later current-state compiler what a labelled shape means.
 *
 * Ride-layout sheets are intentionally narrower than site/landscape plans. An
 * otherwise unclassified CLOSED vector may become a pedestrian plaza only when
 * a nearby explicit plaza/forecourt/etc label exists. Generic ride linework,
 * queue wording, track/support geometry and open routes remain untouched.
 */
export function enrichPlanningPedestrianEvidence(extraction, options = {}) {
  const candidates = extraction?.normalizedEvidence?.geometryCandidates || [];
  const pages = new Map((extraction?.pages || []).map((page) => [Number(page?.pageNumber || 1), page]));
  const counts = {
    path: 0, plaza: 0, road: 0,
    parkingArea: 0, parkingBay: 0, parkingAisle: 0, parkingIsland: 0,
    ambiguous: 0, unlabeled: 0
  };
  const matches = [];

  for (const candidate of candidates) {
    const classification = normalizeClass(candidate?.classification);
    if (!ELIGIBLE_CLASSES.has(classification)) continue;
    if (candidate.kind || candidate.featureKind || candidate.rideStructureEvidence) continue;
    const page = pages.get(Number(candidate.pageNumber || 1));
    const nearby = nearbyText(candidate, page?.text?.items || [], options);
    if (!nearby.length) { counts.unlabeled += 1; continue; }
    const text = nearby.map((entry) => entry.text).join(" ");

    if (classification === "ride_layout") {
      if (candidate.closed !== true || !PEDESTRIAN_AREA.test(text)) {
        counts.unlabeled += 1;
        continue;
      }
      const winner = { kind: "path", subtype: "pedestrian_plaza", semantic: "site-feature", confidence: 0.97, area: true };
      applyPedestrianSemantic(candidate, winner, nearby, "planning-pdf-explicit-ride-layout-plaza-label");
      counts.plaza += 1;
      matches.push(matchRecord(candidate, winner, nearby));
      continue;
    }

    // Parking-specific labels win over generic words such as "access road" or
    // "hardstanding" when both occur around the same parking geometry.
    const parkingHits = [];
    if (PARKING_AISLE.test(text)) parkingHits.push({ kind: "road", subtype: "parking_aisle", semantic: "site-route", confidence: 0.97, parkingRole: "aisle" });
    if (PARKING_BAY.test(text)) parkingHits.push({ kind: "surface", subtype: parkingBaySubtype(text), semantic: "site-feature", confidence: 0.97, area: true, parkingRole: "bay" });
    if (PARKING_ISLAND.test(text)) parkingHits.push({ kind: "surface", subtype: "parking_island", semantic: "site-feature", confidence: 0.96, area: true, parkingRole: "island" });
    if (PARKING_AREA.test(text)) parkingHits.push({ kind: "road", subtype: /coach\s+park/i.test(text) ? "coach_park" : "parking_area", semantic: "site-feature", confidence: 0.98, area: true, parkingRole: "area" });

    const hits = parkingHits.length ? parkingHits : [];
    if (!parkingHits.length) {
      if (ROAD_ROUTE.test(text)) hits.push({ kind: "road", subtype: "planning_access_road", semantic: "site-route", confidence: 0.96 });
      if (PEDESTRIAN_AREA.test(text)) hits.push({ kind: "path", subtype: "pedestrian_plaza", semantic: "site-feature", confidence: 0.97, area: true });
      if (PEDESTRIAN_ROUTE.test(text)) hits.push({ kind: "path", subtype: "pedestrian_route", semantic: candidate.closed ? "site-feature" : "site-route", confidence: 0.96 });
    }

    const uniqueKinds = new Set(hits.map((hit) => hit.kind));
    if (!hits.length) { counts.unlabeled += 1; continue; }
    if (uniqueKinds.size > 1 && !parkingHits.length) { counts.ambiguous += 1; continue; }
    const winner = hits.sort((a, b) => b.confidence - a.confidence)[0];
    if (winner.area && candidate.closed !== true) {
      counts.ambiguous += 1;
      continue;
    }
    applyPedestrianSemantic(candidate, winner, nearby);
    if (winner.parkingRole === "area") counts.parkingArea += 1;
    else if (winner.parkingRole === "bay") counts.parkingBay += 1;
    else if (winner.parkingRole === "aisle") counts.parkingAisle += 1;
    else if (winner.parkingRole === "island") counts.parkingIsland += 1;
    else counts[winner.kind === "road" ? "road" : winner.subtype === "pedestrian_plaza" ? "plaza" : "path"] += 1;
    matches.push(matchRecord(candidate, winner, nearby));
  }

  const enrichedCount = counts.path + counts.plaza + counts.road + counts.parkingArea + counts.parkingBay + counts.parkingAisle + counts.parkingIsland;
  const summary = {
    schemaVersion: 3,
    status: enrichedCount ? "enriched" : "no-pedestrian-or-parking-semantics",
    counts,
    matches: matches.slice(0, Math.max(1, Number(options.maxPlanningPedestrianQaMatches || 250))),
    policy: {
      eligibleClasses: [...ELIGIBLE_CLASSES],
      nearbyLabelRequired: true,
      plazaRequiresClosedGeometry: true,
      rideLayoutClosedPlazaRequiresExplicitAreaLabel: true,
      rideLayoutOpenRoutesRetyped: false,
      parkingAreaRequiresClosedGeometry: true,
      parkingBayRequiresClosedGeometry: true,
      parkingBayGridInferenceAllowed: false,
      ambiguousRoadPedestrianLabelsFailClosed: true,
      authorityGranted: false,
      terrainGeometryMutable: false,
      terrainElevationMutable: false
    }
  };
  extraction.pedestrianExtraction = summary;
  return summary;
}

function applyPedestrianSemantic(candidate, result, nearby, sourceOverride = null) {
  const tags = {
    ...(candidate.tags || candidate.properties?.tags || {}),
    "planning:pedestrian_semantic": result.subtype,
    "terrain:geometry_mutable": "no"
  };
  if (result.kind === "path" && result.subtype === "pedestrian_plaza") {
    tags.highway = "pedestrian";
    tags["area:highway"] = "pedestrian";
    tags.area = "yes";
  }
  if (result.parkingRole) {
    tags["planning:parking_semantic"] = result.subtype;
    tags["parking:layout_inferred"] = "no";
    if (result.parkingRole === "area") tags["area:highway"] = "parking";
    if (result.parkingRole === "aisle") tags.service = "parking_aisle";
  }
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
    source: sourceOverride || (result.parkingRole ? "planning-pdf-nearby-parking-label" : "planning-pdf-nearby-pedestrian-label"),
    confidence: result.confidence,
    nearbyText: nearby.map((entry) => entry.text).slice(0, 8),
    worldGeometryAuthority: false,
    georegistrationRequired: true,
    temporalResolutionRequired: true,
    terrainGeometryMutable: false,
    terrainElevationMutable: false
  };
  if (result.parkingRole) {
    candidate.parkingEvidence = {
      schemaVersion: 1,
      source: "planning-pdf-nearby-parking-label",
      role: result.parkingRole,
      subtype: result.subtype,
      confidence: result.confidence,
      nearbyText: nearby.map((entry) => entry.text).slice(0, 8),
      inventedBayGridAllowed: false,
      worldGeometryAuthority: false,
      georegistrationRequired: true,
      temporalResolutionRequired: true
    };
  }
}

function matchRecord(candidate, winner, nearby) {
  return {
    candidateId: candidate.id || null,
    pageNumber: candidate.pageNumber || 1,
    kind: winner.kind,
    subtype: winner.subtype,
    parkingRole: winner.parkingRole || null,
    confidence: winner.confidence,
    nearbyText: nearby.map((entry) => entry.text).slice(0, 5)
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

function parkingBaySubtype(text) {
  if (/disabled|accessible/i.test(text)) return "accessible_parking_bay";
  if (/\b(ev|electric\s+vehicle|charging)\b/i.test(text)) return "ev_parking_bay";
  if (/coach/i.test(text)) return "coach_bay";
  return "parking_bay";
}

function normalizeClass(value) { return String(value || "unknown").trim().toLowerCase().replace(/[\s-]+/g, "_"); }
