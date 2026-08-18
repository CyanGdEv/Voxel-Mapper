import test from "node:test";
import assert from "node:assert/strict";
import { createProjector, geometryMapCoordinates } from "../src/lib/geo.mjs";
import { reconcileCompiledPlanningChanges } from "../src/lib/planning-change-reconciliation.mjs";

const projector = createProjector({ lat: 52.99, lon: -1.89 });
const polygon = (x0, z0, x1, z1) => ({
  type: "Polygon",
  coordinates: [[[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]]]
});
const line = (...coordinates) => ({ type: "LineString", coordinates });

function current(entry) {
  return {
    confidence: 0.96,
    ...entry,
    worldGeometryAuthority: true,
    planningTemporal: { state: "current", confidence: 0.99, reason: "test-current" }
  };
}

function feature(id, kind, localGeometry, rank = 100) {
  return {
    id,
    name: id,
    kind,
    subtype: kind,
    tags: {},
    geometry: geometryMapCoordinates(localGeometry, projector.inverse),
    localGeometry,
    vertical: { heightM: null, minHeightM: 0, elevationM: null, explicit: false },
    source: { provider: rank >= 400 ? "Survey" : "OpenStreetMap", elementType: "way", elementId: id },
    verification: { plan: rank >= 400 ? "surveyed" : "public-map", vertical: "unknown" },
    authority: { layer: rank >= 400 ? "verified-override" : "osm", rank, geometryLocked: rank >= 400 }
  };
}

function makeMap(features = []) {
  return { projector, features: [...features] };
}

test("generic ride-layout linework is review-only until semantic enrichment proves track", async () => {
  const map = makeMap([]);
  const options = {
    planningAuthorityEvidenceData: {
      geometryCandidates: [current({
        id: "plan:ride-hyphen",
        classification: "ride-layout",
        semantic: "unclassified-linework",
        localGeometry: line([0, 0], [10, 0], [20, 4])
      })],
      verticalObservations: [],
      materialObservations: []
    }
  };
  const result = await reconcileCompiledPlanningChanges(map, options);
  assert.equal(result.added, 0);
  assert.equal(map.features.length, 0);
  assert.equal(result.changeSet.counts.review, 1);
  assert.match(result.changeSet.changes[0].reason, /not-explicitly-certified-as-track/);
});

test("explicitly enriched ride-track centreline still materializes as ride topology", async () => {
  const map = makeMap([]);
  const options = {
    planningAuthorityEvidenceData: {
      geometryCandidates: [current({
        id: "plan:ride-certified",
        classification: "ride-layout",
        semantic: "ride-track-centerline",
        kind: "ride_track",
        subtype: "ride_track_centerline",
        rideStructureEvidence: {
          role: "track",
          subtype: "ride_track_centerline",
          source: "planning-pdf-ride-structure-semantic-enrichment"
        },
        localGeometry: line([0, 0], [10, 0], [20, 4])
      })],
      verticalObservations: [],
      materialObservations: []
    }
  };
  const result = await reconcileCompiledPlanningChanges(map, options);
  assert.equal(result.added, 1);
  assert.equal(map.features[0].kind, "ride_track");
  assert.equal(result.changeSet.changes[0].featureKind, "ride_track");
});

test("document class landscape becomes paint-only rather than terrain geometry", async () => {
  const map = makeMap([]);
  const options = {
    planningAuthorityEvidenceData: {
      geometryCandidates: [current({
        id: "plan:landscape-hyphen",
        contentHash: "landscape-doc",
        pageNumber: 1,
        classification: "landscape",
        semantic: "unclassified-closed-geometry",
        localGeometry: polygon(0, 0, 12, 12)
      })],
      verticalObservations: [],
      materialObservations: [current({
        contentHash: "landscape-doc",
        pageNumber: 1,
        localX: 6,
        localZ: 6,
        material: "earth",
        confidence: 0.94
      })]
    }
  };
  const result = await reconcileCompiledPlanningChanges(map, options);
  assert.equal(result.paint.applied, 1);
  assert.equal(result.changeSet.counts.paint, 1);
  assert.equal(map.features[0].kind, "surface");
  assert.equal(map.features[0].vertical.elevationM, null);
});

test("planning level labels nearest a path are removed from later authority fusion", async () => {
  const path = feature("osm:path:1", "path", line([0, 0], [20, 0]));
  const map = makeMap([path]);
  const pathLevel = current({
    id: "level:path",
    contentHash: "levels-doc",
    pageNumber: 1,
    localX: 10,
    localZ: 0,
    label: "AOD",
    valueM: 123.4,
    datum: "AOD"
  });
  const options = {
    planningAuthorityEvidenceData: {
      geometryCandidates: [],
      verticalObservations: [pathLevel],
      materialObservations: []
    }
  };
  const result = await reconcileCompiledPlanningChanges(map, options);
  assert.equal(result.authoritySanitization.verticalRejectedGroundTargets, 1);
  assert.equal(options.planningAuthorityEvidenceData.verticalObservations.length, 0);
  assert.equal(path.vertical.elevationM, null);
});

test("planning level labels nearest a building remain available for structural height fusion", async () => {
  const building = feature("osm:building:1", "building", polygon(0, 0, 10, 10));
  const map = makeMap([building]);
  const buildingLevel = current({
    id: "level:building",
    contentHash: "levels-doc",
    pageNumber: 1,
    localX: 5,
    localZ: 5,
    label: "FFL",
    valueM: 101.2,
    datum: "AOD"
  });
  const options = {
    planningAuthorityEvidenceData: {
      geometryCandidates: [],
      verticalObservations: [buildingLevel],
      materialObservations: []
    }
  };
  const result = await reconcileCompiledPlanningChanges(map, options);
  assert.equal(result.authoritySanitization.verticalRetainedStructural, 1);
  assert.equal(options.planningAuthorityEvidenceData.verticalObservations.length, 1);
});

test("ride supports are materialized as real topology features", async () => {
  const map = makeMap([]);
  const options = {
    planningAuthorityEvidenceData: {
      geometryCandidates: [current({
        id: "plan:support",
        classification: "ride-layout",
        semantic: "support-structure",
        label: "Ride support column",
        localGeometry: line([2, 2], [2, 8])
      })],
      verticalObservations: [],
      materialObservations: []
    }
  };
  const result = await reconcileCompiledPlanningChanges(map, options);
  assert.equal(result.added, 1);
  assert.equal(map.features[0].kind, "ride_support");
  assert.equal(result.extendedTopology.added, 1);
});

test("higher-authority surveyed geometry cannot be displaced by planning compilation", async () => {
  const surveyed = feature("surveyed:building", "building", polygon(0, 0, 10, 10), 400);
  const map = makeMap([surveyed]);
  const options = {
    planningAuthorityEvidenceData: {
      geometryCandidates: [current({
        id: "plan:building-protected",
        classification: "site-plan",
        semantic: "building-footprint-or-room",
        localGeometry: polygon(0, 0, 12, 12)
      })],
      verticalObservations: [],
      materialObservations: []
    }
  };
  const result = await reconcileCompiledPlanningChanges(map, options);
  assert.equal(result.added, 0);
  assert.equal(result.replaced, 0);
  assert.equal(result.changeSet.counts.review, 1);
  assert.deepEqual(surveyed.localGeometry, polygon(0, 0, 10, 10));
  assert.match(result.changeSet.changes[0].reason, /higher-authority|protected/);
});
