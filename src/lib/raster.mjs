import * as base from "./raster-base.mjs";
import { pointInRing, polygonScanlineSpans } from "./geo.mjs";
import { primaryMaterialBlock } from "./material-palettes.mjs";

export const formatSignText = base.formatSignText;

/**
 * Run the canonical compiler first, then repair LiDAR building shells from one
 * shared filled footprint mask. The old implementation filled roofs with
 * scanlines but walls with line rasterization; diagonal/irregular footprints
 * could therefore disagree by a cell and leave visible holes.
 *
 * This pass deliberately preserves true polygon interior rings (courtyards).
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
  return compilation;
}

export function repairLidarBuildingShells(compilation, { map, sources }) {
  const bounds = compilation?.meta?.bounds;
  const minDatum = Number(compilation?.meta?.elevationDatumM || 0);
  if (!bounds || !map?.features?.length) return emptyStats("missing-compilation-context");

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
      const measuredRoofY = Number.isFinite(pair?.surface) ? Math.round(pair.surface - minDatum) : null;
      const fallbackHeight = Math.max(2, Math.round(Number(feature?.vertical?.heightM ?? feature?.roof?.heightM ?? 5)));
      const roofY = Number.isFinite(measuredRoofY) && measuredHeight >= 1.5 && measuredHeight <= 80 &&
        measuredRoofY >= terrainY + 2 && measuredRoofY <= terrainY + 80
        ? measuredRoofY : terrainY + fallbackHeight;
      const result = { terrainY, roofY };
      heights.set(key, result);
      return result;
    };

    const roofBlock = buildingRoofBlock(feature);
    const floorBlock = buildingFloorBlock(feature);
    const wallBlock = buildingWallBlock(feature);

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
    for (const cell of cells.values()) {
      const current = heightAt(cell.x, cell.z);
      for (const [dx, dz] of [[1, 0], [0, 1]]) {
        const neighbour = cells.get(`${cell.x + dx},${cell.z + dz}`);
        if (!neighbour) continue;
        const other = heightAt(neighbour.x, neighbour.z);
        const delta = other.roofY - current.roofY;
        if (Math.abs(delta) < 2) continue;
        const lower = delta > 0 ? cell : neighbour;
        const lowerHeight = delta > 0 ? current : other;
        appendCellOperation(compilation, 3, lower.x, lowerHeight.roofY + 1, lower.z, detailBlock, stats);
        stats.roofStepDetailCells += 1;
      }
    }
  }

  for (const chunk of compilation.chunks || []) chunk.o.sort((a, b) => a[0] - b[0]);
  compilation.chunks?.sort((a, b) => a.z - b.z || a.x - b.x);
  return stats;
}

function emptyStats(status) {
  return {
    schemaVersion: 1,
    status,
    method: "shared-footprint-mask LiDAR shell repair",
    buildings: 0,
    roofCells: 0,
    wallColumns: 0,
    roofStepDetailCells: 0,
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
