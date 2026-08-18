import test from "node:test";
import assert from "node:assert/strict";
import { enrichPlanningRideStructureEvidence } from "../src/lib/planning-ride-structure-enrichment.mjs";

function vector(x1, y1, x2, y2, overrides = {}) {
  return {
    commands: [{ op: "M", x: x1, y: y1 }, { op: "L", x: x2, y: y2 }],
    closed: false,
    paint: "stroke",
    lineWidthPt: 1,
    strokeColor: [0.1, 0.2, 0.8],
    fillColor: null,
    dash: [],
    pointCount: 2,
    bounds: { minX: Math.min(x1, x2), minY: Math.min(y1, y2), maxX: Math.max(x1, x2), maxY: Math.max(y1, y2) },
    ...overrides
  };
}

function candidate(index, v) {
  return {
    id: `ride-plan:p1:v${index}`,
    contentHash: "ride-plan",
    pageNumber: 1,
    vectorPathIndex: index,
    classification: "ride_layout",
    semantic: "ride-centerline-or-edge",
    closed: false,
    paint: v.paint,
    boundsPt: v.bounds,
    pointCount: v.pointCount,
    commands: v.commands,
    confidence: 0.48,
    coordinateSpace: "pdf-user-space-points",
    georegistrationRequired: true,
    worldGeometryAuthority: false
  };
}

function extraction(vectors, textItems = [{ text: "TRACK CENTRELINE", xPt: 0, yPt: 0 }]) {
  return {
    classification: "ride_layout",
    contentHash: "ride-plan",
    pages: [{
      pageNumber: 1,
      widthPt: 800,
      heightPt: 600,
      text: { items: textItems },
      vector: { paths: vectors, pathCount: vectors.length },
      metadata: {}
    }],
    normalizedEvidence: {
      geometryCandidates: vectors.map((entry, index) => candidate(index, entry)),
      verticalObservations: [],
      materialObservations: [],
      drawingMetadata: [],
      rideStructureTemplates: []
    }
  };
}

test("split same-style ride centreline grows from an explicit labelled seed", () => {
  const vectors = [
    vector(0, 0, 100, 0),
    vector(101, 0, 200, 0),
    vector(201.5, 0, 300, 0)
  ];
  const value = extraction(vectors);
  const summary = enrichPlanningRideStructureEvidence(value, { rideTrackContinuityEndpointTolerancePt: 3 });

  assert.equal(summary.counts.continuityRecoveredTrack, 2);
  assert.equal(summary.counts.rideTrack, 3);
  assert.equal(value.normalizedEvidence.geometryCandidates[0].rideStructureEvidence.source,
    "planning-pdf-ride-structure-semantic-enrichment");
  assert.equal(value.normalizedEvidence.geometryCandidates[1].kind, "ride_track");
  assert.equal(value.normalizedEvidence.geometryCandidates[2].kind, "ride_track");
  assert.equal(value.normalizedEvidence.geometryCandidates[1].rideStructureEvidence.source,
    "planning-pdf-ride-track-style-continuity");
  assert.equal(value.normalizedEvidence.geometryCandidates[1].worldGeometryAuthority, false);
  assert.equal(summary.policy.fragmentedTrackRecoveryGrantsAuthority, false);
});

test("same-style but disconnected ride-layout linework is not swallowed", () => {
  const vectors = [
    vector(0, 0, 100, 0),
    vector(250, 0, 350, 0)
  ];
  const value = extraction(vectors);
  const summary = enrichPlanningRideStructureEvidence(value, { rideTrackContinuityEndpointTolerancePt: 3 });

  assert.equal(summary.counts.continuityRecoveredTrack, 0);
  assert.equal(value.normalizedEvidence.geometryCandidates[1].kind, undefined);
  assert.equal(summary.rideTrackContinuity.rejectedDisconnected, 1);
});

test("connected vector with a different CAD stroke style is not promoted", () => {
  const vectors = [
    vector(0, 0, 100, 0),
    vector(101, 0, 200, 0, { lineWidthPt: 2.5, strokeColor: [0.8, 0.2, 0.1] })
  ];
  const value = extraction(vectors);
  const summary = enrichPlanningRideStructureEvidence(value, { rideTrackContinuityEndpointTolerancePt: 3 });

  assert.equal(summary.counts.continuityRecoveredTrack, 0);
  assert.equal(value.normalizedEvidence.geometryCandidates[1].kind, undefined);
  assert.equal(summary.rideTrackContinuity.rejectedStyleMismatch, 1);
});

test("ride-layout vectors are never continuity-promoted without an explicit track seed", () => {
  const vectors = [vector(0, 0, 100, 0), vector(101, 0, 200, 0)];
  const value = extraction(vectors, []);
  const summary = enrichPlanningRideStructureEvidence(value, { rideTrackContinuityEndpointTolerancePt: 3 });

  assert.equal(summary.rideTrackContinuity.status, "no-explicit-track-seeds");
  assert.equal(summary.counts.continuityRecoveredTrack, 0);
  assert.equal(value.normalizedEvidence.geometryCandidates.some((entry) => entry.kind === "ride_track"), false);
});
