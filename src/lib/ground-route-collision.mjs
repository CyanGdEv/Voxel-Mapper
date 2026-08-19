import { lineCells, pointInPolygon, polygonScanlineSpans } from "./geo.mjs";
import { isBridgeFeature } from "./fidelity.mjs";

const DEFAULT_AUTHORITY_RANK = 100;
const DEFAULT_SAMPLE_STEP_M = 0.5;
const WATER_BLOCK = "minecraft:water";
const ATTRACTION_BLOCK = "minecraft:green_concrete";
const ATTRACTION_PROTECTION_PHASE = 1.94;
const WATER_PROTECTION_PHASE = 1.95;

/**
 * Prevent lower/equal-authority ground routes from being rasterized through
 * protected water or physical ride footprints. Explicit grade separation
 * (bridge/tunnel/non-zero layer) is preserved. Higher-authority routes remain
 * authoritative over lower-authority blockers.
 *
 * Line routes are clipped before the base raster compiler runs. Area routes are
 * left geometrically intact because polygon subtraction would invent topology;
 * the protected-surface pass below removes lower-authority surface paint from
 * overlapping raster cells instead.
 */
export function prepareGroundRouteCollisionSafeInput(input = {}) {
  const map = input?.map;
  const mode = input?.options?.groundRouteCollisionMode || "enforce";
  const summary = emptySummary(mode);
  if (mode === "off" || !Array.isArray(map?.features)) {
    summary.status = mode === "off" ? "disabled" : "no-map-features";
    return { input, summary };
  }

  const blockers = collectGroundBlockers(map.features);
  summary.protectedFeatures = blockers.length;
  summary.protectedWaterFeatures = blockers.filter((entry) => entry.kind === "water").length;
  summary.protectedRideFootprints = blockers.filter((entry) => entry.kind === "attraction").length;
  if (!blockers.length) {
    summary.status = "no-protected-ground-features";
    return { input, summary };
  }

  const features = [];
  for (const feature of map.features) {
    if (!isGroundRoute(feature) || !feature.localGeometry) {
      features.push(feature);
      continue;
    }
    summary.routeFeatures += 1;
    if (isGradeSeparatedRoute(feature)) {
      summary.preservedGradeSeparated += 1;
      features.push(feature);
      continue;
    }

    if (["Polygon", "MultiPolygon"].includes(feature.localGeometry.type)) {
      if (areaRouteCouldConflict(feature, blockers)) summary.areaRoutesProtectedAtRaster += 1;
      features.push(feature);
      continue;
    }

    const clipped = clipRouteGeometry(feature, blockers, input.options || {});
    if (!clipped.geometry) {
      summary.removedRouteFeatures += 1;
      summary.clippedRouteFeatures += 1;
      summary.removedRouteIds.push(feature.id || null);
      summary.removedRouteLengthM += clipped.removedLengthM;
      continue;
    }
    if (!clipped.changed) {
      features.push(feature);
      continue;
    }
    summary.clippedRouteFeatures += 1;
    summary.clippedRouteIds.push(feature.id || null);
    summary.removedRouteLengthM += clipped.removedLengthM;
    features.push({
      ...feature,
      localGeometry: clipped.geometry,
      pathCollisionResolution: {
        schemaVersion: 1,
        status: "clipped-protected-ground-overlap",
        originalGeometryType: feature.localGeometry.type,
        removedLengthM: round2(clipped.removedLengthM),
        authorityRank: authorityRank(feature)
      }
    });
  }

  summary.removedRouteLengthM = round2(summary.removedRouteLengthM);
  summary.status = summary.clippedRouteFeatures || summary.areaRoutesProtectedAtRaster
    ? "protected-ground-collisions-resolved"
    : "no-route-collisions";
  const collisionMap = { ...map, features, pathCollisionResolution: summary };
  return { input: { ...input, map: collisionMap }, summary };
}

/**
 * Reassert protected ground surfaces at a late terrain-overlay phase. This is
 * defense in depth for area paths/plazas, parking paint and current-planning
 * surface paint: water and physical ride footprints remain intact unless an
 * explicitly grade-separated or strictly higher-authority route owns the cell.
 *
 * The phases stay below phase 2 structural output but above hydrology (1.4),
 * parking markings (1.78) and planning top-surface paint (1.0). Because the
 * later planning renderer re-sorts by phase, this protection remains final even
 * though it is emitted before that renderer is called.
 */
export function reassertProtectedGroundSurfaces(compilation, input = {}, summary = null) {
  const map = input?.map;
  const result = summary || emptySummary(input?.options?.groundRouteCollisionMode || "enforce");
  if (!compilation || !Array.isArray(map?.features) || result.mode === "off") return result;

  const blockers = collectGroundBlockers(map.features).filter((entry) => entry.surfaceBlock);
  if (!blockers.length) {
    attachResult(compilation, result);
    return result;
  }

  compilation.palette ||= [];
  const rows = indexPhaseOneRows(compilation);
  const existingWaterIndex = compilation.palette.indexOf(WATER_BLOCK);
  const waterRows = existingWaterIndex >= 0 ? indexBlockRows(compilation, existingWaterIndex) : new Map();
  const routes = map.features.filter((feature) => isGroundRoute(feature) && !isGradeSeparatedRoute(feature));
  const chunkMap = new Map((compilation.chunks || []).map((chunk) => [`${chunk.x},${chunk.z}`, chunk]));
  const paletteIndex = new Map(compilation.palette.map((block, index) => [block, index]));
  const addedByPhase = new Map();
  let operations = 0;
  let cells = 0;

  // Water wins ties against a ride footprint where both source geometries
  // occupy the same ground cell. Within a kind, stronger authority paints last.
  blockers.sort((a, b) => protectionPhase(a) - protectionPhase(b) || a.rank - b.rank);
  for (const blocker of blockers) {
    const blockIndex = registerBlock(compilation, paletteIndex, blocker.surfaceBlock);
    const phase = protectionPhase(blocker);
    let run = null;
    const flush = () => {
      if (!run) return;
      appendRun(chunkMap, [phase, run.x1, run.y, run.z, run.x2, run.y, run.z, blockIndex]);
      const chunkRuns = countChunkRuns(run.x1, run.x2);
      operations += chunkRuns;
      addedByPhase.set(phase, (addedByPhase.get(phase) || 0) + chunkRuns);
      const length = run.x2 - run.x1 + 1;
      cells += length;
      result.byProtectedSurface[blocker.kind] = (result.byProtectedSurface[blocker.kind] || 0) + length;
      run = null;
    };

    for (const [x, z] of blockerRasterCells(blocker)) {
      const y = blocker.kind === "water"
        ? (blockTopYAt(waterRows, x, z) ?? phaseOneYAt(rows, x, z))
        : phaseOneYAt(rows, x, z);
      if (!Number.isFinite(y) || higherAuthorityGroundRouteCovers(routes, blocker, x, z)) {
        flush();
        continue;
      }
      if (run && run.z === z && run.y === y && x === run.x2 + 1) {
        run.x2 = x;
      } else {
        flush();
        run = { x1: x, x2: x, y, z };
      }
    }
    flush();
  }

  if (operations) {
    compilation.chunks = [...chunkMap.values()]
      .map((chunk) => ({ ...chunk, o: chunk.o.sort((a, b) => a[0] - b[0]) }))
      .sort((a, b) => a.z - b.z || a.x - b.x);
    compilation.stats ||= {};
    compilation.stats.rawOperations = Number(compilation.stats.rawOperations || 0) + operations;
    compilation.stats.operations = Number(compilation.stats.operations || 0) + operations;
    compilation.stats.estimatedBlocks = Number(compilation.stats.estimatedBlocks || 0) + cells;
    compilation.stats.chunks = compilation.chunks.length;
    compilation.stats.phaseCounts ||= {};
    for (const [phase, count] of addedByPhase) {
      compilation.stats.phaseCounts[phase] = Number(compilation.stats.phaseCounts[phase] || 0) + count;
    }
  }

  result.protectedSurfaceCells = cells;
  result.protectedSurfaceOperations = operations;
  attachResult(compilation, result);
  return result;
}

function collectGroundBlockers(features) {
  const result = [];
  for (const feature of features || []) {
    if (!feature?.localGeometry) continue;
    if (feature.kind === "water") {
      result.push({
        feature,
        kind: "water",
        geometry: feature.localGeometry,
        rank: authorityRank(feature),
        widthM: explicitWidth(feature, 2),
        surfaceBlock: WATER_BLOCK
      });
      continue;
    }
    if (feature.kind === "attraction" && isPhysicalRideFootprint(feature) && isAreaGeometry(feature.localGeometry)) {
      result.push({
        feature,
        kind: "attraction",
        geometry: feature.localGeometry,
        rank: authorityRank(feature),
        widthM: 0,
        surfaceBlock: ATTRACTION_BLOCK
      });
    }
  }
  return result;
}

function clipRouteGeometry(feature, blockers, options) {
  const geometry = feature.localGeometry;
  const lines = lineParts(geometry);
  if (!lines.length) return { geometry, changed: false, removedLengthM: 0 };
  const kept = [];
  let removedLengthM = 0;
  for (const line of lines) {
    const originalLength = lineLength(line);
    const pieces = clipLine(line, feature, blockers, options);
    const keptLength = pieces.reduce((sum, piece) => sum + lineLength(piece), 0);
    removedLengthM += Math.max(0, originalLength - keptLength);
    kept.push(...pieces);
  }
  if (removedLengthM < 0.05) return { geometry, changed: false, removedLengthM: 0 };
  if (!kept.length) return { geometry: null, changed: true, removedLengthM };
  return {
    geometry: kept.length === 1
      ? { type: "LineString", coordinates: kept[0] }
      : { type: "MultiLineString", coordinates: kept },
    changed: true,
    removedLengthM
  };
}

function clipLine(line, route, blockers, options) {
  if (!Array.isArray(line) || line.length < 2) return [];
  const stepM = clamp(Number(options.groundRouteCollisionSampleStepM ?? DEFAULT_SAMPLE_STEP_M), 0.2, 2);
  const pieces = [];
  let current = null;
  for (let segmentIndex = 1; segmentIndex < line.length; segmentIndex += 1) {
    const a = line[segmentIndex - 1], b = line[segmentIndex];
    const length = distance(a, b);
    if (length < 1e-9) continue;
    const steps = Math.max(1, Math.ceil(length / stepM));
    for (let step = 0; step < steps; step += 1) {
      const t0 = step / steps, t1 = (step + 1) / steps;
      const start = lerp(a, b, t0), end = lerp(a, b, t1);
      const midpoint = lerp(a, b, (t0 + t1) / 2);
      if (routeBlockedAt(route, midpoint, blockers)) {
        if (current?.length >= 2) pieces.push(simplifyCollinear(current));
        current = null;
        continue;
      }
      if (!current) current = [start, end];
      else if (samePoint(current.at(-1), start)) current.push(end);
      else {
        if (current.length >= 2) pieces.push(simplifyCollinear(current));
        current = [start, end];
      }
    }
  }
  if (current?.length >= 2) pieces.push(simplifyCollinear(current));
  return pieces.filter((piece) => piece.length >= 2 && lineLength(piece) >= 0.1);
}

function routeBlockedAt(route, point, blockers) {
  const routeRank = authorityRank(route);
  const routeHalfWidth = Math.max(0.25, routeWidth(route) / 2);
  return blockers.some((blocker) => blocker.rank >= routeRank && geometryBlocksPoint(blocker, point, routeHalfWidth));
}

function geometryBlocksPoint(blocker, point, routeHalfWidth) {
  const geometry = blocker.geometry;
  if (isAreaGeometry(geometry)) {
    for (const rings of polygonParts(geometry)) {
      if (pointInPolygon(point[0], point[1], rings)) return true;
      if (routeHalfWidth > 0 && distancePointToRings(point, rings) <= routeHalfWidth) return true;
    }
    return false;
  }
  const clearance = blocker.kind === "water"
    ? Math.max(0.75, Number(blocker.widthM || 0) / 2 + routeHalfWidth)
    : routeHalfWidth;
  return lineParts(geometry).some((line) => distancePointToLine(point, line) <= clearance);
}

function areaRouteCouldConflict(route, blockers) {
  const rank = authorityRank(route);
  const polygons = polygonParts(route.localGeometry);
  if (!polygons.length) return false;
  for (const blocker of blockers) {
    if (blocker.rank < rank) continue;
    for (const rings of polygons) {
      for (const ring of rings) if (ring.some((point) => geometryBlocksPoint(blocker, point, 0))) return true;
    }
    for (const point of geometryRepresentativePoints(blocker.geometry)) {
      if (polygons.some((rings) => pointInPolygon(point[0], point[1], rings))) return true;
    }
  }
  return false;
}

function higherAuthorityGroundRouteCovers(routes, blocker, x, z) {
  const point = [x, z];
  for (const route of routes) {
    if (authorityRank(route) <= blocker.rank) continue;
    const geometry = route.localGeometry;
    if (isAreaGeometry(geometry) && polygonParts(geometry).some((rings) => pointInPolygon(x, z, rings))) return true;
    const halfWidth = Math.max(0.5, routeWidth(route) / 2);
    if (lineParts(geometry).some((line) => distancePointToLine(point, line) <= halfWidth)) return true;
  }
  return false;
}

function* blockerRasterCells(blocker) {
  const geometry = blocker.geometry;
  if (isAreaGeometry(geometry)) {
    for (const polygon of polygonParts(geometry)) {
      for (const [x1, x2, z] of polygonScanlineSpans(polygon)) {
        for (let x = x1; x <= x2; x += 1) yield [x, z];
      }
    }
    return;
  }
  const width = Math.max(1, Math.round(Number(blocker.widthM || 1)));
  const cells = new Map();
  for (const line of lineParts(geometry)) {
    for (const [x, z] of lineCells(line, width)) cells.set(`${x},${z}`, [x, z]);
  }
  for (const cell of [...cells.values()].sort((a, b) => a[1] - b[1] || a[0] - b[0])) yield cell;
}

function indexPhaseOneRows(compilation) {
  const rows = new Map();
  for (const chunk of compilation?.chunks || []) {
    for (const operation of chunk.o || []) {
      if (operation[0] !== 1) continue;
      const [, x1, y1, z1, x2, y2, z2] = operation;
      if (y1 !== y2 || z1 !== z2) continue;
      if (!rows.has(z1)) rows.set(z1, []);
      rows.get(z1).push({ x1, x2, y: y1 });
    }
  }
  return rows;
}

function phaseOneYAt(rows, x, z) {
  const runs = rows.get(z) || [];
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (x >= run.x1 && x <= run.x2) return run.y;
  }
  return null;
}

function indexBlockRows(compilation, blockIndex) {
  const rows = new Map();
  for (const chunk of compilation?.chunks || []) {
    for (const operation of chunk.o || []) {
      if (operation[7] !== blockIndex || operation[3] !== operation[6]) continue;
      const row = operation[3];
      if (!rows.has(row)) rows.set(row, []);
      rows.get(row).push({
        x1: operation[1], x2: operation[4], y: Math.max(operation[2], operation[5]), phase: Number(operation[0])
      });
    }
  }
  for (const entries of rows.values()) entries.sort((a, b) => a.phase - b.phase);
  return rows;
}

function blockTopYAt(rows, x, z) {
  const entries = rows.get(z) || [];
  let y = null, phase = -Infinity;
  for (const entry of entries) {
    if (x < entry.x1 || x > entry.x2 || entry.phase < phase) continue;
    phase = entry.phase;
    y = entry.y;
  }
  return y;
}

function registerBlock(compilation, paletteIndex, block) {
  let index = paletteIndex.get(block);
  if (index !== undefined) return index;
  index = compilation.palette.length;
  compilation.palette.push(block);
  paletteIndex.set(block, index);
  return index;
}

function appendRun(chunkMap, operation) {
  const [, x1, y1, z1, x2, y2, z2, block] = operation;
  const minChunkX = Math.floor(x1 / 16), maxChunkX = Math.floor(x2 / 16);
  for (let chunkX = minChunkX; chunkX <= maxChunkX; chunkX += 1) {
    const fromX = Math.max(x1, chunkX * 16);
    const toX = Math.min(x2, chunkX * 16 + 15);
    const chunkZ = Math.floor(z1 / 16);
    const key = `${chunkX},${chunkZ}`;
    if (!chunkMap.has(key)) chunkMap.set(key, { x: chunkX, z: chunkZ, o: [] });
    chunkMap.get(key).o.push([operation[0], fromX, y1, z1, toX, y2, z2, block]);
  }
}

function countChunkRuns(x1, x2) { return Math.floor(x2 / 16) - Math.floor(x1 / 16) + 1; }
function protectionPhase(blocker) { return blocker.kind === "water" ? WATER_PROTECTION_PHASE : ATTRACTION_PROTECTION_PHASE; }

function attachResult(compilation, result) {
  compilation.meta ||= {};
  compilation.meta.pathCollisionResolution = result;
  compilation.stats ||= {};
  compilation.stats.pathCollisionClippedFeatures = result.clippedRouteFeatures;
  compilation.stats.pathCollisionRemovedFeatures = result.removedRouteFeatures;
  compilation.stats.pathCollisionRemovedRouteLengthM = result.removedRouteLengthM;
  compilation.stats.pathCollisionProtectedSurfaceCells = result.protectedSurfaceCells;
  compilation.stats.pathCollisionProtectedSurfaceOperations = result.protectedSurfaceOperations;
}

function isGroundRoute(feature) { return feature?.kind === "path" || feature?.kind === "road"; }
function isAreaGeometry(geometry) { return geometry && ["Polygon", "MultiPolygon"].includes(geometry.type); }

function isGradeSeparatedRoute(feature) {
  const tags = feature?.tags || {};
  if (isBridgeFeature(feature)) return true;
  const tunnel = String(tags.tunnel || "").toLowerCase();
  if (["yes", "true", "building_passage", "culvert"].includes(tunnel)) return true;
  const layer = Number(tags.layer ?? feature?.layer ?? 0);
  if (Number.isFinite(layer) && layer !== 0) return true;
  const location = String(tags.location || "").toLowerCase();
  return ["underground", "underwater", "overground", "elevated"].includes(location);
}

function isPhysicalRideFootprint(feature) {
  const value = `${feature?.subtype || ""} ${feature?.tags?.attraction || ""}`.toLowerCase();
  return /ride|coaster|flume|rapids|carousel|wheel|tower|swing|ship|dodgem|bumper|water/.test(value);
}

function authorityRank(feature) {
  const rank = Number(feature?.authority?.rank);
  if (Number.isFinite(rank)) return rank;
  if (feature?.authority?.geometryLocked || feature?.verification?.plan === "planning-current-authority") return 360;
  return DEFAULT_AUTHORITY_RANK;
}

function routeWidth(feature) {
  const fidelity = Number(feature?.fidelity?.path?.rasterWidthM);
  if (Number.isFinite(fidelity) && fidelity > 0) return fidelity;
  return explicitWidth(feature, feature?.kind === "road" ? 4 : 1.5);
}

function explicitWidth(feature, fallback) {
  for (const value of [feature?.tags?.width, feature?.tags?.["width:carriageway"], feature?.widthM]) {
    const parsed = Number.parseFloat(String(value ?? "").replace(/[^0-9.+-]/g, ""));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function polygonParts(geometry) {
  if (geometry?.type === "Polygon") return geometry.coordinates?.length ? [geometry.coordinates] : [];
  if (geometry?.type === "MultiPolygon") return (geometry.coordinates || []).filter((polygon) => polygon?.length);
  return [];
}

function lineParts(geometry) {
  if (geometry?.type === "LineString") return geometry.coordinates?.length >= 2 ? [geometry.coordinates] : [];
  if (geometry?.type === "MultiLineString") return (geometry.coordinates || []).filter((line) => line?.length >= 2);
  return [];
}

function geometryRepresentativePoints(geometry) {
  if (isAreaGeometry(geometry)) {
    return polygonParts(geometry).flatMap((polygon) => polygon[0]?.length ? polygon[0].slice(0, 16) : []);
  }
  return lineParts(geometry).flatMap((line) => line.length ? [line[0], line.at(-1), line[Math.floor(line.length / 2)]] : []);
}

function distancePointToRings(point, rings) {
  let best = Infinity;
  for (const ring of rings || []) {
    for (let index = 1; index < ring.length; index += 1) {
      best = Math.min(best, distancePointToSegment(point, ring[index - 1], ring[index]));
    }
  }
  return best;
}

function distancePointToLine(point, line) {
  let best = Infinity;
  for (let index = 1; index < line.length; index += 1) best = Math.min(best, distancePointToSegment(point, line[index - 1], line[index]));
  return best;
}

function distancePointToSegment(point, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= 1e-12) return distance(point, a);
  const t = clamp(((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / lengthSquared, 0, 1);
  return distance(point, [a[0] + dx * t, a[1] + dz * t]);
}

function lineLength(line) {
  let total = 0;
  for (let index = 1; index < line.length; index += 1) total += distance(line[index - 1], line[index]);
  return total;
}

function simplifyCollinear(points) {
  if (points.length <= 2) return points.map((point) => [...point]);
  const result = [[...points[0]]];
  for (let index = 1; index < points.length - 1; index += 1) {
    const a = points[index - 1], b = points[index], c = points[index + 1];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) > 1e-6) result.push([...b]);
  }
  result.push([...points.at(-1)]);
  return result;
}

function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
function distance(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
function samePoint(a, b) { return distance(a, b) < 1e-6; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function round2(value) { return Math.round(Number(value || 0) * 100) / 100; }

function emptySummary(mode) {
  return {
    schemaVersion: 1,
    status: "not-run",
    mode,
    method: "authority-aware ground-route clipping plus late protected-surface reassertion",
    routeFeatures: 0,
    protectedFeatures: 0,
    protectedWaterFeatures: 0,
    protectedRideFootprints: 0,
    clippedRouteFeatures: 0,
    removedRouteFeatures: 0,
    removedRouteLengthM: 0,
    preservedGradeSeparated: 0,
    areaRoutesProtectedAtRaster: 0,
    protectedSurfaceCells: 0,
    protectedSurfaceOperations: 0,
    clippedRouteIds: [],
    removedRouteIds: [],
    byProtectedSurface: {}
  };
}
