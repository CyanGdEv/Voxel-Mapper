#!/usr/bin/env node
import path from "node:path";
import { readdir } from "node:fs/promises";
import { readJson, writeJson } from "../src/lib/io.mjs";
import { mergePlanningExtractionManifests } from "../src/lib/planning-extraction-worker.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args.includes("--help") || !value("--manifests")) {
  console.log(`Voxel Mapper planning extraction merge\n\nUsage:\n  node scripts/planning-vector-merge.mjs --manifests DIR [options]\n\nOptions:\n  --out FILE                  Merged vector evidence output\n  --raster-fallback-out FILE  Raster fallback queue output\n`);
  process.exit(args.includes("--help") ? 0 : 2);
}

const directory = path.resolve(value("--manifests"));
const files = (await readdir(directory)).filter((file) => /^planning-extraction-shard-\d+\.json$/.test(file)).sort();
const manifests = [];
for (const file of files) manifests.push(await readJson(path.join(directory, file)));
const merged = mergePlanningExtractionManifests(manifests);
const out = path.resolve(value("--out") || "planning-vector-evidence.json");
const rasterOut = path.resolve(value("--raster-fallback-out") || "planning-raster-fallback-queue.json");
await writeJson(out, merged);
await writeJson(rasterOut, {
  schemaVersion: 1,
  source: path.basename(out),
  itemCount: merged.rasterFallbackQueue.length,
  items: merged.rasterFallbackQueue
});
console.log(`Extraction manifests: ${merged.inputShardManifests}`);
console.log(`Documents: ${merged.documentCount}`);
console.log(`Geometry candidates: ${merged.geometryCandidateCount}`);
console.log(`Vertical observations: ${merged.verticalObservationCount}`);
console.log(`Material observations: ${merged.materialObservationCount}`);
console.log(`Raster fallback pages: ${merged.rasterFallbackPages}`);
console.log(`Failures: ${merged.failures.length}`);
console.log(`Vector evidence: ${out}`);
console.log(`Raster fallback queue: ${rasterOut}`);
