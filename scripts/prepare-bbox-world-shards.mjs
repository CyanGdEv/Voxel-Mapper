#!/usr/bin/env node
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { buildPark } from "../src/lib/pipeline.mjs";
import { readJson, writeJson } from "../src/lib/io.mjs";
import { buildBboxWorldOptions } from "./generate-bbox-world.mjs";
import { createWorldShardBundle, planWorldShards } from "../src/lib/world-shards.mjs";

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

  progress(handoff.authority.available
    ? "Preparing reconstruction with verified-current planning authority"
    : "Preparing reconstruction with lower-authority fallback evidence");

  const buildOptions = {
    ...handoff.options,
    out: outputDir,
    noWorld: true,
    noAddon: true,
    noPreview: true,
    compilationOut: compilationPath
  };
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
    preparationTiming
  };
  await writeJson("world-preparation.json", summary);
  await emitGitHubOutputs(plan);
  console.log(JSON.stringify(summary, null, 2));
  return { result, summary, plan };
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

function selectWorldOptions(options) {
  const selected = {};
  for (const key of ["palette", "baseY", "seed", "chunkVersion", "blockDataVersion"]) {
    if (options[key] !== undefined) selected[key] = options[key];
  }
  return selected;
}

async function emitGitHubOutputs(plan) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = [
    `active_shards=${JSON.stringify(plan.activeShardIds)}`,
    `shard_count=${plan.shards.length}`,
    `chunk_count=${plan.chunkCount}`,
    `spawn_shard=${plan.spawnShard}`,
    `plan_hash=${plan.planHash}`,
    "preparation_reused=false"
  ];
  await appendFile(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  prepareBboxWorldShards(parsePrepareArgs(process.argv.slice(2))).catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
