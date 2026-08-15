#!/usr/bin/env node
import path from "node:path";
import { readJson, writeJson } from "../src/lib/io.mjs";
import { processPlanningDocumentShard } from "../src/lib/planning-document-worker.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args.includes("--help") || !value("--queue") || value("--shard") == null) {
  console.log(`Voxel Mapper planning document worker\n\nUsage:\n  node scripts/planning-document-worker.mjs --queue planning-document-queue.json --shard N [options]\n\nOptions:\n  --cache DIR             Shared immutable cache (default .tpmap-cache)\n  --out FILE              Shard manifest output path\n  --concurrency N         Concurrent application jobs (default 6)\n  --max-document-mb N     Maximum single document size (default 120)\n  --refresh               Revalidate cached planning documents/pages\n  --discover-only         Discover document links without downloading them\n  --strict                Fail the shard on a document/provider error\n`);
  process.exit(args.includes("--help") ? 0 : 2);
}

const queuePath = path.resolve(value("--queue"));
const shardIndex = Number(value("--shard"));
const queue = await readJson(queuePath);
const out = path.resolve(value("--out") || path.join(path.dirname(queuePath), `planning-documents-shard-${shardIndex}.json`));
const result = await processPlanningDocumentShard(queue, {
  shardIndex,
  cacheDir: value("--cache") || ".tpmap-cache",
  concurrency: Number(value("--concurrency") || 6),
  maxPlanningDocumentMb: Number(value("--max-document-mb") || 120),
  refreshPlanningDocuments: args.includes("--refresh"),
  downloadDiscovered: !args.includes("--discover-only"),
  strictPlanningDocuments: args.includes("--strict")
});
await writeJson(out, result);
console.log(`Planning document shard ${shardIndex}/${Math.max(0, Number(queue.shardCount || 1) - 1)}`);
console.log(`Input items: ${result.inputItems}`);
console.log(`Downloaded documents: ${result.downloadedDocuments}`);
console.log(`Unique content objects: ${result.uniqueContentObjects}`);
console.log(`Discovered links: ${result.discoveredLinks}`);
console.log(`Failures: ${result.failures.length}`);
console.log(`Manifest: ${out}`);
if (result.failures.length && args.includes("--strict")) process.exitCode = 1;
