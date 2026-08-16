import test from "node:test";
import assert from "node:assert/strict";
import { createProjector, geometryMapCoordinates } from "../src/lib/geo.mjs";
import {
  buildOsmPlanningSearchIndex,
  rankPlanningApplicationsByOsm,
  reconcilePlanningTopology
} from "../src/lib/osm-planning-reconciliation.mjs";

const projector = createProjector({ lat: 52.99, lon: -1.89 });
const polygon = (x0, z0, x1, z1) => ({
  type: "Polygon",
  coordinates: [[[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]]]
});
const line = (...coordinates) => ({ type: "LineString", coordinates });

function osmFeature(id, kind, localGeometry, authorityRank = 100) {
  return {
    id,
    name: id,
    kind,
    subtype: kind,
    tags: {},
    geometry: geometryMapCoordinates(localGeometry, projector.inverse),
    localGeometry,
    vertical: { heightM: null, elevationM: null, explicit: false },
    source: { provider: authorityRank >= 400 ? "User verified override" : "OpenStreetMap", elementType: "way", elementId: id.split(":").at(-1) },
    verification: { plan: authorityRank >= 400 ? "surveyed" : "public-map", vertical: "unknown" },
    authority: { layer: authorityRank >= 400 ? "verified-override" : "osm", rank: authorityRank, geometryLocked: authorityRank >= 400 }
  };
}

function current(entry) {
  return {
    ...entry,
    worldGeometryAuthority: true,
    planningTemporal: { state: "current", confidence: 0.99, reason: "test-current" }
  };
}

test("OSM park, ride and area names rank relevant planning applications first", () => {
  const osm = {
    elements: [
      { type: "relation", id: 1, tags: { tourism: "theme_park", name: "Fixture Park", "addr:postcode": "ST10 1AA" } },
      { type: "way", id: 2, tags: { roller_coaster: "track", name: "Sky Serpent" } },
      { type: "relation", id: 3, tags: { leisure: "park", name: "Dragon Valley", type: "multipolygon" } }
    ]
  };
  const index = buildOsmPlanningSearchIndex(osm);
  assert.deepEqual(index.searchTerms, ["Fixture Park", "ST10 1AA", "Sky Serpent", "Dragon Valley"]);
  assert.equal(index.byRole.ride, 1);
  assert.equal(index.byRole.area, 1);

  const ranked = rankPlanningApplicationsByOsm([
    { reference: "OTHER/1", description: "Warehouse extension outside the resort" },
    { reference: "RIDE/2", description: "Replacement track and station works for Sky Serpent within Dragon Valley" },
    { reference: "PARK/3", address: "Fixture Park, ST10 1AA", description: "Guest route changes" }
  ], index);

  assert.equal(ranked[0].reference, "PARK/3");
  assert.ok(ranked.find((entry) => entry.reference === "RIDE/2").osmRelevance.score > 0.8);
  assert.equal(ranked.at(-1).reference, "OTHER/1");
});

test("current planning topology can add missing rides, replace OSM geometry and tombstone demolished features", async () => {
  const oldRide = osmFeature("osm:way:10", "ride_track", line([0, 0], [10, 0]));
  const demolishedBuilding = osmFeature("osm:way:20", "building", polygon(20, 20, 28, 28));
  const protectedOverride = osmFeature("override:survey:30", "building", polygon(40, 40, 48, 48), 400);
  const map = {
    projector,
    features: [oldRide, demolishedBuilding, protectedOverride],
    geojson: { type: "FeatureCollection", name: "Fixture", features: [] }
  };

  const authority = {
    geometryCandidates: [
      current({
        id: "replace-ride",
        operation: "replace",
        targetFeatureId: "osm:way:10",
        classification: "ride_layout",
        semantic: "ride-centerline-or-edge",
        localGeometry: line([0, 0], [12, 2])
      }),
      current({
        id: "new-ride-gap",
        classification: "ride_layout",
        semantic: "ride-centerline-or-edge",
        localGeometry: line([100, 100], [115, 105])
      }),
      {
        id: "demolished-building",
        targetFeatureId: "osm:way:20",
        classification: "demolition_plan",
        semantic: "demolition-footprint",
        localGeometry: polygon(20, 20, 28, 28),
        worldGeometryAuthority: false,
        planningTemporal: { state: "demolished", confidence: 0.97, reason: "explicit-demolition-status" }
      },
      current({
        id: "cannot-delete-survey",
        operation: "delete",
        targetFeatureId: "override:survey:30",
        classification: "site_plan",
        semantic: "site-feature-or-building-footprint",
        localGeometry: polygon(40, 40, 48, 48)
      })
    ]
  };

  const summary = await reconcilePlanningTopology(map, { planningAuthorityEvidenceData: authority });
  assert.equal(summary.status, "applied");
  assert.equal(summary.replaced, 1);
  assert.equal(summary.added, 1);
  assert.equal(summary.deleted, 1);
  assert.equal(oldRide.localGeometry.coordinates[1][0], 12);
  assert.equal(map.features.some((feature) => feature.id === "osm:way:20"), false);
  assert.equal(map.features.some((feature) => feature.id === "override:survey:30"), true);
  const added = map.features.find((feature) => feature.id.startsWith("planning-current:"));
  assert.equal(added.kind, "ride_track");
  assert.equal(added.authority.rank, 360);
  assert.equal(summary.tombstones[0].featureId, "osm:way:20");
  assert.ok(summary.changes.some((change) => change.reason === "delete-target-higher-authority"));
});

test("approved/proposed planning cannot add or explicitly delete world features", async () => {
  const existing = osmFeature("osm:way:99", "building", polygon(0, 0, 8, 8));
  const map = {
    projector,
    features: [existing],
    geojson: { type: "FeatureCollection", name: "Fixture", features: [] }
  };
  const proposedTemporal = { state: "proposed", confidence: 0.95, reason: "approval-does-not-prove-construction" };
  const summary = await reconcilePlanningTopology(map, {
    planningAuthorityEvidenceData: {
      geometryCandidates: [
        {
          id: "proposal-only-add",
          classification: "ride_layout",
          semantic: "ride-centerline-or-edge",
          localGeometry: line([20, 20], [30, 20]),
          worldGeometryAuthority: false,
          planningTemporal: proposedTemporal
        },
        {
          id: "proposal-only-delete",
          operation: "delete",
          targetFeatureId: "osm:way:99",
          classification: "site_plan",
          semantic: "site-feature-or-building-footprint",
          localGeometry: polygon(0, 0, 8, 8),
          worldGeometryAuthority: false,
          planningTemporal: proposedTemporal
        }
      ]
    }
  });
  assert.equal(summary.added, 0);
  assert.equal(summary.deleted, 0);
  assert.equal(map.features.length, 1);
  assert.equal(map.features[0].id, "osm:way:99");
  assert.ok(summary.changes.some((change) => change.reason === "delete-not-current-authority"));
});
