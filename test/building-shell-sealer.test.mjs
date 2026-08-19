import test from "node:test";
import assert from "node:assert/strict";
import { sealLidarBuildingShells } from "../src/lib/raster.mjs";

function compilation() {
  return {
    meta: {
      bounds: { minX: -2, minZ: -2, maxX: 10, maxZ: 10 },
      elevationDatumM: 100,
      statefulBlockReplacements: []
    },
    palette: [],
    chunks: [],
    stats: { rawOperations: 0, estimatedBlocks: 0 }
  };
}

function building(geometry) {
  return {
    id: "planning:sealed-building",
    kind: "building",
    tags: { "building:material": "brick", "roof:material": "slate" },
    localGeometry: geometry,
    vertical: { heightM: 6 },
    roof: {
      source: "lidar-dsm-surface",
      heightM: 6,
      heightSpreadM: 1.2
    }
  };
}

function square(size = 6) {
  return {
    type: "Polygon",
    coordinates: [[[0, 0], [size, 0], [size, size], [0, size], [0, 0]]]
  };
}

function operations(target) {
  return target.chunks.flatMap((chunk) => chunk.o);
}

test("final building seal rejects an isolated DSM spike and clears the stale tower above the roof", () => {
  const target = compilation();
  const feature = building(square());
  const elevation = {
    sampleLocal: () => 100,
    samplePairLocal(x, z) {
      return { terrain: 100, surface: x === 3 && z === 3 ? 130 : 106 };
    }
  };

  const stats = sealLidarBuildingShells(target, { map: { features: [feature] }, sources: { elevation } });
  assert.equal(stats.buildings, 1);
  assert.ok(stats.outlierSamplesRejected >= 1, "unsupported DSM spike should be rejected");
  assert.ok(stats.clearedBlocks >= 24, "stale blocks above the accepted roof should be explicitly cleared");

  const centreRoof = operations(target).find((op) =>
    op[0] === 3.3 && op[1] === 3 && op[3] === 3 && op[2] === 6 && op[5] === 6
  );
  assert.ok(centreRoof, "sanitized roof should remain at the supported six-metre level");

  const airIndex = target.palette.indexOf("minecraft:air");
  const spikeClear = operations(target).find((op) =>
    op[7] === airIndex && op[1] === 3 && op[3] === 3 && op[2] <= 7 && op[5] >= 30
  );
  assert.ok(spikeClear, "raw spike volume must be cleared before the final roof is written");
});

test("multi-block LiDAR roof steps get full internal riser walls instead of one thin detail block", () => {
  const target = compilation();
  const feature = building({
    type: "Polygon",
    coordinates: [[[0, 0], [6, 0], [6, 4], [0, 4], [0, 0]]]
  });
  const elevation = {
    sampleLocal: () => 100,
    samplePairLocal(x) {
      return { terrain: 100, surface: x >= 3 ? 110 : 106 };
    }
  };

  const stats = sealLidarBuildingShells(target, { map: { features: [feature] }, sources: { elevation } });
  assert.ok(stats.internalStepWallColumns > 0);
  assert.ok(stats.internalStepWallBlocks >= stats.internalStepWallColumns * 3);

  const seam = operations(target).find((op) =>
    op[0] === 3.35 && op[1] === 2 && op[2] === 7 && op[5] === 9
  );
  assert.ok(seam, "the exposed 6m-to-10m roof face should be filled from y=7 through y=9");
});

test("supported half-metre roof gradients retain stateful slab detail after sanitation", () => {
  const target = compilation();
  const feature = building({
    type: "Polygon",
    coordinates: [[[0, 0], [5, 0], [5, 4], [0, 4], [0, 0]]]
  });
  const elevation = {
    sampleLocal: () => 100,
    samplePairLocal(x) {
      return { terrain: 100, surface: 106 + x * 0.5 };
    }
  };

  const stats = sealLidarBuildingShells(target, { map: { features: [feature] }, sources: { elevation } });
  assert.ok(stats.roofSlabCells > 0);
  const slab = target.meta.statefulBlockReplacements.find((item) => item.kind === "lidar-roof-slab");
  assert.ok(slab);
  assert.equal(slab.name, "minecraft:deepslate_tile_slab");
  assert.deepEqual(slab.states, { "minecraft:vertical_half": "bottom" });
});

test("true polygon courtyards stay open while the surrounding roof is sealed", () => {
  const target = compilation();
  const feature = building({
    type: "Polygon",
    coordinates: [
      [[0, 0], [7, 0], [7, 7], [0, 7], [0, 0]],
      [[2, 2], [5, 2], [5, 5], [2, 5], [2, 2]]
    ]
  });
  const elevation = {
    sampleLocal: () => 100,
    samplePairLocal: () => ({ terrain: 100, surface: 106 })
  };

  const stats = sealLidarBuildingShells(target, { map: { features: [feature] }, sources: { elevation } });
  assert.equal(stats.trueInteriorRingsPreserved, 1);
  const roofIndex = target.palette.indexOf("minecraft:deepslate_tiles");
  const courtyardRoof = operations(target).some((op) =>
    op[7] === roofIndex && op[1] <= 3 && op[4] >= 3 && op[3] <= 3 && op[6] >= 3
  );
  assert.equal(courtyardRoof, false, "the final sealing pass must not fill a real courtyard");
});
