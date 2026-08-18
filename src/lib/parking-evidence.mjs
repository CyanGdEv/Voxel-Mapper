import { pointInRing, polygonScanlineSpans } from "./geo.mjs";

const AREA_TYPES = new Set(["Polygon", "MultiPolygon"]);

/**
 * Promote parking out of the generic OSM amenity bucket. Surface car parks are
 * represented as drivable area roads so verified-current planning/official
 * geometry can replace the lower-authority OSM footprint through the existing
 * topology reconciler. Individual spaces remain surface evidence and are never
 * procedurally invented from a car-park outline.
 */
export function normalizeParkingFeatures(map) {
  const summary = {
    schemaVersion: 1,
    status: "complete",
    areas: 0,
    bays: 0,
    aisles: 0,
    entrances: 0,
    structuredParkingRetained: 0,
    osmFallbackAreas: 0,
    strongerAuthorityAreas: 0,
    explicitBayCoverageAreas: 0,
    policy: {
      osmRole: "fallback footprint/detail only",
      inventedBayGridAllowed: false,
      planningAndOfficialGeometryMaySupersedeOsm: true
    }
  };

  const features = map?.features || [];
  for (const feature of features) {
    const tags = feature?.tags || {};
    const amenity = norm(tags.amenity);
    const parking = norm(tags.parking);
    const service = norm(tags.service);
    const area = AREA_TYPES.has(feature?.localGeometry?.type);

    if (amenity === "parking" && area) {
      if (["multi-storey", "underground", "rooftop"].includes(parking)) {
        feature.parkingEvidence = parkingEvidence(feature, "structured", parking || "structured_parking");
        summary.structuredParkingRetained += 1;
        continue;
      }
      feature.kind = "road";
      feature.subtype = "parking_area";
      feature.tags["area:highway"] ||= "parking";
      feature.parkingEvidence = parkingEvidence(feature, "area", parking || "surface_parking");
      summary.areas += 1;
      if (isOsm(feature)) summary.osmFallbackAreas += 1;
      else summary.strongerAuthorityAreas += 1;
      continue;
    }

    if (amenity === "parking_space" && area) {
      feature.kind = "surface";
      feature.subtype = parkingBaySubtype(tags);
      feature.parkingEvidence = parkingEvidence(feature, "bay", feature.subtype);
      summary.bays += 1;
      continue;
    }

    if (amenity === "parking_entrance") {
      feature.kind = "detail";
      feature.subtype = "parking_entrance";
      feature.parkingEvidence = parkingEvidence(feature, "entrance", "parking_entrance");
      summary.entrances += 1;
      continue;
    }

    if (feature?.kind === "road" && service === "parking_aisle") {
      feature.subtype = "parking_aisle";
      feature.parkingEvidence = parkingEvidence(feature, "aisle", "parking_aisle");
      summary.aisles += 1;
    }
  }

  const areas = features.filter((feature) => feature?.parkingEvidence?.role === "area" && AREA_TYPES.has(feature.localGeometry?.type));
  const bays = features.filter((feature) => feature?.parkingEvidence?.role === "bay" && AREA_TYPES.has(feature.localGeometry?.type));
  for (const area of areas) {
    const childBays = bays.filter((bay) => geometryCenterInside(bay.localGeometry, area.localGeometry));
    area.parkingEvidence.explicitBayFeatureIds = childBays.map((bay) => bay.id).filter(Boolean);
    area.parkingEvidence.explicitBayCount = childBays.length;
    if (childBays.length) summary.explicitBayCoverageAreas += 1;
  }

  map.parkingEvidence = summary;
  return summary;
}

/**
 * Convert planning parking semantics into canonical kinds before the generic
 * planning compiler sees them. The conversion grants no authority; normal
 * georegistration/currentness gates still decide whether the candidate can act.
 */
export function preparePlanningParkingEvidence(evidence = {}) {
  const candidates = (evidence.geometryCandidates || []).map((candidate) => {
    const semantic = parkingSemantic(candidate);
    if (!semantic) return candidate;
    const copy = { ...candidate, tags: { ...(candidate.tags || candidate.properties?.tags || {}) } };
    copy.tags["planning:parking_semantic"] = semantic;
    copy.parkingEvidence = {
      schemaVersion: 1,
      source: "planning-pdf-parking-semantic",
      role: semanticRole(semantic),
      confidence: Math.max(Number(candidate.confidence || 0), parkingConfidence(semantic)),
      worldGeometryAuthority: candidate.worldGeometryAuthority === true,
      georegistrationRequired: candidate.georegistrationStatus !== "registered",
      temporalResolutionRequired: candidate?.planningTemporal?.state !== "current",
      inventedBayGridAllowed: false
    };
    if (semantic === "parking_area" || semantic === "coach_park") {
      copy.kind = "road";
      copy.featureKind = "road";
      copy.subtype = semantic;
      copy.semantic = "site-feature";
      copy.tags["area:highway"] = "parking";
    } else if (semantic === "parking_aisle") {
      copy.kind = "road";
      copy.featureKind = "road";
      copy.subtype = "parking_aisle";
      copy.semantic = "site-route";
      copy.tags.service = "parking_aisle";
    } else {
      copy.kind = "surface";
      copy.featureKind = "surface";
      copy.subtype = semantic;
      copy.semantic = "site-feature";
    }
    copy.properties = {
      ...(candidate.properties || {}),
      kind: copy.kind,
      subtype: copy.subtype,
      tags: copy.tags
    };
    return copy;
  });
  return { ...evidence, geometryCandidates: candidates };
}

/**
 * Render only explicitly evidenced parking-space outlines. A parking-area
 * polygon alone never synthesizes bays. Markings replace the existing top
 * surface block and do not flatten/cut/fill terrain.
 */
export function renderParkingMarkings(compilation, { map, sources } = {}) {
  const stats = {
    schemaVersion: 1,
    status: "complete",
    parkingAreas: 0,
    explicitBayFeatures: 0,
    markedBayFeatures: 0,
    markingCells: 0,
    operations: 0,
    estimatedBlocks: 0,
    inferredBayFeatures: 0,
    osmFallbackAreas: 0,
    strongerAuthorityAreas: 0,
    policy: {
      inventedBayGridAllowed: false,
      terrainGeometryMutable: false,
      terrainElevationMutable: false,
      markingRequiresExplicitBayGeometry: true
    }
  };
  const bounds = compilation?.meta?.bounds;
  if (!bounds) return { ...stats, status: "missing-compilation-bounds" };
  const minDatum = Number(compilation?.meta?.elevationDatumM || 0);
  const features = map?.features || [];
  const areas = features.filter((feature) => feature?.parkingEvidence?.role === "area");
  const bays = features.filter((feature) => feature?.parkingEvidence?.role === "bay" && AREA_TYPES.has(feature?.localGeometry?.type));
  stats.parkingAreas = areas.length;
  stats.explicitBayFeatures = bays.length;
  stats.osmFallbackAreas = areas.filter(isOsm).length;
  stats.strongerAuthorityAreas = areas.length - stats.osmFallbackAreas;

  for (const feature of bays) {
    const occupied = geometryCells(feature.localGeometry, bounds);
    if (!occupied.size) continue;
    const boundary = [...occupied.values()].filter(({ x, z }) =>
      [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dz]) => !occupied.has(`${x + dx},${z + dz}`))
    );
    if (!boundary.length) continue;
    const block = parkingMarkingBlock(feature);
    for (const { x, z } of boundary) {
      const absolute = typeof sources?.elevation?.sampleLocal === "function" ? sources.elevation.sampleLocal(x, z) : null;
      const y = Number.isFinite(absolute) ? Math.round(absolute - minDatum) : 0;
      appendCellOperation(compilation, 1.78, x, y, z, block, stats);
      stats.markingCells += 1;
    }
    stats.markedBayFeatures += 1;
  }

  compilation.meta ||= {};
  compilation.meta.parkingEvidence = stats;
  compilation.stats ||= {};
  compilation.stats.parkingAreas = stats.parkingAreas;
  compilation.stats.parkingExplicitBays = stats.explicitBayFeatures;
  compilation.stats.parkingMarkedBays = stats.markedBayFeatures;
  compilation.stats.parkingMarkingCells = stats.markingCells;
  compilation.stats.parkingOsmFallbackAreas = stats.osmFallbackAreas;
  for (const chunk of compilation.chunks || []) chunk.o.sort((a, b) => a[0] - b[0]);
  return stats;
}

function parkingEvidence(feature, role, subtype) {
  return {
    schemaVersion: 1,
    role,
    subtype,
    geometrySource: feature?.source?.provider || feature?.authority?.layer || "unknown",
    authorityLayer: feature?.authority?.layer || null,
    authorityRank: Number(feature?.authority?.rank || 0),
    osmFallback: isOsm(feature),
    surfaceMaterial: feature?.tags?.surface || feature?.tags?.material || null,
    capacity: finite(feature?.tags?.capacity),
    inventedBayGridAllowed: false
  };
}

function parkingSemantic(candidate) {
  const explicit = norm(candidate?.parkingEvidence?.role || candidate?.tags?.["planning:parking_semantic"] || candidate?.properties?.tags?.["planning:parking_semantic"]);
  if (explicit) return explicit;
  const text = [candidate?.label, candidate?.name, candidate?.description, candidate?.raw, candidate?.properties?.label, candidate?.properties?.name]
    .filter(Boolean).join(" ").toLowerCase();
  if (/\b(parking aisle|circulation aisle|vehicle aisle)\b/.test(text)) return "parking_aisle";
  if (/\b(coach bay|coach parking bay)\b/.test(text)) return "coach_bay";
  if (/\b(disabled parking bay|accessible parking bay|accessible bay|disabled bay)\b/.test(text)) return "accessible_parking_bay";
  if (/\b(ev bay|electric vehicle bay|charging bay)\b/.test(text)) return "ev_parking_bay";
  if (/\b(parking bay|parking space|car parking space)\b/.test(text)) return "parking_bay";
  if (/\b(parking island|car park island|landscape island)\b/.test(text)) return "parking_island";
  if (/\b(coach park)\b/.test(text)) return "coach_park";
  if (/\b(car park|parking area|parking court|staff parking|visitor parking)\b/.test(text)) return "parking_area";
  return null;
}

function semanticRole(semantic) {
  if (["parking_area", "coach_park"].includes(semantic)) return "area";
  if (semantic === "parking_aisle") return "aisle";
  if (semantic === "parking_island") return "island";
  return "bay";
}
function parkingConfidence(semantic) { return semanticRole(semantic) === "area" ? 0.98 : semanticRole(semantic) === "aisle" ? 0.97 : 0.96; }

function parkingBaySubtype(tags) {
  const access = norm(tags.access);
  const parking = norm(tags.parking);
  const capacityDisabled = finite(tags["capacity:disabled"]);
  if (access === "disabled" || parking === "disabled" || capacityDisabled > 0) return "accessible_parking_bay";
  if (/charging|ev/.test(`${norm(tags.amenity)} ${norm(tags["fuel:electricity"])} ${norm(tags.socket)}`)) return "ev_parking_bay";
  return "parking_bay";
}

function geometryCells(geometry, bounds) {
  const result = new Map();
  const polygons = geometry?.type === "Polygon" ? [geometry.coordinates] : geometry?.type === "MultiPolygon" ? geometry.coordinates : [];
  for (const polygon of polygons) {
    const holes = polygon.slice(1);
    for (const [x1, x2, z] of polygonScanlineSpans(polygon)) {
      if (z < bounds.minZ || z > bounds.maxZ) continue;
      for (let x = Math.max(x1, bounds.minX); x <= Math.min(x2, bounds.maxX); x += 1) {
        if (holes.some((ring) => pointInRing(x + 0.5, z + 0.5, ring))) continue;
        result.set(`${x},${z}`, { x, z });
      }
    }
  }
  return result;
}

function geometryCenterInside(inner, outer) {
  const points = outerRings(inner).flat();
  if (!points.length) return false;
  const x = points.reduce((sum, point) => sum + Number(point[0]), 0) / points.length;
  const z = points.reduce((sum, point) => sum + Number(point[1]), 0) / points.length;
  return outerRings(outer).some((ring) => pointInRing(x, z, ring));
}
function outerRings(geometry) {
  if (geometry?.type === "Polygon") return geometry.coordinates?.length ? [geometry.coordinates[0]] : [];
  if (geometry?.type === "MultiPolygon") return (geometry.coordinates || []).map((polygon) => polygon?.[0]).filter(Boolean);
  return [];
}

function parkingMarkingBlock(feature) {
  const colour = norm(feature?.tags?.["marking:colour"] || feature?.tags?.marking_colour || feature?.tags?.colour);
  if (colour === "yellow") return "minecraft:yellow_concrete";
  if (colour === "blue") return "minecraft:blue_concrete";
  return "minecraft:white_concrete";
}

function appendCellOperation(compilation, phase, x, y, z, block, stats) {
  const paletteIndex = ensurePalette(compilation, block);
  const chunkX = Math.floor(x / 16), chunkZ = Math.floor(z / 16);
  let chunk = (compilation.chunks || []).find((value) => value.x === chunkX && value.z === chunkZ);
  if (!chunk) {
    chunk = { x: chunkX, z: chunkZ, o: [] };
    compilation.chunks ||= [];
    compilation.chunks.push(chunk);
  }
  chunk.o.push([phase, x, y, z, x, y, z, paletteIndex]);
  stats.operations += 1;
  stats.estimatedBlocks += 1;
  if (compilation.stats) {
    compilation.stats.rawOperations = Number(compilation.stats.rawOperations || 0) + 1;
    compilation.stats.estimatedBlocks = Number(compilation.stats.estimatedBlocks || 0) + 1;
  }
}
function ensurePalette(compilation, block) {
  compilation.palette ||= [];
  const found = compilation.palette.indexOf(block);
  if (found >= 0) return found;
  compilation.palette.push(block);
  return compilation.palette.length - 1;
}
function isOsm(feature) { return feature?.authority?.layer === "osm" || /openstreetmap/i.test(String(feature?.source?.provider || "")); }
function norm(value) { return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_"); }
function finite(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
