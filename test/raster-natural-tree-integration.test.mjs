import test from "node:test";
import assert from "node:assert/strict";
import { compileMap } from "../src/lib/raster.mjs";

test("raster compiler emits branched natural tree geometry without entering sloped terrain", () => {
  const boundary = {
    id: "boundary",
    kind: "boundary",
    localGeometry: {
      type: "Polygon",
      coordinates: [[[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]]]
    }
  };
  const tree = {
    id: "tree:oak-1",
    kind: "vegetation",
    subtype: "tree",
    name: "English oak",
    tags: { species: "Quercus robur", natural: "tree" },
    localGeometry: { type: "Point", coordinates: [10, 10] },
    fidelity: {
      tree: {
        modelClass: "tree",
        heightM: 14,
        crownDiameterM: 10,
        trunkDiameterM: 1.1,
        species: "Quercus robur",
        leafType: "broadleaf",
        leafCycle: "deciduous"
      }
    }
  };
  const map = {
    boundary,
    features: [tree],
    semantics: {},
    topology: {},
    fidelity: {},
    rideProfiles: null,
    orthophoto: null,
    pathGeometry: null,
    pathTopology: null,
    sourceFusion: null,
    terrainDetails: null
  };
  const terrainAt = (x) => x >= 11 ? 2 : 0;
  const sources = {
    center: { lon: 0, lat: 0 },
    elevation: {
      provider: "fixture-slope",
      points: [],
      minM: 0,
      sampleLocal(x) { return terrainAt(Math.round(x)); }
    }
  };

  const compilation = compileMap({
    parkName: "Natural Tree Fixture",
    map,
    sources,
    accuracy: { score: 1, grade: "A", exact3d: true },
    options: {
      scale: 1,
      maxCells: 10_000,
      accuracyMode: "verified",
      buildings: "markers",
      noRideInfoSigns: true,
      aerialTerrainMode: "off",
      seed: 13579
    }
  });

  const phaseFour = compilation.chunks.flatMap((chunk) => chunk.o || [])
    .filter((operation) => Number(operation[0]) === 4);
  const block = (operation) => compilation.palette[operation[7]];
  const wood = phaseFour.filter((operation) => /_(?:log|wood)$/.test(block(operation)));
  const leaves = phaseFour.filter((operation) => /_leaves$/.test(block(operation)));

  assert.ok(wood.length > 0, "tree should contain wood geometry");
  assert.ok(leaves.length > 0, "tree should contain foliage geometry");
  assert.ok(
    wood.some((operation) => operation[1] !== 10 || operation[4] !== 10 || operation[3] !== 10),
    "natural tree should contain branch/root wood away from the original straight trunk column"
  );

  for (const operation of phaseFour) {
    const [, x1, y1, z1, x2, y2, z2] = operation;
    assert.equal(y1, y2, "natural tree row compression should keep each operation on one Y layer");
    assert.equal(z1, z2, "natural tree row compression should keep each operation on one Z row");
    for (let x = x1; x <= x2; x += 1) {
      assert.ok(
        y1 > terrainAt(x),
        `tree voxel ${block(operation)} at ${x},${y1},${z1} must stay above local terrain ${terrainAt(x)}`
      );
    }
  }

  assert.ok(compilation.meta.verticalStats.treeModels >= 1);
  assert.ok(compilation.meta.verticalStats.treeTrunkBlocks > 10, "wood count should include natural branches/root flare");
  assert.ok(compilation.meta.verticalStats.treeLeafBlocks > 20);
});
