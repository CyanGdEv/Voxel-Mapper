import test from "node:test";
import assert from "node:assert/strict";
import { enhanceLidarReconstructionSampling } from "../src/lib/lidar.mjs";

test("high-density LiDAR reconstruction uses 0.25 m sub-samples without claiming a finer source", () => {
  let calls = 0;
  const source = {
    resolutionM: 1,
    samplePairLocal(x, z) {
      calls += 1;
      return { terrain: 100 + x * 0.01, surface: 110 + z * 0.01 };
    }
  };
  const elevation = enhanceLidarReconstructionSampling(source);
  const pair = elevation.samplePairLocal(10, 20);
  assert.equal(calls, 16);
  assert.equal(elevation.nativeResolutionM, 1);
  assert.equal(elevation.resolutionM, 1, "native source resolution must remain truthful");
  assert.equal(elevation.reconstructionSampleSpacingM, 0.25);
  assert.equal(elevation.highDensitySampling.subSamplesPerCell, 16);
  assert.equal(elevation.highDensitySampling.sourceResolutionUnchanged, true);
  assert.equal(source.highDensitySampling, undefined, "source LiDAR authority object remains immutable/unmodified");
  assert.ok(Number.isFinite(pair.terrain));
  assert.ok(Number.isFinite(pair.surface));
});

test("high-density LiDAR sampling fails closed when a source channel has no valid samples", () => {
  const source = {
    resolutionM: 1,
    samplePairLocal() { return { terrain: 100, surface: null }; }
  };
  const elevation = enhanceLidarReconstructionSampling(source);
  assert.equal(elevation.samplePairLocal(0, 0).surface, null);
  assert.equal(elevation.samplePairLocal(0, 0).terrain, 100);
});
