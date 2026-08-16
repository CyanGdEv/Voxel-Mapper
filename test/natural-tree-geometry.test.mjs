import test from "node:test";
import assert from "node:assert/strict";
import { buildNaturalTreeGeometry, classifyTreeArchetype } from "../src/lib/natural-tree-geometry.mjs";

function signature(tree) {
  return JSON.stringify([
    ...tree.woodVoxels.map((v) => [v.x,v.y,v.z,v.block,v.role]),
    ...tree.leafVoxels.map((v) => [v.x,v.y,v.z,v.block,v.role])
  ]);
}

test("24 m tree reproduces the supplied schematic occupied-voxel count and 5x5 footprint", () => {
  const tree = buildNaturalTreeGeometry({ x: 10, z: -4, groundY: 7, heightM: 24 });
  assert.equal(tree.status, "generated");
  assert.equal(tree.shapeModel, "user-schematic-tall-tree-v1");
  assert.equal(tree.woodVoxels.length + tree.leafVoxels.length, 173);
  assert.equal(tree.bounds.minX, 8);
  assert.equal(tree.bounds.maxX, 12);
  assert.equal(tree.bounds.minZ, -6);
  assert.equal(tree.bounds.maxZ, -2);
  assert.equal(tree.bounds.minY, 8);
  assert.equal(tree.bounds.maxY, 31);
});

test("species and seed do not change the fixed schematic geometry", () => {
  const a = buildNaturalTreeGeometry({ heightM: 24, species: "oak", seed: 1 });
  const b = buildNaturalTreeGeometry({ heightM: 24, species: "spruce", seed: 999 });
  assert.equal(signature(a), signature(b));
  assert.equal(classifyTreeArchetype("oak"), "fixed-tall-tree-schematic");
});

test("height evidence rescales only Y and reaches the exact requested top", () => {
  for (const heightM of [5, 13, 31, 60]) {
    const tree = buildNaturalTreeGeometry({ x: 0, z: 0, groundY: 4, heightM });
    assert.equal(tree.bounds.maxY, 4 + heightM);
    assert.ok(tree.bounds.minX >= -2 && tree.bounds.maxX <= 2);
    assert.ok(tree.bounds.minZ >= -2 && tree.bounds.maxZ <= 2);
    assert.equal(tree.dimensions.widthBlocks, 5);
    assert.equal(tree.dimensions.lengthBlocks, 5);
  }
});

test("stretched trees remain vertically continuous where the source trunk exists", () => {
  const tree = buildNaturalTreeGeometry({ x: 0, z: 0, groundY: 0, heightM: 48 });
  const centerWood = new Set(tree.woodVoxels.filter(v => v.x === 0 && v.z === 0).map(v => v.y));
  assert.ok(centerWood.has(1));
  assert.ok(centerWood.size > 20);
  assert.equal(tree.bounds.maxY, 48);
});

test("terrain callback prevents schematic voxels from entering local terrain", () => {
  const tree = buildNaturalTreeGeometry({
    x: 0, z: 0, groundY: 0, heightM: 24,
    terrainYAt: (x, z) => x === 2 ? 4 : (z === 2 ? 2 : 0)
  });
  for (const voxel of [...tree.woodVoxels, ...tree.leafVoxels]) {
    const terrain = voxel.x === 2 ? 4 : (voxel.z === 2 ? 2 : 0);
    assert.ok(voxel.y > terrain);
  }
});

test("schematic blocks are fixed Bedrock-compatible spruce wood and dark-oak leaves", () => {
  const tree = buildNaturalTreeGeometry({ heightM: 24 });
  assert.deepEqual(new Set(tree.woodVoxels.map(v => v.block)), new Set(["minecraft:stripped_spruce_wood"]));
  assert.deepEqual(new Set(tree.leafVoxels.map(v => v.block)), new Set(["minecraft:dark_oak_leaves"]));
});
