import test from "node:test";
import assert from "node:assert/strict";
import { renderPlanningObjects3d } from "../src/lib/planning-object-renderer.mjs";

test("planning object renderer writes only above immutable phase-1 terrain", () => {
  const compilation = terrainCompilation();
  const originalTerrain = JSON.stringify(phaseOneOperations(compilation));
  const planningObjects = {
    objects: [
      {
        id: "planning-object-3d:T1", kind: "tree", anchor: { x: 0, z: 0 },
        heightM: 5, crownSpreadM: 3, trunkDiameterM: null, species: "Beech"
      },
      {
        id: "planning-object-3d:LC1", kind: "lighting_column", anchor: { x: 1, z: 0 },
        heightM: 4, ral: "RAL 9005", constructionMaterial: "steel"
      },
      {
        id: "planning-object-3d:F1", kind: "barrier", subtype: "fence",
        geometry: { type: "LineString", coordinates: [[2, 0], [4, 0]] },
        heightM: 2, constructionMaterial: "timber"
      }
    ]
  };

  const result = renderPlanningObjects3d({ compilation, planningObjects });
  assert.equal(result.status, "rendered");
  assert.equal(result.objects, 3);
  assert.equal(result.trees, 1);
  assert.equal(result.lightingColumns, 1);
  assert.equal(result.barriers, 1);
  assert.equal(result.airWrites, 0);
  assert.equal(result.terrainGeometryChanged, false);
  assert.equal(result.terrainElevationChanged, false);
  assert.equal(JSON.stringify(phaseOneOperations(compilation)), originalTerrain);

  const terrain = new Map([["0,0", 0], ["1,0", 0], ["2,0", 0], ["3,0", 1], ["4,0", 2]]);
  for (const operation of allOperations(compilation).filter((op) => Number(op[0]) >= 9)) {
    const [, x, y, z] = operation;
    const ground = terrain.get(`${x},${z}`);
    assert.ok(Number.isFinite(ground), `overlay wrote outside known terrain at ${x},${z}`);
    assert.ok(y > ground, `overlay wrote at/below terrain: ${JSON.stringify(operation)} ground=${ground}`);
  }
});

test("fence voxels follow per-cell terrain rather than flattening the line", () => {
  const compilation = terrainCompilation();
  const planningObjects = {
    objects: [{
      id: "planning-object-3d:F2", kind: "barrier", subtype: "fence",
      geometry: { type: "LineString", coordinates: [[2, 0], [4, 0]] },
      heightM: 2, constructionMaterial: "timber"
    }]
  };
  renderPlanningObjects3d({ compilation, planningObjects });
  const barrier = allOperations(compilation).filter((op) => Number(op[0]) === 9.2);
  const ys = (x) => barrier.filter((op) => op[1] === x && op[3] === 0).map((op) => op[2]).sort((a, b) => a - b);
  assert.deepEqual(ys(2), [1, 2]);
  assert.deepEqual(ys(3), [2, 3]);
  assert.deepEqual(ys(4), [3, 4]);
});

test("tree and lighting top voxels preserve scheduled total height from local terrain", () => {
  const compilation = terrainCompilation();
  renderPlanningObjects3d({ compilation, planningObjects: { objects: [
    { id: "tree", kind: "tree", anchor: { x: 0, z: 0 }, heightM: 5, crownSpreadM: 3, species: "Oak" },
    { id: "light", kind: "lighting_column", anchor: { x: 1, z: 0 }, heightM: 4, ral: null }
  ] } });
  const ops = allOperations(compilation).filter((op) => Number(op[0]) >= 9);
  const treeTop = Math.max(...ops.filter((op) => [9.1, 9.11].includes(Number(op[0])) && op[1] === 0 && op[3] === 0).map((op) => op[2]));
  const lightTop = Math.max(...ops.filter((op) => [9.3, 9.31].includes(Number(op[0])) && op[1] === 1 && op[3] === 0).map((op) => op[2]));
  assert.equal(treeTop, 5);
  assert.equal(lightTop, 4);
});

function terrainCompilation() {
  return {
    meta: { bounds: { minX: 0, minZ: 0, maxX: 4, maxZ: 0, width: 5, height: 1 } },
    palette: ["minecraft:grass_block"],
    chunks: [{ x: 0, z: 0, o: [
      [1, 0, 0, 0, 0, 0, 0, 0],
      [1, 1, 0, 0, 1, 0, 0, 0],
      [1, 2, 0, 0, 2, 0, 0, 0],
      [1, 3, 1, 0, 3, 1, 0, 0],
      [1, 4, 2, 0, 4, 2, 0, 0]
    ] }],
    stats: { operations: 5, chunks: 1 }
  };
}
function allOperations(compilation) { return compilation.chunks.flatMap((chunk) => chunk.o || []); }
function phaseOneOperations(compilation) { return allOperations(compilation).filter((operation) => Number(operation[0]) === 1); }
