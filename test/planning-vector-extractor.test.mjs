import test from "node:test";
import assert from "node:assert/strict";
import {
  assessRasterFallback,
  extractDrawingMetadata,
  extractMaterialObservations,
  extractPdfPage,
  extractVectorOperations,
  extractVerticalObservations
} from "../src/lib/planning-vector-extractor.mjs";
import { mergePlanningExtractionManifests } from "../src/lib/planning-extraction-worker.mjs";

const OPS = {
  save: 1,
  restore: 2,
  transform: 3,
  setLineWidth: 4,
  setDash: 5,
  setStrokeRGBColor: 6,
  setFillRGBColor: 7,
  constructPath: 8,
  stroke: 9,
  closeStroke: 10,
  fill: 11,
  eoFill: 12,
  fillStroke: 13,
  eoFillStroke: 14,
  closeFillStroke: 15,
  closeEOFillStroke: 16,
  endPath: 17,
  moveTo: 20,
  lineTo: 21,
  curveTo: 22,
  curveTo2: 23,
  curveTo3: 24,
  closePath: 25,
  rectangle: 26,
  paintImageXObject: 30,
  paintInlineImageXObject: 31,
  paintImageMaskXObject: 32,
  paintSolidColorImageMask: 33
};

test("extractVectorOperations preserves transformed closed planning geometry", () => {
  const result = extractVectorOperations({
    fnArray: [OPS.transform, OPS.setLineWidth, OPS.constructPath, OPS.stroke],
    argsArray: [
      [2, 0, 0, 2, 10, 20],
      [0.5],
      [[OPS.rectangle], [0, 0, 50, 20]],
      []
    ]
  }, OPS);
  assert.equal(result.pathCount, 1);
  assert.equal(result.paths[0].closed, true);
  assert.equal(result.paths[0].paint, "stroke");
  assert.deepEqual(result.paths[0].bounds, { minX: 10, minY: 20, maxX: 110, maxY: 60 });
  assert.equal(result.paths[0].lineWidthPt, 0.5);
});

test("planning text extraction finds drawing scale, vertical levels and materials", () => {
  const metadata = extractDrawingMetadata("Proposed Site Plan Drawing No AT-101 Rev C Scale 1:200");
  assert.equal(metadata.scaleDenominator, 200);
  assert.equal(metadata.scaleAmbiguous, false);
  assert.deepEqual(metadata.scaleCandidates, [200]);
  assert.equal(metadata.revision, "C");
  assert.equal(metadata.drawingNumber, "AT-101");

  const items = [
    { text: "FFL 102.35m AOD", xPt: 12, yPt: 44 },
    { text: "Red tarmac path with timber edging", xPt: 40, yPt: 22 }
  ];
  const vertical = extractVerticalObservations(items, 1, "abc");
  assert.ok(vertical.some((entry) => entry.label === "FFL" && entry.valueM === 102.35));
  const materials = extractMaterialObservations(items, 1, "abc");
  assert.ok(materials.some((entry) => entry.material === "red_tarmac"));
  assert.ok(materials.some((entry) => entry.material === "timber"));
});

test("naked ratio text is not accepted as the sheet drawing scale", () => {
  const metadata = extractDrawingMetadata("Site Plan Drawing No AT-201 detail bubble 1:20");
  assert.equal(metadata.scaleDenominator, null);
  assert.deepEqual(metadata.scaleCandidates, []);
  assert.equal(metadata.drawingNumber, "AT-201");
});

test("multiple explicit scales are marked ambiguous instead of choosing one silently", () => {
  const metadata = extractDrawingMetadata("Site Plan Scale 1:500 Detail Scale 1:20 Drawing No AT-202");
  assert.equal(metadata.scaleDenominator, null);
  assert.equal(metadata.scaleAmbiguous, true);
  assert.deepEqual(metadata.scaleCandidates, [500, 20]);
});

test("extractPdfPage creates non-authoritative geometry candidates and avoids raster fallback for vector plans", async () => {
  const page = {
    rotate: 0,
    getViewport: () => ({ width: 600, height: 400, rotation: 0 }),
    getTextContent: async () => ({
      items: [
        { str: "Proposed Site Plan Scale 1:100", transform: [1, 0, 0, 12, 30, 380], width: 160, height: 12 },
        { str: "FFL 101.250", transform: [1, 0, 0, 10, 100, 150], width: 60, height: 10 },
        { str: "Concrete path", transform: [1, 0, 0, 10, 200, 100], width: 60, height: 10 }
      ]
    }),
    getOperatorList: async () => ({
      fnArray: [OPS.constructPath, OPS.stroke],
      argsArray: [
        [[OPS.rectangle], [50, 50, 200, 100]],
        []
      ]
    })
  };
  const evidence = await extractPdfPage(page, OPS, {
    pageNumber: 1,
    classification: "site_plan",
    contentHash: "abc"
  });
  assert.equal(evidence.geometryCandidates.length, 1);
  assert.equal(evidence.geometryCandidates[0].worldGeometryAuthority, false);
  assert.equal(evidence.geometryCandidates[0].georegistrationRequired, true);
  assert.equal(evidence.metadata.scaleDenominator, 100);
  assert.equal(evidence.rasterFallback.required, false);
  assert.ok(evidence.verticalObservations.some((entry) => entry.valueM === 101.25));
  assert.ok(evidence.materialObservations.some((entry) => entry.material === "concrete"));
});

test("image-dominant drawing pages are routed to raster fallback", () => {
  assert.deepEqual(assessRasterFallback({
    classification: "elevation",
    textCharacters: 0,
    vectorPaths: 0,
    meaningfulVectorPaths: 0,
    imagePaintOps: 3
  }), {
    required: true,
    reason: "image-dominant-page-with-insufficient-vector-evidence"
  });
});

test("merged extraction manifests deduplicate document evidence by content hash", () => {
  const extraction = {
    contentHash: "same",
    normalizedEvidence: {
      geometryCandidates: [{ id: "g1" }],
      verticalObservations: [{ valueM: 100 }],
      materialObservations: [{ material: "brick" }],
      drawingMetadata: [{ scaleDenominator: 200 }]
    },
    rasterFallbackQueue: []
  };
  const merged = mergePlanningExtractionManifests([
    { results: [{ extraction }], failures: [], rasterFallbackQueue: [] },
    { results: [{ extraction }], failures: [], rasterFallbackQueue: [] }
  ]);
  assert.equal(merged.documentCount, 1);
  assert.equal(merged.geometryCandidateCount, 1);
  assert.equal(merged.worldGeometryReady, false);
});