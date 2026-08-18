import test from "node:test";
import assert from "node:assert/strict";
import { reclassifyPlanningDocumentFromContent } from "../src/lib/planning-document-content-classifier.mjs";

function extraction(classification, text, { widthPt = 840, heightPt = 594, xPt = 700, yPt = 60 } = {}) {
  return {
    contentHash: "planning-doc",
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

test("ride layout content preserves explicit Track Level AOD as a positioned vertical anchor", () => {
  const value = extraction("unknown", "GALACTICA ROLLER COASTER TRACK LAYOUT - TRACK LEVEL 142.35 m AOD");
  const result = reclassifyPlanningDocumentFromContent(value, "unknown");
  assert.equal(result.classification, "ride_layout");
  assert.equal(result.rideLevelObservationsAdded, 1);
  assert.equal(value.normalizedEvidence.verticalObservations.length, 1);
  assert.deepEqual(value.normalizedEvidence.verticalObservations[0], {
    contentHash: "planning-doc",
    pageNumber: 1,
    xPt: 700,
    yPt: 60,
    label: "TRACK LEVEL",
    valueM: 142.35,
    datum: "AOD",
    raw: "TRACK LEVEL 142.35 m AOD",
    confidence: 0.95,
    source: "pdf-text-explicit-ride-level-aod",
    classification: "ride_layout",
    georegistrationRequired: true,
    worldGeometryAuthority: false
  });
});

test("strong ride_layout documents also receive Top of Rail AOD anchors", () => {
  const value = extraction("ride_layout", "TOP OF RAIL: 155.80m AOD");
  const result = reclassifyPlanningDocumentFromContent(value, "ride_layout");
  assert.equal(result.changed, false);
  assert.equal(result.rideLevelObservationsAdded, 1);
  assert.equal(value.normalizedEvidence.verticalObservations[0].label, "TOP OF RAIL");
  assert.equal(value.normalizedEvidence.verticalObservations[0].valueM, 155.8);
});
