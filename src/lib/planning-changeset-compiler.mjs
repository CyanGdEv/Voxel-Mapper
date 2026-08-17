import { geometryBounds } from "./geo.mjs";

const TOPOLOGY_KINDS = new Set([
  "building", "structure", "path", "road", "ride_track", "ride_support", "barrier", "water", "vegetation"
]);
const PAINT_ONLY_KIND = "surface";
const TERRAIN_GEOMETRY_KINDS = new Set(["terrain", "terrain_detail", "landform", "ground"]);
const MIN_ADD_CONFIDENCE = 0.82;
const DEFAULT_MATCH_SCORE = 0.7;
const DEFAULT_AMBIGUITY_GAP = 0.08;

/**
 * Converts verified-current planning evidence into explicit canonical-map
 * changes before OSM reconciliation. Terrain elevation/shape is intentionally
 * outside this compiler: planning may paint a surface region, but it can never
 * cut, fill, flatten, raise, lower or otherwise deform the terrain raster.
 */
export function compilePlanningChangeSet(map, evidence = {}, options = {}) {
  const output = {
    schemaVersion: 1,
    status: "compiled",
    terrainPolicy: {
      geometryMutable: false,
      elevationMutable: false,
      surfacePaintAllowed: true,
      rule: "planning-never-deforms-terrain"
    },
    input: {
      geometryCandidates: evidence?.geometryCandidates?.length || 0,
      materialObservations: evidence?.materialObservations?.length || 0
    },
    counts: { add: 0, replace: 0, delete: 0, retain: 0, paint: 0, review: 0, ignored: 0 },
    changes: [],
    candidates: []
  };

  for (const candidate of evidence?.geometryCandidates || []) {
    const decision = compileGeometryCandidate(map, candidate, evidence, options);
    output.changes.push(decision.record);
    output.counts[decision.record.operation] = (output.counts[decision.record.operation] || 0) + 1;
    if (decision.candidate) output.candidates.push(decision.candidate);
  }

  if (!output.changes.length) output.status = "no-planning-geometry";
  else if (output.counts.review) output.status = "compiled-with-review-items";
  return output;
}

export function inferPlanningFeatureKind(candidate, map = null, options = {}) {
  const explicit = normalizeKind(candidate?.kind || candidate?.featureKind || candidate?.properties?.kind);
  if (TERRAIN_GEOMETRY_KINDS.has(explicit)) {
    return { kind: null, confidence: 1, reason: "terrain-geometry-immutable", prohibitedTerrainGeometry: true, signals: ["explicit-terrain-kind"] };
  }
  if (explicit === PAINT_ONLY_KIND) return { kind: PAINT_ONLY_KIND, confidence: 0.99, reason: "explicit-surface-paint", signals: ["explicit-kind"] };
  if (TOPOLOGY_KINDS.has(explicit)) return { kind: explicit, confidence: 0.99, reason: "explicit-feature-kind", signals: ["explicit-kind"] };

  const semantic = normalize(candidate?.semantic);
  const classification = normalize(candidate?.classification);
  const text = normalize([
    candidate?.name, candidate?.label, candidate?.raw, candidate?.description,
    candidate?.properties?.name, candidate?.properties?.label, candidate?.properties?.description,
    candidate?.properties?.feature, candidate?.properties?.type
  ].filter(Boolean).join(" "));
  const geometryType = String(candidate?.localGeometry?.type || candidate?.geometry?.type || "");
  const areaGeometry = /Polygon/.test(geometryType);
  const lineGeometry = /LineString/.test(geometryType);
  const signals = [];

  const hit = (kind, confidence, reason, signal) => ({ kind, confidence, reason, signals: [...signals, signal] });

  // A support/column label is more specific than the generic fact that it came
  // from a ride-layout drawing. Check it first so support linework is never
  // silently promoted to a ride centerline.
  if (/ride[-_ ]?support|support[-_ ]?structure|column|support pier/.test(`${semantic} ${text}`)) {
    return hit("ride_support", 0.94, "ride-support-label", "support-label");
  }
  if (/ride[-_ ]?centerline|ride[-_ ]?track|track[-_ ]?layout/.test(`${semantic} ${text}`) ||
      (classification === "ride_layout" && lineGeometry)) {
    return hit("ride_track", 0.98, "ride-layout-centerline", "ride-layout");
  }
  if (/demolition[-_ ]?footprint/.test(semantic)) {
    return hit("building", 0.94, "demolition-building-footprint", "demolition-footprint");
  }
  if (/building[-_ ]?footprint|building[-_ ]?outline|building footprint|floor[-_ ]?plan/.test(`${semantic} ${text}`) ||
      (classification === "floor_plan" && areaGeometry)) {
    return hit("building", 0.92, "building-plan-geometry", "building-plan");
  }
  if (/roof[-_ ]?plane|roof[-_ ]?footprint/.test(semantic) || classification === "roof_plan") {
    return { kind: "building", confidence: 0.76, reason: "roof-plan-match-only", matchOnly: true, signals: ["roof-plan"] };
  }
  if (/\b(fence|fencing|wall|barrier|guardrail|balustrade|gate)\b/.test(text)) {
    return hit("barrier", 0.94, "barrier-label", "barrier-label");
  }
  if (/\b(lake|pond|pool|water|watercourse|stream|basin)\b/.test(text)) {
    return hit("water", 0.94, "water-label", "water-label");
  }
  if (/\b(service road|access road|carriageway|roadway|road)\b/.test(text)) {
    return hit("road", 0.93, "road-label", "road-label");
  }
  if (/\b(path|footpath|footway|walkway|pedestrian|queue line|queue path)\b/.test(text)) {
    return hit("path", 0.94, "path-label", "path-label");
  }
  if (/\b(gantry|platform|canopy|bridge structure|retaining structure)\b/.test(text)) {
    return hit("structure", 0.88, "structure-label", "structure-label");
  }
  if (/\b(tree|trees|planting|hedge|shrub|woodland)\b/.test(text) && areaGeometry) {
    return hit("vegetation", 0.86, "vegetation-area-label", "vegetation-label");
  }

  const corroboratedTarget = implementationCorroboratedTarget(candidate, map);
  if (corroboratedTarget) {
    return {
      kind: corroboratedTarget.kind,
      confidence: 0.96,
      reason: "implementation-corroborated-existing-feature-kind",
      matchOnly: false,
      targetFeatureId: corroboratedTarget.id,
      signals: ["post-decision-current-feature-corroboration"]
    };
  }

  const material = candidate?.compiledMaterial || null;
  if (areaGeometry && (material || classification === "landscape_plan") && !/building|roof/.test(semantic)) {
    return hit(PAINT_ONLY_KIND, material ? 0.93 : 0.72, material ? "material-defined-surface-area" : "landscape-area-needs-material", material ? "surface-material" : "landscape-area");
  }

  const spatial = map ? inferKindFromExistingGeometry(candidate, map.features || [], options) : null;
  if (spatial?.accepted) {
    return {
      kind: spatial.feature.kind,
      confidence: Math.min(0.91, 0.68 + spatial.score * 0.24),
      reason: "unambiguous-existing-feature-kind",
      matchOnly: false,
      targetFeatureId: spatial.feature.id,
      spatial,
      signals: ["existing-map-match"]
    };
  }
  if (spatial?.reason === "ambiguous") {
    return { kind: null, confidence: spatial.score || 0, reason: "ambiguous-existing-feature-kind", ambiguous: true, spatial, signals: ["ambiguous-map-match"] };
  }
  return { kind: null, confidence: 0.4, reason: "semantic-kind-unresolved", signals };
}

function compileGeometryCandidate(map, rawCandidate, evidence, options) {
  const material = associateMaterial(rawCandidate, evidence?.materialObservations || []);
  const candidate = material.accepted
    ? { ...rawCandidate, compiledMaterial: material.material }
    : { ...rawCandidate };
  const inference = inferPlanningFeatureKind(candidate, map, options);
  const sourceRef = candidateRef(candidate);
  const current = isCurrentAuthority(candidate);
  const demolition = isConfirmedDemolition(candidate);
  const explicitOperation = normalizeOperation(candidate);

  if (inference.prohibitedTerrainGeometry || TERRAIN_GEOMETRY_KINDS.has(normalizeKind(candidate?.kind))) {
    return decision("review", candidate, inference, null, "terrain-geometry-immutable", {
      sourceRef, material: material.material || null, terrainMutationRejected: true
    });
  }

  if (!candidate.localGeometry) {
    return decision("review", candidate, inference, null, "missing-georegistered-geometry", { sourceRef });
  }

  if (explicitOperation === "delete" && !current && !demolition) {
    return decision("review", candidate, inference, null, "delete-not-current-authority", { sourceRef });
  }
  if (!current && !demolition) {
    return decision("ignored", candidate, inference, null, "planning-not-current-world-authority", { sourceRef });
  }

  if (demolition || explicitOperation === "delete") {
    if (!inference.kind || inference.kind === PAINT_ONLY_KIND) {
      return decision("review", candidate, inference, null, "demolition-target-kind-unresolved", { sourceRef });
    }
    const match = findKindMatch(candidate, map?.features || [], inference.kind, options);
    if (!match.accepted) {
      return decision("review", candidate, inference, match, `delete-${match.reason}`, { sourceRef });
    }
    return decision("delete", candidate, inference, match, demolition ? "confirmed-demolition" : "explicit-current-delete", {
      sourceRef,
      targetFeatureId: match.feature.id,
      candidate: compiledCandidate(candidate, inference, "delete", match, material)
    });
  }

  if (inference.kind === PAINT_ONLY_KIND) {
    if (!isAreaGeometry(candidate.localGeometry)) {
      return decision("review", candidate, inference, null, "surface-paint-requires-area-geometry", { sourceRef });
    }
    if (!material.accepted) {
      return decision("review", candidate, inference, null, material.reason || "surface-paint-material-unresolved", { sourceRef });
    }
    return decision("paint", candidate, inference, null, "planning-surface-paint-only", {
      sourceRef,
      material: material.material,
      candidate: compiledCandidate(candidate, inference, "paint", null, material)
    });
  }

  if (!inference.kind || !TOPOLOGY_KINDS.has(inference.kind)) {
    return decision("review", candidate, inference, null, inference.reason || "feature-kind-unresolved", { sourceRef });
  }

  const match = inference.targetFeatureId
    ? exactFeatureMatch(map?.features || [], inference.targetFeatureId)
    : findKindMatch(candidate, map?.features || [], inference.kind, options);

  if (match.accepted) {
    if (explicitOperation === "add") {
      return decision("review", candidate, inference, match, "explicit-add-conflicts-with-existing-feature", { sourceRef });
    }
    if (geometryEffectivelySame(candidate.localGeometry, match.feature.localGeometry, match.score, options)) {
      return decision("retain", candidate, inference, match, "planning-corroborates-existing-geometry", { sourceRef, targetFeatureId: match.feature.id });
    }
    return decision("replace", candidate, inference, match, explicitOperation === "replace" ? "explicit-current-replace" : "automatic-current-planning-replace", {
      sourceRef,
      targetFeatureId: match.feature.id,
      candidate: compiledCandidate(candidate, inference, "replace", match, material)
    });
  }

  if (match.reason === "ambiguous") {
    return decision("review", candidate, inference, match, "ambiguous-existing-feature-match", { sourceRef });
  }
  if (inference.matchOnly) {
    return decision("review", candidate, inference, match, "match-only-evidence-has-no-existing-target", { sourceRef });
  }
  if (inference.confidence < Number(options.planningChangeSetMinAddConfidence ?? MIN_ADD_CONFIDENCE)) {
    return decision("review", candidate, inference, match, "new-feature-semantic-confidence-below-gate", { sourceRef });
  }

  return decision("add", candidate, inference, match, explicitOperation === "add" ? "explicit-current-add" : "automatic-current-planning-gap-fill", {
    sourceRef,
    material: material.material || null,
    candidate: compiledCandidate(candidate, inference, "add", null, material)
  });
}

function compiledCandidate(candidate, inference, operation, match, material) {
  const tags = { ...(candidate.tags || candidate.properties?.tags || {}) };
  if (material?.accepted) {
    tags.material = material.material;
    if (inference.kind === PAINT_ONLY_KIND || ["path", "road"].includes(inference.kind)) tags.surface = material.material;
  }
  return {
    ...candidate,
    kind: inference.kind,
    featureKind: inference.kind,
    planningOperation: operation,
    targetFeatureId: match?.feature?.id || inference.targetFeatureId || candidate.targetFeatureId || null,
    tags,
    compiledMaterial: material?.accepted ? material.material : null,
    compilerDecision: {
      schemaVersion: 1,
      kind: inference.kind,
      kindConfidence: round(inference.confidence),
      reason: inference.reason,
      operation,
      terrainGeometryMutable: false,
      surfacePaintOnly: inference.kind === PAINT_ONLY_KIND,
      matchScore: match?.score ?? null
    }
  };
}

function decision(operation, candidate, inference, match, reason, extra = {}) {
  const compiled = extra.candidate || null;
  return {
    candidate: compiled,
    record: {
      operation,
      sourceRef: extra.sourceRef || candidateRef(candidate),
      featureKind: inference.kind || null,
      semanticConfidence: round(inference.confidence),
      semanticReason: inference.reason,
      targetFeatureId: extra.targetFeatureId || match?.feature?.id || null,
      matchScore: match?.score ?? null,
      secondScore: match?.secondScore ?? null,
      material: extra.material || compiled?.compiledMaterial || null,
      reason,
      terrainMutationRejected: Boolean(extra.terrainMutationRejected),
      terrainGeometryMutable: false,
      surfacePaintOnly: inference.kind === PAINT_ONLY_KIND
    }
  };
}

function associateMaterial(candidate, observations) {
  if (!candidate?.localGeometry || !isAreaGeometry(candidate.localGeometry)) return { accepted: false, reason: "material-area-unavailable" };
  const samePage = (observations || []).filter((entry) =>
    isCurrentAuthority(entry) &&
    (!candidate.contentHash || !entry.contentHash || candidate.contentHash === entry.contentHash) &&
    (!candidate.pageNumber || !entry.pageNumber || Number(candidate.pageNumber) === Number(entry.pageNumber)) &&
    Number.isFinite(Number(entry.localX)) && Number.isFinite(Number(entry.localZ)) &&
    pointInGeometry(Number(entry.localX), Number(entry.localZ), candidate.localGeometry)
  );
  if (!samePage.length) return { accepted: false, reason: "no-current-material-label-inside-area" };
  samePage.sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0) || String(a.material).localeCompare(String(b.material)));
  const best = samePage[0];
  const competing = samePage.find((entry) => entry.material !== best.material && Number(best.confidence || 0) - Number(entry.confidence || 0) < 0.08);
  if (competing) return { accepted: false, reason: "ambiguous-material-labels" };
  return { accepted: true, material: best.material, confidence: Number(best.confidence || 0), sourceRef: candidateRef(best) };
}

function implementationCorroboratedTarget(candidate, map) {
  const featureId = candidate?.implementationCorroboration?.featureId ||
    candidate?.planningTemporal?.implementationCorroboration?.featureId ||
    null;
  if (!featureId) return null;
  const feature = (map?.features || []).find((entry) => entry?.id === featureId);
  if (!feature?.localGeometry || !TOPOLOGY_KINDS.has(feature.kind)) return null;
  return feature;
}

function inferKindFromExistingGeometry(candidate, features, options) {
  const eligible = (features || []).filter((feature) =>
    feature?.localGeometry && feature.kind !== "park_boundary" &&
    (TOPOLOGY_KINDS.has(feature.kind) || feature.kind === PAINT_ONLY_KIND)
  );
  const ranked = eligible.map((feature) => ({ feature, score: geometryMatchScore(candidate.localGeometry, feature.localGeometry) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score || String(a.feature.id).localeCompare(String(b.feature.id)));
  return acceptRanked(ranked, options);
}

function findKindMatch(candidate, features, kind, options) {
  const eligible = (features || []).filter((feature) =>
    feature?.localGeometry && compatibleKinds(kind, feature.kind) && Number(feature.authority?.rank ?? 100) < 360
  );
  const ranked = eligible.map((feature) => ({ feature, score: geometryMatchScore(candidate.localGeometry, feature.localGeometry) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score || String(a.feature.id).localeCompare(String(b.feature.id)));
  return acceptRanked(ranked, options);
}

function exactFeatureMatch(features, id) {
  const feature = (features || []).find((entry) => entry.id === id);
  return feature ? { accepted: true, feature, score: 1, secondScore: null, method: "compiler-existing-target" } : { accepted: false, reason: "target-not-found" };
}

function acceptRanked(ranked, options) {
  if (!ranked.length) return { accepted: false, reason: "no-compatible-feature" };
  const best = ranked[0], second = ranked[1] || null;
  const minimum = Number(options.planningChangeSetMinMatchScore ?? DEFAULT_MATCH_SCORE);
  const gap = Number(options.planningChangeSetAmbiguityGap ?? DEFAULT_AMBIGUITY_GAP);
  if (best.score < minimum) return { accepted: false, reason: "below-score-gate", score: round(best.score), secondScore: second ? round(second.score) : null };
  if (second && best.score - second.score < gap) return { accepted: false, reason: "ambiguous", score: round(best.score), secondScore: round(second.score) };
  return { accepted: true, feature: best.feature, score: round(best.score), secondScore: second ? round(second.score) : null, method: "compiler-spatial-kind-match" };
}

function compatibleKinds(requested, actual) {
  if (requested === actual) return true;
  if ([requested, actual].every((kind) => ["building", "structure"].includes(kind))) return true;
  return false;
}

function geometryEffectivelySame(a, b, score, options) {
  if (Number(score || 0) < Number(options.planningChangeSetRetainScore ?? 0.97)) return false;
  const left = geometryBounds(a), right = geometryBounds(b);
  if (!left || !right) return false;
  const tolerance = Number(options.planningChangeSetRetainToleranceM ?? 0.35);
  return Math.max(
    Math.abs(left.minX - right.minX), Math.abs(left.maxX - right.maxX),
    Math.abs(left.minZ - right.minZ), Math.abs(left.maxZ - right.maxZ)
  ) <= tolerance;
}

function geometryMatchScore(a, b) {
  if (!a || !b) return NaN;
  const boxA = geometryBounds(a), boxB = geometryBounds(b);
  if (!boxA || !boxB) return NaN;
  const centerA = [(boxA.minX + boxA.maxX) / 2, (boxA.minZ + boxA.maxZ) / 2];
  const centerB = [(boxB.minX + boxB.maxX) / 2, (boxB.minZ + boxB.maxZ) / 2];
  const distance = Math.hypot(centerA[0] - centerB[0], centerA[1] - centerB[1]);
  const diag = Math.max(2, diagonal(boxA), diagonal(boxB));
  const distanceScore = Math.max(0, 1 - distance / Math.max(8, diag));
  const overlap = bboxOverlapRatio(boxA, boxB);
  const areaA = Math.max(0.01, bboxArea(boxA)), areaB = Math.max(0.01, bboxArea(boxB));
  const scaleScore = Math.min(areaA, areaB) / Math.max(areaA, areaB);
  const familyScore = geometryFamily(a.type) === geometryFamily(b.type) ? 1 : 0.5;
  return clamp(0.46 * overlap + 0.29 * distanceScore + 0.17 * scaleScore + 0.08 * familyScore);
}

function pointInGeometry(x, z, geometry) {
  if (geometry?.type === "Polygon") return polygonContains(geometry.coordinates, x, z);
  if (geometry?.type === "MultiPolygon") return (geometry.coordinates || []).some((polygon) => polygonContains(polygon, x, z));
  return false;
}
function polygonContains(rings, x, z) {
  if (!rings?.length || !pointInRing(x, z, rings[0])) return false;
  return !rings.slice(1).some((ring) => pointInRing(x, z, ring));
}
function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    const intersects = ((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / ((zj - zi) || Number.EPSILON) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}
function isAreaGeometry(geometry) { return ["Polygon", "MultiPolygon"].includes(geometry?.type); }
function geometryFamily(type) { if (/Polygon/.test(String(type))) return "area"; if (/LineString/.test(String(type))) return "line"; if (/Point/.test(String(type))) return "point"; return "other"; }
function bboxArea(box) { return Math.max(0, box.maxX - box.minX) * Math.max(0, box.maxZ - box.minZ); }
function diagonal(box) { return Math.hypot(box.maxX - box.minX, box.maxZ - box.minZ); }
function bboxOverlapRatio(a, b) {
  const width = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const height = Math.max(0, Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ));
  return clamp(width * height / Math.max(0.01, Math.min(bboxArea(a), bboxArea(b))));
}
function normalizeOperation(candidate) {
  const value = normalize(candidate?.operation || candidate?.planningOperation || candidate?.topologyOperation || candidate?.editOperation || candidate?.properties?.operation);
  return ["add", "replace", "delete"].includes(value) ? value : null;
}
function normalizeKind(value) { return normalize(value).replace(/[- ]+/g, "_"); }
function normalize(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9_ -]+/g, " ").replace(/\s+/g, " ").trim(); }
function isCurrentAuthority(entry) { return entry?.worldGeometryAuthority === true && entry?.planningTemporal?.state === "current"; }
function isConfirmedDemolition(entry) {
  const state = entry?.planningTemporal?.state;
  const confidence = Number(entry?.planningTemporal?.confidence || 0);
  const text = normalize(`${entry?.classification || ""} ${entry?.semantic || ""} ${entry?.label || ""} ${entry?.raw || ""}`);
  return state === "demolished" && confidence >= 0.95 && /demolition|demolished|removed/.test(text);
}
function candidateRef(candidate) { return candidate?.id || (candidate?.contentHash ? `${candidate.contentHash}:p${candidate.pageNumber || 1}` : null); }
function round(value) { const number = Number(value); return Number.isFinite(number) ? Math.round(number * 1000) / 1000 : null; }
function clamp(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }
