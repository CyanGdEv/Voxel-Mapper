import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { openMcworld } from "@taku128/mcworld-browser";
import { buildPark } from "../src/lib/pipeline.mjs";

const fixture = path.resolve("test/fixtures/mini-park.overpass.json");
const bbox = "51.0000,-0.0020,51.0020,0.0020";

test("automatic LiDAR relief is visible in the finished mcworld instead of being buried below the flat foundation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "voxel-terrain-materialization-"));
  const compilationPath = path.join(directory, "compilation.json");

  try {
    const result = await buildPark({
      parkName: "Terrain Materialization Fixture",
      osm: fixture,
      bbox,
      cache: path.join(directory, "cache"),
      out: directory,
      compilationOut: compilationPath,
      maxCells: 200_000,
      maxWorldChunks: 400,
      worldMargin: 0,
      noAddon: true,
      buildings: "markers",
      accuracyMode: "plausible",
      acquireElevationImpl: async ({ elevation }) => {
        assert.equal(elevation, "ea-lidar");
        const lidar = {
          provider: "Mock Environment Agency LiDAR",
          sourceKind: "ea-lidar",
          resolutionM: 1,
          minM: 80,
          maxM: 120,
          points: []
        };
        Object.defineProperty(lidar, "sampleLocal", {
          enumerable: false,
          value: (x, z) => 100 + x * 0.035 + z * 0.02
        });
        Object.defineProperty(lidar, "sampleSurfaceLocal", {
          enumerable: false,
          value: (x, z) => 104 + x * 0.035 + z * 0.02
        });
        return lidar;
      },
      planningAcquirerImpl: async () => ({
        provider: "Mock Planning",
        providerId: "planning-data-england",
        status: "acquired",
        applicationCount: 0,
        jurisdictionCount: 0,
        applications: [],
        jurisdictions: []
      })
    });

    assert.equal(result.stats.worldValidation, "passed");
    const envelope = JSON.parse(await readFile(compilationPath, "utf8"));
    const compilation = envelope.compilation;
    const terrainSurfaceOps = compilation.chunks.flatMap((chunk) =>
      chunk.o.filter((operation) => operation[0] === 1)
    );
    assert.ok(terrainSurfaceOps.length > 0, "the raster must emit terrain surface operations");

    const relativeHeights = terrainSurfaceOps.map((operation) => operation[2]);
    const minRelativeY = Math.min(...relativeHeights);
    const maxRelativeY = Math.max(...relativeHeights);
    assert.ok(minRelativeY >= 0,
      `LiDAR terrain must not compile below its own minimum datum; got ${minRelativeY}`);
    assert.ok(maxRelativeY - minRelativeY >= 5,
      `the sloped LiDAR fixture must retain visible relief; got ${minRelativeY}..${maxRelativeY}`);

    const highest = terrainSurfaceOps.reduce((best, operation) =>
      operation[2] > best[2] ? operation : best, terrainSurfaceOps[0]);
    const sampleX = highest[1];
    const sampleZ = highest[3];
    const expectedSurfaceY = Number(compilation.meta.baseY) + highest[2];
    assert.ok(expectedSurfaceY > Number(compilation.meta.baseY) + 5,
      "the high LiDAR sample must rise visibly above the foundation");

    const archiveBytes = new Uint8Array(await readFile(result.paths.world));
    const world = openMcworld(archiveBytes);
    const decodedSurface = world.readBlocks({
      minX: sampleX,
      maxX: sampleX,
      minY: expectedSurfaceY,
      maxY: expectedSurfaceY,
      minZ: sampleZ,
      maxZ: sampleZ
    });
    assert.equal(decodedSurface.blocks.length, 1,
      `the finished world must contain the LiDAR surface block at y=${expectedSurfaceY}`);
    const surfaceBlock = decodedSurface.palette[decodedSurface.blocks[0].state]?.Name;
    assert.ok(surfaceBlock && surfaceBlock !== "minecraft:air",
      `the decoded LiDAR surface must be non-air; got ${surfaceBlock || "missing"}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
