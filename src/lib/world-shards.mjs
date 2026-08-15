import { createHash } from "node:crypto";

const DEFAULT_WORLD_MARGIN = 32;
const DEFAULT_MAX_SHARDS = 20;

export function computeWorldChunkBounds(compilation, worldMargin = DEFAULT_WORLD_MARGIN) {
  const bounds = compilation?.meta?.bounds;
  if (!bounds) throw new Error("Compilation is missing meta.bounds");
  const chunks = compilation.chunks || [];
  const operationX = chunks.map((chunk) => Number(chunk.x)).filter(Number.isFinite);
  const operationZ = chunks.map((chunk) => Number(chunk.z)).filter(Number.isFinite);
  const minOperationX = operationX.length ? Math.min(...operationX) : Infinity;
  const minOperationZ = operationZ.length ? Math.min(...operationZ) : Infinity;
  const maxOperationX = operationX.length ? Math.max(...operationX) : -Infinity;
  const maxOperationZ = operationZ.length ? Math.max(...operationZ) : -Infinity;
  return {
    minChunkX: Math.min(floorDiv(bounds.minX - worldMargin, 16), minOperationX),
    minChunkZ: Math.min(floorDiv(bounds.minZ - worldMargin, 16), minOperationZ),
    maxChunkX: Math.max(floorDiv(bounds.maxX + worldMargin, 16), maxOperationX),
    maxChunkZ: Math.max(floorDiv(bounds.maxZ + worldMargin, 16), maxOperationZ)
  };
}

export function planWorldShards(compilation, options = {}) {
  const maxShards = integer(options.maxShards ?? DEFAULT_MAX_SHARDS, "maxShards", 1, 64);
  const worldMargin = integer(options.worldMargin ?? DEFAULT_WORLD_MARGIN, "worldMargin", 0, 4096);
  const bounds = computeWorldChunkBounds(compilation, worldMargin);
  const width = bounds.maxChunkX - bounds.minChunkX + 1;
  const height = bounds.maxChunkZ - bounds.minChunkZ + 1;
  const chunkCount = width * height;
  if (!(chunkCount > 0)) throw new Error("Compilation produced an empty world chunk roster");

  const axis = width >= height ? "x" : "z";
  const axisLength = axis === "x" ? width : height;
  const shardCount = Math.min(maxShards, axisLength, chunkCount);
  const shards = [];
  for (let id = 0; id < shardCount; id += 1) {
    const startOffset = Math.floor(id * axisLength / shardCount);
    const endOffset = Math.floor((id + 1) * axisLength / shardCount) - 1;
    const shard = axis === "x"
      ? {
          id,
          minChunkX: bounds.minChunkX + startOffset,
          maxChunkX: bounds.minChunkX + endOffset,
          minChunkZ: bounds.minChunkZ,
          maxChunkZ: bounds.maxChunkZ
        }
      : {
          id,
          minChunkX: bounds.minChunkX,
          maxChunkX: bounds.maxChunkX,
          minChunkZ: bounds.minChunkZ + startOffset,
          maxChunkZ: bounds.minChunkZ + endOffset
        };
    shard.chunkCount = rectangleChunkCount(shard);
    shards.push(shard);
  }

  assertExactCoverage(bounds, shards);
  const spawn = compilation?.meta?.spawnLocal || { x: 0, z: 0 };
  const spawnChunk = { x: floorDiv(Number(spawn.x) || 0, 16), z: floorDiv(Number(spawn.z) || 0, 16) };
  const spawnShard = shards.find((shard) => containsChunk(shard, spawnChunk.x, spawnChunk.z))?.id ?? shards[0].id;
  const plan = {
    schemaVersion: 1,
    strategy: "balanced-long-axis-bands-v1",
    maxShards,
    worldMargin,
    axis,
    bounds,
    widthChunks: width,
    heightChunks: height,
    chunkCount,
    activeShardIds: shards.map((shard) => shard.id),
    spawnChunk,
    spawnShard,
    fullSignCount: (compilation.signs || []).length,
    signs: compilation.signs || [],
    shards
  };
  plan.planHash = contentHash(plan);
  return plan;
}

export function createWorldShardBundle(envelope, plan, shardId, worldOptions = {}) {
  if (!envelope?.compilation) throw new Error("World compilation envelope is missing compilation");
  if (plan?.planHash !== contentHash({ ...plan, planHash: undefined })) {
    throw new Error("World shard plan hash does not match its contents");
  }
  const shard = plan.shards.find((entry) => Number(entry.id) === Number(shardId));
  if (!shard) throw new Error(`Unknown world shard ${shardId}`);
  const compilation = sliceCompilationForShard(envelope.compilation, shard);
  return {
    schemaVersion: 1,
    planHash: plan.planHash,
    parkName: envelope.parkName,
    slug: envelope.slug,
    shard,
    spawnShard: Number(plan.spawnShard) === Number(shard.id),
    fullWorld: {
      bounds: plan.bounds,
      chunkCount: plan.chunkCount,
      worldMargin: plan.worldMargin,
      fullSignCount: plan.fullSignCount
    },
    worldOptions: {
      ...worldOptions,
      worldMargin: 0,
      maxWorldChunks: Math.max(1, shard.chunkCount)
    },
    compilation
  };
}

export function sliceCompilationForShard(compilation, shard) {
  const chunks = (compilation.chunks || []).filter((chunk) => containsChunk(shard, chunk.x, chunk.z));
  const signs = (compilation.signs || []).filter((sign) => containsChunk(
    shard,
    floorDiv(Number(sign.x), 16),
    floorDiv(Number(sign.z), 16)
  ));
  return {
    ...compilation,
    meta: {
      ...compilation.meta,
      bounds: {
        minX: shard.minChunkX * 16,
        minZ: shard.minChunkZ * 16,
        maxX: shard.maxChunkX * 16 + 15,
        maxZ: shard.maxChunkZ * 16 + 15
      }
    },
    chunks,
    signs
  };
}

export function containsChunk(bounds, chunkX, chunkZ) {
  return chunkX >= bounds.minChunkX && chunkX <= bounds.maxChunkX &&
    chunkZ >= bounds.minChunkZ && chunkZ <= bounds.maxChunkZ;
}

export function contentHash(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function assertExactCoverage(bounds, shards) {
  const expected = rectangleChunkCount(bounds);
  const actual = shards.reduce((sum, shard) => sum + rectangleChunkCount(shard), 0);
  if (actual !== expected) throw new Error(`Shard coverage mismatch: expected ${expected}, planned ${actual}`);
  for (let i = 0; i < shards.length; i += 1) {
    for (let j = i + 1; j < shards.length; j += 1) {
      if (rectanglesOverlap(shards[i], shards[j])) {
        throw new Error(`World shards ${shards[i].id} and ${shards[j].id} overlap`);
      }
    }
  }
}

function rectanglesOverlap(a, b) {
  return a.minChunkX <= b.maxChunkX && a.maxChunkX >= b.minChunkX &&
    a.minChunkZ <= b.maxChunkZ && a.maxChunkZ >= b.minChunkZ;
}

function rectangleChunkCount(bounds) {
  return (bounds.maxChunkX - bounds.minChunkX + 1) * (bounds.maxChunkZ - bounds.minChunkZ + 1);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function integer(value, name, min, max) {
  const resolved = Number(value);
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return resolved;
}

const floorDiv = (value, divisor) => Math.floor(value / divisor);
