#!/usr/bin/env node
import path from "node:path";
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { readJson, writeJson } from "../src/lib/io.mjs";
import { extractPlanningShardToBundle } from "../src/lib/planning-evidence-bundle.mjs";
import { enrichPlanningPedestrianBundle } from "../src/lib/planning-pedestrian-bundle-enrichment.mjs";
import {
  buildPlanningExtractionImplementationFingerprint,
  buildPlanningExtractionShardCacheKey
} from "../src/lib/planning-extraction-cache.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args.includes("--help") || !value("--catalog") || value("--shard") == null) {
  console.log(`Voxel Mapper planning vector extractor\n\nUsage:\n  node scripts/planning-vector-extract.mjs --catalog FILE --shard N [options]\n\nOptions:\n  --cache DIR         Cache root (default .tpmap-cache)\n  --out DIR           Chunked shard evidence bundle directory\n  --concurrency N     Concurrent PDF extractions (default 2)\n  --max-pages N       Maximum pages per PDF (default 240)\n  --strict            Fail shard on the first extraction error\n`);
  process.exit(args.includes("--help") ? 0 : 2);
}

const catalog = await readJson(path.resolve(value("--catalog")));
const shardIndex = Number(value("--shard"));
const cacheRoot = path.resolve(value("--cache") || ".tpmap-cache");
const out = path.resolve(value("--out") || `planning-extraction-shard-${shardIndex}`);
const implementationFingerprint = await extractionImplementationFingerprint();
const cacheKey = buildPlanningExtractionShardCacheKey(catalog, shardIndex, implementationFingerprint);
// Keep extraction reuse inside the already-restored immutable planning-document
// cache tree. GitHub Actions persists this path between runs, while the exact
// evidence + implementation fingerprint prevents stale semantic reuse.
const cacheDir = path.join(cacheRoot, "planning-documents", ".vector-extraction-cache", cacheKey);

let manifest;
let cacheHit = false;
if (await exists(path.join(cacheDir, "manifest.json"))) {
  await rm(out, { recursive: true, force: true });
  await cp(cacheDir, out, { recursive: true });
  manifest = await readJson(path.join(out, "manifest.json"));
  cacheHit = true;
} else {
  const extracted = await extractPlanningShardToBundle(catalog, {
    shardIndex,
    outDir: out,
    cacheDir: cacheRoot,
    concurrency: Number(value("--concurrency") || 2),
    maxPlanningPdfPages: Number(value("--max-pages") || 240),
    strictPlanningExtraction: args.includes("--strict")
  });
  manifest = extracted.manifest;
}

// Production extraction previously retained page text and vector bounds but
// never ran the pedestrian/plaza semantic pass before the bundle moved on to
// georegistration. Apply it to both fresh and cache-restored bundles so labelled
// plazas (for example ride entrance plazas) survive as path-area candidates.
const pedestrianExtraction = await enrichPlanningPedestrianBundle(out, manifest);
manifest.pedestrianExtraction = pedestrianExtraction;
manifest.expectedActiveExtractionShards = [...(catalog.activeExtractionShards || [])]
  .map(Number)
  .filter((entry) => Number.isInteger(entry) && entry >= 0)
  .sort((a, b) => a - b);
manifest.catalogExtractionQueueItems = Number(catalog.extractionQueueItems || 0);
manifest.acquisitionCoverageComplete = catalog.acquisitionCoverageComplete === true;
manifest.extractionCache = {
  schemaVersion: 1,
  hit: cacheHit,
  key: cacheKey,
  implementationFingerprint
};
await writeJson(path.join(out, "manifest.json"), manifest);

// Cache the enriched representation, not the pre-semantic raw bundle. The
// fingerprint includes the enrichment implementation so future behavior changes
// cannot reuse an older plaza/path classification.
if (!cacheHit) {
  await mkdir(path.dirname(cacheDir), { recursive: true });
  await rm(cacheDir, { recursive: true, force: true });
  await cp(out, cacheDir, { recursive: true });
}

console.log(`Shard: ${manifest.selectedShard}`);
console.log(`Extraction cache: ${cacheHit ? "hit" : "miss"}`);
console.log(`Extraction cache key: ${cacheKey}`);
console.log(`Expected extraction shards: ${manifest.expectedActiveExtractionShards.join(",") || "none"}`);
console.log(`Input documents: ${manifest.inputItems}`);
console.log(`Extracted PDFs: ${manifest.extractedDocuments}`);
console.log(`Raster-only documents: ${manifest.rasterOnlyDocuments}`);
console.log(`Evidence pages: ${manifest.pageCount}`);
console.log(`Geometry candidates: ${manifest.geometryCandidateCount}`);
console.log(`Vertical observations: ${manifest.verticalObservationCount}`);
console.log(`Material observations: ${manifest.materialObservationCount}`);
console.log(`Pedestrian/plaza candidates enriched: ${pedestrianExtraction.enrichedCandidates}`);
console.log(`Raster fallback pages: ${manifest.rasterFallbackPages}`);
console.log(`Failures: ${manifest.failedDocuments}`);
console.log(`Bundle: ${out}`);

async function extractionImplementationFingerprint() {
  const files = [
    "../src/lib/planning-evidence-bundle.mjs",
    "../src/lib/planning-vector-extractor.mjs",
    "../src/lib/planning-extraction-worker.mjs",
    "../src/lib/planning-pdfjs-runtime.mjs",
    "../src/lib/planning-ride-structure-enrichment.mjs",
    "../src/lib/planning-text-evidence.mjs",
    "../src/lib/planning-document-content-classifier.mjs",
    "../src/lib/planning-legend-enrichment.mjs",
    "../src/lib/planning-pedestrian-enrichment.mjs",
    "../src/lib/planning-pedestrian-bundle-enrichment.mjs"
  ];
  const sources = await Promise.all(files.map(async (relative) => {
    const url = new URL(relative, import.meta.url);
    return { name: relative, content: await readFile(url) };
  }));
  return buildPlanningExtractionImplementationFingerprint(sources);
}

async function exists(filename) {
  try {
    await stat(filename);
    return true;
  } catch {
    return false;
  }
}
