import * as base from "./raster-base.mjs";
import { pointInRing, polygonScanlineSpans } from "./geo.mjs";
import { primaryMaterialBlock } from "./material-palettes.mjs";

export const formatSignText = base.formatSignText;

/**
 * Run the canonical compiler first, then repair LiDAR building shells from one
 * shared filled footprint mask. Roof and wall topology can no longer disagree
 * on diagonal/irregular footprints, while genuine interior rings stay open.
 *
 * LiDAR-supported sub-block roof transitions are recorded as stateful Bedrock
 * replacements. The direct-world writer first emits the proven full-block roof
 * fallback and mcworld.mjs replaces only those explicit cells with slabs/stairs.
 */
export function compileMap(input) {
  const compilation = base.compileMap(input);
  const repair = repairLidarBuildingShells(compilation, input);
  compilation.meta ||= {};
  compilation.meta.verticalStats ||= {};
  compilation.meta.verticalStats.buildingShellIntegrity = repair;
  compilation.stats ||= {};
  compilation.stats.buildingShellRepairOperations = repair.operations;
  compilation.stats.buildingShellSealedRoofCells = repair.roofCells;
  compilation.stats.buildingShellSealedWallColumns = repair.wallColumns;
  compilation.stats.buildingRoofStairCells = repair.roofStairCells;
  compilation.stats.buildingRoofSlabCells = repair.roofSlabCells;
  return compilation;
}

export function repairLidarBuildingShells(compilation, { map, sources }) {
  const bounds = compilation?.meta?.bounds;
  const minDatum = Number(compilation?.meta?.elevationDatumM || 0);
  if (!bounds || !map?.features?.length) return emptyStats("missing-compilation-context");

  compilation.meta ||= {};
  compilation.meta.statefulBlockReplacements ||= [];
  const statefulByCell = new Map(compilation.meta.statefulBlockReplacements.map((item) => [cellKey(item.x, item.y, item.z), item]));
  const stats = emptyStats("complete");
  const features = map.features.filter((feature) =>
    feature?.kind === "building" && feature?.roof?.source === "lidar-dsm-surface" &&
    ["Polygon", "MultiPolygon"].includes(feature?.localGeometry?.type)
  );

  for (const feature of features) {
    const polygons = polygonParts(feature.localGeometry);
    if (!polygons.length) continue;
    stats.buildings += 1;
    stats.trueInteriorRingsPreserved += polygons.reduce((sum, polygon) => sum + Math.max(0, polygon.length - 1), 0);

    const cells = new Map();
    for (const polygon of polygons) {
      const holes = polygon.slice(1);
      for (const [x1, x2, z] of polygonScanlineSpans(polygon)) {
        if (z < bounds.minZ || z > bounds.maxZ) continue;
        for (let x = Math.max(x1, bounds.minX); x <= Math.min(x2, bounds.maxX); x += 1) {
          if (holes.some((ring) => pointInRing(x + 0.5, z + 0.5, ring))) continue;
          cells.set(`${x},${z}`, { x, z });
        }
      }
    }
    if (!cells.size) continue;

    const heights = new Map();
    const heightAt = (x, z) => {
      const key = `${x},${z}`;
      if (heights.has(key)) return heights.get(key);
      const pair = typeof sources?.elevation?.samplePairLocal === "function"
        ? sources.elevation.samplePairLocal(x, z) : null;
      const terrainAbsolute = Number.isFinite(pair?.terrain)
        ? pair.terrain
        : typeof sources?.elevation?.sampleLocal === "function" ? sources.elevation.sampleLocal(x, z) : null;
      const terrainY = Number.isFinite(terrainAbsolute) ? Math.round(terrainAbsolute - minDatum) : 0;
      const measuredHeight = Number.isFinite(pair?.surface) && Number.isFinite(pair?.terrain)
        ? pair.surface - pair.terrain : null;
      const measuredRoofRaw = Number.isFinite(pair?.surface) ? pair.surface - minDatum : null;
      const measuredRoofY = Number.isFinite(measuredRoofRaw) ? Math.round(measuredRoofRaw) : null;
      const fallbackHeight = Math.max(2, Math.round(Number(feature?.vertical?.heightM ?? feature?.roof?.heightM ?? 5)));
      const measured = Number.isFinite(measuredRoofY) && measuredHeight >= 1.5 && measuredHeight <= 80 &&
        measuredRoofY >= terrainY + 2 && measuredRoofY <= terrainY + 80;
      const roofY = measured ? measuredRoofY : terrainY + fallbackHeight;
      const result = { terrainY, roofY, roofSurfaceY: measured ? measuredRoofRaw : roofY, measured };
      heights.set(key, result);
      return result;
    };

    const roofBlock = buildingRoofBlock(feature);
    const floorBlock = buildingFloorBlock(feature);
    const wallBlock = buildingWallBlock(feature);

    // Roof and floor share exactly the same topology mask. This is the core
    // watertightness guarantee for reconstructed building shells.
    for (const cell of cells.values()) {
      const { terrainY, roofY } = heightAt(cell.x, cell.z);
      appendCellOperation(compilation, 2, cell.x, terrainY + 1, cell.z, floorBlock, stats);
      appendCellOperation(compilation, 2, cell.x, roofY, cell.z, roofBlock, stats);
      stats.roofCells += 1;
    }

    for (const cell of cells.values()) {
      if (!isBoundaryCell(cell, cells)) continue;
      const { terrainY, roofY } = heightAt(cell.x, cell.z);
      appendColumnOperation(compilation, 2, cell.x, terrainY + 1, roofY, cell.z, wallBlock, stats);
      stats.wallColumns += 1;
    }

    const detailBlock = wallDetailBlock(feature);
    const roofFamily = statefulRoofFamily(roofBlock);
    const transitionCandidates = new Map();

    for (const cell of cells.values()) {
      const current = heightAt(cell.x, cell.z);
      for (const [dx, dz] of [[1, 0], [0, 1]]) {
        const neighbour = cells.get(`${cell.x + dx},${cell.z + dz}`);
        if (!neighbour) continue;
        const other = heightAt(neighbour.x, neighbour.z);
        const deltaRaw = other.roofSurfaceY - current.roofSurfaceY;
        const absoluteDelta = Math.abs(deltaRaw);

        if (current.measured && other.measured && roofFamily && absoluteDelta >= 0.45 && absoluteDelta < 1.5) {
          const lower = deltaRaw > 0 ? cell : neighbour;
          const lowerHeight = deltaRaw > 0 ? current : other;
          const riseDx = deltaRaw > 0 ? dx : -dx;
          const riseDz = deltaRaw > 0 ? dz : -dz;
          const kind = absoluteDelta >= 0.8 ? "stair" : "slab";
          const candidate = {
            x: lower.x,
            y: lowerHeight.roofY,
            z: lower.z,
            kind,
            deltaM: absoluteDelta,
            riseDx,
            riseDz
          };
          const key = cellKey(candidate.x, candidate.y, candidate.z);
          const existing = transitionCandidates.get(key);
          if (!existing || transitionPriority(candidate) > transitionPriority(existing)) transitionCandidates.set(key, candidate);
          continue;
        }

        if (absoluteDelta < 1.5) continue;
        const lower = deltaRaw > 0 ? cell : neighbour;
        const lowerHeight = deltaRaw > 0 ? current : other;
        appendCellOperation(compilation, 3, lower.x, lowerHeight.roofY + 1, lower.z, detailBlock, stats);
        stats.roofStepDetailCells += 1;
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
            featureId: feature.id,
            evidenceDeltaM: Number(candidate.deltaM.toFixed(3))
          }
        : {
            x: candidate.x,
            y: candidate.y,
            z: candidate.z,
            name: roofFamily.slab,
            states: { "minecraft:vertical_half": "bottom" },
            kind: "lidar-roof-slab",
            featureId: feature.id,
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
  stats.roofStairCells = compilation.meta.statefulBlockReplacements.filter((item) => item.kind === "lidar-roof-stair").length;
  stats.roofSlabCells = compilation.meta.statefulBlockReplacements.filter((item) => item.kind === "lidar-roof-slab").length;
  stats.statefulDetailReplacements = stats.roofStairCells + stats.roofSlabCells;

  for (const chunk of compilation.chunks || []) chunk.o.sort((a, b) => a[0] - b[0]);
  compilation.chunks?.sort((a, b) => a.z - b.z || a.x - b.x);
  return stats;
}

function emptyStats(status) {
  return {
    schemaVersion: 2,
    status,
    method: "shared-footprint-mask LiDAR shell repair with stateful roof transitions",
    buildings: 0,
    roofCells: 0,
    wallColumns: 0,
    roofStepDetailCells: 0,
    roofStairCells: 0,
    roofSlabCells: 0,
    statefulDetailReplacements: 0,
    trueInteriorRingsPreserved: 0,
    operations: 0,
    estimatedBlocks: 0,
    watertightBoundaryDerivedFromRoofMask: true
  };
}

function isBoundaryCell(cell, cells) {
  return [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dz]) => !cells.has(`${cell.x + dx},${cell.z + dz}`));
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
  stats.operations += 1;
  stats.estimatedBlocks += y2 - y1 + 1;
  if (compilation.stats) {
    compilation.stats.rawOperations = Number(compilation.stats.rawOperations || 0) + 1;
    compilation.stats.estimatedBlocks = Number(compilation.stats.estimatedBlocks || 0) + y2 - y1 + 1;
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

function polygonParts(geometry) {
  if (geometry?.type === "Polygon") return [geometry.coordinates];
  if (geometry?.type === "MultiPolygon") return geometry.coordinates || [];
  return [];
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
function buildingFloorBlock(feature) {
  const fallback = feature.tags?.material === "wood" || feature.tags?.["building:material"] === "wood"
    ? "minecraft:spruce_planks" : "minecraft:smooth_stone";
  return primaryMaterialBlock(feature, "floor", fallback);
}
function wallDetailBlock(feature) {
  const text = `${feature.tags?.material || ""} ${feature.tags?.["building:material"] || ""} ${feature.tags?.["roof:material"] || ""}`.toLowerCase();
  if (/brick/.test(text)) return "minecraft:brick_wall";
  if (/deepslate|slate/.test(text)) return "minecraft:cobbled_deepslate_wall";
  return "minecraft:stone_brick_wall";
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

const cellKey = (x, y, z) => `${x},${y},${z}`;
