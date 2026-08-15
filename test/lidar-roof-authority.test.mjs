import assert from "node:assert/strict";
import test from "node:test";
import { applyLidarBuildingHeights } from "../src/lib/osm.mjs";

function building(id, heightM, heightSource, authority = "planning") {
  return {
    id,
    kind: "building",
    tags: {},
    localGeometry: {
      type: "Polygon",
      coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]
    },
    vertical: { heightM, heightSource, minHeightM: 0, elevationM: null, explicit: heightM !== null },
    verification: { plan: authority === "planning" ? "planning-authoritative" : "public-map", vertical: heightM !== null ? "planning-drawing" : "unknown" },
    authority: { layer: authority, rank: authority === "planning" ? 300 : 100, geometryLocked: authority === "planning" }
  };
}

test("LiDAR roof evidence attaches to a planning-height building without replacing declared height", () => {
  const feature = building("planning:b1", 6, "planning-drawing");
  const elevation = {
    provider: "Test DSM",
    sourceKind: "ea-lidar",
    resolutionM: 1,
    survey: { newestSurveyDate: "2025-06-01" },
    samplePairLocal: () => ({ terrain: 100, surface: 110 })
  };

  const stats = applyLidarBuildingHeights([feature], elevation);
  assert.equal(feature.vertical.heightM, 6, "planning-declared height remains authoritative");
  assert.equal(feature.vertical.heightSource, "planning-drawing");
  assert.equal(feature.vertical.lidarComparison.measuredHeightM, 10);
  assert.equal(feature.roof.source, "lidar-dsm-surface");
  assert.equal(feature.roof.heightM, 10);
  assert.equal(feature.roof.resolutionM, 1);
  assert.equal(stats.roofProfiles, 1);
  assert.equal(stats.preservedTagged, 1);
});
