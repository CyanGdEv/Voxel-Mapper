#!/usr/bin/env node
import path from "node:path";
import { appendFile, readdir } from "node:fs/promises";
import { readJson, writeJson } from "../src/lib/io.mjs";
import { buildPlanningDocumentCatalog } from "../src/lib/planning-document-catalog.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args.includes("--help") || !value("--manifests")) {
  console.log(`Voxel Mapper planning document catalog\n\nUsage:\n  node scripts/planning-document-catalog.mjs --manifests DIR [options]\n\nOptions:\n  --out FILE               Catalog output (default planning-document-catalog.json)\n  --extraction-shards N    Extraction shard count (default 20)\n  --include-low-value      Include decisions/supporting files in extraction queue\n`);
  process.exit(args.includes("--help") ? 0 : 2);
}

const directory = path.resolve(value("--manifests"));
const files = (await readdir(directory)).filter((file) => /^planning-documents-shard-\d+\.json$/.test(file)).sort();
const manifests = [];
for (const file of files) manifests.push(await readJson(path.join(directory, file)));
const catalog = buildPlanningDocumentCatalog(manifests, {
  planningExtractionShards: Number(value("--extraction-shards") || 20),
  includeLowValuePlanningDocuments: args.includes("--include-low-value")
});
const out = path.resolve(value("--out") || "planning-document-catalog.json");
await writeJson(out, catalog);
const githubMatrix = catalog.activeExtractionShards.length ? catalog.activeExtractionShards : [0];
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `active_extraction_shards=${JSON.stringify(githubMatrix)}\n`);
  await appendFile(process.env.GITHUB_OUTPUT, `extraction_queue_items=${catalog.extractionQueueItems}\n`);
}
console.log(`Shard manifests: ${catalog.inputShardManifests}`);
console.log(`Unique documents: ${catalog.uniqueDocuments}`);
console.log(`Duplicate references collapsed: ${catalog.duplicateReferencesCollapsed}`);
console.log(`Extraction queue: ${catalog.extractionQueueItems}`);
console.log(`Active extraction shards: ${catalog.activeExtractionShards.join(",") || "none"}`);
console.log(`Pending portal links: ${catalog.pendingPortalLinks.length}`);
console.log(`Failures: ${catalog.failures.length}`);
console.log(`Catalog: ${out}`);