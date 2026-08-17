import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPlanningDocumentQueue,
  classifyPlanningDocument,
  extractDocumentLinks,
  isSafePublicHttpUrl,
  selectPlanningDocumentShard,
  shardForApplication
} from "../src/lib/planning-documents.mjs";

test("planning applications become deterministic download/discovery queue items", () => {
  const queue = buildPlanningDocumentQueue({
    providerId: "planning-data-england",
    applications: [
      {
        entity: 101,
        reference: "26/001/FUL",
        description: "New coaster and station",
        "documentation-url": "https://planning.example.gov/app/101",
        "document-urls": "https://planning.example.gov/files/proposed-site-plan.pdf;https://planning.example.gov/files/elevations.pdf"
      },
      {
        entity: 102,
        reference: "26/002/FUL",
        description: "Landscape works",
        "documentation-url": "https://planning.example.gov/app/102"
      }
    ]
  }, { planningDocumentShards: 20 });

  assert.equal(queue.applicationCount, 2);
  assert.equal(queue.applicationsQueued, 2);
  assert.equal(queue.itemCount, 4);
  assert.equal(queue.actionCounts.download, 2);
  assert.equal(queue.actionCounts.discover, 2);
  assert.equal(queue.items.find((item) => item.url.includes("site-plan")).classification, "site-plan");
  assert.equal(queue.items.find((item) => item.url.includes("elevations")).classification, "elevation");
  const app101 = queue.items.filter((item) => item.application.entity === 101);
  assert.equal(new Set(app101.map((item) => item.shard)).size, 1, "all documents for one app stay in one shard");
});

test("planning document fanout defaults to and clamps at 256 shards", () => {
  const planning = { applications: [{ entity: 1, "documentation-url": "https://planning.example.gov/app/1" }] };
  const defaultQueue = buildPlanningDocumentQueue(planning);
  const oversizedQueue = buildPlanningDocumentQueue(planning, { planningDocumentShards: 999 });
  assert.equal(defaultQueue.shardCount, 256);
  assert.equal(oversizedQueue.shardCount, 256);
  assert.ok(defaultQueue.items[0].shard >= 0 && defaultQueue.items[0].shard < 256);
});

test("classification prioritizes reconstruction-relevant drawing types", () => {
  assert.equal(classifyPlanningDocument("Proposed General Arrangement", "https://x.example/ga.pdf"), "site-plan");
  assert.equal(classifyPlanningDocument("North and South Elevations", "https://x.example/123.pdf"), "elevation");
  assert.equal(classifyPlanningDocument("Roller Coaster Track Layout", "https://x.example/track.pdf"), "ride-layout");
  assert.equal(classifyPlanningDocument("Hard Landscape Materials Schedule", "https://x.example/materials.pdf"), "landscape");
  assert.equal(classifyPlanningDocument("Proposed Soft Landscape Plan", "https://x.example/soft-landscape.pdf"), "landscape");
  assert.equal(classifyPlanningDocument("Landscape and Visual Impact Assessment", "https://x.example/lvia.pdf"), "supporting");
  assert.equal(classifyPlanningDocument("LVIA Environmental Statement", "https://x.example/report.pdf"), "supporting");
  assert.equal(classifyPlanningDocument("Supporting note", "https://x.example/note.pdf"), "supporting");
});

test("HTML portal discovery resolves relative high-value document links", () => {
  const links = extractDocumentLinks(`
    <html><body>
      <a href="/docs/proposed-site-plan.pdf">Proposed Site Plan</a>
      <a href="documents/elevations?id=55">Elevations drawing</a>
      <a href="/contact">Contact us</a>
      <a href="javascript:alert(1)">bad</a>
    </body></html>
  `, "https://planning.example.gov/application/1");

  assert.equal(links.length, 2);
  assert.equal(links[0].classification, "site-plan");
  assert.ok(links.some((entry) => entry.url === "https://planning.example.gov/application/documents/elevations?id=55"));
});

test("queue shards are stable and shard selection validates range", () => {
  const a = shardForApplication("entity:100", 20);
  const b = shardForApplication("entity:100", 20);
  assert.equal(a, b);
  assert.ok(a >= 0 && a < 20);

  const queue = buildPlanningDocumentQueue({ applications: [{
    entity: 100,
    "documentation-url": "https://planning.example.gov/application/100"
  }] }, { planningDocumentShards: 20 });
  assert.equal(selectPlanningDocumentShard(queue, queue.items[0].shard).items.length, 1);
  assert.throws(() => selectPlanningDocumentShard(queue, 20), /must be 0\.\.19/);
});

test("document URL safety rejects local/private targets", () => {
  assert.equal(isSafePublicHttpUrl("https://planning.example.gov/doc.pdf"), true);
  assert.equal(isSafePublicHttpUrl("http://127.0.0.1/doc.pdf"), false);
  assert.equal(isSafePublicHttpUrl("http://10.0.0.1/doc.pdf"), false);
  assert.equal(isSafePublicHttpUrl("file:///etc/passwd"), false);
  assert.equal(isSafePublicHttpUrl("http://localhost/doc.pdf"), false);
});
