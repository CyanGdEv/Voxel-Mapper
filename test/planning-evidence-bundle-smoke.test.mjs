import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { extractPlanningShardToBundle, EXTRACTION_BUNDLE_FORMAT } from "../src/lib/planning-evidence-bundle.mjs";

test("planning extraction bundle entry point handles an empty shard without workflow-only helper failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-planning-bundle-"));
  try {
    const outDir = path.join(root, "shard-12");
    const result = await extractPlanningShardToBundle({ extractionQueue: [] }, {
      shardIndex: 12,
      outDir,
      concurrency: 2
    });
    assert.equal(result.manifest.format, EXTRACTION_BUNDLE_FORMAT);
    assert.equal(result.manifest.selectedShard, 12);
    assert.equal(result.manifest.inputItems, 0);
    assert.equal(result.manifest.pageCount, 0);
    const persisted = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf8"));
    assert.equal(persisted.format, EXTRACTION_BUNDLE_FORMAT);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
