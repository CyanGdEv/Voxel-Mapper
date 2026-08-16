import { buildPhaseOneTerrainTopIndex, createAboveTerrainCompilationWriter } from "./compilation-overlay-writer.mjs";
import { buildNaturalTreeGeometry } from "./natural-tree-geometry.mjs";

const PHASE_TREE_LEAVES = 9.10;
const PHASE_TREE_TRUNK = 9.11;
const PHASE_BARRIERS = 9.20;
const PHASE_LIGHTING_POLE = 9.30;
const PHASE_LIGHTING_HEAD = 9.31;

export function renderPlanningObjects3d({ compilation, planningObjects, options = {} } = {}) {
  const result = {
    schemaVersion: 1,
    status: "processed",
    objects: 0,
    trees: 0,
    treeTrunkVoxels: 0,
    treeBranchVoxels: 0,
    treeRootVoxels: 0,
    treeLeafVoxels: 0,
    treeNaturalGeometryModels: 0,
    lightingColumns: 0,
    lightingPoleVoxels: 0,
    lightingHeadVoxels: 0,
    barriers: 0,
    barrierVoxels: 0,
    skippedBelowTerrainWrites: 0,
    skippedOutsideBoundsWrites: 0,
    writtenVoxels: 0,
    deferred: 0,
    airWrites: 0,
    terrainGeometryChanged: false,
    terrainElevationChanged: false
  };
  if (!compilation?.chunks || !Array.isArray(compilation.palette) || !planningObjects?.objects?.length) {
    result.status = "no-planning-objects";
    return result;
  }

  const terrain = buildPhaseOneTerrainTopIndex(compilation);
  const writer = createAboveTerrainCompilationWriter(compilation, terrain, result);

  for (const object of planningObjects.objects) {
    let written = 0;
    if (object.kind === "tree") {
      written = renderTree(object, writer, result, options);
      if (written) result.trees += 1;
    } else if (object.kind === "lighting_column") {
      written = renderLightingColumn(object, writer, result);
      if (written) result.lightingColumns += 1;
    } else if (object.kind === "barrier") {
      written = renderBarrier(object, writer, result);
      if (written) result.barriers += 1;
    }
    if (written) result.objects += 1;
    else result.deferred += 1;
  }

  writer.finish();
  compilation.stats.planningObject3dObjects = result.objects;
  compilation.stats.planningObject3dTreeVoxels = result.treeTrunkVoxels + result.treeLeafVoxels;
  compilation.stats.planningObject3dNaturalTreeModels = result.treeNaturalGeometryModels;
  compilation.stats.planningObject3dTreeBranchVoxels = result.treeBranchVoxels;
  compilation.stats.planningObject3dTreeRootVoxels = result.treeRootVoxels;
  compilation.stats.planningObject3dLightingVoxels = result.lightingPoleVoxels + result.lightingHeadVoxels;
  compilation.stats.planningObject3dBarrierVoxels = result.barrierVoxels;
  compilation.meta.planningObject3d = {
    schemaVersion: 2,
    objects: result.objects,
    trees: result.trees,
    naturalTreeGeometryModels: result.treeNaturalGeometryModels,
    treeShapeModel: "deterministic-natural-tree-v1",
    lightingColumns: result.lightingColumns,
    barriers: result.barriers,
    source: "verified-current registered planning geometry plus exact current schedule",
    terrainGeometryMutable: false,
    terrainElevationMutable: false,
    airClearingAllowed: false,
    writeRule: "all object voxels must be strictly above exact phase-1 terrain top"
  };
  result.status = result.objects ? "rendered" : "evidence-deferred";
  return result;
}

function renderTree(object, writer, result, options = {}) {
  const x = Math.round(Number(object.anchor?.x));
  const z = Math.round(Number(object.anchor?.z));
  const groundY = writer.terrainY(x, z);
  if (![x, z, groundY].every(Number.isFinite)) return 0;
  const totalHeight = Math.max(2, Math.round(Number(object.heightM)));
  const crownDiameter = Math.max(1, Math.round(Number(object.crownSpreadM)));
  if (!Number.isFinite(totalHeight) || !Number.isFinite(crownDiameter)) return 0;

  const blocks = treeBlocks(object.species);
  const geometry = buildNaturalTreeGeometry({
    x,
    z,
    groundY,
    heightM: totalHeight,
    crownDiameterM: crownDiameter,
    trunkDiameterM: object.trunkDiameterM,
    species: object.species,
    logBlock: blocks.log,
    leafPalette: blocks.leaves,
    seed: naturalTreeSeed(object, options),
    terrainYAt: (cellX, cellZ) => writer.terrainY(cellX, cellZ)
  });
  if (geometry.status !== "generated") return 0;

  let written = 0;
  for (const voxel of geometry.leafVoxels) {
    if (writer.cell(PHASE_TREE_LEAVES, voxel.x, voxel.y, voxel.z, voxel.block)) {
      result.treeLeafVoxels += 1;
      written += 1;
    }
  }
  for (const voxel of geometry.woodVoxels) {
    if (!writer.cell(PHASE_TREE_TRUNK, voxel.x, voxel.y, voxel.z, voxel.block)) continue;
    result.treeTrunkVoxels += 1;
    if (voxel.role === "root") result.treeRootVoxels += 1;
    else if (voxel.x !== x || voxel.z !== z || voxel.y > groundY + Math.round(totalHeight * 0.35)) {
      result.treeBranchVoxels += 1;
    }
    written += 1;
  }
  if (written) result.treeNaturalGeometryModels += 1;
  return written;
}

function renderLightingColumn(object, writer, result) {
  const x = Math.round(Number(object.anchor?.x));
  const z = Math.round(Number(object.anchor?.z));
  const groundY = writer.terrainY(x, z);
  const height = Math.max(2, Math.round(Number(object.heightM)));
  if (![x, z, groundY, height].every(Number.isFinite)) return 0;
  const pole = lightingPoleBlock(object);
  let written = 0;
  for (let dy = 1; dy < height; dy += 1) {
    if (writer.cell(PHASE_LIGHTING_POLE, x, groundY + dy, z, pole)) {
      result.lightingPoleVoxels += 1;
      written += 1;
    }
  }
  if (writer.cell(PHASE_LIGHTING_HEAD, x, groundY + height, z, "minecraft:sea_lantern")) {
    result.lightingHeadVoxels += 1;
    written += 1;
  }
  return written;
}

function renderBarrier(object, writer, result) {
  const cells = geometryLineCells(object.geometry);
  if (!cells.length) return 0;
  const height = Math.max(1, Math.ceil(Number(object.heightM)));
  if (!Number.isFinite(height)) return 0;
  const block = barrierBlock(object.constructionMaterial, object.subtype);
  let written = 0;
  for (const [x, z] of cells) {
    const groundY = writer.terrainY(x, z);
    if (!Number.isFinite(groundY)) continue;
    for (let dy = 1; dy <= height; dy += 1) {
      if (writer.cell(PHASE_BARRIERS, x, groundY + dy, z, block)) {
        result.barrierVoxels += 1;
        written += 1;
      }
    }
  }
  return written;
}

function geometryLineCells(geometry) {
  if (!geometry) return [];
  const lines = geometry.type === "LineString" ? [geometry.coordinates || []]
    : geometry.type === "MultiLineString" ? (geometry.coordinates || [])
      : [];
  const result = [];
  const seen = new Set();
  for (const line of lines) {
    for (let i = 1; i < line.length; i += 1) {
      const a = line[i - 1], b = line[i];
      if (!finitePoint(a) || !finitePoint(b)) continue;
      const dx = Number(b[0]) - Number(a[0]);
      const dz = Number(b[1]) - Number(a[1]);
      const steps = Math.max(Math.abs(Math.round(dx)), Math.abs(Math.round(dz)), 1);
      for (let step = 0; step <= steps; step += 1) {
        const x = Math.round(Number(a[0]) + dx * step / steps);
        const z = Math.round(Number(a[1]) + dz * step / steps);
        const key = `${x},${z}`;
        if (!seen.has(key)) {
          seen.add(key);
          result.push([x, z]);
        }
      }
    }
  }
  return result;
}

function treeBlocks(species) {
  const value = String(species || "").toLowerCase();
  if (/birch|betula|alder/.test(value)) {
    return { log: "minecraft:birch_log", leaves: ["minecraft:birch_leaves", "minecraft:oak_leaves"] };
  }
  if (/cherry|prunus/.test(value)) {
    return { log: "minecraft:cherry_log", leaves: ["minecraft:cherry_leaves"] };
  }
  if (/pine|spruce|fir|cedar|yew|larch|redwood|sequoia/.test(value)) {
    return { log: "minecraft:spruce_log", leaves: ["minecraft:spruce_leaves", "minecraft:dark_oak_leaves"] };
  }
  if (/acacia/.test(value)) {
    return { log: "minecraft:acacia_log", leaves: ["minecraft:acacia_leaves", "minecraft:oak_leaves"] };
  }
  return { log: "minecraft:oak_log", leaves: ["minecraft:oak_leaves", "minecraft:dark_oak_leaves"] };
}

function naturalTreeSeed(object, options) {
  const base = Number(options.seed || 0) | 0;
  const text = `${object.id || ""}:${object.canonicalObjectCode || ""}:${object.species || ""}:${object.anchor?.x || 0}:${object.anchor?.z || 0}`;
  let hash = 2166136261;
  for (const character of text) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash ^ base) | 0;
}

function lightingPoleBlock(object) {
  const ral = String(object.ral || "").toUpperCase();
  if (ral === "RAL 9005") return "minecraft:polished_blackstone_wall";
  if (ral === "RAL 7016") return "minecraft:cobbled_deepslate_wall";
  if (object.constructionMaterial === "timber") return "minecraft:oak_fence";
  return "minecraft:iron_bars";
}

function barrierBlock(material, subtype) {
  if (material === "timber") return "minecraft:oak_fence";
  if (material === "steel") return subtype === "boundary_wall" ? "minecraft:iron_block" : "minecraft:iron_bars";
  if (material === "concrete") return "minecraft:light_gray_concrete";
  if (material === "brick") return "minecraft:brick_wall";
  if (material === "stone") return "minecraft:stone_brick_wall";
  return "minecraft:iron_bars";
}

function finitePoint(point) {
  return Array.isArray(point) && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]));
}
