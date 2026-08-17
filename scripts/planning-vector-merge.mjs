#!/usr/bin/env node
import path from "node:path";
import { writeJson } from "../src/lib/io.mjs";
import {
  EXTRACTION_BUNDLE_FORMAT,
  findBundleManifests,
  mergeExtractionBundles
} from "../src/lib/planning-evidence-bundle.mjs";
import {
  assertCompleteShardCoverage,
  expectedShardIdsFromManifests
} from "../src/lib/planning-pipeline-completeness.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args.includes("--help") || !value("--manifests")) {
  console.log(`Voxel Mapper planning extraction merge\n\nUsage:\n  node scripts/planning-vector-merge.mjs --manifests DIR [options]\n\nOptions:\n  --out DIR                   Merged chunked vector evidence bundle\n  --raster-fallback-out FILE  Raster fallback queue output\n`);
  process.exit(args.includes("--help") ? 0 : 2);
}

const directory = path.resolve(value("--manifests"));
const out = path.resolve(value("--out") || "planning-vector-evidence");
const rasterOut = path.resolve(value("--raster-fallback-out") || "planning-raster-fallback-queue.json");
const locatedManifests = await findBundleManifests(directory, EXTRACTION_BUNDLE_FORMAT);
const extractionManifests = locatedManifests.map((entry) => entry.manifest);
const expectedExtractionShards = expectedShardIdsFromManifests(extractionManifests, "expectedActiveExtractionShards");
assertCompleteShardCoverage(
  "planning extraction",
  expectedExtractionShards,
  extractionManifests.map((manifest) => manifest.selectedShard)
);
if (extractionManifests.some((manifest) => manifest.acquisitionCoverageComplete !== true)) {
  throw new Error("Planning extraction cannot merge because acquisition coverage was not certified complete");
}
const { manifest: merged } = await mergeExtractionBundles(directory, out);
merged.expectedExtractionShards = expectedExtractionShards;
merged.observedExtractionShards = extractionManifests.map((manifest) => Number(manifest.selectedShard)).sort((a, b) => a - b);
merged.extractionCoverageComplete = true;
await writeJson(path.join(out, "manifest.json"), merged);
await writeJson(rasterOut, {
  schemaVersion: 1,
  source: `${path.basename(out)}/manifest.json`,
  itemCount: merged.rasterFallbackQueue.length,
  items: merged.rasterFallbackQueue
});
console.log(`Extraction bundles: ${merged.inputShardBundles}`);
console.log(`Extraction shard coverage: ${merged.observedExtractionShards.join(",") || "none"} / ${merged.expectedExtractionShards.join(",") || "none"}`);
console.log(`Documents: ${merged.documentCount}`);
console.log(`Evidence pages: ${merged.pageCount}`);
console.log(`Geometry candidates: ${merged.geometryCandidateCount}`);
console.log(`Vertical observations: ${merged.verticalObservationCount}`);
console.log(`Material observations: ${merged.materialObservationCount}`);
console.log(`Raster fallback pages: ${merged.rasterFallbackPages}`);
console.log(`Failures: ${merged.failures.length}`);
console.log(`Vector evidence bundle: ${out}`);
console.log(`Raster fallback queue: ${rasterOut}`);