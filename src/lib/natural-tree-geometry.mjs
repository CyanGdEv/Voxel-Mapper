import { TREE_SCHEMATIC_TEMPLATE } from "./tree-schematic-template.mjs";

const FIXED_WOOD_BLOCK = "minecraft:stripped_spruce_wood";
const FIXED_LEAF_BLOCK = "minecraft:dark_oak_leaves";
const SOURCE_HEIGHT = TREE_SCHEMATIC_TEMPLATE.sourceDimensions.height;

/**
 * Builds every full tree from the user-supplied Tall Tree schematic.
 *
 * X/Z geometry is deliberately fixed to the 5 x 5 schematic footprint.
 * Only the Y axis is resampled, so measured/tagged/LiDAR tree height remains
 * the real-world evidence dimension while all trees share one predictable,
 * authored Minecraft silhouette.
 */
export function buildNaturalTreeGeometry(options = {}) {
  const x = finiteRound(options.x, 0);
  const z = finiteRound(options.z, 0);
  const groundY = finiteRound(options.groundY, 0);
  const requestedHeight = Number(options.heightM);
  if (!Number.isFinite(requestedHeight) || requestedHeight <= 0) {
    return emptyTree("missing-or-invalid-height");
  }

  const maxHeight = clampInt(options.maxHeightBlocks ?? 80, 2, 320);
  const heightBlocks = clampInt(Math.round(requestedHeight), 2, maxHeight);
  const terrainYAt = typeof options.terrainYAt === "function" ? options.terrainYAt : null;
  const layers = templateLayers();
  const wood = new Map();
  const leaves = new Map();

  // Inverse-resample every target height layer. This preserves a continuous
  // tree when the measured height is taller than the source schematic instead
  // of leaving gaps between stretched source layers.
  for (let targetY = 1; targetY <= heightBlocks; targetY += 1) {
    const sourceY = sourceLayerForTarget(targetY, heightBlocks);
    for (const cell of layers.get(sourceY) || []) {
      const worldX = x + cell[0];
      const worldY = groundY + targetY;
      const worldZ = z + cell[2];
      const terrainY = terrainYAt ? Number(terrainYAt(worldX, worldZ)) : groundY;
      if (Number.isFinite(terrainY) && worldY <= terrainY) continue;

      const key = `${worldX},${worldY},${worldZ}`;
      if (cell[3] === "wood") {
        leaves.delete(key);
        wood.set(key, {
          x: worldX, y: worldY, z: worldZ,
          block: FIXED_WOOD_BLOCK,
          role: woodRole(cell[0], sourceY, cell[2])
        });
      } else if (!wood.has(key)) {
        leaves.set(key, {
          x: worldX, y: worldY, z: worldZ,
          block: FIXED_LEAF_BLOCK,
          role: "foliage"
        });
      }
    }
  }

  const woodVoxels = sortVoxels([...wood.values()]);
  const leafVoxels = sortVoxels([...leaves.values()]);
  const all = [...woodVoxels, ...leafVoxels];
  if (!all.length) return emptyTree("terrain-occluded");

  const suppliedCrown = Number(options.crownDiameterM);
  const suppliedTrunk = Number(options.trunkDiameterM);
  return {
    schemaVersion: 2,
    status: "generated",
    shapeModel: "user-schematic-tall-tree-v1",
    archetype: "fixed-tall-tree-schematic",
    sourceTemplate: {
      name: TREE_SCHEMATIC_TEMPLATE.name,
      format: TREE_SCHEMATIC_TEMPLATE.sourceFormat,
      dimensions: { ...TREE_SCHEMATIC_TEMPLATE.sourceDimensions },
      sourceVoxelCount: TREE_SCHEMATIC_TEMPLATE.voxelCount,
      fixedHorizontalFootprint: true,
      heightResampledFromEvidence: true
    },
    dimensions: {
      heightBlocks,
      crownDiameterBlocks: TREE_SCHEMATIC_TEMPLATE.sourceDimensions.width,
      measuredCrownDiameterM: Number.isFinite(suppliedCrown) ? suppliedCrown : null,
      measuredTrunkDiameterM: Number.isFinite(suppliedTrunk) ? suppliedTrunk : null,
      widthBlocks: TREE_SCHEMATIC_TEMPLATE.sourceDimensions.width,
      lengthBlocks: TREE_SCHEMATIC_TEMPLATE.sourceDimensions.length
    },
    bounds: voxelBounds(all),
    woodVoxels,
    leafVoxels,
    stats: {
      trunkVoxels: woodVoxels.filter((voxel) => voxel.role === "trunk").length,
      branchVoxels: woodVoxels.filter((voxel) => voxel.role === "branch").length,
      rootVoxels: woodVoxels.filter((voxel) => voxel.role === "root").length,
      leafVoxels: leafVoxels.length,
      primaryBranches: 0,
      secondaryBranches: 0,
      foliageClusters: 1,
      sourceTemplateVoxels: TREE_SCHEMATIC_TEMPLATE.voxelCount
    }
  };
}

/**
 * Kept as a compatibility API for callers/evidence reports. Species no longer
 * changes geometry because the mapper is intentionally using one supplied
 * schematic for every full tree.
 */
export function classifyTreeArchetype() {
  return "fixed-tall-tree-schematic";
}

let LAYERS = null;
function templateLayers() {
  if (LAYERS) return LAYERS;
  LAYERS = new Map();
  for (const voxel of TREE_SCHEMATIC_TEMPLATE.voxels) {
    const sourceY = Number(voxel[1]);
    if (!LAYERS.has(sourceY)) LAYERS.set(sourceY, []);
    LAYERS.get(sourceY).push(voxel);
  }
  return LAYERS;
}

function sourceLayerForTarget(targetY, targetHeight) {
  if (targetHeight <= 1) return 1;
  return clampInt(
    Math.round(1 + ((targetY - 1) * (SOURCE_HEIGHT - 1)) / (targetHeight - 1)),
    1,
    SOURCE_HEIGHT
  );
}

function woodRole(dx, sourceY, dz) {
  if (sourceY <= 2 && (dx !== 0 || dz !== 0)) return "root";
  if (sourceY >= 4 && (dx !== 0 || dz !== 0)) return "branch";
  return "trunk";
}

function voxelBounds(voxels) {
  const xs = voxels.map((v) => v.x), ys = voxels.map((v) => v.y), zs = voxels.map((v) => v.z);
  return {
    minX: Math.min(...xs), minY: Math.min(...ys), minZ: Math.min(...zs),
    maxX: Math.max(...xs), maxY: Math.max(...ys), maxZ: Math.max(...zs)
  };
}

function sortVoxels(values) {
  return values.sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x || a.block.localeCompare(b.block));
}

function emptyTree(reason) {
  return {
    schemaVersion: 2,
    status: "deferred",
    reason,
    shapeModel: "user-schematic-tall-tree-v1",
    archetype: "fixed-tall-tree-schematic",
    dimensions: null,
    bounds: null,
    woodVoxels: [],
    leafVoxels: [],
    stats: {
      trunkVoxels: 0, branchVoxels: 0, rootVoxels: 0, leafVoxels: 0,
      primaryBranches: 0, secondaryBranches: 0, foliageClusters: 0,
      sourceTemplateVoxels: TREE_SCHEMATIC_TEMPLATE.voxelCount
    }
  };
}

function finiteRound(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}
function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(Number(value) || min)));
}
