#!/usr/bin/env node
import path from "node:path";
import { appendFile } from "node:fs/promises";
import { parseBbox } from "../src/lib/geo.mjs";
import { ensureDir, writeJson } from "../src/lib/io.mjs";
import { resolveSourcePlan } from "../src/lib/source-registry.mjs";
import { RUNTIME_SOURCE_PROVIDERS } from "../src/lib/runtime-source-providers.mjs";
import { acquirePlanningForBbox } from "../src/lib/planning-acquisition.mjs";
import { buildPlanningDocumentQueue } from "../src/lib/planning-documents.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args.includes("--help") || !value("--bbox")) {
  console.log(`Voxel Mapper planning document plan\n\nUsage:\n  node scripts/planning-document-plan.mjs --bbox south,west,north,east [options]\n\nOptions:\n  --out FILE               Queue output (default planning-document-queue.json)\n  --cache DIR              Discovery cache (default .tpmap-cache)\n  --max-applications N     Maximum intersecting planning applications (max 680)\n  --shards N               Queue shard count (default 20)\n  --refresh                Refresh Planning Data API pages\n`);
  process.exit(args.includes("--help") ? 0 : 2);
}

const bbox = parseBbox(value("--bbox"));
const cacheDir = path.resolve(value("--cache") || ".tpmap-cache");
await ensureDir(cacheDir);
const sourcePlan = resolveSourcePlan(bbox, { providers: RUNTIME_SOURCE_PROVIDERS, kinds: ["planning"] });
const planning = await acquirePlanningForBbox({
  bbox,
  cacheDir,
  noCache: args.includes("--refresh"),
  maxPlanningApplications: Number(value("--max-applications") || 680),
  userAgent: process.env.TPMAP_CONTACT ? `VoxelMapper/0.12 (${process.env.TPMAP_CONTACT})` : "VoxelMapper/0.12"
}, sourcePlan.selected.planning);
const queue = buildPlanningDocumentQueue(planning, {
  planningDocumentShards: Number(value("--shards") || 20)
});
const out = path.resolve(value("--out") || "planning-document-queue.json");
await writeJson(out, queue);
const activeShards = Object.entries(queue.shardCounts || {})
  .filter(([, count]) => Number(count) > 0)
  .map(([index]) => Number(index))
  .sort((a, b) => a - b);

console.log(`Planning provider: ${planning.providerId || planning.provider || "none"}`);
console.log(`Applications: ${planning.applicationCount || 0}`);
console.log(`Queue items: ${queue.itemCount}`);
console.log(`Active shards: ${activeShards.join(",") || "none"}`);
console.log(`Queue: ${out}`);

if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `active_shards=${JSON.stringify(activeShards.length ? activeShards : [0])}\n`);
  await appendFile(process.env.GITHUB_OUTPUT, `queue_items=${queue.itemCount}\n`);
  await appendFile(process.env.GITHUB_OUTPUT, `applications=${planning.applicationCount || 0}\n`);
}
