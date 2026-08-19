import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareGroundRouteCollisionSafeInput,
  reassertProtectedGroundSurfaces
} from "../src/lib/ground-route-collision.mjs";

function route(id, coordinates, extra = {}) {
  return {
    id,
    kind: "path",
    subtype: "footway",
    tags: { highway: "footway", ...(extra.tags || {}) },
    localGeometry: { type: "LineString", coordinates },
    geometry: { type: "LineString", coordinates },
    authority: extra.authority || { layer: "osm", rank: 100, geometryLocked: false },
    fidelity: { path: { rasterWidthM: extra.widthM || 2 } }
  };
}

function water(id, geometry, rank = 100) {
  return {
    id,
    kind: "water",
    subtype: "river",
    tags: { natural: "water" },
    localGeometry: geometry,
    authority: { layer: rank >= 360 ? "planning-current-authority" : "osm", rank, geometryLocked: rank >= 360 }
  };
}

function rideFootprint(id, geometry, rank = 100) {
  return {
    id,
    kind: "attraction",
    subtype: "river_rapids",
    tags: { attraction: "river_rapids" },
    localGeometry: geometry,
    authority: { layer: rank >= 360 ? "planning-current-authority" : "osm", rank, geometryLocked: rank >= 360 }
  };
}

const river = { type: "Polygon", coordinates: [[[4, -2], [8, -2], [8, 2], [4, 2], [4, -2]]] };

test("same-authority ground path is clipped out of water instead of painting through it", () => {
  const input = { map: { features: [route("path", [[0, 0], [12, 0]]), water("river", river)] }, options: {} };
  const result = prepareGroundRouteCollisionSafeInput(input);
  const clipped = result.input.map.features.find((feature) => feature.id === "path");
  assert.equal(result.summary.clippedRouteFeatures, 1);
  assert.equal(clipped.localGeometry.type, "MultiLineString");
  assert.equal(clipped.localGeometry.coordinates.length, 2);
  assert.ok(result.summary.removedRouteLengthM >= 3.5);
});

test("explicit bridge keeps its route across water", () => {
  const input = {
    map: { features: [route("bridge", [[0, 0], [12, 0]], { tags: { bridge: "yes", layer: "1" } }), water("river", river)] },
    options: {}
  };
  const result = prepareGroundRouteCollisionSafeInput(input);
  assert.equal(result.summary.clippedRouteFeatures, 0);
  assert.equal(result.summary.preservedGradeSeparated, 1);
  assert.deepEqual(result.input.map.features.find((feature) => feature.id === "bridge").localGeometry.coordinates, [[0, 0], [12, 0]]);
});

test("higher-authority planning path is not clipped by lower-authority OSM water", () => {
  const planningPath = route("planning-path", [[0, 0], [12, 0]], {
    authority: { layer: "planning-current-authority", rank: 360, geometryLocked: true }
  });
  const result = prepareGroundRouteCollisionSafeInput({ map: { features: [planningPath, water("river", river, 100)] }, options: {} });
  assert.equal(result.summary.clippedRouteFeatures, 0);
});

test("planning-current water clips lower-authority stale OSM path", () => {
  const result = prepareGroundRouteCollisionSafeInput({
    map: { features: [route("osm-path", [[0, 0], [12, 0]]), water("planning-river", river, 360)] },
    options: {}
  });
  assert.equal(result.summary.clippedRouteFeatures, 1);
  assert.ok(result.summary.removedRouteLengthM >= 3.5);
});

test("physical ride footprint blocks a same-authority ground path", () => {
  const footprint = { type: "Polygon", coordinates: [[[4, -2], [8, -2], [8, 2], [4, 2], [4, -2]]] };
  const result = prepareGroundRouteCollisionSafeInput({
    map: { features: [route("stale-path", [[0, 0], [12, 0]]), rideFootprint("rapids", footprint)] },
    options: {}
  });
  assert.equal(result.summary.clippedRouteFeatures, 1);
  assert.equal(result.summary.protectedRideFootprints, 1);
});

test("protected water is emitted after planning and parking ground-paint phases", () => {
  const areaPath = {
    id: "plaza",
    kind: "path",
    tags: { "area:highway": "pedestrian" },
    localGeometry: { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 4], [0, 4], [0, 0]]] },
    authority: { layer: "osm", rank: 100, geometryLocked: false }
  };
  const waterFeature = water("river", { type: "Polygon", coordinates: [[[4, 0], [7, 0], [7, 4], [4, 4], [4, 0]]] });
  const prepared = prepareGroundRouteCollisionSafeInput({ map: { features: [areaPath, waterFeature] }, options: {} });
  const compilation = {
    palette: ["minecraft:light_gray_concrete"],
    chunks: [{
      x: 0, z: 0,
      o: [0, 1, 2, 3, 4].map((z) => [1, 0, 64, z, 10, 64, z, 0])
    }],
    meta: {},
    stats: { rawOperations: 5, operations: 5, estimatedBlocks: 55, chunks: 1, phaseCounts: { 1: 5 } }
  };
  reassertProtectedGroundSurfaces(compilation, prepared.input, prepared.summary);
  const waterIndex = compilation.palette.indexOf("minecraft:water");
  assert.ok(waterIndex >= 0);
  assert.equal(blockAt(compilation, 5, 64, 2), waterIndex);
  const waterOp = compilation.chunks.flatMap((chunk) => chunk.o).find((op) => op[7] === waterIndex && op[1] <= 5 && op[4] >= 5 && op[3] === 2);
  assert.ok(waterOp[0] > 1.78);
  assert.ok(compilation.meta.pathCollisionResolution.protectedSurfaceCells > 0);
});

function blockAt(compilation, x, y, z) {
  let value = null;
  for (const chunk of compilation.chunks) {
    for (const op of chunk.o || []) {
      if (x < op[1] || x > op[4] || y < op[2] || y > op[5] || z < op[3] || z > op[6]) continue;
      value = op[7];
    }
  }
  return value;
}
