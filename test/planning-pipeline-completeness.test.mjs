import test from "node:test";
import assert from "node:assert/strict";
import {
  activeShardIdsFromCounts,
  assertCompleteShardCoverage,
  expectedShardIdsFromManifests
} from "../src/lib/planning-pipeline-completeness.mjs";

test("activeShardIdsFromCounts returns only populated deterministic shard ids", () => {
  assert.deepEqual(activeShardIdsFromCounts({ 3: 2, 0: 7, 2: 0, 1: 4 }), [0, 1, 3]);
});

test("planning shard coverage accepts the complete expected set", () => {
  const result = assertCompleteShardCoverage("planning acquisition", [0, 1, 3], [3, 0, 1]);
  assert.equal(result.complete, true);
  assert.deepEqual(result.observed, [0, 1, 3]);
});

test("planning shard coverage fails closed when any expected shard is missing", () => {
  assert.throws(
    () => assertCompleteShardCoverage("planning extraction", [0, 1, 2, 3], [0, 1, 3]),
    /missing=\[2\]/
  );
});

test("planning shard manifests must agree on their expected coverage", () => {
  assert.deepEqual(expectedShardIdsFromManifests([
    { expectedActiveShards: [0, 1, 3] },
    { expectedActiveShards: [3, 1, 0] }
  ], "expectedActiveShards"), [0, 1, 3]);
  assert.throws(
    () => expectedShardIdsFromManifests([
      { expectedActiveShards: [0, 1] },
      { expectedActiveShards: [0, 2] }
    ], "expectedActiveShards"),
    /disagree/
  );
});
