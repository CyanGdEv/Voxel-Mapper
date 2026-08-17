import test from "node:test";
import assert from "node:assert/strict";
import {
  enrichDrawingLifecycleMetadata,
  extractMaterialObservationsAcrossRuns
} from "../src/lib/planning-text-evidence.mjs";

test("material evidence spans adjacent PDF text items on one drawing line", () => {
  const observations = extractMaterialObservationsAcrossRuns([
    { text: "Proposed path finish:", xPt: 10, yPt: 100, fontSizePt: 10 },
    { text: "Red", xPt: 85, yPt: 100, fontSizePt: 10 },
    { text: "tarmac", xPt: 105, yPt: 100, fontSizePt: 10 }
  ], 2, "abc");
  const red = observations.find((entry) => entry.material === "red_tarmac");
  assert.ok(red);
  assert.equal(red.pageNumber, 2);
  assert.equal(red.source, "pdf-text-adjacent-run-material-label");
  assert.equal(red.georegistrationRequired, true);
});

test("CAD-exported joined material words remain recognizable", () => {
  const observations = extractMaterialObservationsAcrossRuns([
    { text: "Redtarmac", xPt: 10, yPt: 100, fontSizePt: 10 },
    { text: "ResinBoundBeige", xPt: 10, yPt: 80, fontSizePt: 10 },
    { text: "NaturalStone", xPt: 10, yPt: 60, fontSizePt: 10 }
  ], 1, "abc");
  assert.ok(observations.some((entry) => entry.material === "red_tarmac"));
  assert.ok(observations.some((entry) => entry.material === "resin_bound_beige"));
  assert.ok(observations.some((entry) => entry.material === "stone"));
});

test("material windows do not join text from different drawing lines", () => {
  const observations = extractMaterialObservationsAcrossRuns([
    { text: "Red", xPt: 10, yPt: 100, fontSizePt: 10 },
    { text: "tarmac", xPt: 10, yPt: 70, fontSizePt: 10 }
  ], 1, "abc");
  assert.equal(observations.some((entry) => entry.material === "red_tarmac"), false);
});

test("title-block enrichment rejects header words captured as drawing number and revision", () => {
  const metadata = enrichDrawingLifecycleMetadata({
    pageNumber: 1,
    scaleDenominator: 500,
    drawingNumber: "STATUS",
    revision: "CHECKED",
    status: null,
    source: "pdf-text-title-block"
  }, [{
    text: "DRAWING STATUS CHECKED DRAWING NO 373-95-7B REV CHECKED REV B STATUS PLANNING"
  }], 1);

  assert.equal(metadata.drawingNumber, "373-95-7B");
  assert.equal(metadata.revision, "B");
  assert.equal(metadata.status, "planning");
  assert.equal(metadata.scaleDenominator, 500);
});

test("title-block enrichment clears header-only fake drawing metadata", () => {
  const metadata = enrichDrawingLifecycleMetadata({
    pageNumber: 2,
    scaleDenominator: 250,
    drawingNumber: "STATUS",
    revision: "CHECKED",
    status: null,
    source: "pdf-text-title-block"
  }, [{ text: "DRAWING STATUS REV CHECKED SCALE 1:250" }], 2);

  assert.equal(metadata.drawingNumber, null);
  assert.equal(metadata.revision, null);
  assert.equal(metadata.scaleDenominator, 250);
});
