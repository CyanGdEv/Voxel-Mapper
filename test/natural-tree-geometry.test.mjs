import test from "node:test";
import assert from "node:assert/strict";
import { buildNaturalTreeGeometry, classifyTreeArchetype } from "../src/lib/natural-tree-geometry.mjs";

function signature(tree) {
  return JSON.stringify({
    archetype: tree.archetype,
    wood: tree.woodVoxels.map(({ x, y, z, block, role }) => [x, y, z, block, role]),
    leaves: tree.leafVoxels.map(({ x, y, z, block }) => [x, y, z, block])
  });
}

function maxHorizontalDistance(tree, x = 0, z = 0) {
  return Math.max(0, ...[...tree.woodVoxels, ...tree.leafVoxels]
    .map((voxel) => Math.hypot(voxel.x - x, voxel.z - z)));
}

test("natural tree geometry is deterministic for a fixed evidence seed", () => {
  const input = {
    x: 12, z: -8, groundY: 4,
    heightM: 18, crownDiameterM: 12, trunkDiameterM: 1.2,
    species: "English oak", seed: 92714,
    leafPalette: ["minecraft:oak_leaves", "minecraft:birch_leaves"]
  };
  const first = buildNaturalTreeGeometry(input);
  const second = buildNaturalTreeGeometry(input);
  assert.equal(first.status, "generated");
  assert.equal(signature(first), signature(second));
  assert.equal(first.shapeModel, "deterministic-natural-tree-v1");
});

test("different deterministic seeds vary branching without changing measured envelope", () => {
  const shared = { x: 0, z: 0, groundY: 0, heightM: 17, crownDiameterM: 11, species: "oak" };
  const first = buildNaturalTreeGeometry({ ...shared, seed: 101 });
  const second = buildNaturalTreeGeometry({ ...shared, seed: 202 });
  assert.notEqual(signature(first), signature(second));
  for (const tree of [first, second]) {
    assert.ok(tree.bounds.maxY <= 17);
    assert.ok(maxHorizontalDistance(tree) <= 5.5 + 1e-9);
    assert.equal(tree.dimensions.heightBlocks, 17);
    assert.equal(tree.dimensions.crownDiameterBlocks, 11);
  }
});

test("broadleaf trees contain visible root flare, branches and separated foliage clusters", () => {
  const tree = buildNaturalTreeGeometry({
    x: 0, z: 0, groundY: 0,
    heightM: 20, crownDiameterM: 14, trunkDiameterM: 1.4,
    species: "Quercus robur", seed: 8842
  });
  assert.equal(tree.archetype, "broadleaf-spreading");
  assert.ok(tree.stats.rootVoxels >= 4);
  assert.ok(tree.stats.branchVoxels >= 12);
  assert.ok(tree.stats.primaryBranches >= 5);
  assert.ok(tree.stats.foliageClusters >= 6);
  assert.ok(tree.leafVoxels.length > 30);
  assert.ok(tree.woodVoxels.some((voxel) => voxel.role === "root"));
  assert.ok(tree.woodVoxels.some((voxel) => voxel.x !== 0 || voxel.z !== 0));
});

test("conifers use a tiered architecture rather than a rounded broadleaf crown", () => {
  const tree = buildNaturalTreeGeometry({
    x: 0, z: 0, groundY: 0,
    heightM: 24, crownDiameterM: 9,
    species: "Scots pine", leafType: "needle", seed: 477
  });
  assert.equal(tree.archetype, "conifer-tiered");
  assert.equal(tree.bounds.maxY, 24);
  assert.ok(tree.stats.primaryBranches >= 12);
  assert.ok(tree.stats.foliageClusters >= 8);
  const lowLeaves = tree.leafVoxels.filter((voxel) => voxel.y <= 12);
  const highLeaves = tree.leafVoxels.filter((voxel) => voxel.y >= 19);
  assert.ok(lowLeaves.length > highLeaves.length, "lower conifer tiers should be wider/denser than the tip");
});

test("measured tree dimensions remain hard geometry limits", () => {
  const tree = buildNaturalTreeGeometry({
    x: 30, z: 40, groundY: 7,
    heightM: 13, crownDiameterM: 8,
    species: "silver birch", seed: 11
  });
  assert.equal(tree.archetype, "birch-upright");
  assert.ok(tree.bounds.minY > 7);
  assert.ok(tree.bounds.maxY <= 20);
  assert.ok(maxHorizontalDistance(tree, 30, 40) <= 4 + 1e-9);
  assert.ok([...tree.woodVoxels, ...tree.leafVoxels].every((voxel) => voxel.y > 7 && voxel.y <= 20));
});

test("foliage never overwrites the connected wood skeleton", () => {
  const tree = buildNaturalTreeGeometry({
    heightM: 16, crownDiameterM: 10, species: "oak", seed: 99
  });
  const wood = new Set(tree.woodVoxels.map((voxel) => `${voxel.x},${voxel.y},${voxel.z}`));
  assert.ok(tree.leafVoxels.every((voxel) => !wood.has(`${voxel.x},${voxel.y},${voxel.z}`)));
});

test("tree archetypes are selected from species and leaf evidence", () => {
  assert.equal(classifyTreeArchetype("Norway spruce", null), "conifer-tiered");
  assert.equal(classifyTreeArchetype("Silver birch", null), "birch-upright");
  assert.equal(classifyTreeArchetype("Acacia", null), "acacia-spreading");
  assert.equal(classifyTreeArchetype("Lombardy poplar", null), "broadleaf-upright");
  assert.equal(classifyTreeArchetype("Cherry", null), "cherry-rounded");
  assert.equal(classifyTreeArchetype("English oak", null), "broadleaf-spreading");
});

test("large measured trees remain sparse enough for world-generation use", () => {
  const tree = buildNaturalTreeGeometry({
    heightM: 40, crownDiameterM: 30, trunkDiameterM: 2.2,
    species: "mature oak", seed: 71
  });
  assert.ok(tree.woodVoxels.length < 2_500);
  assert.ok(tree.leafVoxels.length < 8_000);
  assert.ok(tree.bounds.maxY <= 40);
  assert.ok(maxHorizontalDistance(tree) <= 15 + 1e-9);
});
