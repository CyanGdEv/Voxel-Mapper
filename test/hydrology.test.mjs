import test from "node:test";
import assert from "node:assert/strict";
import { enrichHydrology, hydrologyRenderFeatures, waterFeatureCells } from "../src/lib/hydrology.mjs";

function water(id, provider, geometry, tags = {}, name = "Lake") {
  return {
    id,
    name,
    kind: "water",
    subtype: tags.water || tags.waterway || "lake",
    tags,
    localGeometry: geometry,
    vertical: { elevationM: null },
    source: { provider },
    verification: { plan: provider === "Survey Water" ? "source-verified" : "public-map" }
  };
}

const lake = {
  type: "Polygon",
  coordinates: [[[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]]]
};

test("independent public water geometry supersedes a matching OSM fallback for rendering", () => {
  const osm = water("osm:way:1", "OpenStreetMap", lake, { water: "lake" });
  const survey = water("public:water:1", "Survey Water", {
    type: "Polygon",
    coordinates: [[[0.2, 0.2], [10.2, 0.2], [10.2, 8.2], [0.2, 8.2], [0.2, 0.2]]]
  }, { water: "lake" });
  const map = { features: [osm, survey] };
  const summary = enrichHydrology(map, {});
  assert.equal(summary.suppressedOsmFeatures, 1);
  assert.equal(osm.hydrology.suppressForRendering, true);
  assert.deepEqual(hydrologyRenderFeatures(map).map((feature) => feature.id), ["public:water:1"]);
});

test("LiDAR constrains flat lake water level from the shoreline without claiming bathymetry", () => {
  const feature = water("osm:way:2", "OpenStreetMap", lake, { water: "lake" });
  const map = { features: [feature] };
  const elevation = { sampleLocal: (x, z) => 120 + Math.sin(x + z) * 0.15 };
  const summary = enrichHydrology(map, { elevation });
  assert.equal(summary.lidarWaterLevels, 1);
  assert.equal(feature.hydrology.surfaceElevationSource, "lidar-shoreline-median");
  assert.ok(feature.hydrology.surfaceElevationM > 119.8 && feature.hydrology.surfaceElevationM < 120.2);
  assert.equal(feature.hydrology.bathymetryStatus, "unknown");
  assert.equal(feature.hydrology.depthM, null);
});

test("verified public bathymetry is accepted but OSM depth remains report-only", () => {
  const survey = water("public:bathy:1", "Survey Water", lake, { water: "lake", depth_m: 4.2 });
  const osm = water("osm:way:3", "OpenStreetMap", lake, { water: "lake", depth: 9 }, "Other Lake");
  const map = { features: [survey, osm] };
  enrichHydrology(map, {});
  assert.equal(survey.hydrology.depthM, 4.2);
  assert.equal(survey.hydrology.bathymetryStatus, "measured");
  assert.equal(osm.hydrology.depthM, null);
  assert.notEqual(osm.hydrology.bathymetryStatus, "measured");
});

test("water-network width expands a river centreline instead of leaving a one-block OSM-style line", () => {
  const feature = water("public:river:1", "Survey Water", {
    type: "LineString",
    coordinates: [[0, 0], [12, 0]]
  }, { waterway: "river", width_m: 6 }, "River");
  const map = { features: [feature] };
  enrichHydrology(map, {});
  const cells = waterFeatureCells(feature);
  const rows = new Set(cells.map(([, z]) => z));
  assert.ok(rows.size >= 5, `expected a broad river corridor, got ${rows.size} rows`);
  assert.equal(feature.hydrology.widthM, 6);
});
