#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { LevelDB } from "@8crafter/leveldb-zlib";
import { openMcworld } from "@taku128/mcworld-browser";
import { unzipSync, zipSync } from "fflate";
import {
  entryContentTypeToFormatMap,
  generateChunkKeyFromIndices,
  offsetToChunkBlockIndex
} from "mcbe-leveldb";
import { readJson, writeJson } from "../src/lib/io.mjs";
import { contentHash } from "../src/lib/world-shards.mjs";

export function parseAssemblyArgs(argv) {
  const result = {
    out: "out/bbox-world",
    downloadDir: "world-download"
  };
  const args = [...argv];
  while (args.length) {
    const token = args.shift();
    if (!["--plan", "--shards-dir", "--preparation", "--build-result", "--out", "--download-dir"].includes(token)) {
      throw new Error(`Unknown option: ${token}`);
    }
    const value = args.shift();
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
    if (token === "--download-dir") result.downloadDir = value;
    else if (token === "--build-result") result.buildResult = value;
    else if (token === "--shards-dir") result.shardsDir = value;
    else result[token.slice(2)] = value;
  }
  for (const required of ["plan", "shardsDir", "preparation", "buildResult"]) {
    if (!result[required]) throw new Error(`--${required.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  return result;
}

export async function assembleWorldShards(args, progress = (message) => console.error(`• ${message}`)) {
  const plan = await readJson(path.resolve(args.plan));
  validatePlan(plan);
  const preparation = await readJson(path.resolve(args.preparation));
  if (preparation.planHash !== plan.planHash) throw new Error("Preparation and world shard plan hashes differ");
  const shardRecords = await loadShardRecords(path.resolve(args.shardsDir), plan);
  const outputDir = path.resolve(args.out);
  const downloadDir = path.resolve(args.downloadDir);
  await mkdir(outputDir, { recursive: true });
  await mkdir(downloadDir, { recursive: true });
  const stage = await mkdtemp(path.join(outputDir, ".parallel-world-stage-"));
  const finalDbPath = path.join(stage, "db");
  await mkdir(finalDbPath, { recursive: true });

  const finalDb = new LevelDB(finalDbPath, { createIfMissing: true, errorIfExists: false });
  let templateManifest = null;
  let templatePalette = null;
  let copiedEntries = 0;
  const seenKeys = new Set();
  const emittedBlocks = new Set();
  let databaseOpen = false;
  try {
    await finalDb.open();
    databaseOpen = true;
    for (const record of shardRecords) {
      progress(`Merging world shard ${record.result.shardId + 1}/${shardRecords.length}`);
      const archiveBytes = await readFile(record.mcworldPath);
      const archive = unzipSync(new Uint8Array(archiveBytes));
      const shardWorld = openMcworld(new Uint8Array(archiveBytes));
      copiedEntries += await copyLogicalRecords(shardWorld.reader, finalDb, seenKeys, record.result.shardId);

      const palette = await readJson(record.palettePath);
      for (const block of palette.emittedBlocks || []) emittedBlocks.add(block);
      if (record.result.spawnShard) {
        if (templateManifest) throw new Error("More than one shard claims to contain the world spawn");
        templateManifest = await readJson(record.manifestPath);
        templatePalette = palette;
        await copyTemplateFiles(archive, stage);
      }
    }
    await finalDb.close();
    databaseOpen = false;

    if (!templateManifest) throw new Error("No spawn shard was available to provide level.dat metadata");
    const validation = await validateMergedWorld(finalDbPath, plan, templateManifest);
    progress(`Validated ${validation.chunksVerified.toLocaleString()} merged chunks`);

    const archive = {};
    await collectFiles(stage, "", archive);
    for (const required of ["level.dat", "levelname.txt", "db/CURRENT"]) {
      if (!archive[required]) throw new Error(`Final world is missing ${required}`);
    }
    // LevelDB values are already compressed. Store-mode ZIP avoids spending the
    // final single-threaded assembly stage recompressing thousands of chunk records.
    const finalBytes = Buffer.from(zipSync(archive, { level: 0 }));
    const archiveSha256 = createHash("sha256").update(finalBytes).digest("hex");
    const slug = preparation.slug || "bbox-world";
    const mcworldPath = path.join(outputDir, `${slug}_1to1.mcworld`);
    await writeFile(mcworldPath, finalBytes);

    const manifest = {
      ...templateManifest,
      generatedAt: new Date().toISOString(),
      chunks: plan.chunkCount,
      chunkBounds: plan.bounds,
      marginBlocks: plan.worldMargin,
      buildingOutput: {
        ...(templateManifest.buildingOutput || {}),
        namedSigns: plan.buildingSignCount
      },
      archiveSha256,
      validation,
      parallelBuild: {
        schemaVersion: 1,
        strategy: plan.strategy,
        planHash: plan.planHash,
        shards: shardRecords.length,
        axis: plan.axis,
        copiedLevelDbEntries: copiedEntries,
        duplicateLogicalKeys: 0,
        zipCompressionLevel: 0
      }
    };
    const worldManifestPath = await writeJson(path.join(outputDir, "world-manifest.json"), manifest);
    const palettePath = await writeJson(path.join(outputDir, "block-palette.json"), {
      ...(templatePalette || {}),
      emittedBlocks: [...emittedBlocks].sort()
    });

    const buildResult = await readJson(path.resolve(args.buildResult));
    buildResult.paths ||= {};
    buildResult.stats ||= {};
    buildResult.paths.world = mcworldPath;
    buildResult.paths.worldManifest = worldManifestPath;
    buildResult.paths.blockPalette = palettePath;
    buildResult.stats.worldChunks = plan.chunkCount;
    buildResult.stats.worldValidation = validation.status;
    buildResult.stats.worldBuildShards = shardRecords.length;
    buildResult.stats.worldLevelDbEntriesMerged = copiedEntries;
    await writeJson(path.resolve(args.buildResult), buildResult);

    const downloadPath = path.join(downloadDir, path.basename(mcworldPath));
    await copyFile(mcworldPath, downloadPath);
    const summary = {
      schemaVersion: 2,
      bbox: preparation.bbox,
      authorityHandoff: preparation.authorityHandoff,
      generatedWorld: downloadPath,
      worldChunks: plan.chunkCount,
      worldValidation: validation.status,
      planningAuthorityMatchedFeatures: preparation.planningAuthorityMatchedFeatures || 0,
      planningAuthorityWinningAttributes: preparation.planningAuthorityWinningAttributes || 0,
      planningAuthorityAppliedAttributes: preparation.planningAuthorityAppliedAttributes || 0,
      confidence: preparation.confidence,
      grade: preparation.grade,
      outputDir,
      parallelWorldBuild: manifest.parallelBuild
    };
    await writeJson(path.join(downloadDir, "bbox-generation-result.json"), summary);
    console.log(JSON.stringify(summary, null, 2));
    return { summary, manifest, validation, mcworldPath };
  } finally {
    if (databaseOpen && finalDb.isOpen()) await finalDb.close().catch(() => {});
    await rm(stage, { recursive: true, force: true });
  }
}

async function loadShardRecords(root, plan) {
  const resultFiles = await findNamedFiles(root, "world-shard-result.json");
  const records = [];
  for (const resultFile of resultFiles) {
    const result = await readJson(resultFile);
    if (result.planHash !== plan.planHash) throw new Error(`Shard ${result.shardId} belongs to a different plan`);
    const directory = path.dirname(resultFile);
    records.push({
      result,
      mcworldPath: path.join(directory, result.mcworldFile),
      manifestPath: path.join(directory, result.manifestFile),
      palettePath: path.join(directory, result.paletteFile)
    });
  }
  records.sort((a, b) => Number(a.result.shardId) - Number(b.result.shardId));
  const expected = plan.activeShardIds.map(Number);
  const actual = records.map((record) => Number(record.result.shardId));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`World shard set is incomplete or duplicated: expected ${expected.join(",")}, got ${actual.join(",")}`);
  }
  const total = records.reduce((sum, record) => sum + Number(record.result.chunkCount || 0), 0);
  if (total !== plan.chunkCount) throw new Error(`Shard chunk total ${total} does not equal planned ${plan.chunkCount}`);
  return records;
}

async function copyTemplateFiles(archive, stage) {
  for (const [name, value] of Object.entries(archive)) {
    if (name.startsWith("db/") || name.endsWith("/")) continue;
    const filename = path.join(stage, name);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, Buffer.from(value));
  }
}

async function copyLogicalRecords(reader, target, seenKeys, shardId) {
  const pending = [];
  let copied = 0;
  for (const entry of reader.iterate({ values: true })) {
    const key = Buffer.from(entry.key);
    const value = Buffer.from(entry.value);
    const keyHex = key.toString("hex");
    if (seenKeys.has(keyHex)) throw new Error(`Duplicate logical LevelDB key while merging shard ${shardId}: ${keyHex}`);
    seenKeys.add(keyHex);
    pending.push({ type: "put", key, value });
    copied += 1;
    if (pending.length >= 512) await target.batch(pending.splice(0));
  }
  if (pending.length) await target.batch(pending);
  return copied;
}

async function validateMergedWorld(databasePath, plan, manifest) {
  const database = new LevelDB(databasePath, { createIfMissing: false });
  await database.open();
  try {
    const chunkVersion = Number(manifest.chunkVersion);
    let chunksVerified = 0;
    for (let z = plan.bounds.minChunkZ; z <= plan.bounds.maxChunkZ; z += 1) {
      for (let x = plan.bounds.minChunkX; x <= plan.bounds.maxChunkX; x += 1) {
        const raw = await database.get(generateChunkKeyFromIndices({ x, z, dimension: "overworld" }, "Version"));
        if (!raw?.length || Number(raw[0]) !== chunkVersion) throw new Error(`Merged world is missing valid chunk ${x},${z}`);
        chunksVerified += 1;
      }
    }
    if (chunksVerified !== plan.chunkCount) throw new Error("Merged world chunk roster did not round-trip exactly");

    const sampleShard = plan.shards[0];
    const sampleIndices = { x: sampleShard.minChunkX, z: sampleShard.minChunkZ, dimension: "overworld" };
    const data3D = await database.get(generateChunkKeyFromIndices(sampleIndices, "Data3D"));
    const parsedData3D = entryContentTypeToFormatMap.Data3D.parse(data3D);
    if ((parsedData3D?.value?.biomes?.value?.value?.length || 0) < 24) throw new Error("Merged Data3D biome record is invalid");

    const signValidation = await validateSigns(database, plan.signs || [], Number(manifest.baseY ?? 64));
    return {
      levelDat: "spawn-shard-template",
      levelDb: "logical-record-merge-reopened",
      chunksExpected: plan.chunkCount,
      chunksVerified,
      chunkVersion,
      data3DBiomeSections: parsedData3D.value.biomes.value.value.length,
      signLabels: signValidation,
      shardCount: plan.shards.length,
      status: "passed"
    };
  } finally {
    await database.close();
  }
}

async function validateSigns(database, signs, baseY) {
  if (!signs.length) return { stored: 0, expected: 0, status: "not-applicable" };
  const groups = new Map();
  for (const sign of signs) {
    const key = `${floorDiv(sign.x, 16)},${floorDiv(sign.z, 16)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sign);
  }
  let stored = 0, sample = null;
  for (const [key, expected] of groups) {
    const [x, z] = key.split(",").map(Number);
    const raw = await database.get(generateChunkKeyFromIndices({ x, z, dimension: "overworld" }, "BlockEntity"));
    if (!raw?.length) throw new Error(`Merged sign chunk ${key} has no BlockEntity record`);
    const parsed = await entryContentTypeToFormatMap.BlockEntity.parse(raw);
    const entities = parsed.value.blockEntities.value.value.filter((candidate) => candidate.id?.value === "Sign");
    if (entities.length !== expected.length) throw new Error(`Merged sign count mismatch in chunk ${key}`);
    for (const sign of expected) {
      const worldY = baseY + sign.y;
      const entity = entities.find((candidate) => candidate.x.value === sign.x && candidate.y.value === worldY && candidate.z.value === sign.z);
      if (!entity || entity.FrontText.value.Text.value !== sign.text || entity.BackText.value.Text.value !== sign.text) {
        throw new Error(`Merged sign failed round-trip at ${sign.x},${worldY},${sign.z}`);
      }
      if (!sample) sample = { ...sign, y: worldY, chunkX: x, chunkZ: z };
    }
    stored += entities.length;
  }
  const block = sample ? await validateSignBlock(database, sample) : null;
  return { stored, expected: signs.length, sample: sample ? { x: sample.x, y: sample.y, z: sample.z, text: sample.text, block } : null, status: "passed" };
}

async function validateSignBlock(database, sample) {
  const subChunkIndex = floorDiv(sample.y, 16);
  const raw = await database.get(generateChunkKeyFromIndices({
    x: sample.chunkX, z: sample.chunkZ, dimension: "overworld", subChunkIndex
  }, "SubChunkPrefix"));
  const parsed = await entryContentTypeToFormatMap.SubChunkPrefix.parse(raw);
  const layer = parsed.value.layers.value.value[0];
  const offset = offsetToChunkBlockIndex({
    x: floorMod(sample.x, 16), y: floorMod(sample.y, 16), z: floorMod(sample.z, 16)
  });
  const paletteIndex = layer.block_indices.value.value[offset];
  const blockName = layer.palette.value[String(paletteIndex)]?.value?.name?.value;
  if (blockName !== "minecraft:standing_sign") throw new Error("Merged sign entity does not have a standing-sign block");
  return blockName;
}

async function collectFiles(directory, prefix, archive) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = path.join(directory, entry.name);
    const archivePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await collectFiles(fullPath, archivePath, archive);
    else archive[archivePath] = new Uint8Array(await readFile(fullPath));
  }
}

async function findNamedFiles(directory, name) {
  const found = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await findNamedFiles(fullPath, name));
    else if (entry.name === name) found.push(fullPath);
  }
  return found;
}

function validatePlan(plan) {
  if (!plan || plan.schemaVersion !== 1 || !Array.isArray(plan.shards) || !plan.shards.length) {
    throw new Error("Unsupported or empty world shard plan");
  }
  const expectedHash = contentHash({ ...plan, planHash: undefined });
  if (plan.planHash !== expectedHash) throw new Error("World shard plan hash does not match its contents");
  const total = plan.shards.reduce((sum, shard) => sum + Number(shard.chunkCount || 0), 0);
  if (total !== plan.chunkCount) throw new Error("World shard plan chunk total is inconsistent");
}

const floorDiv = (value, divisor) => Math.floor(value / divisor);
const floorMod = (value, divisor) => ((value % divisor) + divisor) % divisor;

if (import.meta.url === `file://${process.argv[1]}`) {
  assembleWorldShards(parseAssemblyArgs(process.argv.slice(2))).catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
