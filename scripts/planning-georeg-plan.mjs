#!/usr/bin/env node
import path from "node:path";
import { appendFile } from "node:fs/promises";
import { writeJson } from "../src/lib/io.mjs";
import { EXTRACTION_BUNDLE_FORMAT, loadBundleManifest } from "../src/lib/planning-evidence-bundle.mjs";
import { buildPlanningGeoregistrationShardPlan } from "../src/lib/planning-georeg-shards.mjs";
import {
  MAX_GITHUB_PLANNING_RUNNER_SHARDS,
  clampGithubPlanningRunnerShards
} from "../src/lib/github-actions-planning-fanout.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args.includes("--help") || !value("--evidence")) {
  console.log(`Voxel Mapper planning georegistration shard planner\n\nUsage:\n  node scripts/planning-georeg-plan.mjs --evidence planning-vector-evidence [options]\n\nOptions:\n  --out FILE       Plan output (default planning-georeg-shard-plan.json)\n  --shards N       Georegistration runner shards (default 20, max 20; larger stale callers are clamped)\n`);
  process.exit(args.includes("--help") ? 0 : 2);
}

const bundle = await loadBundleManifest(path.resolve(value("--evidence")), EXTRACTION_BUNDLE_FORMAT);
const requestedShards = Number(value("--shards") || MAX_GITHUB_PLANNING_RUNNER_SHARDS);
const executionShards = clampGithubPlanningRunnerShards(requestedShards);
const plan = buildPlanningGeoregistrationShardPlan(bundle.manifest, {
  shards: executionShards
});
plan.requestedRunnerShards = Number.isFinite(requestedShards) ? requestedShards : null;
plan.runnerShardLimit = MAX_GITHUB_PLANNING_RUNNER_SHARDS;
plan.effectiveRunnerShards = executionShards;
const out = path.resolve(value("--out") || "planning-georeg-shard-plan.json");
await writeJson(out, plan);
const matrix = plan.activeShards.length ? plan.activeShards : [0];
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `active_georeg_shards=${JSON.stringify(matrix)}\n`);
  await appendFile(process.env.GITHUB_OUTPUT, `georeg_page_count=${plan.pageCount}\n`);
  await appendFile(process.env.GITHUB_OUTPUT, `georeg_shard_count=${plan.activeShardCount}\n`);
}
console.log(JSON.stringify({
  pages: plan.pageCount,
  requestedRunnerShards: Number.isFinite(requestedShards) ? requestedShards : null,
  effectiveRunnerShards: executionShards,
  activeShards: plan.activeShards,
  shardPageCounts: plan.shardPageCounts,
  shardWeights: plan.shardWeights,
  maxShardWeight: plan.maxShardWeight,
  minShardWeight: plan.minShardWeight,
  plan: out
}, null, 2));
