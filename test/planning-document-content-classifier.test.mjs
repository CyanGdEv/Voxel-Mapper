import test from "node:test";
import assert from "node:assert/strict";
import { reclassifyPlanningDocumentFromContent } from "../src/lib/planning-document-content-classifier.mjs";

function extraction(classification, text, { widthPt = 840, heightPt = 594, xPt = 700, yPt = 60 } = {}) {
  return {
    classification,
    pages: [{
      pageNumber: 1,
      widthPt,
      heightPt,
      text: { items: [{ text, xPt, yPt, fontSizePt: 14 }] },
      metadata: {}
    }],
    normalizedEvidence: {
      geometryCandidates: [{ id: "g1", classification }],
      verticalObservations: [],
      materialObservations: [],
      drawingMetadata: [{ classification }]
    }
  };
}

test("opaque unknown planning drawing is promoted to ride_layout from strong track title text", () => {
  const value = extraction("unknown", "GALACTICA ROLLER COASTER TRACK LAYOUT - TRACK CENTRELINE");
  const result = reclassifyPlanningDocumentFromContent(value, "unknown");
  assert.equal(result.changed, true);
  assert.equal(result.classification, "ride_layout");
  assert.equal(value.classification, "ride_layout");
  assert.equal(value.acquisitionClassification, "unknown");
  assert.equal(value.normalizedEvidence.geometryCandidates[0].classification, "ride_layout");
  assert.equal(value.contentClassification.authorityGranted, false);
});

test("weak supporting engineering sheet can become a ride section", () => {
  const value = extraction("supporting", "ROLLER COASTER LONGITUDINAL SECTION A-A");
  const result = reclassifyPlanningDocumentFromContent(value, "supporting");
  assert.equal(result.changed, true);
  assert.equal(result.classification, "section");
});

test("explicit acquisition classification is never overwritten by content inference", () => {
  const value = extraction("site_plan", "ROLLER COASTER TRACK LAYOUT");
  const result = reclassifyPlanningDocumentFromContent(value, "site_plan");
  assert.equal(result.changed, false);
  assert.equal(result.reason, "strong-acquisition-classification");
  assert.equal(value.classification, "site_plan");
});

test("environmental prose mentioning a roller coaster does not become ride geometry", () => {
  const value = extraction("supporting", "Environmental Statement. The roller coaster may be visible from nearby receptors and mitigation planting is proposed.", {
    xPt: 100,
    yPt: 300
  });
  const result = reclassifyPlanningDocumentFromContent(value, "supporting");
  assert.equal(result.changed, false);
  assert.equal(result.classification, "supporting");
});

test("generic supporting drawing with an explicit elevation title is promoted", () => {
  const value = extraction("supporting", "PROPOSED EAST ELEVATION");
  const result = reclassifyPlanningDocumentFromContent(value, "supporting");
  assert.equal(result.changed, true);
  assert.equal(result.classification, "elevation");
});
