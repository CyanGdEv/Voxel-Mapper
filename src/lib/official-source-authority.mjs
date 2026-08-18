import { geometryBounds, lineCells } from "./geo.mjs";

const GEOMETRY_POLICIES = Object.freeze([
  policy(/os building features|mastermap topography/i, ["building"], 360, "official-building-geometry"),
  policy(/os structure features|mastermap topography/i, ["structure", "barrier"], 355, "official-structure-geometry"),
  policy(/os transport features|mastermap topography/i, ["path", "road", "rail", "structure"], 350, "official-transport-geometry"),
  policy(/os land features/i, ["surface", "vegetation"], 345, "official-land-geometry"),
  policy(/os land use features/i, ["surface", "amenity", "park_boundary"], 340, "official-land-use-geometry"),
  policy(/os openmap\s*-?\s*local/i, ["building", "path", "road", "rail", "water", "surface"], 315, "official-openmap-local-geometry"),
  policy(/os open greenspace/i, ["surface", "vegetation", "amenity", "park_boundary"], 310, "official-greenspace-geometry")
]);

const CONTEXT_POLICIES = Object.freeze([
  { match: /os open roads/i, rank: 260, role: "transport-topology-corroboration", kinds: new Set(["road"]) },
  { match: /os open uprn/i, rank: 255, role: "property-identity", kinds: new Set(["detail", "amenity", "building"]) },
  { match: /os terrain 50/i, rank: 240, role: "terrain-validation", kinds: new Set(["terrain_detail", "surface"]) },
  { match: /planning data|planning\.data\.gov\.uk/i, rank: 330, role: "planning-constraint-context", kinds: new Set(["surface", "building", "detail", "park_boundary"]) }
]);

export const AUTHORITATIVE_SOURCE_CATALOG = Object.freeze([
  { id: "os-building-features", name: "OS Building Features", role: "building geometry/attributes", geometryAuthority: true },
  { id: "os-structure-features", name: "OS Structure Features", role: "structures, bridges, walls and barriers", geometryAuthority: true },
  { id: "os-transport-features", name: "OS Transport Features", role: "roads, tracks, railways, paths and transport structures", geometryAuthority: true },
  { id: "os-land-features", name: "OS Land Features", role: "topographic land-cover geometry", geometryAuthority: true },
  { id: "os-land-use-features", name: "OS Land Use Features", role: "site/land-use geometry and access context", geometryAuthority: true },
  { id: "os-openmap-local", name: "OS OpenMap - Local", role: "open detailed topographic fallback above OSM", geometryAuthority: true },
  { id: "os-open-greenspace", name: "OS Open Greenspace", role: "public greenspace extents/access", geometryAuthority: true },
  { id: "os-open-roads", name: "OS Open Roads", role: "road network topology/corroboration", geometryAuthority: false },
  { id: "os-open-uprn", name: "OS Open UPRN", role: "property identity/matching", geometryAuthority: false },
  { id: "os-terrain-50", name: "OS Terrain 50", role: "terrain contour/breakline validation", geometryAuthority: false },
  { id: "planning-data-england", name: "Planning Data England", role: "planning constraints/current-state context", geometryAuthority: false }
]);

/**
 * Demotes OSM to a true fallback where a recognized official dataset contains
 * a clear same-feature geometry observation. Ambiguous overlaps fail closed and
 * are retained side-by-side. Planning/verified overrides keep their existing
 * higher authority and are never removed here.
 */
export function applyOfficialSourceAuthority(map, options = {}) {
  const toleranceM = Math.max(1, Number(options.sourceFusionToleranceM ?? 3));
  const features = map?.features || [];
  const summary = {
    schemaVersion: 1,
    status: "active",
    recognizedOfficialFeatures: 0,
    geometryAuthoritativeFeatures: 0,
    contextOnlyFeatures: 0,
    osmFallbackFeaturesRemoved: 0,
    ambiguousOverlapsRetained: 0,
    byPolicy: {},
    policy: {
      planningAndVerifiedRemainHigher: true,
      osmRole: "fallback/context when stronger compatible geometry exists",
      ambiguousOverlap: "retain both",
      coarseOfficialProducts: "identity/topology/validation only; do not replace detailed geometry"
    }
  };

  const official = [];
  for (const feature of features) {
    if (!feature || isOsm(feature) || Number(feature.authority?.rank || 0) >= 400) continue;
    const resolved = resolvePolicy(feature);
    if (!resolved) continue;
    summary.recognizedOfficialFeatures += 1;
    increment(summary.byPolicy, resolved.layer);
    feature.authority = {
      ...(feature.authority || {}),
      layer: resolved.layer,
      rank: Math.max(Number(feature.authority?.rank || 0), resolved.rank),
      geometryLocked: false,
      geometryRole: resolved.geometryAuthority ? "authoritative-base" : resolved.role
    };
    feature.source ||= {};
    feature.source.authorityRole = feature.authority.geometryRole;
    feature.source.osmFallbackPolicy = resolved.geometryAuthority ? "supersede-clear-duplicate" : "corroboration-only";
    if (resolved.geometryAuthority) {
      summary.geometryAuthoritativeFeatures += 1;
      official.push(feature);
    } else {
      summary.contextOnlyFeatures += 1;
    }
  }

  const removeIds = new Set();
  for (const source of official) {
    for (const candidate of features) {
      if (!isOsm(candidate) || removeIds.has(candidate.id)) continue;
      if (candidate.kind !== source.kind || !compatibleIdentity(source, candidate)) continue;
      const confidence = duplicateConfidence(source, candidate, toleranceM);
      if (confidence >= 0.72) {
        removeIds.add(candidate.id);
        source.source ||= {};
        source.source.supersedes ||= [];
        source.source.supersedes.push(candidate.id);
      } else if (confidence >= 0.35) {
        summary.ambiguousOverlapsRetained += 1;
      }
    }
  }

  if (removeIds.size) {
    map.features = features.filter((feature) => !removeIds.has(feature.id));
    summary.osmFallbackFeaturesRemoved = removeIds.size;
  }
  if (!summary.recognizedOfficialFeatures) summary.status = "no-recognized-official-features";
  map.sourceFusion ||= {};
  map.sourceFusion.officialAuthority = summary;
  return summary;
}

export function resolveOfficialSourcePolicy(feature) {
  return resolvePolicy(feature);
}

function resolvePolicy(feature) {
  const text = `${feature?.source?.provider || ""} ${feature?.source?.dataset || ""} ${feature?.source?.sourceUrl || ""}`;
  for (const entry of GEOMETRY_POLICIES) {
    if (entry.match.test(text) && entry.kinds.has(feature.kind)) return entry;
  }
  for (const entry of CONTEXT_POLICIES) {
    if (entry.match.test(text) && entry.kinds.has(feature.kind)) return { ...entry, geometryAuthority: false };
  }
  return null;
}

function policy(match, kinds, rank, layer) {
  return Object.freeze({ match, kinds: new Set(kinds), rank, layer, role: "authoritative-base", geometryAuthority: true });
}

function compatibleIdentity(a, b) {
  const nameA = normalize(a?.name), nameB = normalize(b?.name);
  if (nameA && nameB && nameA !== nameB) return false;
  if (["surface", "vegetation", "structure", "barrier"].includes(a.kind)) {
    const typeA = normalize(a?.subtype), typeB = normalize(b?.subtype);
    if (typeA && typeB && !broadlyCompatibleSubtype(typeA, typeB)) return false;
  }
  return true;
}

function duplicateConfidence(a, b, toleranceM) {
  const ga = a?.localGeometry, gb = b?.localGeometry;
  if (!ga || !gb) return 0;
  const polygons = new Set(["Polygon", "MultiPolygon"]);
  const lines = new Set(["LineString", "MultiLineString"]);
  if (polygons.has(ga.type) && polygons.has(gb.type)) return polygonOverlapScore(ga, gb, toleranceM);
  if (lines.has(ga.type) && lines.has(gb.type)) return lineOverlapScore(ga, gb, toleranceM);
  return 0;
}

function polygonOverlapScore(a, b, toleranceM) {
  const x = geometryBounds(a), y = geometryBounds(b);
  const ix = Math.max(0, Math.min(x.maxX, y.maxX) - Math.max(x.minX, y.minX));
  const iz = Math.max(0, Math.min(x.maxZ, y.maxZ) - Math.max(x.minZ, y.minZ));
  const intersection = ix * iz;
  const areaA = Math.max(1, (x.maxX - x.minX) * (x.maxZ - x.minZ));
  const areaB = Math.max(1, (y.maxX - y.minX) * (y.maxZ - y.minZ));
  if (!intersection) {
    const gapX = Math.max(0, Math.max(x.minX, y.minX) - Math.min(x.maxX, y.maxX));
    const gapZ = Math.max(0, Math.max(x.minZ, y.minZ) - Math.min(x.maxZ, y.maxZ));
    return Math.hypot(gapX, gapZ) <= toleranceM ? 0.35 : 0;
  }
  const iou = intersection / Math.max(1, areaA + areaB - intersection);
  const containment = intersection / Math.max(1, Math.min(areaA, areaB));
  return Math.max(iou, containment * 0.9);
}

function lineOverlapScore(a, b, toleranceM) {
  const cellsA = new Set(flatLineCells(a, Math.max(1, toleranceM * 2)).map(cellKey));
  const cellsB = new Set(flatLineCells(b, Math.max(1, toleranceM * 2)).map(cellKey));
  if (!cellsA.size || !cellsB.size) return 0;
  let intersection = 0;
  for (const key of cellsA) if (cellsB.has(key)) intersection += 1;
  return intersection / Math.max(1, Math.min(cellsA.size, cellsB.size));
}

function flatLineCells(geometry, width) {
  if (geometry.type === "LineString") return lineCells(geometry.coordinates || [], width);
  const unique = new Map();
  for (const line of geometry.coordinates || []) {
    for (const cell of lineCells(line, width)) unique.set(cellKey(cell), cell);
  }
  return [...unique.values()];
}

function broadlyCompatibleSubtype(a, b) {
  if (a === b) return true;
  const green = /grass|green|park|garden|wood|forest|scrub|vegetation/;
  const built = /paved|hard|concrete|asphalt|road|path|pedestrian/;
  return (green.test(a) && green.test(b)) || (built.test(a) && built.test(b));
}

function isOsm(feature) {
  return feature?.source?.provider === "OpenStreetMap" || String(feature?.id || "").startsWith("osm:");
}
function normalize(value) { return String(value || "").trim().toLowerCase(); }
function cellKey(cell) { return `${cell[0]},${cell[1]}`; }
function increment(target, key) { target[key] = Number(target[key] || 0) + 1; }
