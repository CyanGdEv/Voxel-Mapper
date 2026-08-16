#!/usr/bin/env node
import path from "node:path";
import { appendFile } from "node:fs/promises";
import { writeJson } from "../src/lib/io.mjs";
import { EXTRACTION_BUNDLE_FORMAT, loadBundleManifest } from "../src/lib/planning-evidence-bundle.mjs";
import { buildPlanningGeoregistrationShardPlan } from "../src/lib/planning-georeg-shards.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args.includes("--help") || !value("--evidence")) {
  console.log(`Voxel Mapper planning georegistration shard planner\n\nUsage:\n  node scripts/planning-georeg-plan.mjs --evidence planning-vector-evidence [options]\n\nOptions:\n  --out FILE       Plan output (default planning-georeg-shard-plan.json)\n  --shards N       Maximum parallel georegistration shards (default 256, max 256)\n`);
  process.exit(args.includes("--help") ? 0 : 2);
}

const bundle = await loadBundleManifest(path.resolve(value("--evidence")), EXTRACTION_BUNDLE_FORMAT);
const plan = buildPlanningGeoregistrationShardPlan(bundle.manifest, {
  shards: Number(value("--shards") || 256)
});
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
  activeShards: plan.activeShards,
  shardPageCounts: plan.shardPageCounts,
  shardWeights: plan.shardWeights,
  maxShardWeight: plan.maxShardWeight,
  minShardWeight: plan.minShardWeight,
  plan: out
}, null, 2));
