import test from "node:test";
import assert from "node:assert/strict";
import { createProjector, geometryMapCoordinates } from "../src/lib/geo.mjs";
import { compilePlanningChangeSet } from "../src/lib/planning-changeset-compiler.mjs";

const projector = createProjector({ lat: 52.99, lon: -1.89 });
const polygon = (x0, z0, x1, z1) => ({
  type: "Polygon",
  coordinates: [[[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]]]
});

function feature(id, geometry) {
  return {
    id,
    name: id,
    kind: "building",
    subtype: "building",
    tags: {},
    geometry: geometryMapCoordinates(geometry, projector.inverse),
    localGeometry: geometry,
    source: { provider: "OpenStreetMap", elementType: "way", elementId: id },
    authority: { layer: "osm", rank: 100, geometryLocked: false },
    verification: { plan: "public-map", vertical: "unknown" },
    vertical: { heightM: null, elevationM: null, explicit: false }
  };
}

function current(id, geometry, targetFeatureId, confidence = 0.95) {
  return {
    id,
    classification: "site_plan",
    semantic: "building-footprint-or-room",
    confidence,
    localGeometry: geometry,
    worldGeometryAuthority: true,
    planningTemporal: {
      state: "current",
      confidence: 0.99,
      implementationCorroboration: {
        featureId: targetFeatureId,
        featureKind: "building",
        matchScore: 0.9
      }
    }
  };
}

test("different planning fragments targeting the same feature are deferred instead of sequentially overwriting it", () => {
  const target = feature("osm:building:1", polygon(0, 0, 10, 10));
  const evidence = {
    geometryCandidates: [
      current("plan:fragment:a", polygon(0, 0, 12, 12), target.id),
      current("plan:fragment:b", polygon(0, 0, 14, 8), target.id)
    ],
    materialObservations: []
  };
  const result = compilePlanningChangeSet({ projector, features: [target] }, evidence);
  assert.equal(result.counts.replace, 0);
  assert.equal(result.counts.review, 2);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.targetCollisions.conflictingTargetsDeferred, 1);
  assert.equal(result.targetCollisions.conflictingCandidatesDeferred, 2);
  assert.ok(result.changes.every((change) => change.reason === "multiple-current-planning-fragments-same-target-require-consolidation"));
});

test("identical replacement evidence is collapsed to one deterministic candidate", () => {
  const target = feature("osm:building:2", polygon(0, 0, 10, 10));
  const replacement = polygon(0, 0, 12, 12);
  const evidence = {
    geometryCandidates: [
      current("plan:duplicate:lower", replacement, target.id, 0.90),
      current("plan:duplicate:higher", replacement, target.id, 0.98)
    ],
    materialObservations: []
  };
  const result = compilePlanningChangeSet({ projector, features: [target] }, evidence);
  assert.equal(result.counts.replace, 1);
  assert.equal(result.counts.ignored, 1);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].id, "plan:duplicate:higher");
  assert.equal(result.targetCollisions.duplicateCandidatesCollapsed, 1);
  const ignored = result.changes.find((change) => change.operation === "ignored");
  assert.equal(ignored.reason, "duplicate-current-planning-replacement");
});
