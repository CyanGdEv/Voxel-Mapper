import path from "node:path";
import { geometryMapCoordinates } from "./geo.mjs";
import { readJson, sha256 } from "./io.mjs";
import { compilePlanningChangeSet } from "./planning-changeset-compiler.mjs";
import { reconcilePlanningTopology } from "./osm-planning-reconciliation.mjs";

const TOPOLOGY_OPERATIONS = new Set(["add", "replace", "delete"]);
const PLANNING_AUTHORITY_RANK = 360;

/**
 * Compiles raw current-state planning evidence into explicit changes and then
 * delegates topology mutation to the existing, already-tested reconciler.
 * Surface paint is handled separately and cannot write elevation/terrain shape.
 */
export async function reconcileCompiledPlanningChanges(map, options = {}) {
  const evidence = await loadAuthorityEvidence(options);
  if (!evidence) {
    const topology = await reconcilePlanningTopology(map, options);
    const changeSet = disabledChangeSet();
    map.planningChangeSet = changeSet;
    return { ...topology, changeSet, paint: emptyPaintSummary("disabled") };
  }

  const changeSet = compilePlanningChangeSet(map, evidence, options);
  const paint = applyPlanningSurfacePaint(map, changeSet, options);
  const geometryCandidates = changeSet.candidates.filter((candidate) =>
    TOPOLOGY_OPERATIONS.has(String(candidate.planningOperation || "").toLowerCase())
  );
  const topology = await reconcilePlanningTopology(map, {
    ...options,
    planningAuthorityEvidence: undefined,
    planningAuthorityEvidenceData: { geometryCandidates, verticalObservations: [], materialObservations: [] }
  });

  map.planningChangeSet = changeSet;
  map.planningSurfacePaint = paint;
  return {
    ...topology,
    changeSet,
    paint,
    compiledCandidateCount: geometryCandidates.length,
    status: topology.added || topology.replaced || topology.deleted || paint.applied
      ? "applied"
      : changeSet.counts.review ? "compiled-with-review-items" : topology.status
  };
}

export function applyPlanningSurfacePaint(map, changeSet, options = {}) {
  const result = emptyPaintSummary("processed");
  const supported = options.planningSurfacePaintMode === "off" ? new Set() : new Set(["grass", "earth", "stone"]);
  for (const candidate of changeSet?.candidates || []) {
    if (candidate.planningOperation !== "paint" || candidate.kind !== "surface") continue;
    const material = String(candidate.compiledMaterial || candidate.tags?.surface || "").toLowerCase();
    if (!supported.has(material)) {
      result.deferred += 1;
      result.changes.push({
        operation: "paint",
        sourceRef: candidateRef(candidate),
        material: material || null,
        status: "deferred-renderer-palette",
        reason: "exact-surface-material-not-yet-supported-by-base-surface-raster"
      });
      continue;
    }
    if (!candidate.localGeometry || !map?.projector?.inverse) {
      result.rejected += 1;
      result.changes.push({ operation: "paint", sourceRef: candidateRef(candidate), material, status: "rejected", reason: "missing-georegistered-area" });
      continue;
    }
    const feature = planningPaintFeature(candidate, material, map);
    map.features.push(feature);
    result.applied += 1;
    result.changes.push({
      operation: "paint",
      sourceRef: candidateRef(candidate),
      featureId: feature.id,
      material,
      status: "applied",
      terrainGeometryChanged: false,
      terrainElevationChanged: false
    });
  }
  result.status = result.applied ? "applied" : result.deferred ? "deferred-material-palettes" : result.rejected ? "rejected" : "no-surface-paint";
  return result;
}

function planningPaintFeature(candidate, material, map) {
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

function surfaceSubtype(material) {
  if (material === "grass") return "grass";
  if (material === "earth") return "earth";
  if (material === "stone") return "stone";
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
function emptyPaintSummary(status) { return { schemaVersion: 1, status, applied: 0, deferred: 0, rejected: 0, changes: [], terrainGeometryChanged: false, terrainElevationChanged: false }; }
function candidateRef(candidate) { return candidate?.id || (candidate?.contentHash ? `${candidate.contentHash}:p${candidate.pageNumber || 1}` : null); }
function safeId(value) { return String(value || "planning").replace(/[^a-zA-Z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "planning"; }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
