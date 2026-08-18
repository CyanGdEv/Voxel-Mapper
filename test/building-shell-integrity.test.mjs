import test from "node:test";
import assert from "node:assert/strict";
import { repairLidarBuildingShells } from "../src/lib/raster.mjs";

function compilation() {
  return {
    meta: { bounds: { minX: -2, minZ: -2, maxX: 8, maxZ: 8 }, elevationDatumM: 100 },
    palette: [],
    chunks: [],
    stats: { rawOperations: 0, estimatedBlocks: 0 }
  };
}

function building(geometry) {
  return {
    id: "planning:test-building",
    kind: "building",
    tags: { "building:material": "brick", "roof:material": "slate" },
    localGeometry: geometry,
    vertical: { heightM: 6 },
    roof: { source: "lidar-dsm-surface", heightM: 6 }
  };
}

const elevation = {
  sampleLocal: () => 100,
  samplePairLocal(x, z) {
    return { terrain: 100, surface: 106 + (x >= 3 ? 2 : 0) };
  }
};

test("LiDAR shell repair derives roof and walls from one watertight footprint mask", () => {
  const target = compilation();
  const feature = building({
    type: "Polygon",
    coordinates: [[[0, 0], [5, 1], [5, 5], [1, 5], [0, 0]]]
  });
  const stats = repairLidarBuildingShells(target, { map: { features: [feature] }, sources: { elevation } });
  assert.equal(stats.buildings, 1);
  assert.ok(stats.roofCells > 0);
  assert.ok(stats.wallColumns > 0);
  assert.ok(stats.operations >= stats.roofCells * 2 + stats.wallColumns);
  assert.equal(stats.watertightBoundaryDerivedFromRoofMask, true);
});

test("LiDAR shell repair preserves a real courtyard instead of filling it as a raster crack", () => {
  const target = compilation();
  const feature = building({
    type: "Polygon",
    coordinates: [
      [[0, 0], [6, 0], [6, 6], [0, 6], [0, 0]],
      [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]
    ]
  });
  const stats = repairLidarBuildingShells(target, { map: { features: [feature] }, sources: { elevation } });
  assert.equal(stats.trueInteriorRingsPreserved, 1);
  const roofIndex = target.palette.indexOf("minecraft:deepslate_tiles");
  const roofAtCourtyardCentre = target.chunks.flatMap((chunk) => chunk.o).some((op) =>
    op[7] === roofIndex && op[1] <= 3 && op[4] >= 3 && op[3] <= 3 && op[6] >= 3
  );
  assert.equal(roofAtCourtyardCentre, false, "true polygon holes must remain open");
});

test("LiDAR-proven roof steps use thin wall-family detail rather than another full cube", () => {
  const target = compilation();
  const feature = building({
    type: "Polygon",
    coordinates: [[[0, 0], [6, 0], [6, 4], [0, 4], [0, 0]]]
  });
  const stats = repairLidarBuildingShells(target, { map: { features: [feature] }, sources: { elevation } });
  assert.ok(stats.roofStepDetailCells > 0);
  assert.ok(target.palette.includes("minecraft:brick_wall"));
});

test("one-metre LiDAR roof transitions become oriented Bedrock stairs", () => {
  const target = compilation();
  const feature = building({
    type: "Polygon",
    coordinates: [[[0, 0], [5, 0], [5, 4], [0, 4], [0, 0]]]
  });
  const slopedElevation = {
    sampleLocal: () => 100,
    samplePairLocal(x) {
      return { terrain: 100, surface: 106 + x };
    }
  };
  const stats = repairLidarBuildingShells(target, { map: { features: [feature] }, sources: { elevation: slopedElevation } });
  assert.ok(stats.roofStairCells > 0);
  const stair = target.meta.statefulBlockReplacements.find((item) => item.kind === "lidar-roof-stair");
  assert.ok(stair);
  assert.equal(stair.name, "minecraft:deepslate_tile_stairs");
  assert.equal(stair.states["minecraft:corner"], "none");
  assert.equal(stair.states.upside_down_bit, 0);
  assert.equal(stair.states.weirdo_direction, 0, "east-rising roof should retain an east stair orientation");
});

test("half-metre LiDAR roof transitions become bottom slabs without inventing new source resolution", () => {
  const target = compilation();
  const feature = building({
    type: "Polygon",
    coordinates: [[[0, 0], [5, 0], [5, 4], [0, 4], [0, 0]]]
  });
  const steppedElevation = {
    sampleLocal: () => 100,
    samplePairLocal(x) {
      return { terrain: 100, surface: 106 + x * 0.5 };
    }
  };
  const stats = repairLidarBuildingShells(target, { map: { features: [feature] }, sources: { elevation: steppedElevation } });
  assert.ok(stats.roofSlabCells > 0);
  const slab = target.meta.statefulBlockReplacements.find((item) => item.kind === "lidar-roof-slab");
  assert.ok(slab);
  assert.equal(slab.name, "minecraft:deepslate_tile_slab");
  assert.deepEqual(slab.states, { "minecraft:vertical_half": "bottom" });
});
