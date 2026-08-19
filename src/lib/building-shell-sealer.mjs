import { pointInRing, polygonScanlineSpans } from "./geo.mjs";
import { primaryMaterialBlock } from "./material-palettes.mjs";

const CLEAR_PHASE = 3.2;
const SEAL_PHASE = 3.3;
const STEP_PHASE = 3.35;
const NEIGHBOURS_8 = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],            [1, 0],
  [-1, 1],  [0, 1],   [1, 1]
];
const FORWARD_NEIGHBOURS = [[1, 0], [0, 1]];

/**
 * Final structural sanitation for LiDAR-derived building shells.
 *
 * The first LiDAR pass intentionally retains the raw 1 m DSM roof surface so
 * real roof shape is not lost. Production DSMs can also contain isolated tree,
 * mast and edge-return spikes. Those unsupported cells created tall needles and
 * exposed vertical seams between adjacent roof cells. This pass keeps supported
 * multi-cell roof structure, rejects only locally unsupported outliers, clears
 * stale generated blocks above the accepted roof, and seals every exterior and
 * internal roof-step face with full wall-family blocks.
 *
 * Real polygon interior rings remain open: they are never part of the shared
 * footprint mask and therefore still represent courtyards/atria.
 */
export function sealLidarBuildingShells(compilation, { map, sources }) {
  const bounds = compilation?.meta?.bounds;
  const minDatum = Number(compilation?.meta?.elevationDatumM || 0);
  if (!bounds || !map?.features?.length) return emptyStats("missing-compilation-context");

  const features = map.features.filter((feature) =>
    feature?.kind === "building" && feature?.roof?.source === "lidar-dsm-surface" &&
    ["Polygon", "MultiPolygon"].includes(feature?.localGeometry?.type)
  );
  if (!features.length) return emptyStats("no-lidar-buildings");

  compilation.meta ||= {};
  compilation.meta.statefulBlockReplacements ||= [];
  const featureIds = new Set(features.map((feature) => feature.id));
  const retainedReplacements = compilation.meta.statefulBlockReplacements.filter((item) =>
    !(featureIds.has(item?.featureId) && ["lidar-roof-stair", "lidar-roof-slab"].includes(item?.kind))
  );
  const stats = emptyStats("complete");
  stats.removedStaleStatefulTransitions = compilation.meta.statefulBlockReplacements.length - retainedReplacements.length;
  const statefulByCell = new Map(retainedReplacements.map((item) => [cellKey(item.x, item.y, item.z), item]));

  for (const feature of features) {
    const cells = footprintCells(feature.localGeometry, bounds);
    if (!cells.size) continue;
    stats.buildings += 1;
    stats.roofCells += cells.size;
    stats.trueInteriorRingsPreserved += polygonParts(feature.localGeometry)
      .reduce((sum, polygon) => sum + Math.max(0, polygon.length - 1), 0);

    const fallbackHeight = Math.max(2, Math.round(Number(feature?.vertical?.heightM ?? feature?.roof?.heightM ?? 5)));
    const raw = new Map();
    for (const cell of cells.values()) {
      raw.set(cellKey2d(cell.x, cell.z), sampleRawHeight({
        x: cell.x,
        z: cell.z,
        minDatum,
        fallbackHeight,
        elevation: sources?.elevation
      }));
    }

    const accepted = sanitizeRoofSurface({ cells, raw, fallbackHeight, feature, stats });
    const roofBlock = buildingRoofBlock(feature);
    const wallBlock = buildingWallBlock(feature);

    // Remove stale roof/detail blocks only where the raw renderer rose above the
    // accepted roof. This is building-local and never clears terrain or a true
    // courtyard cell.
    for (const cell of cells.values()) {
      const key = cellKey2d(cell.x, cell.z);
      const original = raw.get(key);
      const current = accepted.get(key);
      const staleTop = Math.max(original.generatedRoofY, original.terrainY + fallbackHeight);
      if (staleTop > current.roofY) {
        appendColumnOperation(compilation, CLEAR_PHASE, cell.x, current.roofY + 1, staleTop, cell.z, "minecraft:air", stats);
        stats.clearedColumns += 1;
        stats.clearedBlocks += staleTop - current.roofY;
      }
    }

    // Exterior walls stop one block below the roof; the roof block is written
    // afterwards so the material remains a roof at the eaves rather than being
    // overwritten by the wall column.
    for (const cell of cells.values()) {
      if (!isBoundaryCell(cell, cells)) continue;
      const current = accepted.get(cellKey2d(cell.x, cell.z));
      appendColumnOperation(
        compilation,
        SEAL_PHASE,
        cell.x,
        current.terrainY + 1,
        current.roofY - 1,
        cell.z,
        wallBlock,
        stats
      );
      stats.boundaryWallColumns += 1;
    }

    // Every accepted footprint cell gets a roof cube. This makes the horizontal
    // surface closed even where the first raw DSM pass contained missing/invalid
    // samples.
    for (const cell of cells.values()) {
      const current = accepted.get(cellKey2d(cell.x, cell.z));
      appendCellOperation(compilation, SEAL_PHASE, cell.x, current.roofY, cell.z, roofBlock, stats);
    }

    const roofFamily = statefulRoofFamily(roofBlock);
    const transitionCandidates = new Map();
    for (const cell of cells.values()) {
      const current = accepted.get(cellKey2d(cell.x, cell.z));
      for (const [dx, dz] of FORWARD_NEIGHBOURS) {
        const neighbourCell = cells.get(cellKey2d(cell.x + dx, cell.z + dz));
        if (!neighbourCell) continue;
        const other = accepted.get(cellKey2d(neighbourCell.x, neighbourCell.z));
        const deltaSurface = other.roofSurfaceY - current.roofSurfaceY;
        const absoluteDelta = Math.abs(deltaSurface);
        if (absoluteDelta < 0.45) continue;

        if (roofFamily && absoluteDelta < 1.5 && current.measured && other.measured) {
          const lower = deltaSurface > 0 ? { cell, height: current } : { cell: neighbourCell, height: other };
          const riseDx = deltaSurface > 0 ? dx : -dx;
          const riseDz = deltaSurface > 0 ? dz : -dz;
          const kind = absoluteDelta >= 0.8 ? "stair" : "slab";
          const candidate = {
            x: lower.cell.x,
            y: lower.height.roofY,
            z: lower.cell.z,
            kind,
            deltaM: absoluteDelta,
            riseDx,
            riseDz,
            featureId: feature.id
          };
          const key = cellKey(candidate.x, candidate.y, candidate.z);
          const existing = transitionCandidates.get(key);
          if (!existing || transitionPriority(candidate) > transitionPriority(existing)) transitionCandidates.set(key, candidate);
          continue;
        }

        // A multi-block roof-height discontinuity exposes a vertical face. A
        // single wall/fence block cannot close it. Fill the entire riser using
        // the building wall material, but stop below the upper roof level.
        const lower = current.roofY <= other.roofY ? { cell, height: current, upper: other } :
          { cell: neighbourCell, height: other, upper: current };
        const y1 = lower.height.roofY + 1;
        const y2 = lower.upper.roofY - 1;
        if (y2 < y1) continue;
        appendColumnOperation(compilation, STEP_PHASE, lower.cell.x, y1, y2, lower.cell.z, wallBlock, stats);
        stats.internalStepWallColumns += 1;
        stats.internalStepWallBlocks += y2 - y1 + 1;
      }
    }

    for (const candidate of transitionCandidates.values()) {
      const replacement = candidate.kind === "stair"
        ? {
            x: candidate.x,
            y: candidate.y,
            z: candidate.z,
            name: roofFamily.stairs,
            states: {
              "minecraft:corner": "none",
              upside_down_bit: 0,
              weirdo_direction: stairDirection(candidate.riseDx, candidate.riseDz)
            },
            kind: "lidar-roof-stair",
            featureId: candidate.featureId,
            evidenceDeltaM: Number(candidate.deltaM.toFixed(3))
          }
        : {
            x: candidate.x,
            y: candidate.y,
            z: candidate.z,
            name: roofFamily.slab,
            states: { "minecraft:vertical_half": "bottom" },
            kind: "lidar-roof-slab",
            featureId: candidate.featureId,
            evidenceDeltaM: Number(candidate.deltaM.toFixed(3))
          };
      const key = cellKey(replacement.x, replacement.y, replacement.z);
      const existing = statefulByCell.get(key);
      if (!existing || replacementPriority(replacement) > replacementPriority(existing)) statefulByCell.set(key, replacement);
    }
  }

  compilation.meta.statefulBlockReplacements = [...statefulByCell.values()].sort((a, b) =>
    a.z - b.z || a.x - b.x || a.y - b.y || a.name.localeCompare(b.name)
  );
  stats.roofStairCells = compilation.meta.statefulBlockReplacements.filter((item) =>
    item.kind === "lidar-roof-stair" && featureIds.has(item.featureId)
  ).length;
  stats.roofSlabCells = compilation.meta.statefulBlockReplacements.filter((item) =>
    item.kind === "lidar-roof-slab" && featureIds.has(item.featureId)
  ).length;
  stats.statefulTransitions = stats.roofStairCells + stats.roofSlabCells;

  for (const chunk of compilation.chunks || []) chunk.o.sort((a, b) => a[0] - b[0]);
  compilation.chunks?.sort((a, b) => a.z - b.z || a.x - b.x);
  return stats;
}

function sanitizeRoofSurface({ cells, raw, fallbackHeight, feature, stats }) {
  const accepted = new Map();
  const spread = Number(feature?.roof?.heightSpreadM);
  const expectedAllowance = Math.max(3, Math.min(12, Number.isFinite(spread) ? spread * 1.5 : 3));

  for (const cell of cells.values()) {
    const key = cellKey2d(cell.x, cell.z);
    const current = raw.get(key);
    const neighbours = [{ x: cell.x, z: cell.z }, ...NEIGHBOURS_8.map(([dx, dz]) => ({ x: cell.x + dx, z: cell.z + dz }))]
      .map(({ x, z }) => raw.get(cellKey2d(x, z)))
      .filter((value) => value?.measured);
    const localMedian = neighbours.length ? median(neighbours.map((value) => value.roofSurfaceY)) : null;
    const sameSurfaceSupport = current.measured
      ? neighbours.filter((value) => Math.abs(value.roofSurfaceY - current.roofSurfaceY) <= 1.25).length
      : 0;
    const minimumSupport = neighbours.length >= 6 ? 3 : 2;
    const expectedRoofY = current.terrainY + fallbackHeight;
    let roofSurfaceY = current.roofSurfaceY;
    let measured = current.measured;

    if (!current.measured) {
      if (neighbours.length >= 3 && Number.isFinite(localMedian)) {
        roofSurfaceY = localMedian;
        measured = true;
        stats.interpolatedRoofCells += 1;
      } else {
        roofSurfaceY = expectedRoofY;
        measured = false;
        stats.fallbackRoofCells += 1;
      }
    } else {
      const localDeviation = Number.isFinite(localMedian) ? Math.abs(current.roofSurfaceY - localMedian) : 0;
      const expectedDeviation = Math.abs(current.generatedRoofY - expectedRoofY);
      const unsupportedLocal = neighbours.length >= 4 && localDeviation > 2.25 && sameSurfaceSupport < minimumSupport;
      const unsupportedExpected = expectedDeviation > expectedAllowance && sameSurfaceSupport < 3;
      if (unsupportedLocal || unsupportedExpected) {
        roofSurfaceY = neighbours.length >= 3 && Number.isFinite(localMedian) ? localMedian : expectedRoofY;
        measured = neighbours.length >= 3 && Number.isFinite(localMedian);
        stats.outlierSamplesRejected += 1;
      }
    }

    const roofY = Math.max(current.terrainY + 2, Math.round(roofSurfaceY));
    accepted.set(key, {
      terrainY: current.terrainY,
      roofY,
      roofSurfaceY,
      measured
    });
  }
  return accepted;
}

function sampleRawHeight({ x, z, minDatum, fallbackHeight, elevation }) {
  const pair = typeof elevation?.samplePairLocal === "function" ? elevation.samplePairLocal(x, z) : null;
  const terrainAbsolute = Number.isFinite(pair?.terrain)
    ? pair.terrain
    : typeof elevation?.sampleLocal === "function" ? elevation.sampleLocal(x, z) : null;
  const terrainY = Number.isFinite(terrainAbsolute) ? Math.round(terrainAbsolute - minDatum) : 0;
  const measuredHeight = Number.isFinite(pair?.surface) && Number.isFinite(pair?.terrain)
    ? pair.surface - pair.terrain : null;
  const measuredSurfaceY = Number.isFinite(pair?.surface) ? pair.surface - minDatum : null;
  const measuredRoofY = Number.isFinite(measuredSurfaceY) ? Math.round(measuredSurfaceY) : null;
  const measured = Number.isFinite(measuredRoofY) && measuredHeight >= 1.5 && measuredHeight <= 80 &&
    measuredRoofY >= terrainY + 2 && measuredRoofY <= terrainY + 80;
  const generatedRoofY = measured ? measuredRoofY : terrainY + fallbackHeight;
  return {
    terrainY,
    generatedRoofY,
    roofSurfaceY: measured ? measuredSurfaceY : generatedRoofY,
    measured
  };
}

function footprintCells(geometry, bounds) {
  const cells = new Map();
  for (const polygon of polygonParts(geometry)) {
    const holes = polygon.slice(1);
    for (const [x1, x2, z] of polygonScanlineSpans(polygon)) {
      if (z < bounds.minZ || z > bounds.maxZ) continue;
      for (let x = Math.max(x1, bounds.minX); x <= Math.min(x2, bounds.maxX); x += 1) {
        if (holes.some((ring) => pointInRing(x + 0.5, z + 0.5, ring))) continue;
        cells.set(cellKey2d(x, z), { x, z });
      }
    }
  }
  return cells;
}

function polygonParts(geometry) {
  if (geometry?.type === "Polygon") return [geometry.coordinates];
  if (geometry?.type === "MultiPolygon") return geometry.coordinates || [];
  return [];
}

function isBoundaryCell(cell, cells) {
  return [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dz]) => !cells.has(cellKey2d(cell.x + dx, cell.z + dz)));
}

function appendCellOperation(compilation, phase, x, y, z, block, stats) {
  appendColumnOperation(compilation, phase, x, y, y, z, block, stats);
}

function appendColumnOperation(compilation, phase, x, y1, y2, z, block, stats) {
  if (!Number.isFinite(y1) || !Number.isFinite(y2) || y2 < y1) return;
  const paletteIndex = ensurePalette(compilation, block);
  const chunkX = Math.floor(x / 16), chunkZ = Math.floor(z / 16);
  let chunk = (compilation.chunks || []).find((value) => value.x === chunkX && value.z === chunkZ);
  if (!chunk) {
    chunk = { x: chunkX, z: chunkZ, o: [] };
    compilation.chunks ||= [];
    compilation.chunks.push(chunk);
  }
  chunk.o.push([phase, x, y1, z, x, y2, z, paletteIndex]);
  const blocks = y2 - y1 + 1;
  stats.operations += 1;
  stats.estimatedBlocks += blocks;
  if (compilation.stats) {
    compilation.stats.rawOperations = Number(compilation.stats.rawOperations || 0) + 1;
    compilation.stats.estimatedBlocks = Number(compilation.stats.estimatedBlocks || 0) + blocks;
  }
}

function ensurePalette(compilation, block) {
  compilation.palette ||= [];
  let index = compilation.palette.indexOf(block);
  if (index >= 0) return index;
  index = compilation.palette.length;
  compilation.palette.push(block);
  return index;
}

function buildingWallBlock(feature) {
  const fallback = feature.tags?.material === "wood" || feature.tags?.["building:material"] === "wood"
    ? "minecraft:spruce_planks"
    : feature.tags?.["building:material"] === "brick" ? "minecraft:brick_block" : "minecraft:stone_bricks";
  return primaryMaterialBlock(feature, "wall", fallback);
}

function buildingRoofBlock(feature) {
  const fallback = feature.tags?.["roof:material"] === "glass" ? "minecraft:glass" : "minecraft:deepslate_tiles";
  return primaryMaterialBlock(feature, "roof", fallback);
}

function statefulRoofFamily(block) {
  return ({
    "minecraft:deepslate_tiles": { slab: "minecraft:deepslate_tile_slab", stairs: "minecraft:deepslate_tile_stairs" },
    "minecraft:deepslate_bricks": { slab: "minecraft:deepslate_brick_slab", stairs: "minecraft:deepslate_brick_stairs" },
    "minecraft:polished_deepslate": { slab: "minecraft:polished_deepslate_slab", stairs: "minecraft:polished_deepslate_stairs" },
    "minecraft:brick_block": { slab: "minecraft:brick_slab", stairs: "minecraft:brick_stairs" },
    "minecraft:stone_bricks": { slab: "minecraft:stone_brick_slab", stairs: "minecraft:stone_brick_stairs" },
    "minecraft:spruce_planks": { slab: "minecraft:spruce_slab", stairs: "minecraft:spruce_stairs" },
    "minecraft:oak_planks": { slab: "minecraft:oak_slab", stairs: "minecraft:oak_stairs" },
    "minecraft:sandstone": { slab: "minecraft:sandstone_slab", stairs: "minecraft:sandstone_stairs" },
    "minecraft:smooth_sandstone": { slab: "minecraft:smooth_sandstone_slab", stairs: "minecraft:smooth_sandstone_stairs" }
  })[block] || null;
}

function stairDirection(dx, dz) {
  if (dx > 0) return 0;
  if (dx < 0) return 1;
  if (dz > 0) return 2;
  return 3;
}

function transitionPriority(candidate) {
  return (candidate.kind === "stair" ? 10 : 0) + candidate.deltaM;
}

function replacementPriority(replacement) {
  return (replacement.kind === "lidar-roof-stair" ? 10 : 0) + Number(replacement.evidenceDeltaM || 0);
}

function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function emptyStats(status) {
  return {
    schemaVersion: 1,
    status,
    method: "locally-supported DSM roof sanitation plus full-cube exterior/internal seam sealing",
    buildings: 0,
    roofCells: 0,
    boundaryWallColumns: 0,
    internalStepWallColumns: 0,
    internalStepWallBlocks: 0,
    clearedColumns: 0,
    clearedBlocks: 0,
    outlierSamplesRejected: 0,
    interpolatedRoofCells: 0,
    fallbackRoofCells: 0,
    removedStaleStatefulTransitions: 0,
    statefulTransitions: 0,
    roofStairCells: 0,
    roofSlabCells: 0,
    trueInteriorRingsPreserved: 0,
    operations: 0,
    estimatedBlocks: 0,
    watertightExteriorWalls: true,
    watertightInternalRoofSteps: true,
    terrainMutationAllowed: false,
    trueCourtyardFillAllowed: false
  };
}

const cellKey2d = (x, z) => `${x},${z}`;
const cellKey = (x, y, z) => `${x},${y},${z}`;
