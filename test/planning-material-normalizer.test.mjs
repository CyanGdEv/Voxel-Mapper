import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyPlanningMaterialText,
  extractPlanningMaterialObservations,
  normalizeMaterialText
} from "../src/lib/planning-material-normalizer.mjs";

test("generic planning labels normalize into renderer surface palettes", () => {
  const cases = new Map([
    ["Asphalt surfacing", "weathered_asphalt"],
    ["Light tarmac path", "light_asphalt"],
    ["Weathered concrete paving", "old_concrete"],
    ["Paving slabs", "paving_stones"],
    ["Block paving", "paving_stones"],
    ["Sand surface", "sand"],
    ["Topsoil", "earth"],
    ["Grass lawn", "grass"]
  ]);
  for (const [label, expected] of cases) {
    const matches = classifyPlanningMaterialText(label);
    assert.equal(matches[0]?.material, expected, label);
  }
});

test("specific asphalt and resin wording wins ahead of generic fallbacks", () => {
  assert.equal(classifyPlanningMaterialText("new black asphalt")[0]?.material, "fresh_black_asphalt");
  assert.equal(classifyPlanningMaterialText("red asphalt")[0]?.material, "red_tarmac");
  assert.equal(classifyPlanningMaterialText("buff resin-bound surfacing")[0]?.material, "resin_bound_beige");
  assert.equal(classifyPlanningMaterialText("grey resin bound path")[0]?.material, "resin_bound_grey");
  assert.ok(!classifyPlanningMaterialText("red asphalt").some((entry) => entry.material === "weathered_asphalt"));
});

test("CAD-exported joined material words remain recognizable", () => {
  const cases = new Map([
    ["Redtarmac", "red_tarmac"],
    ["resinboundbeige", "resin_bound_beige"],
    ["blockpaving", "paving_stones"],
    ["weatheredconcrete", "old_concrete"],
    ["lightgreytarmac", "light_asphalt"]
  ]);
  for (const [label, expected] of cases) {
    assert.equal(classifyPlanningMaterialText(label)[0]?.material, expected, label);
  }
});

test("material evidence spans adjacent PDF text items on one drawing line", () => {
  const observations = extractPlanningMaterialObservations([
    { text: "Light", xPt: 20, yPt: 100, widthPt: 18, fontSizePt: 9 },
    { text: "grey", xPt: 41, yPt: 100.5, widthPt: 16, fontSizePt: 9 },
    { text: "tarmac", xPt: 60, yPt: 99.7, widthPt: 28, fontSizePt: 9 },
    { text: "path", xPt: 91, yPt: 100, widthPt: 18, fontSizePt: 9 }
  ], 2, "abc");
  const match = observations.find((entry) => entry.material === "light_asphalt");
  assert.ok(match);
  assert.equal(match.pageNumber, 2);
  assert.equal(match.contentHash, "abc");
  assert.equal(match.source, "pdf-text-material-window");
  assert.ok(match.evidenceItems >= 3);
});

test("material windows never join text from separate drawing lines", () => {
  const observations = extractPlanningMaterialObservations([
    { text: "Red", xPt: 20, yPt: 100, widthPt: 18, fontSizePt: 9 },
    { text: "tarmac", xPt: 42, yPt: 80, widthPt: 30, fontSizePt: 9 }
  ], 1, "abc");
  assert.ok(!observations.some((entry) => entry.material === "red_tarmac"));
  assert.ok(observations.some((entry) => entry.material === "weathered_asphalt"));
});

test("structural and roof materials remain typed and cannot masquerade as ground semantics", () => {
  assert.deepEqual(classifyPlanningMaterialText("glass glazing")[0], {
    material: "glass",
    role: "structural",
    confidence: 0.78
  });
  assert.deepEqual(classifyPlanningMaterialText("slate roof tiles")[0], {
    material: "slate_roof",
    role: "roof",
    confidence: 0.82
  });
});

test("text normalization handles unicode dashes and punctuation deterministically", () => {
  assert.equal(normalizeMaterialText("  Resin–bound, BEIGE / surfacing "), "resin-bound beige surfacing");
});
