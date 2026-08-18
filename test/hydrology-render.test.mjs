import test from "node:test";
import assert from "node:assert/strict";
import { enrichHydrology } from "../src/lib/hydrology.mjs";
import { renderHydrologyWater } from "../src/lib/raster.mjs";

function compilation() {
  return {
    meta: { bounds: { minX: -2, minZ: -2, maxX: 12, maxZ: 12 }, elevationDatumM: 100 },
    palette: [],
    chunks: [],
    stats: { rawOperations: 0, estimatedBlocks: 0 }
  };
}

function feature(provider, tags = {}, geometry = null) {
  return {
    id: provider === "OpenStreetMap" ? "osm:way:water" : "public:water:test",
    name: "Test Lake",
    kind: "water",
    subtype: tags.water || "lake",
    tags,
    localGeometry: geometry || {
      type: "Polygon",
      coordinates: [[[0, 0], [8, 0], [8, 8], [0, 8], [0, 0]]]
    },
    vertical: { elevationM: null },
    source: { provider },
    verification: { plan: provider === "OpenStreetMap" ? "public-map" : "source-verified" }
  };
}

const elevation = { sampleLocal: () => 110 };

function waterOps(target) {
  const index = target.palette.indexOf("minecraft:water");
  return target.chunks.flatMap((chunk) => chunk.o).filter((op) => op[7] === index && op[0] === 1.4);
}

test("OSM-only water with unknown depth remains a surface and never excavates a fake basin", () => {
  const water = feature("OpenStreetMap", { water: "lake", depth: 8 });
  const map = { features: [water] };
  enrichHydrology(map, { elevation });
  const target = compilation();
  const stats = renderHydrologyWater(target, { map, sources: { elevation } });
  const operations = waterOps(target);
  assert.equal(stats.surfaceOnlyFeatures, 1);
  assert.equal(stats.measuredDepthFeatures, 0);
  assert.ok(operations.length > 0);
  assert.ok(operations.every((op) => op[2] === op[5]), "unknown/OSM depth must never create a multi-block water column");
  assert.equal(stats.osmDepthExcavationAllowed, false);
  assert.ok(Number.isFinite(stats.operations));
  assert.ok(Number.isFinite(stats.estimatedBlocks));
});

test("trusted measured depth creates a multi-block water volume", () => {
  const water = feature("Survey Water", { water: "lake", depth_m: 4, water_level_m: 110 });
  const map = { features: [water] };
  enrichHydrology(map, { elevation });
  const target = compilation();
  const stats = renderHydrologyWater(target, { map, sources: { elevation } });
  const operations = waterOps(target);
  assert.equal(stats.measuredDepthFeatures, 1);
  assert.ok(operations.some((op) => op[5] - op[2] >= 3), "trusted 4 m depth should generate a four-block water column");
});

test("trusted maximum depth makes the interior deeper than the shoreline", () => {
  const water = feature("Survey Water", { water: "lake", max_depth_m: 6, water_level_m: 110 });
  const map = { features: [water] };
  enrichHydrology(map, { elevation });
  const target = compilation();
  const stats = renderHydrologyWater(target, { map, sources: { elevation } });
  const operations = waterOps(target);
  const depths = operations.map((op) => op[5] - op[2] + 1);
  assert.equal(stats.maxDepthConstrainedFeatures, 1);
  assert.ok(Math.max(...depths) > Math.min(...depths), "max-depth evidence should constrain a basin, not a constant-depth box");
  assert.ok(Math.max(...depths) <= 6);
});

test("trusted measured river width expands rendered water beyond a one-block centreline", () => {
  const water = feature("Survey Water", { waterway: "river", width_m: 6 }, {
    type: "LineString",
    coordinates: [[0, 3], [10, 3]]
  });
  const map = { features: [water] };
  enrichHydrology(map, { elevation });
  const target = compilation();
  const stats = renderHydrologyWater(target, { map, sources: { elevation } });
  const rows = new Set(waterOps(target).map((op) => op[3]));
  assert.equal(stats.expandedWidthFeatures, 1);
  assert.ok(rows.size >= 5);
});
