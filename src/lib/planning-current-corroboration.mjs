const ELIGIBLE_CLASSES = new Set([
  "site_plan", "site-plan",
  "location_plan", "location-plan",
  "ride_layout", "ride-layout",
  "landscape_plan", "landscape-plan"
]);
const DEFAULT_MIN_SCORE = 0.78;
export const DEFAULT_PLANNING_CORROBORATION_AMBIGUITY_GAP = 0.08;
const REFERENCE_INDEX_CACHE = new WeakMap();

/**
 * Approval is not implementation. This promotes only an individual registered
 * planning geometry candidate that is independently re-observed in a later
 * current OSM feature. The current observation must post-date the planning
 * decision; pre-decision geometry cannot prove that the proposal was built.
 */
export function corroboratePlanningGeometryCandidate(candidate, referenceFeatures, context = {}) {
  const classification = String(candidate?.classification || "").toLowerCase();
  if (!ELIGIBLE_CLASSES.has(classification)) return rejected("non-materializable-planning-class");
  if (!candidate?.localGeometry || candidate?.georegistrationStatus !== "registered") return rejected("candidate-not-spatially-registered");
  const decisionAt = latestPlanningDecisionDate(context.applicationTemporal || [], context.drawingIssueDate || null);
  if (!decisionAt) return rejected("missing-planning-decision-date");

  // Current-state resolution may test tens of thousands of planning candidates
  // against the same OSM reference. Recomputing every reference geometry's
  // bounds for every candidate dominated the post-georegistration critical
  // path. The index below caches only deterministic geometry descriptors; the
  // scoring equation, compatibility rules, gates and ambiguity semantics are
  // equivalent to the canonical authority matcher.
  const match = matchIndexedGeometryCandidate(candidate, referenceFeatures || [], {
    planningAuthorityMinMatchScore: Number(context.minMatchScore ?? DEFAULT_MIN_SCORE),
    planningAuthorityAmbiguityGap: Number(context.ambiguityGap ?? DEFAULT_PLANNING_CORROBORATION_AMBIGUITY_GAP)
  });
  if (!match.accepted) return rejected(`geometry-${match.reason}`, { match });
  const observedAt = parsePlanningDate(match.feature?.source?.timestamp);
  if (!observedAt) return rejected("current-observation-missing-timestamp", { match });
  if (!(observedAt.getTime() > decisionAt.getTime())) {
    return rejected("observation-not-post-decision", {
      match,
      decisionAt: decisionAt.toISOString(),
      observedAt: observedAt.toISOString()
    });
  }

  const score = Number(match.score || 0);
  const temporalConfidence = clampTemporal(0.82 + Math.max(0, score - DEFAULT_MIN_SCORE) * 0.55);
  return {
    accepted: true,
    match,
    decisionAt: decisionAt.toISOString(),
    observedAt: observedAt.toISOString(),
    temporal: {
      state: "current",
      confidence: round(temporalConfidence),
      reason: "post-decision-current-osm-geometry-corroboration",
      source: "cross-source-current-observation",
      observedAt: observedAt.toISOString(),
      planningDecisionAt: decisionAt.toISOString(),
      temporalResolved: true,
      worldGeometryAuthority: true,
      implementationCorroboration: {
        provider: match.feature?.source?.provider || "OpenStreetMap",
        featureId: match.feature?.id || null,
        elementType: match.feature?.source?.elementType || null,
        elementId: match.feature?.source?.elementId || null,
        version: match.feature?.source?.version ?? null,
        timestamp: match.feature?.source?.timestamp || null,
        matchScore: match.score ?? null,
        secondScore: match.secondScore ?? null
      }
    }
  };
}

export function latestPlanningDecisionDate(applicationTemporal, drawingIssueDate = null) {
  const values = [];
  for (const temporal of applicationTemporal || []) {
    for (const evidence of temporal?.dateEvidence || []) {
      if (!/decision[-_ ]?date/i.test(String(evidence?.kind || ""))) continue;
      const date = parsePlanningDate(evidence?.value);
      if (date) values.push(date);
    }
  }
  if (!values.length) return null;
  values.sort((a, b) => b.getTime() - a.getTime());
  return values[0];
}

export function parsePlanningDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  // UK local planning registers commonly emit DD/MM/YYYY. Parse this form
  // explicitly before the platform Date parser so 09/08/2016 is never treated
  // as 8 September or rejected differently across runtimes.
  const uk = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:\s+.*)?$/);
  if (uk) {
    const day = Number(uk[1]), month = Number(uk[2]), year = Number(uk[3]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      const date = new Date(Date.UTC(year, month - 1, day));
      if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) return date;
    }
    return null;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function matchIndexedGeometryCandidate(candidate, referenceFeatures, options = {}) {
  const sourceGeometry = candidate?.localGeometry;
  if (!sourceGeometry) return { accepted: false, reason: "missing-geometry" };
  const source = prepareGeometry(sourceGeometry);
  if (!source) return { accepted: false, reason: "no-finite-match" };
  const index = referenceGeometryIndex(referenceFeatures || []);
  const compatible = index.filter((entry) => semanticCompatible(candidate.semantic, entry.feature?.kind));
  if (!compatible.length) return { accepted: false, reason: "no-compatible-feature" };
  const scored = compatible.map((entry) => ({
    feature: entry.feature,
    score: geometryMatchScorePrepared(source, entry)
  })).filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score || String(a.feature.id).localeCompare(String(b.feature.id)));
  if (!scored.length) return { accepted: false, reason: "no-finite-match" };

  const best = scored[0], second = scored[1] || null;
  const minimum = Number(options.planningAuthorityMinMatchScore ?? 0.66);
  const requestedGap = Number(options.planningAuthorityAmbiguityGap ?? DEFAULT_PLANNING_CORROBORATION_AMBIGUITY_GAP);
  // Keep every production caller on the canonical authority-matcher semantics.
  // Callers may opt for a smaller gap, but a stale/hard-coded larger value must
  // not silently reject geometry that the canonical matcher considers unique.
  const gap = Number.isFinite(requestedGap)
    ? Math.min(Math.max(0, requestedGap), DEFAULT_PLANNING_CORROBORATION_AMBIGUITY_GAP)
    : DEFAULT_PLANNING_CORROBORATION_AMBIGUITY_GAP;
  if (best.score < minimum) return { accepted: false, reason: "below-score-gate", score: round(best.score) };
  if (second && best.score - second.score < gap) {
    return { accepted: false, reason: "ambiguous", score: round(best.score), secondScore: round(second.score) };
  }
  return {
    accepted: true,
    feature: best.feature,
    score: round(best.score),
    secondScore: second ? round(second.score) : null
  };
}

function referenceGeometryIndex(features) {
  if (!Array.isArray(features)) return [];
  const cached = REFERENCE_INDEX_CACHE.get(features);
  if (cached) return cached;
  const index = features.map((feature) => {
    const prepared = prepareGeometry(feature?.localGeometry);
    return prepared ? { feature, ...prepared } : { feature, invalid: true };
  });
  REFERENCE_INDEX_CACHE.set(features, index);
  return index;
}

function prepareGeometry(geometry) {
  if (!geometry) return null;
  const points = geometryPoints(geometry);
  if (!points.length) return null;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const point of points) {
    const x = Number(point?.[0]), z = Number(point?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  if (![minX, maxX, minZ, maxZ].every(Number.isFinite)) return null;
  const width = Math.max(0, maxX - minX), height = Math.max(0, maxZ - minZ);
  return {
    minX, maxX, minZ, maxZ,
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
    area: Math.max(0.01, width * height),
    diag: Math.hypot(width, height),
    family: geometryFamily(geometry.type)
  };
}

function geometryMatchScorePrepared(a, b) {
  if (!a || !b || b.invalid) return NaN;
  const distance = Math.hypot(a.centerX - b.centerX, a.centerZ - b.centerZ);
  const diag = Math.max(2, a.diag, b.diag);
  const distanceScore = Math.max(0, 1 - distance / Math.max(8, diag));
  const overlapWidth = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const overlapHeight = Math.max(0, Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ));
  const overlap = clampScore(overlapWidth * overlapHeight / Math.max(0.01, Math.min(a.area, b.area)));
  const scaleScore = Math.min(a.area, b.area) / Math.max(a.area, b.area);
  const typeScore = a.family === b.family ? 1 : 0.55;
  return clampScore(0.43 * overlap + 0.29 * distanceScore + 0.18 * scaleScore + 0.10 * typeScore);
}

function semanticCompatible(semantic, kind) {
  const value = String(semantic || ""), target = String(kind || "");
  if (/ride-centerline-or-edge/.test(value)) return target === "ride_track";
  if (/ride-envelope-or-structure/.test(value)) return target === "structure";
  if (/building-footprint-or-room/.test(value)) return ["building", "structure"].includes(target);
  if (/landscape-area-or-path/.test(value)) return ["path", "road", "water", "terrain_detail"].includes(target);
  if (/landscape-edge-or-route/.test(value)) return ["path", "road", "barrier"].includes(target);
  if (/site-feature-or-building-footprint/.test(value)) return ["building", "structure", "path", "road", "water", "terrain_detail"].includes(target);
  if (/site-edge-or-route/.test(value)) return ["path", "road", "barrier", "ride_track"].includes(target);
  return false;
}

function geometryFamily(type) {
  if (/Polygon/.test(String(type))) return "area";
  if (/LineString/.test(String(type))) return "line";
  if (/Point/.test(String(type))) return "point";
  return "other";
}
function geometryPoints(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Point") return [geometry.coordinates];
  if (geometry.type === "LineString") return geometry.coordinates || [];
  if (geometry.type === "MultiLineString") return (geometry.coordinates || []).flat();
  if (geometry.type === "Polygon") return (geometry.coordinates || []).flat();
  if (geometry.type === "MultiPolygon") return (geometry.coordinates || []).flat(2);
  return [];
}
function rejected(reason, extra = {}) { return { accepted: false, reason, ...extra }; }
function clampScore(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }
function clampTemporal(value) { return Math.max(0, Math.min(0.995, Number(value) || 0)); }
function round(value) { return Math.round(Number(value) * 1000) / 1000; }
