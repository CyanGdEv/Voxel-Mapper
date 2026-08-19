import test from "node:test";
import assert from "node:assert/strict";
import { enrichPlanningTextEvidence } from "../src/lib/planning-text-evidence.mjs";
import { compactPlanningExtraction } from "../src/lib/planning-extraction-worker.mjs";

test("planning plaza semantics are attached before raw PDF text is compacted", () => {
  const candidate = {
    id: "site:p1:v0",
    contentHash: "site",
    pageNumber: 1,
    classification: "site_plan",
    semantic: "site-feature-or-building-footprint",
    closed: true,
    boundsPt: { minX: 100, minY: 100, maxX: 220, maxY: 190 },
    confidence: 0.48,
    georegistrationRequired: true,
    worldGeometryAuthority: false
  };
  const extraction = {
    schemaVersion: 1,
    contentHash: "site",
    status: "extracted",
    pages: [{
      pageNumber: 1,
      text: {
        itemCount: 2,
        characterCount: 50,
        items: [
          { text: "WICKER MAN ENTRANCE PLAZA", xPt: 155, yPt: 140 },
          { text: "BUFF RESIN BOUND PAVING", xPt: 155, yPt: 154 }
        ]
      },
      materialObservations: [],
      metadata: null
    }],
    normalizedEvidence: {
      geometryCandidates: [candidate],
      materialObservations: [],
      verticalObservations: [],
      drawingMetadata: []
    }
  };

  enrichPlanningTextEvidence(extraction);
  assert.equal(candidate.kind, "path");
  assert.equal(candidate.subtype, "pedestrian_plaza");
  assert.ok(extraction.normalizedEvidence.materialObservations.some((entry) => entry.material === "resin_bound_beige"));

  const compact = compactPlanningExtraction(extraction);
  assert.equal(compact.pages[0].text.items, undefined);
  assert.equal(compact.normalizedEvidence.geometryCandidates[0].kind, "path");
  assert.equal(compact.normalizedEvidence.geometryCandidates[0].subtype, "pedestrian_plaza");
  assert.ok(compact.normalizedEvidence.materialObservations.some((entry) => entry.material === "resin_bound_beige"));
});
