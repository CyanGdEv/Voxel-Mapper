import { deriveSurfaceStyle } from "./fidelity.mjs";
import { surfaceMaterialPalette } from "./material-palettes.mjs";

const DEFAULT_LINE_TOLERANCE_M = 5;
const DEFAULT_AREA_EDGE_TOLERANCE_M = 3;
const DEFAULT_AMBIGUITY_GAP = 0.08;
const DEFAULT_MIN_SCORE = 0.62;

/**
 * Reattaches certified planning surface materials to canonical path/road
 * features immediately before rasterization. Planning topology replacement
 * intentionally keeps the original feature identity, which historically meant
 * an OSM path could receive planning geometry while retaining its stale OSM
 * surface tag. Material labels on linear paths were also never eligible for the
 * old polygon-only association rule.
 *
 * This pass is fail-closed: only current authority candidates/observations from
 * the same drawing page are considered, labels must be inside/near the accepted
 * geometry, and competing materials inside the ambiguity gap are rejected.
 */
export function applyPlanningRouteMaterials(map, options = {}) {
  const result = emptySummary();
  const evidence = options?.planningAuthorityEvidenceData;
  if (!Array.isArray(map?.features) || !evidence) {
    result.status = "no-planning-authority-evidence";
    return result;
  }

  const candidates = (evidence.geometryCandidates || []).filter((candidate) =>
    isCurrentAuthority(candidate) && ["path", "road"].includes(String(candidate.kind || candidate.featureKind || "")) && candidate.localGeometry
  );
  const observations = (evidence.materialObservations || []).filter((entry) =>
    isCurrentAuthority(entry) && surfaceMaterialPalette(entry.material)
  );
  result.currentRouteCandidates = candidates.length;
  result.currentSurfaceObservations = observations.length;

  const candidatesByTarget = new Map();
  for (const candidate of candidates) {
    const targetId = candidate.targetFeatureId || candidate.associationContract?.featureId || null;
    if (!targetId) continue;
    if (!candidatesByTarget.has(targetId)) candidatesByTarget.set(targetId, []);
    candidatesByTarget.get(targetId).push(candidate);
  }

  for (const feature of map.features) {
    if (!["path", "road"].includes(feature?.kind) || !feature.localGeometry) continue;
    const routeCandidates = candidatesByTarget.get(feature.id) || [];
    const sourceRef = feature.planningTopologyResolution?.sourceRef || null;
    if (sourceRef) {
      for (const candidate of candidates) {
        if (candidateRef(candidate) !== sourceRef || routeCandidates.includes(candidate)) continue;
        routeCandidates.push(candidate);
      }
    }
    if (!routeCandidates.length) continue;
    result.routeFeaturesConsidered += 1;

    const matches = routeCandidates
      .map((candidate) => associateCandidateMaterial(candidate, observations, options))
      .filter((entry) => entry.accepted)
      .sort(compareMatches);
    if (!matches.length) {
      result.unresolved += 1;
      continue;
    }
    const best = matches[0];
    const second = matches.find((entry) => entry.material !== best.material);
    const gap = Number(options.planningRouteMaterialAmbiguityGap ?? DEFAULT_AMBIGUITY_GAP);
    if (second && best.score - second.score < gap) {
      result.ambiguous += 1;
      result.changes.push({
        featureId: feature.id,
        status: "rejected-ambiguous-material",
        best: compactMatch(best),
        competing: compactMatch(second)
      });
      continue;
    }

    const palette = surfaceMaterialPalette(best.material);
    if (!palette) {
      result.unsupported += 1;
      continue;
    }
    feature.tags ||= {};
    feature.tags.material = palette.key;
    feature.tags.surface = palette.key;
    feature.materialPalette ||= {};
    feature.materialPalette.surface = clone(palette);
    feature.planningSurfaceMaterial = {
      schemaVersion: 1,
      material: palette.key,
      sourceRef: best.sourceRef,
      candidateRef: best.candidateRef,
      score: round(best.score),
      distanceM: round(best.distanceM),
      confidence: round(best.confidence),
      method: best.method,
      authorityLayer: "planning-current-authority"
    };
    // Fidelity normally runs before compilation. Refresh only this route's
    // surface style so the newly restored planning material reaches the raster.
    feature.surfaceStyle = deriveSurfaceStyle(feature, options);
    if (feature.fidelity?.path) feature.fidelity.path.surfaceStyle = feature.surfaceStyle;
    result.applied += 1;
    result.byMaterial[palette.key] = (result.byMaterial[palette.key] || 0) + 1;
    result.changes.push({
      featureId: feature.id,
      status: "applied",
      material: palette.key,
      sourceRef: best.sourceRef,
      method: best.method,
      distanceM: round(best.distanceM),
      score: round(best.score)
    });
  }

  result.status = result.applied
    ? (result.ambiguous || result.unresolved ? "applied-with-deferred-routes" : "applied")
    : result.routeFeaturesConsidered ? "no-unambiguous-route-materials" : "no-current-planning-routes";
  map.planningRouteMaterials = result;
  return result;
}

function associateCandidateMaterial(candidate, observations, options) {
  const direct = String(candidate.compiledMaterial || candidate.tags?.surface || candidate.tags?.material || "").trim();
  if (surfaceMaterialPalette(direct)) {
    return {
      accepted: true,
      material: surfaceMaterialPalette(direct).key,
      confidence: Math.max(0.9, Number(candidate.confidence || 0)),
      score: 1,
      distanceM: 0,
      sourceRef: candidateRef(candidate),
      candidateRef: candidateRef(candidate),
      method: "compiled-current-planning-material"
    };
  }

  const geometry = candidate.localGeometry;
  const area = ["Polygon", "MultiPolygon"].includes(geometry?.type);
  const tolerance = area
    ? Math.max(0.5, Number(options.planningAreaMaterialEdgeToleranceM ?? DEFAULT_AREA_EDGE_TOLERANCE_M))
    : Math.max(0.5, Number(options.planningRouteMaterialToleranceM ?? DEFAULT_LINE_TOLERANCE_M));
  const minimum = Number(options.planningRouteMaterialMinScore ?? DEFAULT_MIN_SCORE);
  const samePage = observations.filter((entry) =>
    (!candidate.contentHash || !entry.contentHash || candidate.contentHash === entry.contentHash) &&
    (!candidate.pageNumber || !entry.pageNumber || Number(candidate.pageNumber) === Number(entry.pageNumber))
  );
  const ranked = [];
  for (const observation of samePage) {
    const point = [Number(observation.localX), Number(observation.localZ)];
    if (!point.every(Number.isFinite)) continue;
    const distanceM = distancePointToGeometry(point, geometry);
    if (!Number.isFinite(distanceM) || distanceM > tolerance) continue;
    const confidence = clamp(Number(observation.confidence || 0));
    const score = confidence - 0.16 * Math.min(1, distanceM / tolerance);
    if (score < minimum) continue;
    ranked.push({
      accepted: true,
      material: surfaceMaterialPalette(observation.material).key,
      confidence,
      score,
      distanceM,
      sourceRef: candidateRef(observation),
      candidateRef: candidateRef(candidate),
      method: area && distanceM === 0 ? "planning-material-label-inside-area" : "planning-material-label-near-route"
    });
  }
  ranked.sort(compareMatches);
  if (!ranked.length) return { accepted: false };
  const best = ranked[0];
  const competing = ranked.find((entry) => entry.material !== best.material);
  const gap = Number(options.planningRouteMaterialAmbiguityGap ?? DEFAULT_AMBIGUITY_GAP);
  if (competing && best.score - competing.score < gap) return { accepted: false, ambiguous: true };
  return best;
}

function distancePointToGeometry(point, geometry) {
  if (geometry?.type === "LineString") return distancePointToLine(point, geometry.coordinates || []);
  if (geometry?.type === "MultiLineString") return Math.min(...(geometry.coordinates || []).map((line) => distancePointToLine(point, line)));
  if (geometry?.type === "Polygon") return distancePointToPolygon(point, geometry.coordinates || []);
  if (geometry?.type === "MultiPolygon") return Math.min(...(geometry.coordinates || []).map((polygon) => distancePointToPolygon(point, polygon)));
  return Infinity;
}

function distancePointToPolygon(point, rings) {
  if (!rings?.length) return Infinity;
  if (pointInPolygon(point, rings)) return 0;
  return Math.min(...rings.map((ring) => distancePointToLine(point, ring)));
}

function pointInPolygon([x, z], rings) {
  if (!rings?.length || !pointInRing(x, z, rings[0])) return false;
  return !rings.slice(1).some((ring) => pointInRing(x, z, ring));
}

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    const crosses = (zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / ((zj - zi) || Number.EPSILON) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function distancePointToLine(point, line) {
  if (!Array.isArray(line) || line.length < 2) return Infinity;
  let best = Infinity;
  for (let index = 1; index < line.length; index += 1) {
    best = Math.min(best, pointSegmentDistance(point, line[index - 1], line[index]));
  }
  return best;
}

function pointSegmentDistance(point, from, to) {
  const dx = Number(to?.[0]) - Number(from?.[0]);
  const dz = Number(to?.[1]) - Number(from?.[1]);
  const length2 = dx * dx + dz * dz;
  if (!(length2 > 0)) return Math.hypot(point[0] - Number(from?.[0]), point[1] - Number(from?.[1]));
  const fraction = Math.max(0, Math.min(1,
    ((point[0] - Number(from[0])) * dx + (point[1] - Number(from[1])) * dz) / length2
  ));
  return Math.hypot(
    point[0] - (Number(from[0]) + dx * fraction),
    point[1] - (Number(from[1]) + dz * fraction)
  );
}

function compareMatches(a, b) {
  return Number(b.score || 0) - Number(a.score || 0) ||
    Number(a.distanceM || 0) - Number(b.distanceM || 0) ||
    String(a.material || "").localeCompare(String(b.material || ""));
}

function compactMatch(value) {
  return {
    material: value.material,
    score: round(value.score),
    distanceM: round(value.distanceM),
    sourceRef: value.sourceRef
  };
}

function candidateRef(candidate) {
  return candidate?.id || (candidate?.contentHash ? `${candidate.contentHash}:p${candidate.pageNumber || 1}` : null);
}
function isCurrentAuthority(entry) { return entry?.worldGeometryAuthority === true && entry?.planningTemporal?.state === "current"; }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function clamp(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }
function round(value) { const number = Number(value); return Number.isFinite(number) ? Math.round(number * 1000) / 1000 : null; }
function emptySummary() {
  return {
    schemaVersion: 1,
    status: "not-run",
    currentRouteCandidates: 0,
    currentSurfaceObservations: 0,
    routeFeaturesConsidered: 0,
    applied: 0,
    unresolved: 0,
    ambiguous: 0,
    unsupported: 0,
    byMaterial: {},
    changes: [],
    policy: {
      currentPlanningOnly: true,
      sameDrawingPageRequired: true,
      linearPathLabelsMayAssociateByBoundedDistance: true,
      ambiguityFailsClosed: true,
      terrainGeometryMutable: false,
      terrainElevationMutable: false
    }
  };
}
