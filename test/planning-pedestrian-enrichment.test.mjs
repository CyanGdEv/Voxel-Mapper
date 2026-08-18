import test from "node:test";
import assert from "node:assert/strict";
import { enrichPlanningPedestrianEvidence } from "../src/lib/planning-pedestrian-enrichment.mjs";
import { compilePlanningChangeSet } from "../src/lib/planning-changeset-compiler.mjs";

function candidate({ classification = "site_plan", closed = true, semantic = null } = {}) {
  return {
    id: "plan:p1:v0",
    contentHash: "plan",
    pageNumber: 1,
    vectorPathIndex: 0,
    classification,
    semantic: semantic || (closed ? "site-feature-or-building-footprint" : "site-edge-or-route"),
    closed,
    boundsPt: { minX: 100, minY: 100, maxX: 200, maxY: 180 },
    confidence: 0.48,
    georegistrationRequired: true,
    worldGeometryAuthority: false
  };
}

function extraction(value, text) {
  return {
    pages: [{ pageNumber: 1, text: { items: [{ text, xPt: 150, yPt: 140 }] } }],
    normalizedEvidence: { geometryCandidates: [value] }
  };
}

const polygon = {
  type: "Polygon",
  coordinates: [[[0, 0], [20, 0], [20, 15], [0, 15], [0, 0]]]
};

test("closed site-plan polygon labelled entrance plaza becomes pedestrian plaza geometry", () => {
  const value = candidate();
  const source = extraction(value, "MAIN ENTRANCE PLAZA - RESIN BOUND PAVING");
  const summary = enrichPlanningPedestrianEvidence(source);
  assert.equal(summary.counts.plaza, 1);
  assert.equal(value.kind, "path");
  assert.equal(value.subtype, "pedestrian_plaza");
  assert.equal(value.pedestrianEvidence.worldGeometryAuthority, false);
  assert.equal(value.pedestrianEvidence.terrainGeometryMutable, false);
});

test("open landscape-plan pedestrian route becomes path topology semantic", () => {
  const value = candidate({ classification: "landscape_plan", closed: false, semantic: "landscape-edge-or-route" });
  const source = extraction(value, "PROPOSED PEDESTRIAN ROUTE");
  const summary = enrichPlanningPedestrianEvidence(source);
  assert.equal(summary.counts.path, 1);
  assert.equal(value.kind, "path");
  assert.equal(value.subtype, "pedestrian_route");
});

test("conflicting vehicular and pedestrian label fails closed", () => {
  const value = candidate({ closed: false });
  const source = extraction(value, "VEHICULAR ACCESS / PEDESTRIAN ROUTE");
  const summary = enrichPlanningPedestrianEvidence(source);
  assert.equal(summary.counts.ambiguous, 1);
  assert.equal(value.kind, undefined);
});

test("ride-layout queue wording is not retyped by generic pedestrian enrichment", () => {
  const value = candidate({ classification: "ride_layout", closed: false, semantic: "ride-centerline-or-edge" });
  const source = extraction(value, "QUEUE PATH");
  const summary = enrichPlanningPedestrianEvidence(source);
  assert.equal(summary.counts.path, 0);
  assert.equal(value.kind, undefined);
});

test("current labelled plaza polygon compiles as real path geometry rather than disappearing into review", () => {
  const value = candidate();
  enrichPlanningPedestrianEvidence(extraction(value, "RIDE ENTRANCE PLAZA"));
  value.localGeometry = polygon;
  value.worldGeometryAuthority = true;
  value.planningTemporal = { state: "current", confidence: 0.99, worldGeometryAuthority: true };
  const result = compilePlanningChangeSet({ features: [] }, {
    geometryCandidates: [value],
    materialObservations: []
  });
  assert.equal(result.counts.add, 1);
  assert.equal(result.candidates[0].kind, "path");
  assert.equal(result.changes[0].featureKind, "path");
});
