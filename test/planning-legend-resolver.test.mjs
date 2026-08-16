import test from "node:test";
import assert from "node:assert/strict";

import {
  fillStyleKey,
  hatchStrokeStyleKey,
  normalizeLegendCode,
  resolvePlanningLegend
} from "../src/lib/planning-legend-resolver.mjs";
import { enrichPlanningLegendEvidence } from "../src/lib/planning-legend-enrichment.mjs";
import { compactPlanningExtraction, mergePlanningExtractionManifests } from "../src/lib/planning-extraction-worker.mjs";

function material(materialName, xPt, yPt, evidenceItemIndices, extra = {}) {
  return {
    contentHash: "doc",
    pageNumber: 1,
    xPt,
    yPt,
    material: materialName,
    role: "surface",
    raw: materialName.replaceAll("_", " "),
    confidence: 0.92,
    evidenceItemIndices,
    source: "pdf-text-material-label",
    georegistrationRequired: true,
    ...extra
  };
}

function rect(minX, minY, maxX, maxY, fillColor = null, extra = {}) {
  return {
    closed: true,
    paint: fillColor ? "fill-stroke" : "stroke",
    fillColor,
    strokeColor: extra.strokeColor || [0, 0, 0],
    lineWidthPt: extra.lineWidthPt ?? 0.5,
    dash: extra.dash || [],
    pointCount: 5,
    bounds: { minX, minY, maxX, maxY },
    commands: [
      { op: "M", x: minX, y: minY },
      { op: "L", x: maxX, y: minY },
      { op: "L", x: maxX, y: maxY },
      { op: "L", x: minX, y: maxY },
      { op: "Z" }
    ]
  };
}

function line(x1, y1, x2, y2, extra = {}) {
  return {
    closed: false,
    paint: "stroke",
    fillColor: null,
    strokeColor: extra.strokeColor || [24, 24, 24],
    lineWidthPt: extra.lineWidthPt ?? 0.4,
    dash: extra.dash || [],
    pointCount: 2,
    bounds: { minX: Math.min(x1, x2), minY: Math.min(y1, y2), maxX: Math.max(x1, x2), maxY: Math.max(y1, y2) },
    commands: [{ op: "M", x: x1, y: y1 }, { op: "L", x: x2, y: y2 }]
  };
}

function candidate(vectorPathIndex, boundsPt) {
  return {
    id: `doc:p1:v${vectorPathIndex}`,
    contentHash: "doc",
    pageNumber: 1,
    vectorPathIndex,
    classification: "landscape_plan",
    semantic: "landscape-area-or-path",
    closed: true,
    boundsPt,
    confidence: 0.48,
    georegistrationRequired: true,
    worldGeometryAuthority: false
  };
}

test("legend codes propagate canonical surface material to matching drawing labels", () => {
  const textItems = [
    { text: "P1", xPt: 20, yPt: 100, widthPt: 14, fontSizePt: 9 },
    { text: "Red tarmac", xPt: 60, yPt: 100, widthPt: 54, fontSizePt: 9 },
    { text: "P1", xPt: 250, yPt: 250, widthPt: 14, fontSizePt: 9 }
  ];
  const result = resolvePlanningLegend({
    pageNumber: 1,
    contentHash: "doc",
    textItems,
    vectorPaths: [],
    geometryCandidates: [],
    materialObservations: [material("red_tarmac", 60, 100, [1])]
  });

  assert.equal(result.status, "resolved");
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].code, "P1");
  assert.equal(result.entries[0].codeAccepted, true);
  const inferred = result.materialObservations.filter((entry) => entry.source === "pdf-legend-code-material");
  assert.equal(inferred.length, 1);
  assert.equal(inferred[0].material, "red_tarmac");
  assert.equal(inferred[0].xPt, 250);
  assert.equal(inferred[0].legendEvidence.evidenceMethod, "legend-code");
});

test("solid legend swatches propagate material only to matching closed geometry", () => {
  const swatch = rect(20, 90, 42, 110, [196, 44, 36]);
  const target = rect(200, 200, 320, 300, [196, 44, 36]);
  const other = rect(360, 200, 460, 300, [120, 120, 120]);
  const paths = [swatch, target, other];
  const result = resolvePlanningLegend({
    pageNumber: 1,
    contentHash: "doc",
    textItems: [{ text: "Red tarmac", xPt: 62, yPt: 100, widthPt: 55, fontSizePt: 9 }],
    vectorPaths: paths,
    geometryCandidates: [candidate(1, target.bounds), candidate(2, other.bounds)],
    materialObservations: [material("red_tarmac", 62, 100, [0])]
  });

  assert.ok(fillStyleKey(swatch));
  assert.equal(result.entries[0].fillAccepted, true);
  const inferred = result.materialObservations.filter((entry) => entry.source === "pdf-legend-fill-material");
  assert.equal(inferred.length, 1);
  assert.equal(inferred[0].material, "red_tarmac");
  assert.deepEqual([inferred[0].xPt, inferred[0].yPt], [260, 250]);
  assert.equal(inferred[0].legendEvidence.vectorPathIndex, 1);
});

test("repeated hatch signatures propagate material into a matching surface polygon", () => {
  const swatch = rect(20, 88, 50, 112, null);
  const swatchHatch = [
    line(23, 90, 38, 105),
    line(29, 90, 44, 105),
    line(35, 90, 48, 103)
  ];
  const target = rect(200, 200, 320, 320, null);
  const targetHatch = [
    line(210, 215, 250, 255),
    line(225, 215, 265, 255),
    line(240, 215, 280, 255),
    line(255, 215, 295, 255)
  ];
  const paths = [swatch, ...swatchHatch, target, ...targetHatch];
  const targetIndex = 1 + swatchHatch.length;
  const result = resolvePlanningLegend({
    pageNumber: 1,
    contentHash: "doc",
    textItems: [{ text: "Resin-bound beige", xPt: 70, yPt: 100, widthPt: 90, fontSizePt: 9 }],
    vectorPaths: paths,
    geometryCandidates: [candidate(targetIndex, target.bounds)],
    materialObservations: [material("resin_bound_beige", 70, 100, [0])]
  });

  assert.ok(hatchStrokeStyleKey(swatchHatch[0]));
  assert.equal(result.entries[0].hatchAccepted, true);
  const inferred = result.materialObservations.filter((entry) => entry.source === "pdf-legend-hatch-material");
  assert.equal(inferred.length, 1);
  assert.equal(inferred[0].material, "resin_bound_beige");
  assert.ok(inferred[0].legendEvidence.hatchStrokeCount >= 3);
});

test("conflicting legend codes fail closed instead of choosing a material", () => {
  const textItems = [
    { text: "P1", xPt: 20, yPt: 120, widthPt: 14, fontSizePt: 9 },
    { text: "Red tarmac", xPt: 60, yPt: 120, widthPt: 54, fontSizePt: 9 },
    { text: "P1", xPt: 20, yPt: 90, widthPt: 14, fontSizePt: 9 },
    { text: "Gravel", xPt: 60, yPt: 90, widthPt: 38, fontSizePt: 9 },
    { text: "P1", xPt: 260, yPt: 260, widthPt: 14, fontSizePt: 9 }
  ];
  const result = resolvePlanningLegend({
    pageNumber: 1,
    contentHash: "doc",
    textItems,
    vectorPaths: [],
    geometryCandidates: [],
    materialObservations: [
      material("red_tarmac", 60, 120, [1]),
      material("gravel", 60, 90, [3])
    ]
  });

  assert.equal(result.counts.conflicts, 1);
  assert.ok(result.entries.every((entry) => entry.codeAccepted === false));
  assert.equal(result.materialObservations.length, 0);
});

test("non-ground legend entries are retained for QA but never propagated as terrain paint evidence", () => {
  const result = resolvePlanningLegend({
    pageNumber: 1,
    contentHash: "doc",
    textItems: [
      { text: "S1", xPt: 20, yPt: 100, widthPt: 14, fontSizePt: 9 },
      { text: "Steel", xPt: 60, yPt: 100, widthPt: 28, fontSizePt: 9 },
      { text: "S1", xPt: 250, yPt: 250, widthPt: 14, fontSizePt: 9 }
    ],
    vectorPaths: [],
    geometryCandidates: [],
    materialObservations: [material("steel", 60, 100, [1], { role: "structural", confidence: 0.78 })]
  });

  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].propagationEligible, false);
  assert.equal(result.counts.acceptedEntries, 0);
  assert.equal(result.materialObservations.length, 0);
  assert.equal(result.terrainPolicy.geometryMutable, false);
  assert.equal(result.terrainPolicy.elevationMutable, false);
});

test("legend code normalization is deterministic and rejects non-key prose", () => {
  assert.equal(normalizeLegendCode("P-01"), "P01");
  assert.equal(normalizeLegendCode(" h 12a "), "H12A");
  assert.equal(normalizeLegendCode("Scale 1:200"), null);
  assert.equal(normalizeLegendCode("PATH"), null);
});

test("production legend enrichment is idempotent and survives compact/merge manifests", () => {
  const extraction = {
    schemaVersion: 1,
    contentHash: "doc",
    objectPath: "doc.pdf",
    contentType: "application/pdf",
    classification: "landscape_plan",
    status: "extracted",
    method: "pdfjs-vector-first",
    pageCount: 1,
    vectorPageCount: 0,
    textPageCount: 1,
    rasterFallbackPageCount: 0,
    rasterFallbackQueue: [],
    pages: [{
      pageNumber: 1,
      widthPt: 600,
      heightPt: 400,
      rotation: 0,
      text: {
        itemCount: 3,
        characterCount: 15,
        truncated: false,
        items: [
          { text: "P1", xPt: 20, yPt: 100, widthPt: 14, fontSizePt: 9 },
          { text: "Red tarmac", xPt: 60, yPt: 100, widthPt: 54, fontSizePt: 9 },
          { text: "P1", xPt: 250, yPt: 250, widthPt: 14, fontSizePt: 9 }
        ]
      },
      vector: { pathCount: 0, imagePaintOps: 0, truncated: false, paths: [] },
      geometryCandidates: [],
      verticalObservations: [],
      materialObservations: [material("red_tarmac", 60, 100, [1])],
      metadata: null,
      rasterFallback: { required: false, reason: null }
    }],
    normalizedEvidence: {
      schemaVersion: 1,
      coordinateSpace: "pdf-user-space-points",
      georegistrationStatus: "required",
      worldGeometryReady: false,
      geometryCandidates: [],
      verticalObservations: [],
      materialObservations: [material("red_tarmac", 60, 100, [1])],
      drawingMetadata: []
    }
  };

  enrichPlanningLegendEvidence(extraction);
  const once = extraction.normalizedEvidence.materialObservations.length;
  enrichPlanningLegendEvidence(extraction);
  const twice = extraction.normalizedEvidence.materialObservations.length;
  assert.equal(once, twice);
  assert.equal(extraction.normalizedEvidence.legendEntries.length, 1);
  assert.ok(extraction.normalizedEvidence.materialObservations.some((entry) => entry.source === "pdf-legend-code-material"));

  const compact = compactPlanningExtraction(extraction);
  assert.equal(compact.pages[0].legend.status, "resolved");
  const merged = mergePlanningExtractionManifests([{ results: [{ extraction: compact }], failures: [], rasterFallbackQueue: [] }]);
  assert.equal(merged.legendEntryCount, 1);
  assert.equal(merged.normalizedEvidence.legendEntries.length, 1);
  assert.ok(merged.normalizedEvidence.materialObservations.some((entry) => entry.source === "pdf-legend-code-material"));
});
