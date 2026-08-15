import test from "node:test";
import assert from "node:assert/strict";
import { createProjector, geometryMapCoordinates } from "../src/lib/geo.mjs";
import { integratePlanningAuthorityEvidence } from "../src/lib/planning-authority-fusion.mjs";

const projector = createProjector({ lat: 52.99, lon: -1.89 });
const localGeometry = {
  type: "Polygon",
  coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]
};

function building() {
  return {
    id: "osm:building:fail-closed",
    name: "Existing building",
    kind: "building",
    subtype: "yes",
    tags: {},
    geometry: geometryMapCoordinates(localGeometry, projector.inverse),
    localGeometry,
    vertical: { heightM: null, elevationM: null, explicit: false },
    source: { provider: "OpenStreetMap" },
    verification: { plan: "public-map", vertical: "unknown" },
    authority: { layer: "osm", rank: 100, geometryLocked: false }
  };
}

test("worldGeometryAuthority without explicit current temporal state is rejected", async () => {
  const feature = building();
  const map = { projector, features: [feature] };
  const result = await integratePlanningAuthorityEvidence(map, {
    planningAuthorityEvidenceData: {
      geometryCandidates: [{
        id: "unsafe-missing-temporal-state",
        contentHash: "doc",
        pageNumber: 1,
        semantic: "building-footprint-or-room",
        confidence: 0.99,
        localGeometry,
        worldGeometryAuthority: true
      }],
      verticalObservations: [],
      materialObservations: []
    }
  });

  assert.equal(result.input.geometryCandidates, 0);
  assert.equal(result.status, "no-accepted-authority-evidence");
  assert.equal(feature.planningAuthorityCandidates, undefined);
});

test("explicit current state plus world authority remains eligible", async () => {
  const feature = building();
  const map = { projector, features: [feature] };
  const result = await integratePlanningAuthorityEvidence(map, {
    planningAuthorityEvidenceData: {
      geometryCandidates: [{
        id: "safe-current",
        contentHash: "doc",
        pageNumber: 1,
        semantic: "building-footprint-or-room",
        confidence: 0.99,
        localGeometry,
        worldGeometryAuthority: true,
        planningTemporal: { state: "current", confidence: 0.99 }
      }],
      verticalObservations: [],
      materialObservations: []
    }
  });

  assert.equal(result.input.geometryCandidates, 1);
  assert.equal(result.accepted.geometry, 1);
});
