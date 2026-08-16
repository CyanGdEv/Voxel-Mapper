import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const generateWorldPath = new URL("../.github/workflows/generate-world.yml", import.meta.url);
const planningPath = new URL("../.github/workflows/planning-documents.yml", import.meta.url);

test("player-facing generation workflow exposes bbox as its only dispatch input", async () => {
  const yaml = await readFile(generateWorldPath, "utf8");
  const dispatch = yaml.split("workflow_dispatch:")[1].split("permissions:")[0];
  assert.match(dispatch, /\bbbox:/);
  assert.doesNotMatch(dispatch, /max_applications:/);
  assert.doesNotMatch(dispatch, /shards:/);
  assert.doesNotMatch(dispatch, /refresh:/);
  assert.doesNotMatch(dispatch, /park[-_]name:/i);
});

test("bbox generation reuses planning authority and compiles reconstruction only once before world fan-out", async () => {
  const yaml = await readFile(generateWorldPath, "utf8");
  assert.match(yaml, /uses: \.\/\.github\/workflows\/planning-documents\.yml/);
  assert.match(yaml, /shards: "20"/);
  assert.match(yaml, /name: planning-current-state-evidence/);
  assert.match(yaml, /planning-current-authority-evidence\.json/);
  assert.match(yaml, /scripts\/prepare-bbox-world-shards\.mjs/);
  assert.equal((yaml.match(/scripts\/prepare-bbox-world-shards\.mjs/g) || []).length, 1);
  assert.doesNotMatch(yaml, /scripts\/generate-bbox-world\.mjs/);
});

test("Bedrock world generation fans out to a dynamic matrix capped at twenty concurrent shard jobs", async () => {
  const yaml = await readFile(generateWorldPath, "utf8");
  const preparation = yaml.split("  prepare-world:")[1].split("  build-world-shards:")[0];
  const shardJob = yaml.split("  build-world-shards:")[1].split("  assemble-world:")[0];
  assert.match(shardJob, /max-parallel: 20/);
  assert.match(shardJob, /fromJSON\(needs\.prepare-world\.outputs\.active_shards\)/);
  assert.match(preparation, /name: voxel-world-shard-inputs/);
  assert.match(preparation, /world-shard-inputs\/shard-\*\.json/);
  assert.equal((preparation.match(/name: voxel-world-shard-inputs/g) || []).length, 1);
  assert.doesNotMatch(preparation, /voxel-world-shard-input-0|voxel-world-shard-input-19/);
  assert.match(shardJob, /name: voxel-world-shard-inputs/);
  assert.match(shardJob, /shard-input\/shard-\$\{\{ matrix\.shard \}\}\.json/);
  assert.match(shardJob, /scripts\/build-world-shard\.mjs/);
  assert.match(shardJob, /voxel-built-world-shard-\$\{\{ matrix\.shard \}\}/);
  assert.match(shardJob, /compression-level: 0/);
});

test("parallel Bedrock shards are assembled only after every matrix worker succeeds", async () => {
  const yaml = await readFile(generateWorldPath, "utf8");
  const assembly = yaml.split("  assemble-world:")[1];
  assert.match(assembly, /needs: \[prepare-world, build-world-shards\]/);
  assert.match(assembly, /pattern: voxel-built-world-shard-\*/);
  assert.match(assembly, /merge-multiple: false/);
  assert.match(assembly, /scripts\/assemble-world-shards\.mjs/);
  assert.match(assembly, /world-shard-plan\.json/);
});

test("world download and QA evidence remain separate artifacts after parallel assembly", async () => {
  const yaml = await readFile(generateWorldPath, "utf8");
  const worldUpload = yaml.split("name: Upload Minecraft world only")[1].split("name: Upload generation evidence separately")[0];
  assert.match(worldUpload, /name: voxel-mapper-mcworld/);
  assert.match(worldUpload, /world-download\/\*\.mcworld/);
  assert.doesNotMatch(worldUpload, /evidence\.json|ACCURACY_REPORT/);

  const evidenceUpload = yaml.split("name: Upload generation evidence separately")[1];
  assert.match(evidenceUpload, /name: voxel-mapper-generation-evidence/);
  assert.match(evidenceUpload, /planning-authority-fusion\.json/);
  assert.match(evidenceUpload, /world-shard-plan\.json/);
});

test("planning workflow supports reusable workflow_call without removing developer dispatch", async () => {
  const yaml = await readFile(planningPath, "utf8");
  assert.match(yaml, /workflow_call:/);
  assert.match(yaml, /workflow_dispatch:/);
  assert.match(yaml, /default: "680"/);
  assert.match(yaml, /default: "20"/);
});

test("planning current-state resolution consumes merged georegistration in the same job without a huge intermediate artifact", async () => {
  const yaml = await readFile(planningPath, "utf8");
  const finalizer = yaml.split("  finalize-current-state:")[1].split("  finalize-current-state-degraded:")[0];
  assert.match(finalizer, /scripts\/planning-georeg-merge\.mjs/);
  assert.match(finalizer, /scripts\/planning-resolve-revisions\.mjs/);
  assert.match(finalizer, /scripts\/planning-authority-compat\.mjs/);
  assert.doesNotMatch(yaml, /name: planning-georegistration-evidence/);
  assert.doesNotMatch(finalizer, /Download planning spatial registration evidence/);
});
