#!/usr/bin/env node
import path from "node:path";
import { readdir } from "node:fs/promises";
import { exists, readJson, sha256, writeJson } from "../src/lib/io.mjs";
import { classifyPlanningDocument } from "../src/lib/planning-documents.mjs";
import { processPlanningDocumentShard } from "../src/lib/planning-document-worker.mjs";
import { activeShardIdsFromCounts } from "../src/lib/planning-pipeline-completeness.mjs";

const DISCOVERY_PARSER_VERSION = 3;
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
const cacheDir = value("--cache") || ".tpmap-cache";
const refreshPlanningDocuments = args.includes("--refresh");
const out = path.resolve(value("--out") || path.join(path.dirname(queuePath), `planning-documents-shard-${shardIndex}.json`));

if (!refreshPlanningDocuments) {
  const recovered = await recoverPreviousDiscoveryCache(queue, shardIndex, cacheDir);
  if (recovered > 0) console.log(`Recovered ${recovered} planning discovery cache entr${recovered === 1 ? "y" : "ies"} across parser upgrade.`);
}

const result = await processPlanningDocumentShard(queue, {
  shardIndex,
  cacheDir,
  concurrency: Number(value("--concurrency") || 6),
  maxPlanningDocumentMb: Number(value("--max-document-mb") || 120),
  refreshPlanningDocuments,
  downloadDiscovered: !args.includes("--discover-only"),
  strictPlanningDocuments: args.includes("--strict")
});
result.expectedActiveShards = activeShardIdsFromCounts(queue.shardCounts || {});
result.queueItemCount = Number(queue.itemCount || (queue.items || []).length || 0);
await writeJson(out, result);
console.log(`Planning document shard ${shardIndex}/${Math.max(0, Number(queue.shardCount || 1) - 1)}`);
console.log(`Expected active shards: ${result.expectedActiveShards.join(",") || "none"}`);
console.log(`Input items: ${result.inputItems}`);
console.log(`Downloaded documents: ${result.downloadedDocuments}`);
console.log(`Unique content objects: ${result.uniqueContentObjects}`);
console.log(`Discovered links: ${result.discoveredLinks}`);
console.log(`Failures: ${result.failures.length}`);
console.log(`Manifest: ${out}`);
if (result.failures.length && args.includes("--strict")) process.exitCode = 1;

async function recoverPreviousDiscoveryCache(queueValue, selectedShard, cacheRoot) {
  const discoveryDir = path.join(path.resolve(cacheRoot), "planning-documents", "discovery");
  let filenames;
  try {
    filenames = await readdir(discoveryDir);
  } catch {
    return 0;
  }

  const requested = new Map();
  for (const item of queueValue.items || []) {
    if (item.action !== "discover" || Number(item.shard) !== selectedShard || !item.url) continue;
    const url = String(item.url);
    requested.set(url, path.join(discoveryDir, `${sha256(`${DISCOVERY_PARSER_VERSION}\n${url}`)}.json`));
  }
  if (!requested.size) return 0;

  const candidates = new Map();
  for (const filename of filenames) {
    if (!filename.endsWith(".json")) continue;
    const source = path.join(discoveryDir, filename);
    let cached;
    try {
      cached = await readJson(source);
    } catch {
      continue;
    }
    const url = String(cached?.url || "");
    if (!requested.has(url) || !Array.isArray(cached?.links) || cached.links.length === 0) continue;
    const version = Number(cached.parserVersion || 0);
    const current = candidates.get(url);
    if (!current || version > current.version) candidates.set(url, { cached, version });
  }

  let recovered = 0;
  for (const [url, target] of requested) {
    if (await exists(target)) continue;
    const candidate = candidates.get(url);
    if (!candidate) continue;
    const upgradedLinks = candidate.cached.links.map((link) => ({
      ...link,
      classification: classifyPlanningDocument(link?.label || "", link?.url || "")
    }));
    await writeJson(target, {
      ...candidate.cached,
      parserVersion: DISCOVERY_PARSER_VERSION,
      migratedFromParserVersion: candidate.version || null,
      cacheRecovery: "previous-parser-discovery",
      linkCount: upgradedLinks.length,
      links: upgradedLinks
    });
    recovered += 1;
  }
  return recovered;
}
