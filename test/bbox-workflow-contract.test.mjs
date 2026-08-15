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

test("bbox generation reuses the parallel planning workflow and automatically downloads current authority", async () => {
  const yaml = await readFile(generateWorldPath, "utf8");
  assert.match(yaml, /uses: \.\/\.github\/workflows\/planning-documents\.yml/);
  assert.match(yaml, /shards: "20"/);
  assert.match(yaml, /name: planning-current-state-evidence/);
  assert.match(yaml, /planning-current-authority-evidence\.json/);
  assert.match(yaml, /scripts\/generate-bbox-world\.mjs/);
});

test("world download and QA evidence are separate artifacts", async () => {
  const yaml = await readFile(generateWorldPath, "utf8");
  const worldUpload = yaml.split("name: Upload Minecraft world only")[1].split("name: Upload generation evidence separately")[0];
  assert.match(worldUpload, /name: voxel-mapper-mcworld/);
  assert.match(worldUpload, /world-download\/\*\.mcworld/);
  assert.doesNotMatch(worldUpload, /evidence\.json|ACCURACY_REPORT/);

  const evidenceUpload = yaml.split("name: Upload generation evidence separately")[1];
  assert.match(evidenceUpload, /name: voxel-mapper-generation-evidence/);
  assert.match(evidenceUpload, /planning-authority-fusion\.json/);
});

test("planning workflow supports reusable workflow_call without removing developer dispatch", async () => {
  const yaml = await readFile(planningPath, "utf8");
  assert.match(yaml, /workflow_call:/);
  assert.match(yaml, /workflow_dispatch:/);
  assert.match(yaml, /default: "680"/);
  assert.match(yaml, /default: "20"/);
});
