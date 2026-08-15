#!/usr/bin/env node
import path from "node:path";
import { readJson, writeJson } from "../src/lib/io.mjs";
import { processPlanningExtractionShard } from "../src/lib/planning-extraction-worker.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args.includes("--help") || !value("--catalog") || value("--shard") == null) {
  console.log(`Voxel Mapper planning vector extractor\n\nUsage:\n  node scripts/planning-vector-extract.mjs --catalog FILE --shard N [options]\n\nOptions:\n  --cache DIR         Cache root (default .tpmap-cache)\n  --out FILE          Shard extraction manifest\n  --concurrency N     Concurrent PDF extractions (default 2)\n  --max-pages N       Maximum pages per PDF (default 240)\n  --strict            Fail shard on the first extraction error\n`);
  process.exit(args.includes("--help") ? 0 : 2);
}

const catalog = await readJson(path.resolve(value("--catalog")));
const shardIndex = Number(value("--shard"));
const manifest = await processPlanningExtractionShard(catalog, {
  shardIndex,
  cacheDir: path.resolve(value("--cache") || ".tpmap-cache"),
  concurrency: Number(value("--concurrency") || 2),
  maxPlanningPdfPages: Number(value("--max-pages") || 240),
  strictPlanningExtraction: args.includes("--strict")
});
const out = path.resolve(value("--out") || `planning-extraction-shard-${shardIndex}.json`);
await writeJson(out, manifest);
console.log(`Shard: ${manifest.selectedShard}`);
console.log(`Input documents: ${manifest.inputItems}`);
console.log(`Extracted PDFs: ${manifest.extractedDocuments}`);
console.log(`Raster-only documents: ${manifest.rasterOnlyDocuments}`);
console.log(`Geometry candidates: ${manifest.geometryCandidates}`);
console.log(`Vertical observations: ${manifest.verticalObservations}`);
console.log(`Material observations: ${manifest.materialObservations}`);
console.log(`Raster fallback pages: ${manifest.rasterFallbackPages}`);
console.log(`Failures: ${manifest.failedDocuments}`);
console.log(`Manifest: ${out}`);
