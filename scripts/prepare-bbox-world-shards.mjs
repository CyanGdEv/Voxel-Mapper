#!/usr/bin/env node
import { access, appendFile, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { buildPark } from "../src/lib/pipeline.mjs";
import { readJson, sha256, sha256File, writeJson } from "../src/lib/io.mjs";
import { buildBboxWorldOptions } from "./generate-bbox-world.mjs";
import { createWorldShardBundle, planWorldShards } from "../src/lib/world-shards.mjs";
import { validatePreparation } from "./replay-world-preparation.mjs";

const PREPARATION_CACHE_VERSION = 1;
const REQUIRED_PREPARATION_HEAP_MB = 6144;
const HEAP_REEXEC_FLAG = "VOXEL_WORLD_PREPARATION_HEAP_REEXEC";

export function parsePrepareArgs(argv) {
  const result = {
    out: "out/bbox-world",
    cache: ".tpmap-cache",
    authority: "planning-current-authority-evidence.json",
    shardDir: "world-shard-inputs",
    shards: 20
  };
  const args = [...argv];
  while (args.length) {
    const token = args.shift();
    if (!["--bbox", "--out", "--cache", "--authority", "--shard-dir", "--shards"].includes(token)) {
      throw new Error(`Unknown option: ${token}`);
    }
    const value = args.shift();
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
    if (token === "--bbox") result.bbox = value;
    else if (token === "--out") result.out = value;
    else if (token === "--cache") result.cache = value;
    else if (token === "--authority") result.authority = value;
    else if (token === "--shard-dir") result.shardDir = value;
    else if (token === "--shards") result.shards = Number(value);
  }
  if (!result.bbox) throw new Error("--bbox is required");
  if (!Number.isInteger(result.shards) || result.shards < 1 || result.shards > 20) {
    throw new Error("--shards must be an integer from 1 to 20");
  }
  return result;
}

export async function prepareBboxWorldShards(args, progress = (message) => console.error(`• ${message}`)) {
  const handoff = await buildBboxWorldOptions(args);
  const outputDir = path.resolve(args.out);
  const shardDir = path.resolve(args.shardDir);
  const compilationPath = path.join(outputDir, "world-compilation.json");
  await mkdir(outputDir, { recursive: true });
  await mkdir(shardDir, { recursive: true });

  const buildOptions = {
    ...handoff.options,
    out: outputDir,
    noWorld: true,
    noAddon: true,
    // Preparation is also the canonical final-data QA handoff, so keep the
    // top-down SVG/HTML preview. It is tiny compared with shard artifacts and
    // lets acceptance verify that every fused feature is visibly represented.
    noPreview: false,
    compilationOut: compilationPath
  };
  const cacheIdentity = await buildPreparationCacheIdentity(args, handoff, buildOptions);
  const preparationCacheDir = path.join(path.resolve(args.cache), "world-preparation-v1", cacheIdentity);
  const restored = await restorePreparationCache({ preparationCacheDir, outputDir, shardDir });
  if (restored) {
    progress(`Reusing validated reconstruction preparation cache ${cacheIdentity.slice(0, 12)}`);
    const summary = {
      ...restored.summary,
      preparationCache: {
        schemaVersion: 1,
        version: PREPARATION_CACHE_VERSION,
        key: cacheIdentity,
        status: "hit",
        gitSha: process.env.GITHUB_SHA || null,
        restoredAt: new Date().toISOString()
      }
    };
    await writeJson("world-preparation.json", summary);
    await emitGitHubOutputs(restored.plan, true);
    console.log(JSON.stringify(summary, null, 2));
    return { result: null, summary, plan: restored.plan, reused: true };
  }

  progress(handoff.authority.available
    ? "Preparing reconstruction with verified-current planning authority"
    : "Preparing reconstruction with lower-authority fallback evidence");

  const preparationStarted = performance.now();
  const profiler = createStageProfiler(progress);
  const result = await buildPark(buildOptions, profiler.progress);
  const stageTimings = profiler.finish();
  const envelope = await readJson(compilationPath);
  const shardPlanningStarted = performance.now();
  const plan = planWorldShards(envelope.compilation, {
    maxShards: args.shards,
    worldMargin: Number.isInteger(buildOptions.worldMargin) ? buildOptions.worldMargin : 32
  });

  const worldOptions = selectWorldOptions(buildOptions);
  for (const shard of plan.shards) {
    const bundle = createWorldShardBundle(envelope, plan, shard.id, worldOptions);
    await writeJson(path.join(shardDir, `shard-${shard.id}.json`), bundle);
  }
  const planPath = await writeJson(path.join(shardDir, "world-shard-plan.json"), plan);
  const preparationTiming = {
    schemaVersion: 1,
    totalMs: Math.round(performance.now() - preparationStarted),
    reconstructionMs: stageTimings.reduce((sum, entry) => sum + entry.durationMs, 0),
    shardPlanningAndWriteMs: Math.round(performance.now() - shardPlanningStarted),
    stages: stageTimings
  };
  const profilePath = await writeJson(path.join(outputDir, "preparation-profile.json"), preparationTiming);
  const summary = {
    schemaVersion: 1,
    bbox: args.bbox,
    authorityHandoff: handoff.authority,
    parkName: result.parkName,
    slug: result.slug,
    confidence: result.confidence,
    grade: result.grade,
    planningAuthorityMatchedFeatures: result.stats?.planningAuthorityMatchedFeatures || 0,
    planningAuthorityWinningAttributes: result.stats?.planningAuthorityWinningAttributes || 0,
    planningAuthorityAppliedAttributes: result.stats?.planningAuthorityAppliedAttributes || 0,
    compilationPath,
    planPath,
    planHash: plan.planHash,
    worldChunks: plan.chunkCount,
    shardCount: plan.shards.length,
    activeShardIds: plan.activeShardIds,
    spawnShard: plan.spawnShard,
    outputDir,
    preparationProfile: profilePath,
    preparationTiming,
    preparationCache: {
      schemaVersion: 1,
      version: PREPARATION_CACHE_VERSION,
      key: cacheIdentity,
      status: "saved",
      gitSha: process.env.GITHUB_SHA || null
    }
  };
  await writeJson("world-preparation.json", summary);
  await savePreparationCache({ preparationCacheDir, outputDir, shardDir, summary, plan });
  await emitGitHubOutputs(plan, false);
  console.log(JSON.stringify(summary, null, 2));
  return { result, summary, plan, reused: false };
}

export function createStageProfiler(sink = () => {}) {
  const stages = [];
  let currentStage = null;
  let stageStarted = performance.now();
  const record = (finishedAt) => {
    if (!currentStage) return;
    stages.push({
      stage: currentStage,
      durationMs: Math.max(0, Math.round(finishedAt - stageStarted))
    });
  };
  return {
    progress(message) {
      const now = performance.now();
      record(now);
      sink(message);
      currentStage = message === "Build complete" ? null : String(message);
      stageStarted = now;
    },
    finish() {
      const now = performance.now();
      record(now);
      currentStage = null;
      return stages;
    }
  };
}

export async function buildPreparationCacheIdentity(args, handoff, buildOptions) {
  const authorityHash = handoff.authority.available
    ? await sha256File(handoff.authority.requestedPath)
    : "none";
  return sha256({
    schemaVersion: PREPARATION_CACHE_VERSION,
    gitSha: process.env.GITHUB_SHA || "local",
    bbox: args.bbox,
    authorityHash,
    shards: args.shards,
    worldOptions: selectWorldOptions(buildOptions),
    reconstructionOptions: {
      buildings: buildOptions.buildings,
      accuracyMode: buildOptions.accuracyMode,
      pathGeometryMode: buildOptions.pathGeometryMode,
      pathEdgeMode: buildOptions.pathEdgeMode,
      pathTerrainMode: buildOptions.pathTerrainMode,
      terrainDetailMode: buildOptions.terrainDetailMode,
      rideTerrainMode: buildOptions.rideTerrainMode
    }
  });
}

async function restorePreparationCache({ preparationCacheDir, outputDir, shardDir }) {
  const summaryPath = path.join(preparationCacheDir, "world-preparation.json");
  const planPath = path.join(preparationCacheDir, "world-shard-plan.json");
  if (!await fileExists(summaryPath) || !await fileExists(planPath)) return null;
  const [summary, plan] = await Promise.all([readJson(summaryPath), readJson(planPath)]);
  validatePreparation(summary, plan);
  const cachedOut = path.join(preparationCacheDir, "out");
  const cachedShards = path.join(preparationCacheDir, "shards");
  if (!await fileExists(cachedOut) || !await fileExists(cachedShards)) return null;
  await rm(outputDir, { recursive: true, force: true });
  await rm(shardDir, { recursive: true, force: true });
  await cp(cachedOut, outputDir, { recursive: true, force: true });
  await cp(cachedShards, shardDir, { recursive: true, force: true });
  validatePreparation(summary, await readJson(path.join(shardDir, "world-shard-plan.json")));
  return { summary, plan };
}

async function savePreparationCache({ preparationCacheDir, outputDir, shardDir, summary, plan }) {
  const temp = `${preparationCacheDir}.tmp-${process.pid}`;
  await rm(temp, { recursive: true, force: true });
  await mkdir(temp, { recursive: true });
  await cp(outputDir, path.join(temp, "out"), { recursive: true, force: true });
  await rm(path.join(temp, "out", "world-compilation.json"), { force: true });
  await cp(shardDir, path.join(temp, "shards"), { recursive: true, force: true });
  await writeJson(path.join(temp, "world-preparation.json"), summary);
  await writeJson(path.join(temp, "world-shard-plan.json"), plan);
  await rm(preparationCacheDir, { recursive: true, force: true });
  await mkdir(path.dirname(preparationCacheDir), { recursive: true });
  await cp(temp, preparationCacheDir, { recursive: true, force: true });
  await rm(temp, { recursive: true, force: true });
}

function selectWorldOptions(options) {
  const selected = {};
  for (const key of ["palette", "baseY", "seed", "chunkVersion", "blockDataVersion"]) {
    if (options[key] !== undefined) selected[key] = options[key];
  }
  return selected;
}

async function emitGitHubOutputs(plan, reused) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = [
    `active_shards=${JSON.stringify(plan.activeShardIds)}`,
    `shard_count=${plan.shards.length}`,
    `chunk_count=${plan.chunkCount}`,
    `spawn_shard=${plan.spawnShard}`,
    `plan_hash=${plan.planHash}`,
    `preparation_reused=${reused ? "true" : "false"}`
  ];
  await appendFile(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

async function fileExists(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

function configuredOldSpaceMb() {
  const values = [
    ...process.execArgv,
    ...String(process.env.NODE_OPTIONS || "").split(/\s+/).filter(Boolean)
  ];
  let configured = 0;
  for (const value of values) {
    const match = String(value).match(/^--max-old-space-size(?:=|$)(\d+)?$/);
    if (match?.[1]) configured = Math.max(configured, Number(match[1]));
  }
  return configured;
}

function runCliWithPreparationHeap() {
  const configured = configuredOldSpaceMb();
  if (process.env[HEAP_REEXEC_FLAG] === "1" || configured >= REQUIRED_PREPARATION_HEAP_MB) return false;
  const child = spawnSync(process.execPath, [
    `--max-old-space-size=${REQUIRED_PREPARATION_HEAP_MB}`,
    process.argv[1],
    ...process.argv.slice(2)
  ], {
    stdio: "inherit",
    env: { ...process.env, [HEAP_REEXEC_FLAG]: "1" }
  });
  if (child.error) throw child.error;
  if (child.signal) throw new Error(`World preparation child terminated by signal ${child.signal}`);
  process.exitCode = child.status ?? 1;
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    if (!runCliWithPreparationHeap()) {
      prepareBboxWorldShards(parsePrepareArgs(process.argv.slice(2))).catch((error) => {
        console.error(error?.stack || error);
        process.exitCode = 1;
      });
    }
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
