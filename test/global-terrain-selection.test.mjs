import test from "node:test";
import assert from "node:assert/strict";
import { resolveSourcePlan } from "../src/lib/source-registry.mjs";
import { RUNTIME_SOURCE_PROVIDERS } from "../src/lib/runtime-source-providers.mjs";
import { chooseGlobalTerrainTilePlan, globalTerrainTileRange } from "../src/lib/global-terrain.mjs";

function plan(bbox) {
  return resolveSourcePlan(bbox, {
    providers: RUNTIME_SOURCE_PROVIDERS,
    kinds: ["terrain"],
    maxPerKind: 8
  });
}

test("England keeps Environment Agency LiDAR ahead of the global DEM", () => {
  const result = plan({ south: 52.9820, west: -1.9000, north: 52.9945, east: -1.8665 });
  assert.equal(result.selected.terrain.providerId, "environment-agency-lidar-england");
  assert.equal(result.selected.terrain.acquisition.adapter, "ea-lidar");
});

test("a live bbox outside national LiDAR coverage gets an executable global terrain provider", () => {
  const result = plan({ south: 35.62, west: 139.68, north: 35.66, east: 139.74 });
  assert.equal(result.selected.terrain.providerId, "aws-terrain-tiles");
  assert.equal(result.selected.terrain.acquisition.adapter, "aws-terrain-tiles");
  assert.equal(result.selected.terrain.implemented, true);
});

test("global terrain planning stays bounded and automatically reduces zoom for large tile counts", () => {
  const bbox = { south: 35.62, west: 139.68, north: 35.66, east: 139.74 };
  const high = globalTerrainTileRange(bbox, 14);
  assert.ok(high.count > 0);
  const bounded = chooseGlobalTerrainTilePlan(bbox, 14, Math.max(1, Math.min(4, high.count)));
  assert.ok(bounded.tiles.length <= Math.max(1, Math.min(4, high.count)));
  assert.ok(bounded.zoom <= 14);
});

test("global terrain provider is not advertised beyond Web Mercator polar coverage", () => {
  const result = plan({ south: 86.0, west: -20, north: 86.1, east: -19.9 });
  assert.notEqual(result.selected.terrain?.providerId, "aws-terrain-tiles");
});
