import test from "node:test";
import assert from "node:assert/strict";
import {
  computeWorldChunkBounds,
  createWorldShardBundle,
  planWorldShards,
  sliceCompilationForShard
} from "../src/lib/world-shards.mjs";

function compilation() {
  return {
    palette: ["minecraft:stone"],
    meta: {
      bounds: { minX: 0, minZ: 0, maxX: 511, maxZ: 255 },
      spawnLocal: { x: 250, y: 0, z: 120 }
    },
    chunks: [
      { x: 0, z: 0, o: [] },
      { x: 10, z: 4, o: [] },
      { x: 31, z: 15, o: [] }
    ],
    signs: [
      { x: 2, y: 1, z: 2, text: "A", role: "building" },
      { x: 500, y: 1, z: 200, text: "B", role: "information" }
    ],
    stats: {}
  };
}

test("world shard planner covers the exact chunk roster once with at most 20 balanced bands", () => {
  const source = compilation();
  const bounds = computeWorldChunkBounds(source, 0);
  assert.deepEqual(bounds, { minChunkX: 0, minChunkZ: 0, maxChunkX: 31, maxChunkZ: 15 });
  const plan = planWorldShards(source, { maxShards: 20, worldMargin: 0 });
  assert.equal(plan.shards.length, 20);
  assert.equal(plan.axis, "x");
  assert.equal(plan.chunkCount, 512);
  assert.equal(plan.shards.reduce((sum, shard) => sum + shard.chunkCount, 0), 512);
  assert.equal(plan.fullSignCount, 2);
  assert.equal(plan.buildingSignCount, 1);
  assert.ok(plan.planHash);

  const seen = new Set();
  for (const shard of plan.shards) {
    for (let x = shard.minChunkX; x <= shard.maxChunkX; x += 1) {
      for (let z = shard.minChunkZ; z <= shard.maxChunkZ; z += 1) {
        const key = `${x},${z}`;
        assert.equal(seen.has(key), false, `duplicate planned chunk ${key}`);
        seen.add(key);
      }
    }
  }
  assert.equal(seen.size, 512);
  assert.ok(plan.shards.some((shard) => shard.id === plan.spawnShard &&
    plan.spawnChunk.x >= shard.minChunkX && plan.spawnChunk.x <= shard.maxChunkX));
});

test("shard slicing keeps only local operations/signs while preserving reconstruction metadata", () => {
  const source = compilation();
  const plan = planWorldShards(source, { maxShards: 2, worldMargin: 0 });
  const left = plan.shards[0];
  const sliced = sliceCompilationForShard(source, left);
  assert.ok(sliced.chunks.every((chunk) => chunk.x >= left.minChunkX && chunk.x <= left.maxChunkX));
  assert.ok(sliced.signs.every((sign) => Math.floor(sign.x / 16) >= left.minChunkX && Math.floor(sign.x / 16) <= left.maxChunkX));
  assert.equal(sliced.meta.spawnLocal.x, source.meta.spawnLocal.x);
  assert.deepEqual(sliced.meta.bounds, {
    minX: left.minChunkX * 16,
    minZ: left.minChunkZ * 16,
    maxX: left.maxChunkX * 16 + 15,
    maxZ: left.maxChunkZ * 16 + 15
  });

  const envelope = { parkName: "Fixture", slug: "fixture", compilation: source };
  const bundle = createWorldShardBundle(envelope, plan, left.id, { baseY: 8 });
  assert.equal(bundle.planHash, plan.planHash);
  assert.equal(bundle.worldOptions.worldMargin, 0);
  assert.equal(bundle.worldOptions.maxWorldChunks, left.chunkCount);
  assert.equal(bundle.fullWorld.chunkCount, plan.chunkCount);
});
