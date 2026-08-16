import test from "node:test";
import assert from "node:assert/strict";
import {
  cmykToRgb,
  grayToRgb,
  normalizeDeviceColourSpace,
  normalizePlanningPdfOperatorListColours,
  wrapPlanningPdfJsColourNormalization
} from "../src/lib/planning-pdf-colour-normalizer.mjs";

const OPS = {
  setStrokeColorSpace: 1,
  setFillColorSpace: 2,
  setStrokeColor: 3,
  setStrokeColorN: 4,
  setFillColor: 5,
  setFillColorN: 6,
  setStrokeGray: 7,
  setFillGray: 8,
  setStrokeRGBColor: 9,
  setFillRGBColor: 10,
  setStrokeCMYKColor: 11,
  setFillCMYKColor: 12,
  rectangle: 20,
  fill: 21
};

test("DeviceGray and DeviceCMYK operators become canonical RGB byte operators", () => {
  const result = normalizePlanningPdfOperatorListColours({
    fnArray: [OPS.setStrokeGray, OPS.setFillGray, OPS.setStrokeCMYKColor, OPS.setFillCMYKColor],
    argsArray: [[0.5], [1], [0, 1, 1, 0], [1, 0, 0, 0]]
  }, OPS);

  assert.deepEqual(result.fnArray, [
    OPS.setStrokeRGBColor,
    OPS.setFillRGBColor,
    OPS.setStrokeRGBColor,
    OPS.setFillRGBColor
  ]);
  assert.deepEqual(result.argsArray[0], [128, 128, 128]);
  assert.deepEqual(result.argsArray[1], [255, 255, 255]);
  assert.deepEqual(result.argsArray[2], [255, 0, 0]);
  assert.deepEqual(result.argsArray[3], [0, 255, 255]);
  assert.equal(result.planningColourNormalization.grayToRgb, 2);
  assert.equal(result.planningColourNormalization.cmykToRgb, 2);
  assert.equal(result.planningColourNormalization.outputColourSpace, "srgb-8bit");
});

test("generic Device colour-space operators are normalized without changing list order", () => {
  const result = normalizePlanningPdfOperatorListColours({
    fnArray: [
      OPS.setFillColorSpace,
      OPS.setFillColor,
      OPS.setStrokeColorSpace,
      OPS.setStrokeColorN,
      OPS.rectangle,
      OPS.fill
    ],
    argsArray: [
      [{ name: "DeviceCMYK" }],
      [0.2, 0.1, 0, 0.25],
      ["/DeviceGray"],
      [0.2],
      [[0, 0, 10, 10]],
      []
    ]
  }, OPS);

  assert.equal(result.fnArray[1], OPS.setFillRGBColor);
  assert.deepEqual(result.argsArray[1], cmykToRgb([0.2, 0.1, 0, 0.25]));
  assert.equal(result.fnArray[3], OPS.setStrokeRGBColor);
  assert.deepEqual(result.argsArray[3], grayToRgb([0.2]));
  assert.equal(result.fnArray[4], OPS.rectangle);
  assert.equal(result.fnArray[5], OPS.fill);
  assert.equal(result.planningColourNormalization.genericDeviceToRgb, 2);
});

test("Pattern, Separation and unknown colour spaces fail closed instead of inventing RGB", () => {
  const result = normalizePlanningPdfOperatorListColours({
    fnArray: [
      OPS.setFillColorSpace,
      OPS.setFillColorN,
      OPS.setStrokeColorSpace,
      OPS.setStrokeColor
    ],
    argsArray: [
      ["Pattern"],
      [0.4, "P1"],
      [{ name: "Separation" }],
      [0.7]
    ]
  }, OPS);

  assert.equal(result.fnArray[1], OPS.setFillColorN);
  assert.deepEqual(result.argsArray[1], [0.4, "P1"]);
  assert.equal(result.fnArray[3], OPS.setStrokeColor);
  assert.deepEqual(result.argsArray[3], [0.7]);
  assert.equal(result.planningColourNormalization.unsupportedColourOperators, 2);
  assert.equal(result.planningColourNormalization.failClosedForComplexColourSpaces, true);
});

test("already-normalized PDF.js RGB operators stay RGB and canonicalize byte values idempotently", () => {
  const once = normalizePlanningPdfOperatorListColours({
    fnArray: [OPS.setFillRGBColor, OPS.setStrokeRGBColor],
    argsArray: [[0.1, 0.2, 0.3], [64, 128, 255]]
  }, OPS);
  const twice = normalizePlanningPdfOperatorListColours(once, OPS);

  assert.deepEqual(once.argsArray, [[26, 51, 77], [64, 128, 255]]);
  assert.deepEqual(twice.argsArray, once.argsArray);
  assert.deepEqual(twice.fnArray, once.fnArray);
  assert.equal(once.planningColourNormalization.convertedOperators, 0);
});

test("PDF runtime wrapper preserves loading/document/page contracts while normalizing operator lists", async () => {
  let destroyed = false;
  const page = {
    pageNumber: 4,
    getViewport: ({ scale }) => ({ width: 100 * scale, height: 80 * scale }),
    async getOperatorList() {
      return { fnArray: [OPS.setFillCMYKColor], argsArray: [[0, 0, 1, 0]] };
    }
  };
  const document = {
    numPages: 4,
    async getPage(number) {
      assert.equal(number, 4);
      return page;
    },
    async destroy() { destroyed = true; }
  };
  const loadingTask = {
    promise: Promise.resolve(document),
    destroy() { return "task-destroyed"; }
  };
  const engine = wrapPlanningPdfJsColourNormalization({
    OPS,
    version: "fixture",
    getDocument(options) {
      assert.equal(options.disableWorker, true);
      return loadingTask;
    }
  });

  const task = engine.getDocument({ disableWorker: true });
  assert.equal(task.destroy(), "task-destroyed");
  const wrappedDocument = await task.promise;
  assert.equal(wrappedDocument.numPages, 4);
  const wrappedPage = await wrappedDocument.getPage(4);
  assert.deepEqual(wrappedPage.getViewport({ scale: 2 }), { width: 200, height: 160 });
  const operatorList = await wrappedPage.getOperatorList();
  assert.equal(operatorList.fnArray[0], OPS.setFillRGBColor);
  assert.deepEqual(operatorList.argsArray[0], [255, 255, 0]);
  await wrappedDocument.destroy();
  assert.equal(destroyed, true);
});

test("device colour-space aliases normalize deterministically", () => {
  assert.equal(normalizeDeviceColourSpace("/DeviceGray"), "device-gray");
  assert.equal(normalizeDeviceColourSpace({ name: "DeviceRGB" }), "device-rgb");
  assert.equal(normalizeDeviceColourSpace("CMYK"), "device-cmyk");
  assert.equal(normalizeDeviceColourSpace("DeviceN"), null);
});
