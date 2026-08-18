import { geometryBounds, lineCells, polygonScanlineSpans } from "./geo.mjs";

const FLAT_WATER_TYPES = new Set(["lake", "pond", "reservoir", "basin", "moat", "swimming_pool"]);

/**
 * Builds a source-aware hydrology evidence layer without granting OSM special
 * authority. Geometry, water level, width and depth are kept as independent
 * attributes so a strong shoreline source never silently invents bathymetry.
 */
export function enrichHydrology(map, sources = {}, options = {}) {
  const water = (map?.features || []).filter((feature) => feature?.kind === "water");
  const summary = {
    schemaVersion: 1,
    status: water.length ? "active" : "no-water-features",
    policy: {
      geometryPrecedence: ["verified-override", "planning-current", "licensed-public-water", "OSM", "Overture"],
      lidarRole: "water-surface/shoreline elevation constraint only; LiDAR is not treated as underwater bathymetry",
      depthPolicy: "verified depth/bathymetry may shape the bed; OSM depth never becomes measured bathymetry",
      osmRole: "fallback/context"
    },
    features: water.length,
    independentGeometryFeatures: 0,
    osmFallbackFeatures: 0,
    lidarWaterLevels: 0,
    explicitWaterLevels: 0,
    measuredDepthFeatures: 0,
    measuredMaxDepthFeatures: 0,
    explicitWidthFeatures: 0,
    suppressedOsmFeatures: 0,
    unresolvedDepthFeatures: 0
  };

  for (const feature of water) {
    const rank = hydrologySourceRank(feature);
    const level = resolveWaterLevel(feature, sources.elevation);
    const depth = resolveDepthEvidence(feature);
    const widthM = resolveWidth(feature);
    feature.hydrology = {
      schemaVersion: 1,
      sourceRank: rank,
      geometryAuthority: geometryAuthority(feature),
      waterType: normalizedWaterType(feature),
      surfaceElevationM: level?.elevationM ?? null,
      surfaceElevationSource: level?.source ?? null,
      surfaceElevationConfidence: level?.confidence ?? null,
      widthM,
      depthM: depth.depthM,
      maxDepthM: depth.maxDepthM,
      depthSource: depth.source,
      depthConfidence: depth.confidence,
      bathymetryStatus: depth.status,
      bedShape: depth.maxDepthM !== null ? "max-depth-constrained-inference" : depth.depthM !== null ? "measured-depth" : "unknown",
      suppressForRendering: false
    };
    if (feature.hydrology.geometryAuthority !== "osm-fallback" && feature.hydrology.geometryAuthority !== "overture-fallback") {
      summary.independentGeometryFeatures += 1;
    } else if (feature.hydrology.geometryAuthority === "osm-fallback") {
      summary.osmFallbackFeatures += 1;
    }
    if (level?.source === "lidar-shoreline-median") summary.lidarWaterLevels += 1;
    else if (level) summary.explicitWaterLevels += 1;
    if (depth.depthM !== null) summary.measuredDepthFeatures += 1;
    else if (depth.maxDepthM !== null) summary.measuredMaxDepthFeatures += 1;
    else summary.unresolvedDepthFeatures += 1;
    if (widthM !== null) summary.explicitWidthFeatures += 1;
  }

  // When an independently sourced water polygon is clearly the same named/type
  // feature as an OSM polygon, render the stronger geometry and keep OSM only as
  // provenance/context. Unnamed or weak overlaps fail closed and both remain.
  const independent = water.filter((feature) => hydrologySourceRank(feature) > 100 && isPolygon(feature));
  const osm = water.filter((feature) => feature?.source?.provider === "OpenStreetMap" && isPolygon(feature));
  for (const candidate of independent) {
    for (const fallback of osm) {
      if (fallback.hydrology?.suppressForRendering) continue;
      if (!compatibleWaterIdentity(candidate, fallback)) continue;
      if (bboxIou(candidate.localGeometry, fallback.localGeometry) < 0.62) continue;
      fallback.hydrology.suppressForRendering = true;
      fallback.hydrology.supersededBy = candidate.id;
      summary.suppressedOsmFeatures += 1;
    }
  }

  map.hydrology = summary;
  return summary;
}

export function hydrologyRenderFeatures(map) {
  return (map?.features || []).filter((feature) => !feature?.hydrology?.suppressForRendering);
}

export function waterFeatureCells(feature) {
  const geometry = feature?.localGeometry;
  if (!geometry) return [];
  if (geometry.type === "Polygon") return polygonCells(geometry.coordinates);
  if (geometry.type === "MultiPolygon") {
    const cells = new Map();
    for (const polygon of geometry.coordinates || []) {
      for (const cell of polygonCells(polygon)) cells.set(`${cell[0]},${cell[1]}`, cell);
    }
    return [...cells.values()];
  }
  if (geometry.type === "LineString") {
    return lineCells(geometry.coordinates || [], feature?.hydrology?.widthM || 1);
  }
  if (geometry.type === "MultiLineString") {
    const cells = new Map();
    for (const line of geometry.coordinates || []) {
      for (const cell of lineCells(line, feature?.hydrology?.widthM || 1)) cells.set(`${cell[0]},${cell[1]}`, cell);
    }
    return [...cells.values()];
  }
  return [];
}

function polygonCells(rings) {
  const cells = [];
  for (const [x1, x2, z] of polygonScanlineSpans(rings)) {
    for (let x = x1; x <= x2; x += 1) cells.push([x, z]);
  }
  return cells;
}

function resolveWaterLevel(feature, elevation) {
  const tags = feature.tags || {};
  const explicit = number(tags.water_surface_elevation_m ?? tags.water_level_m ?? tags.level_m ?? feature.vertical?.elevationM);
  if (explicit !== null) {
    return { elevationM: explicit, source: feature.source?.provider === "OpenStreetMap" ? "osm-tag" : "source-observed", confidence: feature.source?.provider === "OpenStreetMap" ? 0.5 : 0.9 };
  }
  if (!FLAT_WATER_TYPES.has(normalizedWaterType(feature))) return null;
  if (typeof elevation?.sampleLocal !== "function" || !isPolygon(feature)) return null;
  const samples = sampleExteriorBoundary(feature.localGeometry, elevation.sampleLocal);
  if (samples.length < 4) return null;
  samples.sort((a, b) => a - b);
  const median = percentile(samples, 0.5);
  const spread = percentile(samples, 0.9) - percentile(samples, 0.1);
  if (!Number.isFinite(median) || spread > 4) return null;
  return {
    elevationM: round2(median),
    source: "lidar-shoreline-median",
    confidence: Math.max(0.55, Math.min(0.92, 0.92 - spread * 0.08))
  };
}

function resolveDepthEvidence(feature) {
  const tags = feature.tags || {};
  const sourceTrusted = hydrologySourceRank(feature) > 100 && !["OpenStreetMap", "Overture Maps Foundation"].includes(feature.source?.provider);
  const direct = number(tags.bathymetry_depth_m ?? tags.depth_m ?? tags.mean_depth_m);
  const maximum = number(tags.max_depth_m ?? tags.maximum_depth_m ?? tags.bathymetry_max_depth_m);
  if (sourceTrusted && direct !== null && direct > 0 && direct <= 200) {
    return { depthM: direct, maxDepthM: null, source: "verified-public-depth", confidence: 0.9, status: "measured" };
  }
  if (sourceTrusted && maximum !== null && maximum > 0 && maximum <= 500) {
    return { depthM: null, maxDepthM: maximum, source: "verified-public-max-depth", confidence: 0.82, status: "measured-max-depth" };
  }
  if (direct !== null || maximum !== null) {
    return { depthM: null, maxDepthM: null, source: "untrusted-reported-depth", confidence: 0.35, status: "reported-not-bathymetry" };
  }
  return { depthM: null, maxDepthM: null, source: null, confidence: null, status: "unknown" };
}

function resolveWidth(feature) {
  const value = number(feature.tags?.width_m ?? feature.tags?.width);
  return value !== null && value > 0 && value <= 5000 ? value : null;
}

function sampleExteriorBoundary(geometry, sampleLocal) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
  const values = [];
  for (const polygon of polygons) {
    const ring = polygon?.[0] || [];
    for (let i = 1; i < ring.length && values.length < 2048; i += 1) {
      const a = ring[i - 1], b = ring[i];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.ceil(length / 3));
      for (let step = 0; step <= steps && values.length < 2048; step += 1) {
        const t = step / steps;
        const value = sampleLocal(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
        if (Number.isFinite(value)) values.push(value);
      }
    }
  }
  return values;
}

function hydrologySourceRank(feature) {
  if (Number.isFinite(feature?.authority?.rank)) return feature.authority.rank;
  if (feature?.id?.startsWith("override:")) return 500;
  if (feature?.id?.startsWith("planning:")) return 400;
  if (feature?.id?.startsWith("public:")) return 300;
  if (feature?.source?.provider === "OpenStreetMap") return 100;
  if (feature?.source?.provider === "Overture Maps Foundation") return 80;
  return feature?.verification?.plan === "source-verified" ? 300 : 150;
}

function geometryAuthority(feature) {
  const rank = hydrologySourceRank(feature);
  if (rank >= 500) return "verified-override";
  if (rank >= 400) return "planning-current";
  if (rank >= 200) return "licensed-public-water";
  if (feature?.source?.provider === "Overture Maps Foundation") return "overture-fallback";
  return "osm-fallback";
}

function normalizedWaterType(feature) {
  return String(feature?.tags?.water || feature?.tags?.waterway || feature?.subtype || feature?.tags?.natural || "water").toLowerCase();
}

function compatibleWaterIdentity(a, b) {
  const nameA = String(a?.name || "").trim().toLowerCase();
  const nameB = String(b?.name || "").trim().toLowerCase();
  const sameNamed = nameA && nameB && nameA === nameB;
  const typeA = normalizedWaterType(a), typeB = normalizedWaterType(b);
  const sameType = typeA === typeB || (FLAT_WATER_TYPES.has(typeA) && FLAT_WATER_TYPES.has(typeB));
  return sameType && (sameNamed || (!nameA && !nameB));
}

function bboxIou(a, b) {
  const x = geometryBounds(a), y = geometryBounds(b);
  const ix = Math.max(0, Math.min(x.maxX, y.maxX) - Math.max(x.minX, y.minX));
  const iz = Math.max(0, Math.min(x.maxZ, y.maxZ) - Math.max(x.minZ, y.minZ));
  const intersection = ix * iz;
  if (!intersection) return 0;
  const areaA = Math.max(0, x.maxX - x.minX) * Math.max(0, x.maxZ - x.minZ);
  const areaB = Math.max(0, y.maxX - y.minX) * Math.max(0, y.maxZ - y.minZ);
  return intersection / Math.max(Number.EPSILON, areaA + areaB - intersection);
}

function isPolygon(feature) {
  return ["Polygon", "MultiPolygon"].includes(feature?.localGeometry?.type);
}

function percentile(sorted, fraction) {
  if (!sorted.length) return NaN;
  const index = (sorted.length - 1) * fraction;
  const lo = Math.floor(index), hi = Math.ceil(index);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - index) + sorted[hi] * (index - lo);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const round2 = (value) => Math.round(value * 100) / 100;
