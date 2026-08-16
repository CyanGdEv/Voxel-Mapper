#!/usr/bin/env node
import path from "node:path";
import { readJson } from "../src/lib/io.mjs";
import { materializePlanningGeoregistrationInputShard } from "../src/lib/planning-georeg-shards.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args.includes("--help") || !value("--evidence") || !value("--plan") || value("--shard") == null) {
  console.log(`Voxel Mapper planning georegistration input sharder\n\nUsage:\n  node scripts/planning-georeg-shard.mjs --evidence planning-vector-evidence --plan planning-georeg-shard-plan.json --shard N [options]\n\nOptions:\n  --out DIR        Sharded extraction bundle output\n`);
  process.exit(args.includes("--help") ? 0 : 2);
}

const plan = await readJson(path.resolve(value("--plan")));
const shard = Number(value("--shard"));
const out = path.resolve(value("--out") || `planning-georeg-input-shard-${shard}`);
const result = await materializePlanningGeoregistrationInputShard(
  path.resolve(value("--evidence")),
  plan,
  shard,
  out
);
console.log(JSON.stringify({
  shard,
  pages: result.manifest.pageCount,
  geometryCandidates: result.manifest.geometryCandidateCount,
  verticalObservations: result.manifest.verticalObservationCount,
  materialObservations: result.manifest.materialObservationCount,
  rideStructureTemplates: result.manifest.rideStructureTemplateCount,
  out: result.outDir
}, null, 2));
