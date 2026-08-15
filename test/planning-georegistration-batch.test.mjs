import test from "node:test";
import assert from "node:assert/strict";
import { georegisterPlanningEvidenceBatch, splitPlanningEvidenceByPage } from "../src/lib/planning-georegistration-batch.mjs";

function candidate(contentHash, pageNumber, id) {
  return {
    id, contentHash, pageNumber, semantic: "building-footprint-or-room", closed: true,
    coordinateSpace: "pdf-user-space-points", georegistrationRequired: true,
    commands: [
      { op: "M", x: 0, y: 0 }, { op: "L", x: 100, y: 0 },
      { op: "L", x: 100, y: 50 }, { op: "L", x: 0, y: 50 }, { op: "Z" }
    ]
  };
}

function target([x, y], tx, tz) { return [x * 0.04 + tx, y * 0.04 + tz]; }

test("merged planning evidence is split by document and page coordinate system", () => {
  const extraction = {
    normalizedEvidence: {
      geometryCandidates: [candidate("aaa", 1, "a1"), candidate("bbb", 1, "b1"), candidate("aaa", 2, "a2")],
      verticalObservations: [], materialObservations: [], drawingMetadata: []
    }
  };
  const groups = splitPlanningEvidenceByPage(extraction);
  assert.deepEqual(groups.map((group) => group.key), ["aaa:p1", "aaa:p2", "bbb:p1"]);
  assert.equal(groups.every((group) => group.extraction.normalizedEvidence.geometryCandidates.length === 1), true);
});

test("page-scoped control points produce independent transforms for separate drawings", () => {
  const extraction = {
    normalizedEvidence: {
      geometryCandidates: [candidate("aaa", 1, "a1"), candidate("bbb", 1, "b1")],
      verticalObservations: [], materialObservations: [], drawingMetadata: []
    }
  };
  const source = [[0, 0], [100, 0], [100, 50], [0, 50]];
  const controls = [
    ...source.map((point) => ({ contentHash: "aaa", pageNumber: 1, source: point, target: target(point, 10, 20) })),
    ...source.map((point) => ({ contentHash: "bbb", pageNumber: 1, source: point, target: target(point, 500, -300) }))
  ];
  const result = georegisterPlanningEvidenceBatch(extraction, [], {
    disableAutomaticControlPoints: true,
    controlPoints: controls,
    minInliers: 4,
    maxRmseM: 0.01,
    maxResidualM: 0.01
  });
  assert.equal(result.status, "registered");
  assert.equal(result.registeredGroupCount, 2);
  const first = result.registrations.find((entry) => entry.contentHash === "aaa");
  const second = result.registrations.find((entry) => entry.contentHash === "bbb");
  assert.ok(Math.abs(first.solution.transform.tx - 10) < 1e-9);
  assert.ok(Math.abs(first.solution.transform.ty - 20) < 1e-9);
  assert.ok(Math.abs(second.solution.transform.tx - 500) < 1e-9);
  assert.ok(Math.abs(second.solution.transform.ty + 300) < 1e-9);
});

test("unscoped control points are ignored for multi-page evidence rather than contaminating every page", () => {
  const extraction = {
    normalizedEvidence: {
      geometryCandidates: [candidate("aaa", 1, "a1"), candidate("bbb", 1, "b1")],
      verticalObservations: [], materialObservations: [], drawingMetadata: []
    }
  };
  const result = georegisterPlanningEvidenceBatch(extraction, [], {
    disableAutomaticControlPoints: true,
    controlPoints: [
      { source: [0, 0], target: [10, 20] },
      { source: [100, 0], target: [14, 20] },
      { source: [0, 50], target: [10, 22] }
    ]
  });
  assert.equal(result.status, "unregistered");
  assert.equal(result.registeredGroupCount, 0);
  assert.ok(result.warnings.some((warning) => warning.includes("Unscoped explicit control points")));
});
