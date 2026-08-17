import path from "node:path";
import { geometryMapCoordinates, pointInRing } from "./geo.mjs";
import { readJson } from "./io.mjs";
import { createMaterialRegistry, resolveFeatureMaterialPalettes } from "./material-palettes.mjs";

const AUTHORITY_LAYER = "planning-current-authority";
const AUTHORITY_SOURCE = "Planning current-state authority";
const DEFAULT_MIN_MATCH_SCORE = 0.66;
const DEFAULT_AMBIGUITY_GAP = 0.08;
const DEFAULT_POINT_TOLERANCE_M = 12;
const MATERIALIZABLE_GEOMETRY_CLASSES = new Set(["site_plan", "location_plan", "ride_layout", "landscape_plan"]);
const SURFACE_ONLY_MATERIALS = new Set([
  "weathered_asphalt", "fresh_black_asphalt", "light_asphalt", "red_tarmac",
  "resin_bound_beige", "resin_bound_grey", "gravel", "grass", "earth"
]);
const ROOF_ONLY_MATERIALS = new Set(["slate_roof", "clay_tile_roof", "metal_roof"]);
const STRUCTURE_MATERIALS = new Set(["brick", "stone", "timber", "steel", "glass"]);
const REQUIRED_ATTRIBUTES = {
  building: ["geometry", "height", "roof", "material"],
  structure: ["geometry", "height", "material"],
  path: ["geometry", "width", "material"],
  road: ["geometry", "width", "material"],
  ride_track: ["geometry", "verticalProfile"],
  vegetation: ["geometry", "height"],
  barrier: ["geometry", "height", "material"],
  water: ["geometry"],
  terrain_detail: ["geometry"]
};

/**
 * Converts the authority-only planning artifact into candidate records.
 * Nothing is materialized into the world here; the existing Evidence Graph is
 * still allowed to compare planning against OSM, LiDAR and other evidence.
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
    association: { certifiedGeometryTargets: 0, genericGeometryMatches: 0 },
    rejected: {},
    matchedFeatures: 0,
    matches: []
  };
  if (!source) return summary;

  const features = (map?.features || []).filter((feature) => feature?.localGeometry && feature.kind !== "park_boundary");
  const touched = new Set();
  const verticalByFeature = new Map();

  for (const candidate of source.geometryCandidates || []) {
    if (!materializableGeometryCandidate(candidate)) { reject(summary, "geometry-non-materializable-semantic"); continue; }
    if (!candidate.localGeometry || !map?.projector?.inverse) { reject(summary, "geometry-missing-local-shape"); continue; }
    const match = resolveGeometryCandidateMatch(candidate, features, options);
    if (!match.accepted) { reject(summary, `geometry-${match.reason}`); continue; }
    if (match.method === "certified-current-target") summary.association.certifiedGeometryTargets += 1;
    else summary.association.genericGeometryMatches += 1;

    const geographic = geometryMapCoordinates(candidate.localGeometry, map.projector.inverse);
    addPlanningCandidate(match.feature, {
      attribute: "geometry",
      value: geographic,
      materializeValue: candidate.localGeometry,
      method: "planning-current-georegistered-geometry",
      confidence: authorityConfidence(candidate, match.score),
      directness: 0.99,
      sourceRef: candidate.id || pageRef(candidate),
      provenance: compactPlanningProvenance(candidate, match)
    });
    if (Number.isFinite(Number(candidate.widthM))) {
      addPlanningCandidate(match.feature, {
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
    const match = matchPointObservation(
      observation,
      features,
      (kind) => materialCompatibleKind(kind, observation.material),
      options
    );
    if (!match.accepted) { reject(summary, `material-${match.reason}`); continue; }
    const role = materialRole(observation.material, match.feature.kind, observation.raw);
    addPlanningCandidate(match.feature, {
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
    const match = matchPointObservation(observation, features, verticalCompatibleKind, options);
    if (!match.accepted) { reject(summary, `vertical-${match.reason}`); continue; }
    if (!verticalByFeature.has(match.feature.id)) verticalByFeature.set(match.feature.id, { feature: match.feature, observations: [] });
    verticalByFeature.get(match.feature.id).observations.push({ ...observation, matchScore: match.score });
    touched.add(match.feature.id);
    summary.matches.push(matchRecord("vertical", observation, match, { label: observation.label, valueM: observation.valueM }));
  }

  for (const { feature, observations } of verticalByFeature.values()) integrateVerticalObservations(feature, observations, summary);

  summary.matchedFeatures = touched.size;
  const accepted = Object.values(summary.accepted).reduce((sum, value) => sum + value, 0);
  summary.status = accepted ? "integrated" : "no-accepted-authority-evidence";
  summary.matches = summary.matches.slice(0, Math.max(1, Number(options.maxPlanningAuthorityQaMatches || 500)));
  return summary;
}

/**
 * Inserts planning candidates into the already-built Evidence Graph and
 * re-resolves winners. The original graph implementation remains unchanged,
 * which keeps this bridge isolated and easy to remove/audit.
 */
export function fusePlanningAuthorityIntoEvidenceGraph(map, options = {}) {
  let candidateCount = 0;
  let winningAttributes = 0;
  const affected = new Set();

  for (const feature of map?.features || []) {
    const candidates = feature.planningAuthorityCandidates || [];
    if (!candidates.length || !feature.evidenceGraph) continue;
    for (const candidate of candidates) {
      const attribute = candidate.attribute;
      const existing = feature.evidenceGraph.attributes[attribute] || { winner: null, alternatives: [], conflict: false };
      const pool = uniqueCandidates([existing.winner, ...(existing.alternatives || []), candidate].filter(Boolean));
      pool.sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(b.authorityRank || 0) - Number(a.authorityRank || 0));
      const winner = pool[0] || null, runnerUp = pool[1] || null;
      feature.evidenceGraph.attributes[attribute] = {
        winner,
        alternatives: pool.slice(1, 5),
        conflict: Boolean(winner && runnerUp && materiallyDifferent(attribute, winner.value, runnerUp.value) && Math.abs(winner.score - runnerUp.score) < 0.12)
      };
      candidateCount += 1;
      affected.add(feature.id);
      if (winner?.authorityLayer === AUTHORITY_LAYER) winningAttributes += 1;
      if (winner && winner.score >= 0.72) {
        feature.evidenceGraph.gaps = (feature.evidenceGraph.gaps || []).filter((gap) => gap.attribute !== attribute);
      }
    }
  }

  const summary = rebuildEvidenceSummary(map, options);
  summary.planningAuthority = {
    schemaVersion: 1,
    candidateCount,
    affectedFeatures: affected.size,
    winningAttributes
  };
  map.evidenceGraph = summary;
  return summary.planningAuthority;
}

/**
 * Materializes only planning candidates that actually won their attribute.
 * This is the first point where the generated world is changed.
 */
export function applyPlanningAuthorityWinners(map) {
  const materialRegistry = createMaterialRegistry();
  const summary = {
    schemaVersion: 1,
    appliedAttributes: 0,
    affectedFeatures: 0,
    byAttribute: {},
    changes: []
  };
  const affected = new Set();

  for (const feature of map?.features || []) {
    const graph = feature.evidenceGraph;
    if (!graph?.attributes) continue;
    for (const [attribute, entry] of Object.entries(graph.attributes)) {
      const winner = entry?.winner;
      if (!winner || winner.authorityLayer !== AUTHORITY_LAYER) continue;
      const before = materializedValue(feature, attribute);
      if (!applyWinner(feature, attribute, winner, map, materialRegistry)) continue;
      const after = materializedValue(feature, attribute);
      feature.evidenceResolution ||= {};
      feature.evidenceResolution[attribute] = {
        source: winner.source,
        sourceRef: winner.sourceRef,
        authorityLayer: winner.authorityLayer,
        score: winner.score,
        method: winner.method,
        before,
        after
      };
      summary.appliedAttributes += 1;
      summary.byAttribute[attribute] = (summary.byAttribute[attribute] || 0) + 1;
      affected.add(feature.id);
      summary.changes.push({ featureId: feature.id, featureKind: feature.kind, attribute, sourceRef: winner.sourceRef, score: winner.score });
    }
  }
  summary.affectedFeatures = affected.size;
  return summary;
}

/**
 * A planning geometry that has already been independently corroborated against
 * a specific post-decision current feature must keep that identity. Re-running
 * a park-wide nearest/overlap search after topology reconciliation can create a
 * false ambiguity from duplicate or adjacent OSM representations and discard a
 * target that was already proven upstream.
 *
 * Only internal certification is trusted. A raw targetFeatureId alone is never
 * sufficient to bypass matching. If a certified target is declared but is no
 * longer present or semantically compatible, fail closed rather than falling
 * back to a different feature.
 */
export function resolveGeometryCandidateMatch(candidate, features, options = {}) {
  if (!isAuthorityEntry(candidate)) return { accepted: false, reason: "candidate-not-current-authority" };
  const certified = certifiedGeometryTarget(candidate);
  if (!certified) return matchGeometryCandidate(candidate, features, options);

  const feature = (features || []).find((entry) => entry?.id === certified.featureId);
  if (!feature?.localGeometry) {
    return { accepted: false, reason: "certified-target-not-found", targetFeatureId: certified.featureId };
  }
  if (!planningSemanticCompatible(candidate, feature)) {
    return {
      accepted: false,
      reason: "certified-target-kind-mismatch",
      targetFeatureId: certified.featureId,
      featureKind: feature.kind
    };
  }

  const minimum = Number(options.planningAuthorityMinMatchScore ?? DEFAULT_MIN_MATCH_SCORE);
  const score = Number(certified.matchScore);
  if (Number.isFinite(score) && score < minimum) {
    return {
      accepted: false,
      reason: "certified-target-below-score-gate",
      targetFeatureId: certified.featureId,
      score: round(score)
    };
  }

  return {
    accepted: true,
    feature,
    score: Number.isFinite(score) ? round(score) : 1,
    secondScore: Number.isFinite(Number(certified.secondScore)) ? round(certified.secondScore) : null,
    method: "certified-current-target",
    certification: certified.method
  };
}

export function matchGeometryCandidate(candidate, features, options = {}) {
  const sourceGeometry = candidate?.localGeometry;
  if (!sourceGeometry) return { accepted: false, reason: "missing-geometry" };
  const compatible = (features || []).filter((feature) => planningSemanticCompatible(candidate, feature));
  if (!compatible.length) return { accepted: false, reason: "no-compatible-feature" };
  const scored = compatible.map((feature) => ({ feature, score: geometryMatchScore(sourceGeometry, feature.localGeometry) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score || String(a.feature.id).localeCompare(String(b.feature.id)));
  if (!scored.length) return { accepted: false, reason: "no-finite-match" };

  const best = scored[0], second = scored[1] || null;
  const minimum = Number(options.planningAuthorityMinMatchScore ?? DEFAULT_MIN_MATCH_SCORE);
  const gap = Number(options.planningAuthorityAmbiguityGap ?? DEFAULT_AMBIGUITY_GAP);
  if (best.score < minimum) return { accepted: false, reason: "below-score-gate", score: round(best.score) };
  if (second && best.score - second.score < gap) return { accepted: false, reason: "ambiguous", score: round(best.score), secondScore: round(second.score) };
  return { accepted: true, feature: best.feature, score: round(best.score), secondScore: second ? round(second.score) : null, method: "geometry-search" };
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
    candidates.push({ feature, distance, score: contained ? 1 : Math.max(0, 1 - distance / tolerance) });
  }
  candidates.sort((a, b) => a.distance - b.distance || b.score - a.score || String(a.feature.id).localeCompare(String(b.feature.id)));
  if (!candidates.length) return { accepted: false, reason: "no-nearby-feature" };
  const best = candidates[0], second = candidates[1] || null;
  const ambiguityM = Number(options.planningAuthorityPointAmbiguityM ?? 1.5);
  if (second && Math.abs(second.distance - best.distance) < ambiguityM && second.feature.id !== best.feature.id) {
    return { accepted: false, reason: "ambiguous", distanceM: round(best.distance) };
  }
  return { accepted: true, feature: best.feature, distanceM: round(best.distance), score: round(best.score), secondDistanceM: second ? round(second.distance) : null };
}

function integrateVerticalObservations(feature, observations, summary) {
  const bases = observations.filter((entry) => baseLevelLabel(entry.label) && Number.isFinite(Number(entry.valueM)));
  if (bases.length) {
    addPlanningCandidate(feature, {
      attribute: "groundElevation",
      value: round(median(bases.map((entry) => Number(entry.valueM))), 3),
      method: "planning-current-level-observation",
      confidence: Math.min(...bases.map((entry) => Number(entry.confidence ?? 0.8))) * 0.96,
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
    const confidence = Math.min(...pageBases.map((entry) => Number(entry.confidence ?? 0.8)), ...tops.map((entry) => Number(entry.confidence ?? 0.8))) * 0.92;
    const candidate = { height, confidence, sourceRef: pageRef(tops[0]), baseLabels: pageBases.map((entry) => entry.label), topLabels: tops.map((entry) => entry.label) };
    if (!best || candidate.confidence > best.confidence || (candidate.confidence === best.confidence && candidate.height > best.height)) best = candidate;
  }
  if (!best) return;
  addPlanningCandidate(feature, {
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

function addPlanningCandidate(feature, evidence) {
  feature.planningAuthorityCandidates ||= [];
  const quality = {
    authority: 0.9,
    directness: clamp(evidence.directness ?? 0.96),
    confidence: clamp(evidence.confidence ?? 0.9),
    recency: 1,
    resolution: 0.66,
    temporal: 0.997
  };
  const score = 0.34 * quality.authority + 0.24 * quality.directness + 0.15 * quality.confidence + 0.10 * quality.recency + 0.10 * quality.resolution + 0.07 * quality.temporal;
  feature.planningAuthorityCandidates.push({
    schemaVersion: 1,
    attribute: evidence.attribute,
    value: evidence.value,
    materializeValue: evidence.materializeValue,
    role: evidence.role || null,
    method: evidence.method,
    source: AUTHORITY_SOURCE,
    sourceRef: evidence.sourceRef || null,
    authorityLayer: AUTHORITY_LAYER,
    authorityRank: 360,
    observedAt: evidence.observedAt || null,
    quality,
    score: round(score),
    provenance: evidence.provenance || null,
    worldGeometryAuthority: true
  });
}

function applyWinner(feature, attribute, winner, map, materialRegistry) {
  if (attribute === "geometry") {
    if (!winner.value || !map?.projector?.forward) return false;
    feature.geometry = clone(winner.value);
    feature.localGeometry = winner.materializeValue ? clone(winner.materializeValue) : geometryMapCoordinates(winner.value, map.projector.forward);
    feature.authority = { ...(feature.authority || {}), attributeGeometry: AUTHORITY_LAYER };
    return true;
  }
  if (attribute === "height") {
    if (!Number.isFinite(Number(winner.value))) return false;
    feature.vertical ||= {};
    feature.vertical.heightM = Number(winner.value);
    feature.vertical.heightSource = winner.method;
    feature.vertical.heightConfidence = winner.quality?.confidence ?? null;
    feature.vertical.explicit = true;
    feature.verification ||= {};
    feature.verification.vertical = "planning-current-authority";
    return true;
  }
  if (attribute === "groundElevation") {
    if (!Number.isFinite(Number(winner.value))) return false;
    feature.vertical ||= {};
    feature.vertical.elevationM = Number(winner.value);
    feature.vertical.elevationSource = winner.method;
    feature.vertical.explicit = true;
    return true;
  }
  if (attribute === "width") {
    if (!Number.isFinite(Number(winner.value))) return false;
    feature.tags ||= {};
    feature.tags.width = String(Number(winner.value));
    feature.surfaceEvidence = { ...(feature.surfaceEvidence || {}), widthM: Number(winner.value), widthMethod: winner.method, widthConfidence: winner.quality?.confidence ?? null };
    return true;
  }
  if (attribute === "material") {
    const material = String(winner.value || "").trim();
    if (!material) return false;
    feature.tags ||= {};
    const role = winner.role || materialRole(material, feature.kind, "");
    feature.tags.material = material;
    if (role === "surface") feature.tags.surface = material;
    else if (role === "roof") feature.tags["roof:material"] = material;
    else if (role === "wall") feature.tags["building:material"] = material;
    else if (role === "barrier") feature.tags.barrier_material = material;
    const resolved = resolveFeatureMaterialPalettes(feature, materialRegistry);
    if (resolved) feature.materialPalette = { ...(feature.materialPalette || {}), ...resolved };
    return true;
  }
  return false;
}

function materializedValue(feature, attribute) {
  if (attribute === "geometry") return clone(feature.geometry || null);
  if (attribute === "height") return feature.vertical?.heightM ?? null;
  if (attribute === "groundElevation") return feature.vertical?.elevationM ?? null;
  if (attribute === "width") return feature.tags?.width ?? feature.surfaceEvidence?.widthM ?? null;
  if (attribute === "material") return feature.tags?.material || feature.tags?.["building:material"] || feature.tags?.surface || null;
  return null;
}

async function loadAuthorityEvidence(options) {
  const raw = options.planningAuthorityEvidenceData
    ? options.planningAuthorityEvidenceData
    : options.planningAuthorityEvidence ? await readJson(path.resolve(options.planningAuthorityEvidence)) : null;
  if (!raw) return null;
  return {
    geometryCandidates: (raw.geometryCandidates || []).filter(isAuthorityEntry),
    verticalObservations: (raw.verticalObservations || []).filter(isAuthorityEntry),
    materialObservations: (raw.materialObservations || []).filter(isAuthorityEntry)
  };
}
function isAuthorityEntry(entry) {
  return entry?.worldGeometryAuthority === true && entry?.planningTemporal?.state === "current";
}
function certifiedGeometryTarget(entry) {
  const contract = entry?.associationContract;
  if (contract?.certifiedCurrentTarget === true && contract?.featureId) {
    return {
      featureId: String(contract.featureId),
      matchScore: contract.matchScore,
      secondScore: contract.secondScore,
      method: contract.method || "compiler-certified-current-target"
    };
  }
  const implementation = entry?.implementationCorroboration || entry?.planningTemporal?.implementationCorroboration;
  if (implementation?.featureId) {
    return {
      featureId: String(implementation.featureId),
      matchScore: implementation.matchScore,
      secondScore: implementation.secondScore,
      method: "post-decision-current-osm-corroboration"
    };
  }
  return null;
}
function authorityConfidence(entry, spatialScore = 1) {
  const extraction = Number(entry?.confidence ?? 0.9), temporal = Number(entry?.planningTemporal?.confidence ?? 0.99);
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
    matchDistanceM: match?.distanceM ?? null,
    matchMethod: match?.method || null,
    targetCertification: match?.certification || null
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
    method: match.method || null,
    certification: match.certification || null,
    ...extra
  };
}

function materializableGeometryCandidate(candidate) {
  const classification = String(candidate?.classification || "").toLowerCase();
  const semantic = String(candidate?.semantic || "").toLowerCase();
  if (!MATERIALIZABLE_GEOMETRY_CLASSES.has(classification)) return false;
  if (/roof|vertical-profile|demolition|building-linework|unclassified/.test(semantic)) return false;
  return Boolean(semantic);
}

function rebuildEvidenceSummary(map, options) {
  const previous = map.evidenceGraph || {};
  const summary = {
    ...previous,
    featureCount: map.features?.length || 0,
    attributeCount: 0,
    evidencedAttributes: 0,
    missingAttributes: 0,
    lowConfidenceAttributes: 0,
    conflictAttributes: 0,
    byKind: {},
    byAttribute: {},
    acquisitionQueue: []
  };
  for (const feature of map.features || []) {
    const graph = feature.evidenceGraph || { attributes: {}, gaps: [], temporal: { state: "unknown" } };
    const kind = feature.kind || "unknown";
    summary.byKind[kind] ||= { features: 0, required: 0, evidenced: 0, missing: 0, lowConfidence: 0, conflicts: 0 };
    summary.byKind[kind].features += 1;
    for (const [attribute, entry] of Object.entries(graph.attributes || {})) {
      summary.attributeCount += 1;
      summary.byAttribute[attribute] ||= { total: 0, evidenced: 0, missing: 0, lowConfidence: 0, conflicts: 0 };
      const bucket = summary.byAttribute[attribute];
      bucket.total += 1;
      if (entry.winner) { bucket.evidenced += 1; summary.evidencedAttributes += 1; }
      else { bucket.missing += 1; summary.missingAttributes += 1; }
      if (entry.winner && entry.winner.score < 0.72) { bucket.lowConfidence += 1; summary.lowConfidenceAttributes += 1; }
      if (entry.conflict) { bucket.conflicts += 1; summary.conflictAttributes += 1; }
    }
    const required = REQUIRED_ATTRIBUTES[kind] || ["geometry"];
    summary.byKind[kind].required += required.length;
    for (const attribute of required) {
      const entry = graph.attributes?.[attribute];
      const gap = (graph.gaps || []).find((value) => value.attribute === attribute);
      if (entry?.winner) summary.byKind[kind].evidenced += 1;
      if (gap?.status === "missing") summary.byKind[kind].missing += 1;
      else if (gap?.status === "low-confidence") summary.byKind[kind].lowConfidence += 1;
    }
    summary.byKind[kind].conflicts += Object.values(graph.attributes || {}).filter((entry) => entry.conflict).length;
    for (const gap of graph.gaps || []) summary.acquisitionQueue.push({ featureId: feature.id, kind, ...gap });
  }
  summary.acquisitionQueue.sort((a, b) => b.priority - a.priority || String(a.featureId).localeCompare(String(b.featureId)));
  summary.acquisitionQueue = summary.acquisitionQueue.slice(0, Math.max(1, Number(options.maxEvidenceQueue || 500)));
  return summary;
}

function uniqueCandidates(values) {
  const seen = new Set();
  return values.filter((candidate) => {
    const key = `${candidate.source || ""}|${candidate.sourceRef || ""}|${candidate.method || ""}|${stable(candidate.value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function materiallyDifferent(attribute, a, b) {
  if (["height", "groundElevation", "width"].includes(attribute)) {
    return Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) > (attribute === "width" ? 0.75 : 1);
  }
  return stable(a) !== stable(b);
}
function stable(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return String(value);
  try { return JSON.stringify(canonicalize(value)); } catch { return "[object]"; }
}
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function planningSemanticCompatible(candidate, feature) {
  const semantic = String(candidate?.semantic || "");
  const kind = String(feature?.kind || "");
  const classification = normalizePlanningClass(candidate?.classification);

  if (kind === "ride_track") {
    return classification === "ride_layout" && /ride-centerline-or-edge/.test(semantic);
  }
  if (/ride-centerline-or-edge/.test(semantic)) return false;
  if (/ride-envelope-or-structure/.test(semantic)) return classification === "ride_layout" && kind === "structure";
  if (/building-footprint-or-room/.test(semantic)) return ["building", "structure"].includes(kind);
  if (/landscape-area-or-path/.test(semantic)) return ["path", "road", "water", "terrain_detail"].includes(kind);
  if (/landscape-edge-or-route/.test(semantic)) return ["path", "road", "barrier"].includes(kind);
  if (/site-feature-or-building-footprint/.test(semantic)) return ["building", "structure", "path", "road", "water", "terrain_detail"].includes(kind);
  if (/site-edge-or-route/.test(semantic)) return ["path", "road", "barrier"].includes(kind);
  return false;
}
function normalizePlanningClass(value) {
  return String(value || "").toLowerCase().trim().replace(/[\s-]+/g, "_");
}
function materialCompatibleKind(kind, material) {
  const target = String(kind || "");
  const key = String(material || "").toLowerCase();
  if (ROOF_ONLY_MATERIALS.has(key)) return target === "building";
  if (SURFACE_ONLY_MATERIALS.has(key)) return ["path", "road", "terrain_detail"].includes(target);
  if (STRUCTURE_MATERIALS.has(key)) return ["building", "structure", "barrier"].includes(target);
  return ["building", "structure", "path", "road", "barrier", "ride_track"].includes(target);
}
function verticalCompatibleKind(kind) { return ["building", "structure", "ride_track", "path", "road", "terrain_detail"].includes(String(kind || "")); }
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
function geometryFamily(type) { if (/Polygon/.test(String(type))) return "area"; if (/LineString/.test(String(type))) return "line"; if (/Point/.test(String(type))) return "point"; return "other"; }
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
  return clamp(width * height / Math.max(0.01, Math.min(bboxArea(a), bboxArea(b))));
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
function polygonContains(rings, x, z) { return Boolean(rings?.length && pointInRing(x, z, rings[0]) && !rings.slice(1).some((ring) => pointInRing(x, z, ring))); }
function distancePointToGeometry(point, geometry) {
  if (!geometry) return Infinity;
  if (geometryContainsPoint(geometry, point[0], point[1])) return 0;
  let best = Infinity;
  for (const line of geometryLines(geometry)) for (let index = 1; index < line.length; index += 1) best = Math.min(best, distancePointToSegment(point, line[index - 1], line[index]));
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
  const dx = b[0] - a[0], dz = b[1] - a[1], length2 = dx * dx + dz * dz;
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
function round(value, places = 3) { const number = Number(value); if (!Number.isFinite(number)) return null; const factor = 10 ** places; return Math.round(number * factor) / factor; }
function clamp(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }
function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
