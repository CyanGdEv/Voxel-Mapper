import test from "node:test";
import assert from "node:assert/strict";
import { extractMaterialObservationsAcrossRuns } from "../src/lib/planning-text-evidence.mjs";

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

test("material windows do not join text from different drawing lines", () => {
  const observations = extractMaterialObservationsAcrossRuns([
    { text: "Red", xPt: 10, yPt: 100, fontSizePt: 10 },
    { text: "tarmac", xPt: 10, yPt: 70, fontSizePt: 10 }
  ], 1, "abc");
  assert.equal(observations.some((entry) => entry.material === "red_tarmac"), false);
});
