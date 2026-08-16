import test from "node:test";
import assert from "node:assert/strict";

import { surfaceMaterialPalette } from "../src/lib/material-palettes.mjs";
import {
  blockForPlanningSurfacePalette,
  renderPlanningSurfacePaint
} from "../src/lib/planning-surface-renderer.mjs";

test("planning ground palette resolver accepts surface materials and rejects roof/cladding palettes", () => {
  const expected = new Map([
    ["weathered_asphalt", 4],
    ["fresh_black_asphalt", 4],
    ["light_asphalt", 4],
    ["red_tarmac", 4],
    ["resin_bound_beige", 5],
    ["resin_bound_grey", 5],
    ["concrete", 4],
    ["old_concrete", 4],
    ["paving_stones", 5],
    ["brick", 3],
    ["stone", 4],
    ["timber", 4],
    ["gravel", 4],
    ["sand", 3],
    ["grass", 3],
    ["earth", 4]
  ]);
  for (const [material, blocks] of expected) {
    const palette = surfaceMaterialPalette(material);
    assert.equal(palette?.key, material);
    assert.equal(palette?.role, "surface");
    assert.equal(palette?.blocks.length, blocks);
    assert.ok(Math.abs(palette.blocks.reduce((sum, entry) => sum + entry.weight, 0) - 1) < 0.001);
  }
  assert.equal(surfaceMaterialPalette("paving slabs")?.key, "paving_stones");
  assert.equal(surfaceMaterialPalette("block paving")?.key, "paving_stones");
  assert.equal(surfaceMaterialPalette("asphalt")?.key, "weathered_asphalt");
  assert.equal(surfaceMaterialPalette("slate_roof"), null);
  assert.equal(surfaceMaterialPalette("metal roof"), null);
  assert.equal(surfaceMaterialPalette("glass"), null);
});

test("weighted renderer preserves every block in five-entry resin palettes", () => {
  const palette = surfaceMaterialPalette("resin_bound_beige");
  const observed = new Set();
  for (let z = 0; z < 96; z += 1) {
    for (let x = 0; x < 96; x += 1) {
      observed.add(blockForPlanningSurfacePalette(palette, x, z, 417));
    }
  }
  assert.deepEqual(observed, new Set(palette.blocks.map((entry) => entry.block)));
});

test("planning surface renderer overwrites only the already-compiled top block at its exact terrain Y", () => {
  const baseOperations = [];
  for (let z = 0; z <= 7; z += 1) {
    baseOperations.push([1, 0, z, z, 15, z, z, 0]);
  }
  const compilation = {
    meta: { elevationDatumM: 100, surfaceStyles: [] },
    palette: ["minecraft:grass_block"],
    chunks: [{ x: 0, z: 0, o: baseOperations.map((entry) => [...entry]) }],
    stats: {
      rawOperations: baseOperations.length,
      operations: baseOperations.length,
      estimatedBlocks: 16 * 8,
      chunks: 1,
      phaseCounts: { 1: baseOperations.length }
    }
  };
  const changeSet = {
    candidates: [{
      id: "paint-red-tarmac",
      kind: "surface",
      planningOperation: "paint",
      compiledMaterial: "red_tarmac",
      localGeometry: {
        type: "Polygon",
        coordinates: [[[1, 1], [14, 1], [14, 6], [1, 6], [1, 1]]]
      }
    }]
  };

  const result = renderPlanningSurfacePaint({ compilation, changeSet, options: { seed: 19 } });
  assert.equal(result.status, "rendered");
  assert.equal(result.renderedFeatures, 1);
  assert.ok(result.renderedCellWrites > 0);
  assert.equal(result.terrainGeometryChanged, false);
  assert.equal(result.terrainElevationChanged, false);
  assert.equal(result.elevationPolicy, "reuse-exact-compiled-phase-1-ground-y");

  const overlay = compilation.chunks[0].o.filter((operation) => operation[0] === 1 && operation[7] !== 0);
  assert.ok(overlay.length > 0);
  for (const operation of overlay) {
    const [, , y1, z1, , y2, z2] = operation;
    assert.equal(y1, y2);
    assert.equal(z1, z2);
    assert.equal(y1, z1, "paint must reuse the exact Y from the compiled terrain row");
  }
  assert.ok(compilation.palette.includes("minecraft:red_concrete"));
  assert.ok(compilation.palette.includes("minecraft:red_terracotta"));
  assert.ok(compilation.stats.planningSurfacePaintRenderedCells > 0);
  assert.equal(compilation.meta.planningSurfacePaintRender.terrainElevationChanged, false);
});

test("planning paint cannot create terrain outside an existing compiled top-surface cell", () => {
  const compilation = {
    meta: {},
    palette: ["minecraft:grass_block"],
    chunks: [{ x: 0, z: 0, o: [[1, 0, 4, 0, 3, 4, 0, 0]] }],
    stats: { rawOperations: 1, operations: 1, estimatedBlocks: 4, chunks: 1, phaseCounts: { 1: 1 } }
  };
  const changeSet = {
    candidates: [{
      id: "outside-paint",
      kind: "surface",
      planningOperation: "paint",
      compiledMaterial: "fresh_black_asphalt",
      localGeometry: {
        type: "Polygon",
        coordinates: [[[20, 20], [24, 20], [24, 24], [20, 24], [20, 20]]]
      }
    }]
  };
  const result = renderPlanningSurfacePaint({ compilation, changeSet });
  assert.equal(result.renderedFeatures, 0);
  assert.equal(result.rejectedFeatures, 1);
  assert.equal(compilation.chunks.length, 1);
  assert.equal(compilation.chunks[0].o.length, 1);
});

test("non-ground planning materials fail closed instead of being painted onto terrain", () => {
  const compilation = {
    meta: {},
    palette: ["minecraft:grass_block"],
    chunks: [{ x: 0, z: 0, o: [[1, 0, 0, 0, 7, 0, 0, 0]] }],
    stats: { rawOperations: 1, operations: 1, estimatedBlocks: 8, chunks: 1, phaseCounts: { 1: 1 } }
  };
  const changeSet = {
    candidates: [{
      id: "roof-material-on-ground",
      kind: "surface",
      planningOperation: "paint",
      compiledMaterial: "slate_roof",
      localGeometry: {
        type: "Polygon",
        coordinates: [[[0, 0], [7, 0], [7, 1], [0, 1], [0, 0]]]
      }
    }]
  };
  const result = renderPlanningSurfacePaint({ compilation, changeSet });
  assert.equal(result.renderedFeatures, 0);
  assert.equal(result.deferredFeatures, 1);
  assert.deepEqual(compilation.palette, ["minecraft:grass_block"]);
});
