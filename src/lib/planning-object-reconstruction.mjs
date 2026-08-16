import path from "node:path";
import { readJson } from "./io.mjs";

const SUPPORTED_BARRIERS = new Set(["fence", "acoustic_barrier", "railing", "boundary_wall"]);
const DEFAULT_OBJECT_CONFIDENCE_GATE = 0.88;

/**
 * Builds dimensioned planning-object models only after the spatial, temporal and
 * cross-document schedule gates have all succeeded. No generic dimensions are
 * invented here: a missing required schedule measurement defers the object.
 */
export async function reconstructPlanningObjects3d(map, options = {}) {
  const evidence = await loadPlanningObjectAuthorityEvidence(options);
  return reconstructPlanningObjects3dFromEvidence(evidence, map, options);
}

export function reconstructPlanningObjects3dFromEvidence(evidence, map = null, options = {}) {
  const candidates = evidence?.geometryCandidates || [];
  const model = {
    schemaVersion: 1,
    status: "processed",
    policy: {
      authoritativeRegisteredGeometryRequired: true,
      verifiedCurrentGeometryRequired: true,
      exactResolvedScheduleRequired: true,
      conflictingScheduleFailsClosed: true,
      missingRequiredDimensionsFailClosed: true,
      inferredDimensionsAllowed: false,
      terrainGeometryMutable: false,
      terrainElevationMutable: false,
      airClearingAllowed: false
    },
    objects: [],
    deferred: [],
    summary: {
      inputGeometryCandidates: candidates.length,
      authoritativeCurrentCandidates: 0,
      scheduleResolvedCandidates: 0,
      reconstructedObjects: 0,
      trees: 0,
      lightingColumns: 0,
      barriers: 0,
      deferredNotRegistered: 0,
      deferredNotCurrentAuthority: 0,
      deferredSchedule: 0,
      deferredUnsupported: 0,
      deferredMissingDimensions: 0
    }
  };

  const confidenceGate = Number(options.planningObjectReconstructionConfidenceGate ?? DEFAULT_OBJECT_CONFIDENCE_GATE);
  for (const candidate of candidates) {
    const gate = authorityGate(candidate, confidenceGate);
    if (!gate.accepted) {
      model.deferred.push(deferred(candidate, gate.reason));
      if (gate.reason === "planning-object-geometry-not-registered") model.summary.deferredNotRegistered += 1;
      else if (gate.reason === "planning-object-not-verified-current-authority") model.summary.deferredNotCurrentAuthority += 1;
      else if (/schedule/.test(gate.reason)) model.summary.deferredSchedule += 1;
      else model.summary.deferredUnsupported += 1;
      continue;
    }
    model.summary.authoritativeCurrentCandidates += 1;
    model.summary.scheduleResolvedCandidates += 1;

    const reconstructed = reconstructCandidate(candidate);
    if (!reconstructed.accepted) {
      model.deferred.push(deferred(candidate, reconstructed.reason));
      if (/missing|invalid/.test(reconstructed.reason)) model.summary.deferredMissingDimensions += 1;
      else model.summary.deferredUnsupported += 1;
      continue;
    }
    model.objects.push(reconstructed.value);
    model.summary.reconstructedObjects += 1;
    if (reconstructed.value.kind === "tree") model.summary.trees += 1;
    else if (reconstructed.value.kind === "lighting_column") model.summary.lightingColumns += 1;
    else if (reconstructed.value.kind === "barrier") model.summary.barriers += 1;
  }

  model.objects.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  model.deferred.sort((a, b) => String(a.candidateId || "").localeCompare(String(b.candidateId || "")) || String(a.reason).localeCompare(String(b.reason)));
  if (!model.objects.length) model.status = candidates.length ? "evidence-deferred" : "no-planning-object-evidence";
  if (map) map.planningObjects3d = model;
  return model;
}

export async function loadPlanningObjectAuthorityEvidence(options = {}) {
  const raw = options.planningAuthorityEvidenceData
    ? options.planningAuthorityEvidenceData
    : options.planningAuthorityEvidence
      ? await readJson(path.resolve(options.planningAuthorityEvidence))
      : null;
  return raw || null;
}

function authorityGate(candidate, confidenceGate) {
  if (!candidate?.planningObject) return { accepted: false, reason: "missing-planning-object-semantic" };
  if (!candidate.localGeometry || candidate.georegistrationStatus !== "registered" || candidate.georegistrationRequired !== false) {
    return { accepted: false, reason: "planning-object-geometry-not-registered" };
  }
  if (candidate.worldGeometryAuthority !== true || candidate.planningTemporal?.state !== "current") {
    return { accepted: false, reason: "planning-object-not-verified-current-authority" };
  }
  if (Number(candidate.planningObject.confidence || 0) < confidenceGate) {
    return { accepted: false, reason: "planning-object-semantic-confidence-below-gate" };
  }
  const fusion = candidate.planningObject.scheduleFusion;
  if (!fusion || fusion.status !== "resolved") {
    return { accepted: false, reason: fusion?.status === "conflict" ? "planning-object-schedule-conflict" : "planning-object-schedule-unresolved" };
  }
  if (!fusion.canonicalObjectCode || !fusion.sourceRecordCount) {
    return { accepted: false, reason: "planning-object-schedule-link-incomplete" };
  }
  return { accepted: true };
}

function reconstructCandidate(candidate) {
  const object = candidate.planningObject;
  const schedule = object.scheduleFusion?.scheduleAttributes || {};
  if (object.objectType === "tree") return reconstructTree(candidate, object, schedule);
  if (object.objectType === "lighting" && object.subtype === "lighting_column") return reconstructLightingColumn(candidate, object, schedule);
  if (object.objectType === "barrier") return reconstructBarrier(candidate, object, schedule);
  return { accepted: false, reason: "planning-object-family-not-supported-by-first-adapter" };
}

function reconstructTree(candidate, object, schedule) {
  const anchor = geometryRepresentativePoint(candidate.localGeometry);
  if (!anchor) return { accepted: false, reason: "tree-plan-anchor-missing" };
  const heightM = finiteInRange(schedule.heightM, 1, 80);
  if (heightM == null) return { accepted: false, reason: "tree-schedule-height-missing-or-invalid" };
  const crownSpreadM = finiteInRange(schedule.crownSpreadM, 0.5, 60);
  if (crownSpreadM == null) return { accepted: false, reason: "tree-schedule-crown-spread-missing-or-invalid" };
  const diameterMm = finiteInRange(schedule.diameterMm, 10, 5000);
  return {
    accepted: true,
    value: baseRecord(candidate, object, "tree", {
      anchor: { x: round(anchor[0]), z: round(anchor[1]) },
      heightM,
      crownSpreadM,
      trunkDiameterM: diameterMm == null ? null : round(diameterMm / 1000),
      species: schedule.species || null,
      shapeModel: "dimension-constrained-ellipsoid-canopy",
      dimensionSources: { height: "current-schedule", crownSpread: "current-schedule", trunkDiameter: diameterMm == null ? null : "current-schedule" }
    })
  };
}

function reconstructLightingColumn(candidate, object, schedule) {
  const anchor = geometryRepresentativePoint(candidate.localGeometry);
  if (!anchor) return { accepted: false, reason: "lighting-column-plan-anchor-missing" };
  const heightM = finiteInRange(schedule.heightM, 2, 40);
  if (heightM == null) return { accepted: false, reason: "lighting-column-schedule-height-missing-or-invalid" };
  return {
    accepted: true,
    value: baseRecord(candidate, object, "lighting_column", {
      anchor: { x: round(anchor[0]), z: round(anchor[1]) },
      heightM,
      ral: schedule.ral || null,
      constructionMaterial: explicitConstructionMaterial(object, schedule),
      shapeModel: "single-column-with-top-luminaire",
      dimensionSources: { height: "current-schedule" }
    })
  };
}

function reconstructBarrier(candidate, object, schedule) {
  if (!SUPPORTED_BARRIERS.has(object.subtype)) return { accepted: false, reason: "barrier-subtype-requires-dedicated-adapter" };
  const geometry = barrierGeometry(candidate.localGeometry);
  if (!geometry) return { accepted: false, reason: "barrier-plan-linework-missing" };
  const heightM = finiteInRange(schedule.heightM, 0.4, 15);
  if (heightM == null) return { accepted: false, reason: "barrier-schedule-height-missing-or-invalid" };
  const constructionMaterial = explicitConstructionMaterial(object, schedule);
  if (!constructionMaterial) return { accepted: false, reason: "barrier-schedule-construction-material-missing" };
  return {
    accepted: true,
    value: baseRecord(candidate, object, "barrier", {
      subtype: object.subtype,
      geometry,
      heightM,
      constructionMaterial,
      shapeModel: object.subtype === "fence" || object.subtype === "railing" ? "terrain-following-linear-barrier" : "terrain-following-solid-barrier",
      dimensionSources: { height: "current-schedule" }
    })
  };
}

function explicitConstructionMaterial(object, schedule) {
  const direct = normalizeConstructionMaterial(schedule?.constructionMaterial);
  if (direct) return direct;
  const text = [
    ...(object?.nearbyText || []),
    ...(object?.scheduleFusion?.sourceRecords || []).map((record) => record?.raw || "")
  ].join(" ").toLowerCase();
  if (/\b(?:timber|wood|wooden)\b/.test(text)) return "timber";
  if (/\b(?:galvanised|galvanized)?\s*steel\b|\b(?:metal|mesh|palisade|iron)\b/.test(text)) return "steel";
  if (/\bconcrete\b/.test(text)) return "concrete";
  if (/\bbrick(?:work)?\b/.test(text)) return "brick";
  if (/\b(?:stone|granite)\b/.test(text)) return "stone";
  return null;
}

function baseRecord(candidate, object, kind, values) {
  const fusion = object.scheduleFusion;
  return {
    schemaVersion: 1,
    id: `planning-object-3d:${candidate.id || object.id}`,
    candidateId: candidate.id || null,
    planningObjectId: object.id || null,
    objectCode: object.objectCode || null,
    canonicalObjectCode: fusion.canonicalObjectCode,
    kind,
    objectType: object.objectType,
    subtype: values.subtype || object.subtype || null,
    ...values,
    source: {
      contentHash: candidate.contentHash || null,
      pageNumber: candidate.pageNumber || null,
      planningTemporal: candidate.planningTemporal || null,
      registration: candidate.registration || null,
      scheduleRecords: fusion.sourceRecords || []
    },
    authority: {
      registeredGeometry: true,
      verifiedCurrentGeometry: true,
      exactResolvedSchedule: true,
      worldGeometryAuthority: true,
      terrainGeometryAuthority: false,
      terrainElevationAuthority: false
    },
    confidence: round(Math.min(Number(candidate.confidence ?? 1), Number(object.confidence ?? 1), Number(candidate.planningTemporal?.confidence ?? 1)))
  };
}

function barrierGeometry(geometry) {
  if (!geometry) return null;
  if (geometry.type === "LineString" && (geometry.coordinates || []).length >= 2) return clone(geometry);
  if (geometry.type === "MultiLineString" && (geometry.coordinates || []).some((line) => line.length >= 2)) return clone(geometry);
  if (geometry.type === "Polygon" && (geometry.coordinates?.[0] || []).length >= 3) return { type: "LineString", coordinates: clone(geometry.coordinates[0]) };
  if (geometry.type === "MultiPolygon" && (geometry.coordinates?.[0]?.[0] || []).length >= 3) return { type: "LineString", coordinates: clone(geometry.coordinates[0][0]) };
  return null;
}

function geometryRepresentativePoint(geometry) {
  if (!geometry) return null;
  if (geometry.type === "Point") return finitePair(geometry.coordinates);
  const points = flattenGeometryPoints(geometry);
  if (!points.length) return null;
  return [points.reduce((sum, point) => sum + point[0], 0) / points.length, points.reduce((sum, point) => sum + point[1], 0) / points.length];
}

function flattenGeometryPoints(geometry) {
  const result = [];
  const visit = (value) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
      result.push([Number(value[0]), Number(value[1])]);
      return;
    }
    for (const child of value) visit(child);
  };
  visit(geometry?.coordinates);
  return result;
}

function finitePair(value) {
  if (!Array.isArray(value) || !Number.isFinite(Number(value[0])) || !Number.isFinite(Number(value[1]))) return null;
  return [Number(value[0]), Number(value[1])];
}

function finiteInRange(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function normalizeConstructionMaterial(value) {
  const key = String(value || "").trim().toLowerCase();
  return ["timber", "steel", "concrete", "brick", "stone"].includes(key) ? key : null;
}

function deferred(candidate, reason) {
  return {
    candidateId: candidate?.id || null,
    planningObjectId: candidate?.planningObject?.id || null,
    objectCode: candidate?.planningObject?.objectCode || null,
    objectType: candidate?.planningObject?.objectType || null,
    subtype: candidate?.planningObject?.subtype || null,
    reason
  };
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
function round(value, places = 3) {
  const factor = 10 ** places;
  return Math.round(Number(value || 0) * factor) / factor;
}
