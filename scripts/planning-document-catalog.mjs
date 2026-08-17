#!/usr/bin/env node
import path from "node:path";
import { appendFile, readdir } from "node:fs/promises";
import { readJson, writeJson } from "../src/lib/io.mjs";
import { buildPlanningDocumentCatalog } from "../src/lib/planning-document-catalog.mjs";
import {
  MAX_GITHUB_PLANNING_RUNNER_SHARDS,
  clampGithubPlanningRunnerShards
} from "../src/lib/github-actions-planning-fanout.mjs";
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
  console.log(`Voxel Mapper planning document catalog\n\nUsage:\n  node scripts/planning-document-catalog.mjs --manifests DIR [options]\n\nOptions:\n  --out FILE               Catalog output (default planning-document-catalog.json)\n  --extraction-shards N    Extraction runner shards (bounded by the GitHub planning runner limit)\n  --include-low-value      Include decisions/supporting files in extraction queue\n`);
  process.exit(args.includes("--help") ? 0 : 2);
}

const directory = path.resolve(value("--manifests"));
const files = (await readdir(directory)).filter((file) => /^planning-documents-shard-\d+\.json$/.test(file)).sort();
const manifests = [];
for (const file of files) manifests.push(await readJson(path.join(directory, file)));
const expectedAcquisitionShards = expectedShardIdsFromManifests(manifests, "expectedActiveShards");
assertCompleteShardCoverage(
  "planning acquisition",
  expectedAcquisitionShards,
  manifests.map((manifest) => manifest.selectedShard)
);
const requestedExtractionShards = Number(value("--extraction-shards") || MAX_GITHUB_PLANNING_RUNNER_SHARDS);
const extractionShards = clampGithubPlanningRunnerShards(requestedExtractionShards);
const catalog = buildPlanningDocumentCatalog(manifests, {
  planningExtractionShards: extractionShards,
  includeLowValuePlanningDocuments: args.includes("--include-low-value")
});
catalog.expectedAcquisitionShards = expectedAcquisitionShards;
catalog.observedAcquisitionShards = manifests.map((manifest) => Number(manifest.selectedShard)).sort((a, b) => a - b);
catalog.acquisitionCoverageComplete = true;
catalog.requestedRunnerShards = Number.isFinite(requestedExtractionShards) ? requestedExtractionShards : null;
catalog.runnerShardLimit = MAX_GITHUB_PLANNING_RUNNER_SHARDS;
catalog.effectiveRunnerShards = extractionShards;
const out = path.resolve(value("--out") || "planning-document-catalog.json");
await writeJson(out, catalog);
const githubMatrix = catalog.activeExtractionShards.length ? catalog.activeExtractionShards : [0];
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `active_extraction_shards=${JSON.stringify(githubMatrix)}\n`);
  await appendFile(process.env.GITHUB_OUTPUT, `extraction_queue_items=${catalog.extractionQueueItems}\n`);
}
console.log(`Shard manifests: ${catalog.inputShardManifests}`);
console.log(`Acquisition shard coverage: ${catalog.observedAcquisitionShards.join(",") || "none"} / ${catalog.expectedAcquisitionShards.join(",") || "none"}`);
console.log(`Unique documents: ${catalog.uniqueDocuments}`);
console.log(`Duplicate references collapsed: ${catalog.duplicateReferencesCollapsed}`);
console.log(`Extraction queue: ${catalog.extractionQueueItems}`);
console.log(`Requested extraction runner shards: ${Number.isFinite(requestedExtractionShards) ? requestedExtractionShards : "invalid"}`);
console.log(`Effective extraction runner shards: ${extractionShards}`);
console.log(`Active extraction shards: ${catalog.activeExtractionShards.join(",") || "none"}`);
console.log(`Pending portal links: ${catalog.pendingPortalLinks.length}`);
console.log(`Failures: ${catalog.failures.length}`);
console.log(`Catalog: ${out}`);