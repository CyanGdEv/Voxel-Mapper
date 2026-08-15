import test from "node:test";
import assert from "node:assert/strict";
import { createProjector, geometryMapCoordinates } from "../src/lib/geo.mjs";
import { integratePlanningAuthorityEvidence } from "../src/lib/planning-authority-fusion.mjs";

const projector = createProjector({ lat: 52.99, lon: -1.89 });
const polygon = (x0, z0, x1, z1) => ({
  type: "Polygon",
  coordinates: [[[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]]]
});

function feature(id, kind, localGeometry) {
  return {
    id, kind, subtype: kind, name: id, tags: {},
    localGeometry,
    geometry: geometryMapCoordinates(localGeometry, projector.inverse),
    vertical: { heightM: null, elevationM: null, explicit: false },
    source: { provider: "OpenStreetMap" },
    verification: { plan: "public-map", vertical: "unknown" },
    authority: { layer: "osm", rank: 100, geometryLocked: false }
  };
}

function current(entry) {
  return {
    ...entry,
    worldGeometryAuthority: true,
    planningTemporal: { state: "current", confidence: 0.99 }
  };
}

test("floor-plan and roof-plan vectors cannot replace a building footprint", async () => {
  const building = feature("building", "building", polygon(0, 0, 10, 10));
  const map = { projector, features: [building] };
  const result = await integratePlanningAuthorityEvidence(map, {
    planningAuthorityEvidenceData: {
      geometryCandidates: [
        current({ id: "floor-room", contentHash: "floor", pageNumber: 1, classification: "floor_plan", semantic: "building-footprint-or-room", confidence: 0.99, localGeometry: polygon(1, 1, 9, 9) }),
        current({ id: "roof-plane", contentHash: "roof", pageNumber: 1, classification: "roof_plan", semantic: "roof-plane-or-footprint", confidence: 0.99, localGeometry: polygon(0, 0, 10, 10) })
      ],
      verticalObservations: [], materialObservations: []
    }
  });

  assert.equal(result.accepted.geometry, 0);
  assert.equal(building.planningAuthorityCandidates, undefined);
  assert.equal(result.rejected["geometry-non-materializable-semantic"], 2);
});

test("surface-only material labels do not attach to building walls", async () => {
  const building = feature("building", "building", polygon(0, 0, 10, 10));
  const path = feature("path", "path", { type: "LineString", coordinates: [[12, 0], [12, 10]] });
  const map = { projector, features: [building, path] };
  const result = await integratePlanningAuthorityEvidence(map, {
    planningAuthorityPointToleranceM: 8,
    planningAuthorityEvidenceData: {
      geometryCandidates: [], verticalObservations: [],
      materialObservations: [current({ contentHash: "materials", pageNumber: 1, localX: 9, localZ: 5, material: "red_tarmac", raw: "Red tarmac", confidence: 0.95 })]
    }
  });

  assert.equal(result.accepted.material, 1);
  assert.equal(building.planningAuthorityCandidates, undefined);
  assert.equal(path.planningAuthorityCandidates[0].attribute, "material");
  assert.equal(path.planningAuthorityCandidates[0].role, "surface");
});

test("roof material remains eligible for buildings even though roof geometry is not", async () => {
  const building = feature("building", "building", polygon(0, 0, 10, 10));
  const map = { projector, features: [building] };
  const result = await integratePlanningAuthorityEvidence(map, {
    planningAuthorityEvidenceData: {
      geometryCandidates: [], verticalObservations: [],
      materialObservations: [current({ contentHash: "roof", pageNumber: 1, localX: 5, localZ: 5, material: "slate_roof", raw: "Slate roof", confidence: 0.95 })]
    }
  });

  assert.equal(result.accepted.material, 1);
  assert.equal(building.planningAuthorityCandidates[0].role, "roof");
});
