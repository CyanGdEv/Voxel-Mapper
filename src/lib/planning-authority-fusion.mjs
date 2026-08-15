import path from "node:path";
import { geometryMapCoordinates, pointInRing } from "./geo.mjs";
import { readJson } from "./io.mjs";

const AUTHORITY_LAYER = "planning-current-authority";
const DEFAULT_MIN_MATCH_SCORE = 0.66;
const DEFAULT_AMBIGUITY_GAP = 0.08;
const DEFAULT_POINT_TOLERANCE_M = 12;

/**
 * Converts PR #8's authority-only planning artifact into per-feature evidence
 * candidates. This function never mutates geometry/material/height directly;
 * it only attaches externalEvidence records that the Evidence Graph can rank.
 */
export async function integratePlanningAuthorityEvidence(map, options = {}) {
  const source = await loadAuthorityEvidence(options);
  const summary = {
    schemaVersion: 1,
    status: source ? "processed" : "disabled",
    authorityLayer: AUTHORITY_LAYER,
    sourcePath: options.planningAuthorityEvidence ? path.resolve(options.planningAuthorityEvidence) : null,
    input: {
      geometryCandidates: source?.geometryCandidates?.length || 0,
      verticalObservations: source?.verticalObservations?.length || 0,
      materialObservations: source?.materialObservations?.length || 0
    },
    accepted: { geometry: 0, groundElevation: 0, height: 0, material: 0, width: 0 },
    rejected: {},
    matchedFeatures: 0,
    matches: []
  };
  if (!source) return summary;

  const features = (map?.features || []).filter((feature) => feature?.localGeometry && feature.kind !== "park_boundary");
  const touched = new Set();
  const verticalByFeature = new Map();

  for (const candidate of source.geometryCandidates || []) {
    if (!isAuthorityEntry(candidate)) { reject(summary, "geometry-not-authoritative"); continue; }
    if (!candidate.localGeometry || !map?.projector?.inverse) { reject(summary, "geometry-missing-local-shape"); continue; }
    if (/vertical-profile/.test(String(candidate.semantic || ""))) { reject(summary, "geometry-non-plan-view-semantic"); continue; }

    const match = matchGeometryCandidate(candidate, features, options);
    if (!match.accepted) { reject(summary, `geometry-${match.reason}`); continue; }

    const geographic = geometryMapCoordinates(candidate.localGeometry, map.projector.inverse);
    addExternalEvidence(match.feature, {
      attribute: "geometry",
      value: geographic,
      materializeValue: candidate.localGeometry,
      method: "planning-current-georegistered-geometry",
      confidence: authorityConfidence(candidate, match.score),
      directness: 0.99,
      sourceRef: candidate.id || pageRef(candidate),
      provenance: compactPlanningProvenance(candidate, match)
    });
    if (Number.isFinite(candidate.widthM)) {
      addExternalEvidence(match.feature, {
        attribute: "width",
        value: Number(candidate.widthM),
        method: "planning-current-explicit-width",
        confidence: authorityConfidence(candidate, match.score),
        directness: 0.98,
        sourceRef: candidate.id || pageRef(candidate),
        provenance: compactPlanningProvenance(candidate, match)
      });
      summary.accepted.width += 1;
    }
    summary.accepted.geometry += 1;
    touched.add(match.feature.id);
    summary.matches.push(matchRecord("geometry", candidate, match));
  }

  for (const observation of source.materialObservations || []) {
    if (!isAuthorityEntry(observation)) { reject(summary, "material-not-authoritative"); continue; }
    const match = matchPointObservation(observation, features, materialCompatibleKind, options);
    if (!match.accepted) { reject(summary, `material-${match.reason}`); continue; }
    const role = materialRole(observation.material, match.feature.kind, observation.raw);
    addExternalEvidence(match.feature, {
      attribute: "material",
      value: observation.material,
      role,
      method: "planning-current-material-label",
      confidence: authorityConfidence(observation, match.score),
      directness: 0.96,
      sourceRef: pageRef(observation),
      provenance: compactPlanningProvenance(observation, match)
    });
    summary.accepted.material += 1;
    touched.add(match.feature.id);
    summary.matches.push(matchRecord("material", observation, match, { role, value: observation.material }));
  }

  for (const observation of source.verticalObservations || []) {
    if (!isAuthorityEntry(observation)) { reject(summary, "vertical-not-authoritative"); continue; }
    const match = matchPointObservation(observation, features, verticalCompatibleKind, options);
    if (!match.accepted) { reject(summary, `vertical-${match.reason}`); continue; }
    const key = match.feature.id;
    if (!verticalByFeature.has(key)) verticalByFeature.set(key, { feature: match.feature, observations: [] });
    verticalByFeature.get(key).observations.push({ ...observation, matchScore: match.score });
    touched.add(match.feature.id);
    summary.matches.push(matchRecord("vertical", observation, match, { label: observation.label, valueM: observation.valueM }));
  }

  for (const { feature, observations } of verticalByFeature.values()) {
    integrateVerticalObservations(feature, observations, summary);
  }

  summary.matchedFeatures = touched.size;
  summary.status = summary.accepted.geometry + summary.accepted.groundElevation + summary.accepted.height + summary.accepted.material + summary.accepted.width
    ? "integrated" : "no-accepted-authority-evidence";
  summary.matches = summary.matches.slice(0, Math.max(1, Number(options.maxPlanningAuthorityQaMatches || 500)));
  return summary;
}

export function matchGeometryCandidate(candidate, features, options = {}) {
  const sourceGeometry = candidate?.localGeometry;
  if (!sourceGeometry) return { accepted: false, reason: "missing-geometry" };
  const compatible = (features || []).filter((feature) => semanticCompatible(candidate.semantic, feature.kind));
  if (!compatible.length) return { accepted: false, reason: "no-compatible-feature" };

  const scored = compatible.map((feature) => ({ feature, score: geometryMatchScore(sourceGeometry, feature.localGeometry) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score || String(a.feature.id).localeCompare(String(b.feature.id)));
  if (!scored.length) return { accepted: false, reason: "no-finite-match" };

  const best = scored[0], second = scored[1] || null;
  const minimum = Number(options.planningAuthorityMinMatchScore ?? DEFAULT_MIN_MATCH_SCORE);
  const gap = Number(options.planningAuthorityAmbiguityGap ?? DEFAULT_AMBIGUITY_GAP);
  if (best.score < minimum) return { accepted: false, reason: "below-score-gate", score: round(best.score) };
  if (second && best.score - second.score < gap) {
    return { accepted: false, reason: "ambiguous", score: round(best.score), secondScore: round(second.score) };
  }
  return { accepted: true, feature: best.feature, score: round(best.score), secondScore: second ? round(second.score) : null };
}

export function matchPointObservation(observation, features, compatibleKind = () => true, options = {}) {
  const x = Number(observation?.localX), z = Number(observation?.localZ);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return { accepted: false, reason: "unpositioned" };
  const tolerance = Number(options.planningAuthorityPointToleranceM ?? DEFAULT_POINT_TOLERANCE_M);
  const candidates = [];
  for (const feature of features || []) {
    if (!compatibleKind(feature.kind)) continue;
    const distance = distancePointToGeometry([x, z], feature.localGeometry);
    if (!Number.isFinite(distance) || distance > tolerance) continue;
    const contained = distance === 0 && geometryContainsPoint(feature.localGeometry, x, z);
    const score = contained ? 1 : Math.max(0, 1 - distance / tolerance);
    candidates.push({ feature, distance, score });
  }
  candidates.sort((a, b) => a.distance - b.distance || b.score - a.score || String(a.feature.id).localeCompare(String(b.feature.id)));
  if (!candidates.length) return { accepted: false, reason: "no-nearby-feature" };
  const best = candidates[0], second = candidates[1] || null;
  const ambiguityM = Number(options.planningAuthorityPointAmbiguityM ?? 1.5);
  if (second && Math.abs(second.distance - best.distance) < ambiguityM && second.feature.id !== best.feature.id) {
    return { accepted: false, reason: "ambiguous", distanceM: round(best.distance) };
  }
  return {
    accepted: true,
    feature: best.feature,
    distanceM: round(best.distance),
    score: round(best.score),
    secondDistanceM: second ? round(second.distance) : null
  };
}

function integrateVerticalObservations(feature, observations, summary) {
  const bases = observations.filter((entry) => baseLevelLabel(entry.label) && Number.isFinite(Number(entry.valueM)));
  if (bases.length) {
    const value = median(bases.map((entry) => Number(entry.valueM)));
    const confidence = Math.min(...bases.map((entry) => Number(entry.confidence ?? 0.8))) * 0.96;
    addExternalEvidence(feature, {
      attribute: "groundElevation",
      value: round(value, 3),
      method: "planning-current-level-observation",
      confidence,
      directness: bases.some((entry) => String(entry.datum || "").toUpperCase() === "AOD") ? 0.99 : 0.9,
      sourceRef: pageRef(bases[0]),
      provenance: { labels: [...new Set(bases.map((entry) => entry.label))], sampleCount: bases.length }
    });
    summary.accepted.groundElevation += 1;
  }

  if (!["building", "structure"].includes(feature.kind)) return;
  const byPage = new Map();
  for (const entry of observations) {
    const key = `${entry.contentHash || ""}:p${entry.pageNumber || 1}`;
    if (!byPage.has(key)) byPage.set(key, []);
    byPage.get(key).push(entry);
  }
  let best = null;
  for (const values of byPage.values()) {
    const pageBases = values.filter((entry) => baseLevelLabel(entry.label) && Number.isFinite(Number(entry.valueM)));
    const tops = values.filter((entry) => topLevelLabel(entry.label) && Number.isFinite(Number(entry.valueM)));
    if (!pageBases.length || !tops.length) continue;
    const base = median(pageBases.map((entry) => Number(entry.valueM)));
    const top = Math.max(...tops.map((entry) => Number(entry.valueM)));
    const height = top - base;
    if (!(height >= 1.5 && height <= 100)) continue;
    const confidence = Math.min(
      ...pageBases.map((entry) => Number(entry.confidence ?? 0.8)),
      ...tops.map((entry) => Number(entry.confidence ?? 0.8))
    ) * 0.92;
    const candidate = { height, confidence, sourceRef: pageRef(tops[0]), baseLabels: pageBases.map((entry) => entry.label), topLabels: tops.map((entry) => entry.label) };
    if (!best || candidate.confidence > best.confidence || (candidate.confidence === best.confidence && candidate.height > best.height)) best = candidate;
  }
  if (!best) return;
  addExternalEvidence(feature, {
    attribute: "height",
    value: round(best.height, 3),
    method: "planning-current-level-difference",
    confidence: best.confidence,
    directness: 0.98,
    sourceRef: best.sourceRef,
    provenance: { baseLabels: [...new Set(best.baseLabels)], topLabels: [...new Set(best.topLabels)] }
  });
  summary.accepted.height += 1;
}

function addExternalEvidence(feature, evidence) {
  feature.externalEvidence ||= [];
  feature.externalEvidence.push({
    schemaVersion: 1,
    ...evidence,
    source: "Planning current-state authority",
    authorityLayer: AUTHORITY_LAYER,
    authorityRank: 360,
    temporalState: "current",
    temporalConfidence: 0.99,
    recency: 1,
    resolutionM: null,
    external: true,
    worldGeometryAuthority: true
  });
}

async function loadAuthorityEvidence(options) {
  if (options.planningAuthorityEvidenceData) return normalizeAuthorityArtifact(options.planningAuthorityEvidenceData);
  if (!options.planningAuthorityEvidence) return null;
  const value = await readJson(path.resolve(options.planningAuthorityEvidence));
  return normalizeAuthorityArtifact(value);
}

function normalizeAuthorityArtifact(value) {
  const artifact = value || {};
  const result = {
    geometryCandidates: (artifact.geometryCandidates || []).filter(isAuthorityEntry),
    verticalObservations: (artifact.verticalObservations || []).filter(isAuthorityEntry),
    materialObservations: (artifact.materialObservations || []).filter(isAuthorityEntry)
  };
  return result;
}

function isAuthorityEntry(entry) {
  return entry?.worldGeometryAuthority === true && String(entry?.planningTemporal?.state || "current") === "current";
}

function authorityConfidence(entry, spatialScore = 1) {
  const extraction = Number(entry?.confidence ?? 0.9);
  const temporal = Number(entry?.planningTemporal?.confidence ?? 0.99);
  return clamp(extraction * 0.42 + temporal * 0.33 + Number(spatialScore ?? 1) * 0.25);
}

function compactPlanningProvenance(entry, match) {
  return {
    contentHash: entry.contentHash || null,
    pageNumber: entry.pageNumber || null,
    classification: entry.classification || null,
    semantic: entry.semantic || null,
    planningTemporal: entry.planningTemporal || null,
    matchScore: match?.score ?? null,
    matchDistanceM: match?.distanceM ?? null
  };
}

function matchRecord(type, entry, match, extra = {}) {
  return {
    type,
    sourceRef: entry.id || pageRef(entry),
    featureId: match.feature.id,
    featureKind: match.feature.kind,
    score: match.score ?? null,
    distanceM: match.distanceM ?? null,
    ...extra
  };
}

function semanticCompatible(semantic, kind) {
  const value = String(semantic || "");
  const target = String(kind || "");
  if (/ride-centerline|ride-envelope/.test(value)) return ["ride_track", "structure"].includes(target);
  if (/building-footprint|building-linework/.test(value)) return ["building", "structure"].includes(target);
  if (/roof/.test(value)) return target === "building";
  if (/landscape-area-or-path|landscape-edge-or-route/.test(value)) return ["path", "road", "water", "terrain_detail", "barrier"].includes(target);
  if (/site-feature-or-building-footprint/.test(value)) return ["building", "structure", "path", "road", "water", "terrain_detail"].includes(target);
  if (/site-edge-or-route/.test(value)) return ["path", "road", "barrier", "ride_track"].includes(target);
  if (/demolition/.test(value)) return ["building", "structure"].includes(target);
  return ["building", "structure"].includes(target);
}

function materialCompatibleKind(kind) {
  return ["building", "structure", "path", "road", "barrier", "ride_track"].includes(String(kind || ""));
}
function verticalCompatibleKind(kind) {
  return ["building", "structure", "ride_track", "path", "road", "terrain_detail"].includes(String(kind || ""));
}

function materialRole(material, kind, raw) {
  const text = `${material || ""} ${raw || ""}`.toLowerCase();
  if (/roof|slate|tile/.test(text) && kind === "building") return "roof";
  if (kind === "barrier") return "barrier";
  if (kind === "building" || kind === "structure") return "wall";
  return "surface";
}

function geometryMatchScore(a, b) {
  if (!a || !b) return NaN;
  const boxA = geometryBounds(a), boxB = geometryBounds(b);
  if (!boxA || !boxB) return NaN;
  const centerA = [(boxA.minX + boxA.maxX) / 2, (boxA.minZ + boxA.maxZ) / 2];
  const centerB = [(boxB.minX + boxB.maxX) / 2, (boxB.minZ + boxB.maxZ) / 2];
  const distance = Math.hypot(centerA[0] - centerB[0], centerA[1] - centerB[1]);
  const diag = Math.max(2, Math.hypot(boxA.maxX - boxA.minX, boxA.maxZ - boxA.minZ), Math.hypot(boxB.maxX - boxB.minX, boxB.maxZ - boxB.minZ));
  const distanceScore = Math.max(0, 1 - distance / Math.max(8, diag));
  const overlap = bboxOverlapRatio(boxA, boxB);
  const areaA = Math.max(0.01, bboxArea(boxA)), areaB = Math.max(0.01, bboxArea(boxB));
  const scaleScore = Math.min(areaA, areaB) / Math.max(areaA, areaB);
  const typeScore = geometryFamily(a.type) === geometryFamily(b.type) ? 1 : 0.55;
  return clamp(0.43 * overlap + 0.29 * distanceScore + 0.18 * scaleScore + 0.10 * typeScore);
}

function geometryFamily(type) {
  if (/Polygon/.test(String(type))) return "area";
  if (/LineString/.test(String(type))) return "line";
  if (/Point/.test(String(type))) return "point";
  return "other";
}

function geometryBounds(geometry) {
  const points = geometryPoints(geometry);
  if (!points.length) return null;
  const xs = points.map((point) => point[0]), zs = points.map((point) => point[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}
function bboxArea(box) { return Math.max(0, box.maxX - box.minX) * Math.max(0, box.maxZ - box.minZ); }
function bboxOverlapRatio(a, b) {
  const width = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const height = Math.max(0, Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ));
  const intersection = width * height;
  const smaller = Math.max(0.01, Math.min(bboxArea(a), bboxArea(b)));
  return clamp(intersection / smaller);
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

function geometryContainsPoint(geometry, x, z) {
  if (geometry?.type === "Polygon") return polygonContains(geometry.coordinates, x, z);
  if (geometry?.type === "MultiPolygon") return (geometry.coordinates || []).some((polygon) => polygonContains(polygon, x, z));
  return false;
}
function polygonContains(rings, x, z) {
  if (!rings?.length || !pointInRing(x, z, rings[0])) return false;
  return !rings.slice(1).some((ring) => pointInRing(x, z, ring));
}

function distancePointToGeometry(point, geometry) {
  if (!geometry) return Infinity;
  if (geometryContainsPoint(geometry, point[0], point[1])) return 0;
  const lines = geometryLines(geometry);
  let best = Infinity;
  for (const line of lines) {
    for (let index = 1; index < line.length; index += 1) {
      best = Math.min(best, distancePointToSegment(point, line[index - 1], line[index]));
    }
  }
  if (best < Infinity) return best;
  const points = geometryPoints(geometry);
  return points.length ? Math.min(...points.map((candidate) => Math.hypot(point[0] - candidate[0], point[1] - candidate[1]))) : Infinity;
}
function geometryLines(geometry) {
  if (geometry?.type === "LineString") return [geometry.coordinates || []];
  if (geometry?.type === "MultiLineString") return geometry.coordinates || [];
  if (geometry?.type === "Polygon") return geometry.coordinates || [];
  if (geometry?.type === "MultiPolygon") return (geometry.coordinates || []).flat();
  return [];
}
function distancePointToSegment(point, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const length2 = dx * dx + dz * dz;
  if (!(length2 > 0)) return Math.hypot(point[0] - a[0], point[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / length2));
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dz));
}

function baseLevelLabel(value) { return /^(FFL|SSL|AOD|GROUND LEVEL|GL|BOW|BOTTOM OF WALL)$/i.test(String(value || "").trim()); }
function topLevelLabel(value) { return /^(RIDGE|EAVES?|TOW|TOP OF WALL)$/i.test(String(value || "").trim()); }
function pageRef(entry) { return `${entry?.contentHash || "unknown"}:p${entry?.pageNumber || 1}`; }
function reject(summary, reason) { summary.rejected[reason] = (summary.rejected[reason] || 0) + 1; }
function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function round(value, places = 3) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** places;
  return Math.round(number * factor) / factor;
}
function clamp(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }
