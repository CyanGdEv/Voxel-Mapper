import test from "node:test";
import assert from "node:assert/strict";
import { sliceCompilationForShard } from "../src/lib/world-shards.mjs";

test("world shard slicing keeps stateful replacements only in their owning shard", () => {
  const compilation = {
    meta: {
      bounds: { minX: -32, minZ: -16, maxX: 31, maxZ: 15 },
      statefulBlockReplacements: [
        { x: -17, y: 2, z: 0, name: "minecraft:stone_stairs" },
        { x: -1, y: 2, z: 0, name: "minecraft:stone_stairs" },
        { x: 0, y: 2, z: 0, name: "minecraft:stone_stairs" },
        { x: 31, y: 2, z: 0, name: "minecraft:stone_stairs" }
      ]
    },
    chunks: [
      { x: -2, z: 0, o: [] },
      { x: -1, z: 0, o: [] },
      { x: 0, z: 0, o: [] },
      { x: 1, z: 0, o: [] }
    ],
    signs: []
  };
  const left = { id: 0, minChunkX: -2, maxChunkX: -1, minChunkZ: -1, maxChunkZ: 0 };
  const right = { id: 1, minChunkX: 0, maxChunkX: 1, minChunkZ: -1, maxChunkZ: 0 };

  const leftSlice = sliceCompilationForShard(compilation, left);
  const rightSlice = sliceCompilationForShard(compilation, right);

  assert.deepEqual(leftSlice.meta.statefulBlockReplacements.map(({ x }) => x), [-17, -1]);
  assert.deepEqual(rightSlice.meta.statefulBlockReplacements.map(({ x }) => x), [0, 31]);
  assert.equal(leftSlice.meta.statefulBlockReplacements.length + rightSlice.meta.statefulBlockReplacements.length,
    compilation.meta.statefulBlockReplacements.length);
  assert.deepEqual(leftSlice.chunks.map(({ x }) => x), [-2, -1]);
  assert.deepEqual(rightSlice.chunks.map(({ x }) => x), [0, 1]);
});

test("world shard slicing fails closed on malformed stateful replacement coordinates", () => {
  const compilation = {
    meta: {
      bounds: { minX: 0, minZ: 0, maxX: 15, maxZ: 15 },
      statefulBlockReplacements: [{ x: 1.5, y: 2, z: 1, name: "minecraft:stone_stairs" }]
    },
    chunks: [{ x: 0, z: 0, o: [] }],
    signs: []
  };
  const shard = { id: 0, minChunkX: 0, maxChunkX: 0, minChunkZ: 0, maxChunkZ: 0 };

  assert.throws(
    () => sliceCompilationForShard(compilation, shard),
    /Stateful block replacement coordinates must be integer world-grid coordinates/
  );
});
