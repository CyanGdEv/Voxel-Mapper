#!/usr/bin/env node
import path from "node:path";
import { readFile } from "node:fs/promises";
import { writeJson } from "../src/lib/io.mjs";
import { mergePlanningGeoregistrationShards } from "../src/lib/planning-georeg-shards.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args.includes("--help") || !value("--shards") || !value("--registered-out") || !value("--out")) {
  console.log(`Voxel Mapper planning georegistration shard merger\n\nUsage:\n  node scripts/planning-georeg-merge.mjs --shards DIR --registered-out DIR --out FILE [options]\n\nOptions:\n  --reference FILE   OSM georegistration reference for report metadata\n`);
  process.exit(args.includes("--help") ? 0 : 2);
}

const reference = value("--reference")
  ? JSON.parse(await readFile(path.resolve(value("--reference")), "utf8"))
  : null;
const result = await mergePlanningGeoregistrationShards(
  path.resolve(value("--shards")),
  path.resolve(value("--registered-out")),
  { reference }
);
await writeJson(path.resolve(value("--out")), result.report);
console.log(JSON.stringify({
  status: result.report.status,
  mode: result.report.mode,
  shardBundles: result.report.parallelGeoregistration.shardBundles,
  groups: result.report.groupCount,
  registeredGroups: result.report.registeredGroupCount,
  templateOnlyGroups: result.report.templateOnlyGroupCount,
  unregisteredGroups: result.report.unregisteredGroupCount,
  geometryCandidates: result.manifest.geometryCandidateCount,
  verticalObservations: result.manifest.verticalObservationCount,
  materialObservations: result.manifest.materialObservationCount,
  rideStructureTemplates: result.manifest.rideStructureTemplateCount,
  out: path.resolve(value("--out")),
  registeredOut: path.resolve(value("--registered-out"))
}, null, 2));
