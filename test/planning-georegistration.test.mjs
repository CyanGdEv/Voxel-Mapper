import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPlanningGeoregistrationPoint,
  discoverAutomaticPlanningControlPoints,
  georegisterPlanningEvidence,
  solvePlanningGeoregistration
} from "../src/lib/planning-georegistration.mjs";

function similarityPoint([x, y], scale = 0.05, rotationDeg = 28, tx = 140, tz = -65) {
  const angle = rotationDeg * Math.PI / 180;
  const a = Math.cos(angle) * scale;
  const b = Math.sin(angle) * scale;
  return [a * x - b * y + tx, b * x + a * y + tz];
}

test("robust planning registration rejects one bad control point and recovers similarity transform", () => {
  const sources = [[0, 0], [100, 0], [100, 80], [0, 80], [50, 40]];
  const controls = sources.map((source) => ({ source, target: similarityPoint(source) }));
  controls.push({ source: [25, 20], target: [900, -900] });
  const solution = solvePlanningGeoregistration(controls, {
    model: "similarity",
    inlierThresholdM: 0.35,
    maxRmseM: 0.15,
    maxResidualM: 0.25,
    minInliers: 4
  });
  assert.equal(solution.pass, true);
  assert.equal(solution.status, "registered");
  assert.equal(solution.inlierCount, 5);
  assert.equal(solution.outlierCount, 1);
  assert.ok(Math.abs(solution.scaleMPerPt - 0.05) < 1e-8);
  assert.ok(Math.abs(solution.rotationDeg - 28) < 1e-8);
  const mapped = applyPlanningGeoregistrationPoint([33, 17], solution);
  const expected = similarityPoint([33, 17]);
  assert.ok(Math.hypot(mapped[0] - expected[0], mapped[1] - expected[1]) < 1e-8);
});

test("drawing scale is a quality gate rather than a decorative metadata value", () => {
  const controls = [[0, 0], [100, 0], [0, 100]].map((source) => ({ source, target: similarityPoint(source, 0.2, 0, 0, 0) }));
  const solution = solvePlanningGeoregistration(controls, {
    scaleDenominator: 100,
    maxScaleRelativeError: 0.2,
    maxRmseM: 0.01,
    maxResidualM: 0.01
  });
  assert.equal(solution.pass, false);
  assert.equal(solution.status, "rejected");
  assert.ok(solution.rejectionReasons.some((reason) => reason.includes("drawing title-block")));
});

test("automatic footprint matching yields control points without granting authority itself", () => {
  const sourceRing = [[10, 20], [110, 20], [110, 70], [10, 70]];
  const targetRing = sourceRing.map((point) => similarityPoint(point, 0.04, -17, 220, 310));
  const extraction = {
    normalizedEvidence: {
      drawingMetadata: [],
      geometryCandidates: [{
        id: "plan:p1:v0",
        pageNumber: 1,
        closed: true,
        semantic: "building-footprint-or-room",
        commands: [
          { op: "M", x: 10, y: 20 },
          { op: "L", x: 110, y: 20 },
          { op: "L", x: 110, y: 70 },
          { op: "L", x: 10, y: 70 },
          { op: "Z" }
        ]
      }]
    }
  };
  const references = [{
    id: "osm:way:123",
    kind: "building",
    localGeometry: { type: "Polygon", coordinates: [[...targetRing, targetRing[0]]] }
  }];
  const discovered = discoverAutomaticPlanningControlPoints(extraction, references, { maxAutoShapeRmseM: 0.2 });
  assert.equal(discovered.matches.length, 1);
  assert.ok(discovered.controlPoints.length >= 3);
  assert.equal(discovered.controlPoints.every((point) => point.method === "automatic-shape-match"), true);
});

test("registered evidence is promoted to local metres but temporal fusion remains mandatory", () => {
  const commands = [
    { op: "M", x: 0, y: 0 },
    { op: "L", x: 100, y: 0 },
    { op: "L", x: 100, y: 50 },
    { op: "L", x: 0, y: 50 },
    { op: "Z" }
  ];
  const extraction = {
    normalizedEvidence: {
      coordinateSpace: "pdf-user-space-points",
      drawingMetadata: [],
      geometryCandidates: [{
        id: "doc:p1:v0", contentHash: "doc", pageNumber: 1,
        semantic: "building-footprint-or-room", closed: true,
        commands, coordinateSpace: "pdf-user-space-points",
        georegistrationRequired: true, worldGeometryAuthority: false
      }],
      verticalObservations: [{ contentHash: "doc", pageNumber: 1, xPt: 50, yPt: 25, label: "FFL", valueM: 12.5 }],
      materialObservations: [{ contentHash: "doc", pageNumber: 1, xPt: 20, yPt: 10, material: "red_tarmac" }]
    }
  };
  const sourceControls = [[0, 0], [100, 0], [100, 50], [0, 50]];
  const result = georegisterPlanningEvidence(extraction, [], {
    disableAutomaticControlPoints: true,
    controlPoints: sourceControls.map((source) => ({ source, target: similarityPoint(source, 0.035, 12, 40, 70) })),
    minInliers: 4,
    maxRmseM: 0.01,
    maxResidualM: 0.01
  });
  assert.equal(result.status, "registered");
  assert.equal(result.registeredEvidence.worldGeometryReady, true);
  assert.equal(result.registeredEvidence.worldGeometryAuthority, false);
  assert.equal(result.registeredEvidence.temporalResolutionRequired, true);
  const candidate = result.registeredEvidence.geometryCandidates[0];
  assert.equal(candidate.coordinateSpace, "local-world-metres");
  assert.equal(candidate.spatialAuthorityEligible, true);
  assert.equal(candidate.worldGeometryAuthority, false);
  assert.equal(candidate.localGeometry.type, "Polygon");
  assert.equal(candidate.localGeometry.coordinates[0].length, 5);
  assert.ok(Number.isFinite(result.registeredEvidence.verticalObservations[0].localX));
  assert.ok(Number.isFinite(result.registeredEvidence.materialObservations[0].localZ));
});

test("failed registration never promotes document-space geometry", () => {
  const extraction = {
    normalizedEvidence: {
      geometryCandidates: [{ id: "x", closed: true, commands: [{ op: "M", x: 0, y: 0 }, { op: "L", x: 10, y: 0 }, { op: "L", x: 10, y: 10 }, { op: "Z" }] }],
      verticalObservations: [], materialObservations: [], drawingMetadata: []
    }
  };
  const result = georegisterPlanningEvidence(extraction, [], {
    disableAutomaticControlPoints: true,
    controlPoints: [{ source: [0, 0], target: [1, 1] }]
  });
  assert.equal(result.status, "unregistered");
  assert.equal(result.registeredEvidence, null);
  assert.equal(result.originalEvidenceRetained, true);
});
