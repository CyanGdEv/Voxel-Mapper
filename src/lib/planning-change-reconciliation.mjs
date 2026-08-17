import path from "node:path";
import { geometryBounds, geometryMapCoordinates } from "./geo.mjs";
import { readJson, sha256 } from "./io.mjs";
import { surfaceMaterialPalette } from "./material-palettes.mjs";
import { matchPointObservation } from "./planning-authority-fusion.mjs";
import { compilePlanningChangeSet } from "./planning-changeset-compiler.mjs";
import { reconcilePlanningTopology } from "./osm-planning-reconciliation.mjs";

const TOPOLOGY_OPERATIONS = new Set(["add", "replace", "delete"]);
const EXTENDED_TOPOLOGY_KINDS = new Set(["ride_support", "vegetation"]);
const SAFE_VERTICAL_KINDS = new Set(["building", "structure", "ride_track"]);
const PLANNING_AUTHORITY_RANK = 360;

/**
 * Compiles raw current-state planning evidence into explicit changes and then
 * delegates the feature classes already supported by PR #20 to its reconciler.
 * Ride supports and vegetation are handled here because they are valid semantic
 * planning features but are outside PR #20's original topology-kind allowlist.
 *
 * Surface paint is always handled separately and can never write elevation or
 * terrain shape. Before returning, this function also replaces the authority
 * bundle in `options` with a terrain-safe view so later Evidence Graph fusion
 * cannot reintroduce ground-elevation edits through planning level labels.
 */
export async function reconcileCompiledPlanningChanges(map, options = {}) {
  const rawEvidence = await loadAuthorityEvidence(options);
  if (!rawEvidence) {
    const topology = await reconcilePlanningTopology(map, options);
    const changeSet = disabledChangeSet();
    map.planningChangeSet = changeSet;
    return { ...topology, changeSet, paint: emptyPaintSummary("disabled"), authoritySanitization: disabledSanitization() };
  }

  const evidence = normalizePlanningEvidence(rawEvidence);
  const changeSet = compilePlanningChangeSet(map, evidence, options);
  const paint = applyPlanningSurfacePaint(map, changeSet, options);

  const compiledTopologyCandidates = changeSet.candidates.filter((candidate) =>
    TOPOLOGY_OPERATIONS.has(String(candidate.planningOperation || "").toLowerCase())
  );
  const safeTopologyCandidates = preflightProtectedTargets(map, changeSet, compiledTopologyCandidates, options);
  const extendedCandidates = safeTopologyCandidates.filter((candidate) => EXTENDED_TOPOLOGY_KINDS.has(candidate.kind));
  const baseCandidates = safeTopologyCandidates.filter((candidate) => !EXTENDED_TOPOLOGY_KINDS.has(candidate.kind));

  const extended = applyExtendedTopologyChanges(map, extendedCandidates);
  const base = await reconcilePlanningTopology(map, {
    ...options,
    planningAuthorityEvidence: undefined,
    planningAuthorityEvidenceData: { geometryCandidates: baseCandidates, verticalObservations: [], materialObservations: [] }
  });
  const topology = mergeTopologySummaries(base, extended);

  // This is the authority bundle consumed later by integratePlanningAuthorityEvidence.
  // Keep only geometry decisions that the semantic compiler accepted and only
  // vertical labels whose nearest compatible target is a building/structure/ride.
  // Paths, roads and terrain never receive planning ground-elevation authority.
  const sanitized = buildTerrainSafeAuthorityEvidence(map, evidence, changeSet, options);
  options.planningAuthorityEvidenceData = sanitized.evidence;
  const authoritySanitization = sanitized.summary;

  map.planningChangeSet = changeSet;
  map.planningSurfacePaint = paint;
  map.planningAuthoritySanitization = authoritySanitization;
  return {
    ...topology,
    changeSet,
    paint,
    authoritySanitization,
    compiledCandidateCount: safeTopologyCandidates.length,
    status: topology.added || topology.replaced || topology.deleted || paint.applied
      ? "applied"
      : changeSet.counts.review ? "compiled-with-review-items" : topology.status
  };
}

export function applyPlanningSurfacePaint(map, changeSet, options = {}) {
  const result = emptyPaintSummary("processed");
  if (options.planningSurfacePaintMode === "off") {
    result.status = "disabled";
    return result;
  }
  for (const candidate of changeSet?.candidates || []) {
    if (candidate.planningOperation !== "paint" || candidate.kind !== "surface") continue;
    const material = String(candidate.compiledMaterial || candidate.tags?.surface || "").toLowerCase();
    const palette = surfaceMaterialPalette(material);
    if (!palette) {
      result.deferred += 1;
      result.changes.push({
        operation: "paint",
        sourceRef: candidateRef(candidate),
        material: material || null,
        status: "deferred-unsupported-ground-material",
        reason: "material-is-not-a-safe-built-in-ground-surface-palette"
      });
      continue;
    }
    if (!candidate.localGeometry || !map?.projector?.inverse) {
      result.rejected += 1;
      result.changes.push({ operation: "paint", sourceRef: candidateRef(candidate), material, status: "rejected", reason: "missing-georegistered-area" });
      continue;
    }
    const feature = planningPaintFeature(candidate, material, map, palette);
    map.features.push(feature);
    result.applied += 1;
    result.changes.push({
      operation: "paint",
      sourceRef: candidateRef(candidate),
      featureId: feature.id,
      material: palette.key,
      palette: clone(palette),
      status: "applied",
      terrainGeometryChanged: false,
      terrainElevationChanged: false
    });
  }
  result.status = result.applied
    ? (result.deferred || result.rejected ? "applied-with-deferred-items" : "applied")
    : result.deferred ? "deferred-material-palettes" : result.rejected ? "rejected" : "no-surface-paint";
  return result;
}

function preflightProtectedTargets(map, changeSet, candidates, options) {
  const result = [];
  for (const candidate of candidates) {
    const target = candidate.targetFeatureId
      ? (map.features || []).find((feature) => feature.id === candidate.targetFeatureId)
      : null;
    if (target && Number(target.authority?.rank ?? 100) >= PLANNING_AUTHORITY_RANK) {
      downgradeChangeSetToReview(changeSet, candidate, "higher-authority-feature-protected");
      continue;
    }
    if (candidate.planningOperation === "add") {
      const protectedMatch = bestProtectedKindMatch(candidate, map.features || [], options);
      if (protectedMatch?.accepted) {
        downgradeChangeSetToReview(changeSet, candidate, "add-blocked-by-higher-authority-match", protectedMatch.feature.id, protectedMatch.score);
        continue;
      }
    }
    result.push(candidate);
  }
  return result;
}

function applyExtendedTopologyChanges(map, candidates) {
  const summary = {
    schemaVersion: 1,
    status: "no-extended-topology-changes",
    added: 0,
    replaced: 0,
    deleted: 0,
    deferredMatched: 0,
    skipped: 0,
    changes: [],
    tombstones: []
  };
  for (const candidate of candidates || []) {
    const operation = String(candidate.planningOperation || "").toLowerCase();
    const targetIndex = candidate.targetFeatureId
      ? (map.features || []).findIndex((feature) => feature.id === candidate.targetFeatureId)
      : -1;
    const target = targetIndex >= 0 ? map.features[targetIndex] : null;

    if (operation === "add") {
      const added = planningTopologyFeature(candidate, map);
      map.features.push(added);
      summary.added += 1;
      summary.changes.push({ operation: "add", featureId: added.id, featureKind: added.kind, planningSourceRef: candidateRef(candidate), reason: "compiled-planning-gap-fill" });
      continue;
    }
    if (!target) {
      summary.skipped += 1;
      summary.changes.push({ operation: "skip", planningSourceRef: candidateRef(candidate), featureKind: candidate.kind, reason: "compiled-target-not-found" });
      continue;
    }
    if (Number(target.authority?.rank ?? 100) >= PLANNING_AUTHORITY_RANK) {
      summary.skipped += 1;
      summary.changes.push({ operation: "skip", planningSourceRef: candidateRef(candidate), featureId: target.id, featureKind: target.kind, reason: "compiled-target-higher-authority" });
      continue;
    }
    if (operation === "delete") {
      const [removed] = map.features.splice(targetIndex, 1);
      const tombstone = {
        featureId: removed.id,
        featureKind: removed.kind,
        featureName: removed.name || null,
        source: clone(removed.source || null),
        planningSourceRef: candidateRef(candidate),
        reason: "compiled-planning-delete",
        match: { method: "compiler-explicit-target", score: candidate.compilerDecision?.matchScore ?? 1 }
      };
      summary.deleted += 1;
      summary.tombstones.push(tombstone);
      summary.changes.push({ operation: "delete", ...tombstone });
      continue;
    }
    if (operation === "replace") {
      target.evidenceHistory ||= [];
      target.evidenceHistory.push({
        reason: "compiled-planning-topology-replace-prior",
        geometry: clone(target.geometry),
        localGeometry: clone(target.localGeometry),
        source: clone(target.source),
        authority: clone(target.authority)
      });
      target.geometry = candidate.geometry || geometryMapCoordinates(candidate.localGeometry, map.projector.inverse);
      target.localGeometry = clone(candidate.localGeometry);
      target.tags = { ...(target.tags || {}), ...(candidate.tags || {}) };
      target.authority = { ...(target.authority || {}), attributeGeometry: "planning-current-authority" };
      target.planningTopologyResolution = {
        operation: "replace",
        sourceRef: candidateRef(candidate),
        planningTemporal: clone(candidate.planningTemporal || null)
      };
      summary.replaced += 1;
      summary.changes.push({ operation: "replace", featureId: target.id, featureKind: target.kind, planningSourceRef: candidateRef(candidate), reason: "compiled-planning-replace" });
    }
  }
  if (summary.added || summary.replaced || summary.deleted) summary.status = "applied";
  return summary;
}

function buildTerrainSafeAuthorityEvidence(map, evidence, changeSet, options) {
  const acceptedChanges = new Map(
    (changeSet.changes || [])
      .filter((change) => ["add", "replace", "retain"].includes(change.operation) && change.featureKind && change.featureKind !== "surface")
      .filter((change) => change.sourceRef)
      .map((change) => [change.sourceRef, change])
  );
  const featuresById = new Map((map.features || []).filter((feature) => feature?.id).map((feature) => [feature.id, feature]));
  const featuresByPlanningSourceRef = new Map();
  for (const feature of map.features || []) {
    const sourceRef = feature?.planningTopologyResolution?.sourceRef;
    if (sourceRef && !featuresByPlanningSourceRef.has(sourceRef)) featuresByPlanningSourceRef.set(sourceRef, feature);
  }

  const geometryCandidates = [];
  let geometryRejectedMissingCanonicalTarget = 0;
  let geometryRejectedCanonicalKindMismatch = 0;
  for (const candidate of evidence.geometryCandidates || []) {
    const sourceRef = candidateRef(candidate);
    const change = acceptedChanges.get(sourceRef);
    if (!change) continue;

    const implementation = candidate.implementationCorroboration || candidate.planningTemporal?.implementationCorroboration || null;
    const targetId = change.targetFeatureId || change.featureId || featuresByPlanningSourceRef.get(sourceRef)?.id || implementation?.featureId || null;
    const target = targetId ? featuresById.get(targetId) : null;
    if (!target?.localGeometry) {
      geometryRejectedMissingCanonicalTarget += 1;
      continue;
    }
    if (change.featureKind && target.kind !== change.featureKind && !compatibleKinds(change.featureKind, target.kind)) {
      geometryRejectedCanonicalKindMismatch += 1;
      continue;
    }

    geometryCandidates.push({
      ...candidate,
      targetFeatureId: target.id,
      associationContract: {
        schemaVersion: 1,
        certifiedCurrentTarget: true,
        featureId: target.id,
        featureKind: target.kind,
        operation: change.operation,
        sourceRef,
        method: "compiled-current-planning-target",
        matchScore: change.matchScore ?? candidate.compilerDecision?.matchScore ?? implementation?.matchScore ?? null,
        secondScore: implementation?.secondScore ?? null
      }
    });
  }

  const verticalObservations = [];
  let rejectedGroundTargets = 0;
  let rejectedAmbiguous = 0;
  for (const observation of evidence.verticalObservations || []) {
    if (!isCurrentAuthority(observation)) continue;
    const match = matchPointObservation(
      observation,
      map.features || [],
      (kind) => ["building", "structure", "ride_track", "path", "road", "terrain_detail"].includes(String(kind || "")),
      options
    );
    if (!match.accepted) {
      rejectedAmbiguous += 1;
      continue;
    }
    if (!SAFE_VERTICAL_KINDS.has(match.feature.kind)) {
      rejectedGroundTargets += 1;
      continue;
    }
    verticalObservations.push(observation);
  }

  const materialObservations = (evidence.materialObservations || []).filter(isCurrentAuthority);
  const summary = {
    schemaVersion: 2,
    terrainElevationAuthority: false,
    terrainGeometryAuthority: false,
    geometryInput: evidence.geometryCandidates?.length || 0,
    geometryRetained: geometryCandidates.length,
    geometryRejectedBySemanticCompiler: Math.max(0, (evidence.geometryCandidates?.length || 0) - geometryCandidates.length - geometryRejectedMissingCanonicalTarget - geometryRejectedCanonicalKindMismatch),
    geometryRejectedMissingCanonicalTarget,
    geometryRejectedCanonicalKindMismatch,
    geometryCertifiedTargets: geometryCandidates.length,
    verticalInput: evidence.verticalObservations?.length || 0,
    verticalRetainedStructural: verticalObservations.length,
    verticalRejectedGroundTargets: rejectedGroundTargets,
    verticalRejectedAmbiguous: rejectedAmbiguous,
    materialRetained: materialObservations.length,
    policy: "planning-levels-may-describe-structures-and-rides-but-never-ground-terrain"
  };
  return {
    summary,
    evidence: {
      ...evidence,
      geometryCandidates,
      verticalObservations,
      materialObservations
    }
  };
}

function normalizePlanningEvidence(evidence) {
  const normalizeEntry = (entry) => ({ ...entry, classification: normalizePlanningClass(entry?.classification) });
  return {
    ...evidence,
    geometryCandidates: (evidence.geometryCandidates || []).map(normalizeEntry),
    verticalObservations: (evidence.verticalObservations || []).map(normalizeEntry),
    materialObservations: (evidence.materialObservations || []).map(normalizeEntry),
    drawingMetadata: (evidence.drawingMetadata || []).map(normalizeEntry)
  };
}

function normalizePlanningClass(value) {
  const normalized = String(value || "unknown").toLowerCase().trim().replace(/[\s-]+/g, "_");
  if (normalized === "landscape") return "landscape_plan";
  if (normalized === "demolition") return "demolition_plan";
  return normalized;
}

function bestProtectedKindMatch(candidate, features, options) {
  const eligible = (features || []).filter((feature) =>
    feature?.localGeometry && compatibleKinds(candidate.kind, feature.kind) && Number(feature.authority?.rank ?? 100) >= PLANNING_AUTHORITY_RANK
  );
  const scored = eligible.map((feature) => ({ feature, score: simpleGeometryMatchScore(candidate.localGeometry, feature.localGeometry) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score || String(a.feature.id).localeCompare(String(b.feature.id)));
  const best = scored[0];
  const threshold = Number(options.planningChangeSetMinMatchScore ?? 0.7);
  return best && best.score >= threshold ? { accepted: true, feature: best.feature, score: round(best.score) } : { accepted: false };
}

function simpleGeometryMatchScore(a, b) {
  const left = geometryBounds(a), right = geometryBounds(b);
  if (!left || !right) return NaN;
  const intersectionX = Math.max(0, Math.min(left.maxX, right.maxX) - Math.max(left.minX, right.minX));
  const intersectionZ = Math.max(0, Math.min(left.maxZ, right.maxZ) - Math.max(left.minZ, right.minZ));
  const areaLeft = Math.max(0.01, (left.maxX - left.minX) * (left.maxZ - left.minZ));
  const areaRight = Math.max(0.01, (right.maxX - right.minX) * (right.maxZ - right.minZ));
  const overlap = Math.min(1, intersectionX * intersectionZ / Math.min(areaLeft, areaRight));
  const centerLeft = [(left.minX + left.maxX) / 2, (left.minZ + left.maxZ) / 2];
  const centerRight = [(right.minX + right.maxX) / 2, (right.minZ + right.maxZ) / 2];
  const diagonal = Math.max(2, Math.hypot(left.maxX - left.minX, left.maxZ - left.minZ), Math.hypot(right.maxX - right.minX, right.maxZ - right.minZ));
  const distance = Math.hypot(centerLeft[0] - centerRight[0], centerLeft[1] - centerRight[1]);
  return Math.max(0, Math.min(1, 0.7 * overlap + 0.3 * Math.max(0, 1 - distance / Math.max(8, diagonal))));
}

function downgradeChangeSetToReview(changeSet, candidate, reason, targetFeatureId = null, matchScore = null) {
  const sourceRef = candidateRef(candidate);
  const operation = candidate.planningOperation;
  const record = (changeSet.changes || []).find((entry) => entry.sourceRef === sourceRef && entry.operation === operation);
  if (record) {
    record.operation = "review";
    record.reason = reason;
    if (targetFeatureId) record.targetFeatureId = targetFeatureId;
    if (matchScore != null) record.matchScore = matchScore;
  }
  if (changeSet.counts?.[operation] > 0) changeSet.counts[operation] -= 1;
  changeSet.counts.review = (changeSet.counts.review || 0) + 1;
  changeSet.candidates = (changeSet.candidates || []).filter((entry) => entry !== candidate);
  changeSet.status = "compiled-with-review-items";
}

function mergeTopologySummaries(base, extended) {
  const added = Number(base.added || 0) + Number(extended.added || 0);
  const replaced = Number(base.replaced || 0) + Number(extended.replaced || 0);
  const deleted = Number(base.deleted || 0) + Number(extended.deleted || 0);
  return {
    ...base,
    status: added || replaced || deleted ? "applied" : base.status,
    added,
    replaced,
    deleted,
    skipped: Number(base.skipped || 0) + Number(extended.skipped || 0),
    changes: [...(base.changes || []), ...(extended.changes || [])],
    tombstones: [...(base.tombstones || []), ...(extended.tombstones || [])],
    extendedTopology: extended
  };
}

function planningPaintFeature(candidate, material, map, palette) {
  const geometry = candidate.geometry || geometryMapCoordinates(candidate.localGeometry, map.projector.inverse);
  const sourceRef = candidateRef(candidate);
  return {
    id: `planning-paint:${safeId(sourceRef || material)}:${sha256({ geometry, material }).slice(0, 10)}`,
    name: candidate.name || candidate.label || null,
    kind: "surface",
    subtype: surfaceSubtype(material),
    tags: {
      ...(candidate.tags || {}),
      material,
      surface: material,
      "planning:paint_only": "yes",
      "terrain:geometry_mutable": "no"
    },
    materialPalette: { surface: clone(palette) },
    geometry,
    localGeometry: clone(candidate.localGeometry),
    vertical: { heightM: null, minHeightM: 0, elevationM: null, explicit: false },
    source: {
      provider: "Planning current-state authority",
      contentHash: candidate.contentHash || null,
      pageNumber: candidate.pageNumber || null,
      sourceRef,
      timestamp: candidate.planningTemporal?.observedAt || null
    },
    verification: { plan: "planning-current-authority", vertical: "terrain-source-locked" },
    authority: {
      layer: "planning-current-authority",
      rank: PLANNING_AUTHORITY_RANK,
      geometryLocked: true,
      worldGeometryAuthority: true,
      terrainGeometryAuthority: false
    },
    planningTopologyResolution: {
      operation: "paint",
      surfaceOnly: true,
      terrainGeometryChanged: false,
      terrainElevationChanged: false,
      sourceRef
    }
  };
}

function planningTopologyFeature(candidate, map) {
  const geometry = candidate.geometry || geometryMapCoordinates(candidate.localGeometry, map.projector.inverse);
  const sourceRef = candidateRef(candidate);
  const heightM = numberOrNull(candidate.heightM ?? candidate.properties?.height_m);
  return {
    id: `planning-current:${safeId(sourceRef || candidate.kind)}:${sha256({ geometry, kind: candidate.kind }).slice(0, 10)}`,
    name: candidate.name || candidate.label || candidate.properties?.name || null,
    kind: candidate.kind,
    subtype: candidate.subtype || candidate.properties?.subtype || `planning-${candidate.kind}`,
    tags: { ...(candidate.tags || candidate.properties?.tags || {}) },
    geometry,
    localGeometry: clone(candidate.localGeometry),
    vertical: {
      heightM,
      heightSource: heightM != null ? "planning-current-authority" : null,
      minHeightM: numberOrNull(candidate.minHeightM ?? candidate.properties?.min_height_m) ?? 0,
      elevationM: null,
      explicit: heightM != null
    },
    source: {
      provider: "Planning current-state authority",
      contentHash: candidate.contentHash || null,
      pageNumber: candidate.pageNumber || null,
      sourceRef,
      timestamp: candidate.planningTemporal?.observedAt || null
    },
    verification: { plan: "planning-current-authority", vertical: heightM != null ? "planning-current-authority" : "unknown" },
    authority: { layer: "planning-current-authority", rank: PLANNING_AUTHORITY_RANK, geometryLocked: true, worldGeometryAuthority: true },
    planningTopologyResolution: { operation: "add", sourceRef, planningTemporal: clone(candidate.planningTemporal || null) }
  };
}

function surfaceSubtype(material) {
  if (material === "grass") return "grass";
  if (material === "earth") return "earth";
  if (material === "stone") return "stone";
  if (material === "sand") return "sand";
  return "planning-surface";
}

async function loadAuthorityEvidence(options) {
  if (options.planningAuthorityEvidenceData) return options.planningAuthorityEvidenceData;
  if (!options.planningAuthorityEvidence) return null;
  return readJson(path.resolve(options.planningAuthorityEvidence));
}

function disabledChangeSet() {
  return {
    schemaVersion: 1,
    status: "disabled",
    terrainPolicy: { geometryMutable: false, elevationMutable: false, surfacePaintAllowed: true, rule: "planning-never-deforms-terrain" },
    input: { geometryCandidates: 0, materialObservations: 0 },
    counts: { add: 0, replace: 0, delete: 0, retain: 0, paint: 0, review: 0, ignored: 0 },
    changes: [],
    candidates: []
  };
}
function disabledSanitization() { return { schemaVersion: 1, terrainElevationAuthority: false, terrainGeometryAuthority: false, status: "disabled" }; }
function emptyPaintSummary(status) { return { schemaVersion: 1, status, applied: 0, deferred: 0, rejected: 0, changes: [], terrainGeometryChanged: false, terrainElevationChanged: false }; }
function compatibleKinds(requested, actual) { return requested === actual || [requested, actual].every((kind) => ["building", "structure"].includes(kind)); }
function isCurrentAuthority(entry) { return entry?.worldGeometryAuthority === true && entry?.planningTemporal?.state === "current"; }
function candidateRef(candidate) { return candidate?.id || (candidate?.contentHash ? `${candidate.contentHash}:p${candidate.pageNumber || 1}` : null); }
function numberOrNull(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function round(value) { const number = Number(value); return Number.isFinite(number) ? Math.round(number * 1000) / 1000 : null; }
function safeId(value) { return String(value || "planning").replace(/[^a-zA-Z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "planning"; }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
