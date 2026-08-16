import test from "node:test";
import assert from "node:assert/strict";
import { normalizePlanningPdfOperatorListColours } from "../src/lib/planning-pdf-colour-normalizer.mjs";

const OPS = {
  setStrokeColor: 1,
  setFillColor: 2,
  setStrokeGray: 3,
  setFillGray: 4,
  setStrokeRGBColor: 5,
  setFillRGBColor: 6,
  setStrokeCMYKColor: 7,
  setFillCMYKColor: 8
};

test("specialized PDF colour operators update state for following generic SC/sc operators", () => {
  const result = normalizePlanningPdfOperatorListColours({
    fnArray: [
      OPS.setStrokeGray,
      OPS.setStrokeColor,
      OPS.setFillCMYKColor,
      OPS.setFillColor
    ],
    argsArray: [
      [0.75],
      [0.25],
      [0, 1, 0, 0],
      [1, 0, 0, 0]
    ]
  }, OPS);

  assert.equal(result.fnArray[0], OPS.setStrokeRGBColor);
  assert.equal(result.fnArray[1], OPS.setStrokeRGBColor);
  assert.deepEqual(result.argsArray[1], [64, 64, 64]);
  assert.equal(result.fnArray[2], OPS.setFillRGBColor);
  assert.equal(result.fnArray[3], OPS.setFillRGBColor);
  assert.deepEqual(result.argsArray[3], [0, 255, 255]);
  assert.equal(result.planningColourNormalization.genericDeviceToRgb, 2);
});
