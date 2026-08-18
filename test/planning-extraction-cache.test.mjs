import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPlanningExtractionImplementationFingerprint,
  buildPlanningExtractionShardCacheKey
} from "../src/lib/planning-extraction-cache.mjs";

const catalog = {
  extractionQueue: [
    {
      shard: 7,
      contentHash: "abc123",
      objectPath: "planning-documents/abc123.pdf",
      contentType: "application/pdf",
      classification: "ride-layout",
      applicationKeys: ["entity:2", "entity:1"],
      acquisitionShard: 7
    },
    {
      shard: 3,
      contentHash: "other",
      objectPath: "planning-documents/other.pdf",
      classification: "site_plan",
      applicationKeys: ["entity:9"]
    }
  ]
};

test("planning extraction cache is stable for identical evidence regardless of application-key order", () => {
  const implementation = buildPlanningExtractionImplementationFingerprint([
    { name: "extractor", content: "same-code" }
  ]);
  const reordered = structuredClone(catalog);
  reordered.extractionQueue[0].applicationKeys.reverse();
  assert.equal(
    buildPlanningExtractionShardCacheKey(catalog, 7, implementation),
    buildPlanningExtractionShardCacheKey(reordered, 7, implementation)
  );
});

test("planning extraction cache invalidates when document content changes", () => {
  const implementation = buildPlanningExtractionImplementationFingerprint([
    { name: "extractor", content: "same-code" }
  ]);
  const changed = structuredClone(catalog);
  changed.extractionQueue[0].contentHash = "changed-content";
  assert.notEqual(
    buildPlanningExtractionShardCacheKey(catalog, 7, implementation),
    buildPlanningExtractionShardCacheKey(changed, 7, implementation)
  );
});

test("planning extraction cache invalidates when semantic classification or application binding changes", () => {
  const implementation = buildPlanningExtractionImplementationFingerprint([
    { name: "extractor", content: "same-code" }
  ]);
  const classificationChanged = structuredClone(catalog);
  classificationChanged.extractionQueue[0].classification = "section";
  const bindingChanged = structuredClone(catalog);
  bindingChanged.extractionQueue[0].applicationKeys.push("entity:3");
  const baseline = buildPlanningExtractionShardCacheKey(catalog, 7, implementation);
  assert.notEqual(baseline, buildPlanningExtractionShardCacheKey(classificationChanged, 7, implementation));
  assert.notEqual(baseline, buildPlanningExtractionShardCacheKey(bindingChanged, 7, implementation));
});

test("planning extraction cache invalidates when extractor implementation changes", () => {
  const before = buildPlanningExtractionImplementationFingerprint([
    { name: "extractor", content: "version-a" }
  ]);
  const after = buildPlanningExtractionImplementationFingerprint([
    { name: "extractor", content: "version-b" }
  ]);
  assert.notEqual(before, after);
  assert.notEqual(
    buildPlanningExtractionShardCacheKey(catalog, 7, before),
    buildPlanningExtractionShardCacheKey(catalog, 7, after)
  );
});
