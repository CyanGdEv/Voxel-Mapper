import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { acquireSources } from "../src/lib/sources.mjs";

const ENGLAND_BBOX = "52.9820,-1.9000,52.9945,-1.8665";

test("automatic LiDAR selection preserves non-enumerable runtime samplers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-lidar-sampler-"));
  const osmPath = path.join(root, "osm.json");
  await writeFile(osmPath, JSON.stringify({ version: 0.6, elements: [] }));

  try {
    const calls = [];
    const sources = await acquireSources({
      bbox: ENGLAND_BBOX,
      osm: osmPath,
      cache: path.join(root, "cache"),
      noCache: true,
      acquireElevationImpl: async ({ elevation }) => {
        calls.push(elevation);
        assert.equal(elevation, "ea-lidar");
        const result = {
          provider: "Mock Environment Agency LiDAR",
          sourceKind: "ea-lidar",
          resolutionM: 1,
          minM: 90,
          maxM: 130,
          points: []
        };
        Object.defineProperty(result, "sampleLocal", {
          enumerable: false,
          value: (x, z) => 100 + x * 0.01 + z * 0.02
        });
        Object.defineProperty(result, "sampleSurfaceLocal", {
          enumerable: false,
          value: (x, z) => 105 + x * 0.01 + z * 0.02
        });
        return result;
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

    assert.deepEqual(calls, ["ea-lidar"]);
    assert.equal(sources.autoSelection.terrain, "environment-agency-lidar-england");
    assert.equal(typeof sources.elevation.sampleLocal, "function");
    assert.equal(typeof sources.elevation.sampleSurfaceLocal, "function");
    assert.equal(sources.elevation.sampleLocal(10, 20), 100.5);
    assert.equal(sources.elevation.sampleSurfaceLocal(10, 20), 105.5);
    assert.equal(Object.getOwnPropertyDescriptor(sources.elevation, "sampleLocal")?.enumerable, false);
    assert.deepEqual(sources.elevation.acquisitionAttempts.map((entry) => entry.status), ["success"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
