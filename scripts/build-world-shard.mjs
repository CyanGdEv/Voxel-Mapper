#!/usr/bin/env node
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { buildBedrockWorld } from "../src/lib/mcworld.mjs";
import { readJson, writeJson } from "../src/lib/io.mjs";
import { contentHash } from "../src/lib/world-shards.mjs";

export function parseShardArgs(argv) {
  const result = {};
  const args = [...argv];
  while (args.length) {
    const token = args.shift();
    if (!["--input", "--out"].includes(token)) throw new Error(`Unknown option: ${token}`);
    const value = args.shift();
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
    result[token.slice(2)] = value;
  }
  if (!result.input) throw new Error("--input is required");
  if (!result.out) throw new Error("--out is required");
  return result;
}

export async function buildWorldShard(args, progress = (message) => console.error(`• ${message}`)) {
  const inputPath = path.resolve(args.input);
  const outputDir = path.resolve(args.out);
  const bundle = await readJson(inputPath);
  validateBundle(bundle);
  await mkdir(outputDir, { recursive: true });
  const shardId = Number(bundle.shard.id);
  const shardSlug = `${bundle.slug}-shard-${String(shardId).padStart(2, "0")}`;
  progress(`Building world shard ${shardId} (${bundle.shard.chunkCount} chunks)`);
  const world = await buildBedrockWorld({
    parkName: bundle.parkName,
    slug: shardSlug,
    compilation: bundle.compilation,
    outputDir,
    options: bundle.worldOptions,
    progress
  });
  if (world.chunkCount !== bundle.shard.chunkCount) {
    throw new Error(`Shard ${shardId} built ${world.chunkCount} chunks; expected ${bundle.shard.chunkCount}`);
  }
  const manifest = await readJson(world.worldManifestPath);
  assertBoundsEqual(manifest.chunkBounds, bundle.shard, shardId);
  const result = {
    schemaVersion: 1,
    planHash: bundle.planHash,
    inputHash: contentHash(bundle),
    shardId,
    shard: bundle.shard,
    spawnShard: bundle.spawnShard === true,
    chunkCount: world.chunkCount,
    validation: world.validation,
    mcworldFile: path.basename(world.mcworldPath),
    manifestFile: path.basename(world.worldManifestPath),
    paletteFile: path.basename(world.palettePath)
  };
  await writeJson(path.join(outputDir, "world-shard-result.json"), result);
  console.log(JSON.stringify(result, null, 2));
  return { world, result };
}

function validateBundle(bundle) {
  if (!bundle || bundle.schemaVersion !== 1) throw new Error("Unsupported world shard bundle");
  if (!bundle.planHash || !bundle.parkName || !bundle.slug || !bundle.shard || !bundle.compilation) {
    throw new Error("World shard bundle is incomplete");
  }
  const count = (bundle.shard.maxChunkX - bundle.shard.minChunkX + 1) *
    (bundle.shard.maxChunkZ - bundle.shard.minChunkZ + 1);
  if (count !== bundle.shard.chunkCount || !(count > 0)) throw new Error("World shard chunk count is invalid");
  if (bundle.worldOptions?.worldMargin !== 0) throw new Error("World shard bundles must use zero local margin");
  if (Number(bundle.worldOptions?.maxWorldChunks) < count) throw new Error("World shard maxWorldChunks is too small");
}

function assertBoundsEqual(actual, expected, shardId) {
  for (const key of ["minChunkX", "minChunkZ", "maxChunkX", "maxChunkZ"]) {
    if (Number(actual?.[key]) !== Number(expected?.[key])) {
      throw new Error(`Shard ${shardId} manifest ${key}=${actual?.[key]} but plan requires ${expected?.[key]}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildWorldShard(parseShardArgs(process.argv.slice(2))).catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
