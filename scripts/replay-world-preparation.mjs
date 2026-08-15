#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { readJson } from "../src/lib/io.mjs";
import { contentHash } from "../src/lib/world-shards.mjs";

export function parseReplayArgs(argv) {
  const result = {
    summary: "world-preparation.json",
    plan: "world-shard-inputs/world-shard-plan.json"
  };
  const args = [...argv];
  while (args.length) {
    const token = args.shift();
    if (!["--summary", "--plan"].includes(token)) throw new Error(`Unknown option: ${token}`);
    const value = args.shift();
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
    result[token.slice(2)] = value;
  }
  return result;
}

export async function replayWorldPreparation(args = parseReplayArgs([])) {
  const summary = await readJson(path.resolve(args.summary));
  const plan = await readJson(path.resolve(args.plan));
  validatePreparation(summary, plan);
  await emitGitHubOutputs(plan);
  const replay = {
    schemaVersion: 1,
    status: "reused",
    planHash: plan.planHash,
    chunkCount: plan.chunkCount,
    shardCount: plan.shards.length,
    activeShardIds: plan.activeShardIds,
    originalPreparationTiming: summary.preparationTiming || null
  };
  console.log(JSON.stringify(replay, null, 2));
  return replay;
}

export function validatePreparation(summary, plan) {
  if (!summary || summary.schemaVersion !== 1) throw new Error("Cached world preparation summary is invalid");
  if (!plan || plan.schemaVersion !== 1) throw new Error("Cached world shard plan is invalid");
  const expectedHash = contentHash({ ...plan, planHash: undefined });
  if (plan.planHash !== expectedHash) throw new Error("Cached world shard plan hash does not match its contents");
  if (summary.planHash !== plan.planHash) throw new Error("Cached preparation summary and shard plan hashes differ");
  if (Number(summary.worldChunks) !== Number(plan.chunkCount)) throw new Error("Cached preparation chunk count does not match shard plan");
  if (Number(summary.shardCount) !== Number(plan.shards?.length || 0)) throw new Error("Cached preparation shard count does not match shard plan");
  if (JSON.stringify((summary.activeShardIds || []).map(Number)) !== JSON.stringify((plan.activeShardIds || []).map(Number))) {
    throw new Error("Cached preparation active shard IDs do not match shard plan");
  }
  return true;
}

async function emitGitHubOutputs(plan) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = [
    `active_shards=${JSON.stringify(plan.activeShardIds)}`,
    `shard_count=${plan.shards.length}`,
    `chunk_count=${plan.chunkCount}`,
    `spawn_shard=${plan.spawnShard}`,
    `plan_hash=${plan.planHash}`,
    "preparation_reused=true"
  ];
  await appendFile(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  replayWorldPreparation(parseReplayArgs(process.argv.slice(2))).catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
