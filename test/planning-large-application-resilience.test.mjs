import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { buildPlanningDocumentQueue } from "../src/lib/planning-documents.mjs";
import { processPlanningDocumentShard } from "../src/lib/planning-document-worker.mjs";
import {
  compactPlanningExtraction,
  mergePlanningExtractionManifests
} from "../src/lib/planning-extraction-worker.mjs";
import { splitPlanningEvidenceByPage } from "../src/lib/planning-georegistration-batch.mjs";

function geometryCandidate() {
  return {
    id: "abc:p1:v0",
    contentHash: "abc",
    pageNumber: 1,
    classification: "site_plan",
    semantic: "site-feature-or-building-footprint",
    closed: true,
    boundsPt: { minX: 0, minY: 0, maxX: 100, maxY: 50 },
    pointCount: 5,
    commands: [
      { op: "M", x: 0, y: 0 },
      { op: "L", x: 100, y: 0 },
      { op: "L", x: 100, y: 50 },
      { op: "L", x: 0, y: 50 },
      { op: "Z" }
    ],
    coordinateSpace: "pdf-user-space-points",
    georegistrationRequired: true,
    worldGeometryAuthority: false
  };
}

test("large extraction compaction retains semantic evidence once and drops renderer duplication", () => {
  const geometry = geometryCandidate();
  const extraction = {
    schemaVersion: 1,
    contentHash: "abc",
    objectPath: "objects/abc.pdf",
    contentType: "application/pdf",
    classification: "site_plan",
    applicationKeys: ["app:1"],
    acquisitionShard: 12,
    status: "extracted",
    method: "pdfjs-vector-first",
    pageCount: 1,
    vectorPageCount: 1,
    textPageCount: 1,
    rasterFallbackPageCount: 0,
    pages: [{
      pageNumber: 1,
      widthPt: 1000,
      heightPt: 700,
      rotation: 0,
      text: {
        itemCount: 2,
        characterCount: 24,
        truncated: false,
        items: [{ text: "Proposed Site Plan", xPt: 10, yPt: 10 }, { text: "FFL 123.4", xPt: 20, yPt: 20 }]
      },
      vector: {
        pathCount: 1,
        imagePaintOps: 0,
        truncated: false,
        paths: [{ commands: geometry.commands, pointCount: 5, bounds: geometry.boundsPt }]
      },
      metadata: { pageNumber: 1, drawingNumber: "TP-100", revision: "P01", status: "planning" },
      geometryCandidates: [geometry],
      verticalObservations: [{ contentHash: "abc", pageNumber: 1, label: "FFL", valueM: 123.4, xPt: 20, yPt: 20 }],
      materialObservations: [{ contentHash: "abc", pageNumber: 1, material: "concrete", xPt: 30, yPt: 30 }],
      rasterFallback: { required: false, reason: null }
    }],
    normalizedEvidence: {
      schemaVersion: 1,
      coordinateSpace: "pdf-user-space-points",
      geometryCandidates: [geometry],
      verticalObservations: [{ contentHash: "abc", pageNumber: 1, label: "FFL", valueM: 123.4, xPt: 20, yPt: 20 }],
      materialObservations: [{ contentHash: "abc", pageNumber: 1, material: "concrete", xPt: 30, yPt: 30 }],
      drawingMetadata: [{ pageNumber: 1, drawingNumber: "TP-100", revision: "P01", status: "planning" }]
    },
    rasterFallbackQueue: []
  };

  const compact = compactPlanningExtraction(extraction);
  assert.equal(compact.pages[0].text.items, undefined);
  assert.equal(compact.pages[0].vector.paths, undefined);
  assert.equal(compact.pages[0].geometryCandidates, undefined);
  assert.deepEqual(compact.normalizedEvidence.geometryCandidates[0].commands, geometry.commands);
  assert.equal(compact.normalizedEvidence.drawingMetadata[0].contentHash, "abc");

  const merged = mergePlanningExtractionManifests([{
    schemaVersion: 2,
    results: [{ status: "extracted", extraction: compact }],
    failures: [],
    rasterFallbackQueue: []
  }]);
  assert.equal(merged.serialization, "normalized-evidence-single-copy");
  assert.equal(merged.documents.length, 1);
  assert.equal(merged.documents[0].normalizedEvidence, undefined);
  assert.equal(merged.normalizedEvidence.geometryCandidates.length, 1);

  const groups = splitPlanningEvidenceByPage(merged);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].contentHash, "abc");
  assert.equal(groups[0].extraction.normalizedEvidence.geometryCandidates.length, 1);
  assert.equal(groups[0].extraction.normalizedEvidence.drawingMetadata[0].drawingNumber, "TP-100");
});

test("discovered planning PDFs download through the bounded parallel pool", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-planning-parallel-"));
  try {
    const queue = buildPlanningDocumentQueue({ applications: [{
      entity: 909,
      reference: "26/909/FUL",
      "documentation-url": "https://planning.example.gov/application/909"
    }] }, { planningDocumentShards: 20 });
    const shard = queue.items[0].shard;
    let active = 0;
    let maxActive = 0;
    const fetchImpl = async (url) => {
      if (String(url).includes("application/909")) {
        const links = Array.from({ length: 6 }, (_, index) =>
          `<a href="/docs/site-plan-${index}.pdf">Proposed Site Plan ${index}</a>`
        ).join("\n");
        return new Response(`<html><body>${links}</body></html>`, {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return new Response(Buffer.from(`%PDF-${url}`), {
        status: 200,
        headers: { "content-type": "application/pdf" }
      });
    };

    const result = await processPlanningDocumentShard(queue, {
      shardIndex: shard,
      cacheDir: root,
      concurrency: 3,
      fetchImpl,
      fetchRetries: 0
    });
    assert.equal(result.failures.length, 0);
    assert.equal(result.downloadedDocuments, 6);
    assert.ok(maxActive >= 2, `expected concurrent downloads, max in-flight was ${maxActive}`);
    assert.ok(maxActive <= 3, `bounded pool exceeded concurrency: ${maxActive}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
