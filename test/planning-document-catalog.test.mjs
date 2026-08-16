import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPlanningDocumentCatalog,
  extractionShardForContent,
  isExtractablePlanningDocument
} from "../src/lib/planning-document-catalog.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

test("catalog collapses identical document bytes while retaining all application provenance", () => {
  const catalog = buildPlanningDocumentCatalog([
    {
      selectedShard: 7,
      results: [{
        application: { key: "entity:1", entity: 1, reference: "26/1/FUL" },
        documents: [{
          status: "downloaded", contentHash: HASH_A, objectPath: `objects/${HASH_A}.pdf`,
          contentType: "application/pdf", byteLength: 1000, classification: "site-plan",
          url: "https://planning.example/a.pdf"
        }]
      }], discovered: [], failures: []
    },
    {
      selectedShard: 12,
      results: [{
        application: { key: "entity:2", entity: 2, reference: "26/2/FUL" },
        documents: [{
          status: "cached", contentHash: HASH_A, objectPath: `objects/${HASH_A}.pdf`,
          contentType: "application/pdf", byteLength: 1000, classification: "supporting",
          url: "https://mirror.example/a.pdf"
        }]
      }], discovered: [], failures: []
    }
  ]);

  assert.equal(catalog.uniqueDocuments, 1);
  assert.equal(catalog.applicationCount, 2);
  assert.equal(catalog.duplicateReferencesCollapsed, 1);
  assert.equal(catalog.documents[0].classification, "site-plan");
  assert.deepEqual(catalog.documents[0].applicationKeys, ["entity:1", "entity:2"]);
  assert.deepEqual(catalog.documents[0].acquisitionShards, [7, 12]);
  assert.equal(catalog.extractionQueueItems, 1);
  assert.equal(catalog.extractionQueue[0].shard, 7);
  assert.equal(catalog.extractionQueue[0].acquisitionShard, 7);
  assert.deepEqual(catalog.activeExtractionShards, [7]);
  assert.equal(catalog.extractionShardStrategy, "acquisition-affinity-with-hash-fallback");
});

test("catalog extraction fanout defaults to and clamps at 256 shards", () => {
  assert.equal(buildPlanningDocumentCatalog([]).extractionShards, 256);
  assert.equal(buildPlanningDocumentCatalog([], { planningExtractionShards: 999 }).extractionShards, 256);
});

test("catalog excludes low-value decision/supporting PDFs from extraction by default", () => {
  const catalog = buildPlanningDocumentCatalog([{
    selectedShard: 4,
    results: [{
      application: { key: "entity:3" },
      documents: [
        { status: "downloaded", contentHash: HASH_A, objectPath: `objects/${HASH_A}.pdf`, contentType: "application/pdf", classification: "decision" },
        { status: "downloaded", contentHash: HASH_B, objectPath: `objects/${HASH_B}.pdf`, contentType: "application/pdf", classification: "elevation" }
      ]
    }]
  }]);
  assert.equal(catalog.uniqueDocuments, 2);
  assert.equal(catalog.extractionQueueItems, 1);
  assert.equal(catalog.extractionQueue[0].contentHash, HASH_B);
  assert.equal(catalog.extractionQueue[0].shard, 4);
});

test("extraction shard is stable by content hash when acquisition affinity is unavailable", () => {
  const first = extractionShardForContent(HASH_A, 20);
  const second = extractionShardForContent(HASH_A, 20);
  assert.equal(first, second);
  assert.ok(first >= 0 && first < 20);
});

test("extractability accepts PDF/images but rejects unsupported binary objects", () => {
  assert.equal(isExtractablePlanningDocument({ contentHash: HASH_A, objectPath: "objects/a.pdf", contentType: "application/pdf", classification: "site-plan" }), true);
  assert.equal(isExtractablePlanningDocument({ contentHash: HASH_A, objectPath: "objects/a.bin", contentType: "application/octet-stream", classification: "site-plan" }), false);
});
