import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { buildPark } from "../src/lib/pipeline.mjs";
import { validateBedrockContent } from "../scripts/validate-bedrock-content.mjs";

const fixture = path.resolve("test/fixtures/mini-park.overpass.json");
const bbox = "51.0000,-0.0020,51.0020,0.0020";

function planningNone() {
  return {
    provider: "Mock Planning",
    providerId: "planning-data-england",
    status: "acquired",
    applicationCount: 0,
    jurisdictionCount: 0,
    applications: [],
    jurisdictions: []
  };
}

test("decoded Bedrock content acceptance passes a real sloped terrain world", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "voxel-bedrock-content-pass-"));
  try {
    await buildPark({
      parkName: "Decoded Terrain QA Fixture",
      osm: fixture,
      bbox,
      cache: path.join(directory, "cache"),
      out: directory,
      maxCells: 200_000,
      maxWorldChunks: 400,
      worldMargin: 0,
      noAddon: true,
      buildings: "markers",
      accuracyMode: "plausible",
      disablePlanItDiscovery: true,
      acquireElevationImpl: async () => {
        const result = {
          provider: "Mock 1 m LiDAR",
          sourceKind: "ea-lidar",
          resolutionM: 1,
          minM: 80,
          maxM: 120,
          points: []
        };
        Object.defineProperty(result, "sampleLocal", {
          enumerable: false,
          value: (x, z) => 100 + x * 0.04 + z * 0.025
        });
        Object.defineProperty(result, "sampleSurfaceLocal", {
          enumerable: false,
          value: (x, z) => 104 + x * 0.04 + z * 0.025
        });
        return result;
      },
      planningAcquirerImpl: planningNone
    });

    const report = await validateBedrockContent({
      root: directory,
      report: path.join(directory, "bedrock-content-qa.json"),
      markdown: path.join(directory, "BEDROCK_CONTENT_QA.md")
    });
    assert.equal(report.status, "passed", report.failures?.join("; "));
    assert.ok(report.terrain.decodedReliefBlocks >= 5);
    assert.ok(report.terrain.distinctSurfaceHeights >= 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("decoded Bedrock content acceptance rejects a flat world whose evidence claims strong terrain relief", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "voxel-bedrock-content-reject-"));
  try {
    const result = await buildPark({
      parkName: "False Relief Fixture",
      osm: fixture,
      bbox,
      elevation: "none",
      cache: path.join(directory, "cache"),
      out: directory,
      maxCells: 200_000,
      maxWorldChunks: 400,
      worldMargin: 0,
      noAddon: true,
      buildings: "markers",
      accuracyMode: "plausible",
      disablePlanItDiscovery: true,
      planningAcquirerImpl: planningNone
    });

    const evidence = JSON.parse(await readFile(result.paths.evidence, "utf8"));
    evidence.source.elevation = {
      provider: "Claimed LiDAR",
      sourceKind: "ea-lidar",
      resolutionM: 1,
      minM: 90,
      maxM: 150
    };
    evidence.compilation.meta.spawnLocal = {
      ...(evidence.compilation.meta.spawnLocal || {}),
      y: -90
    };
    await writeFile(result.paths.evidence, `${JSON.stringify(evidence, null, 2)}\n`);

    const report = await validateBedrockContent({
      root: directory,
      report: path.join(directory, "bedrock-content-qa.json"),
      markdown: path.join(directory, "BEDROCK_CONTENT_QA.md")
    });
    assert.equal(report.status, "failed");
    assert.ok(report.failures.some((message) =>
      /effectively flat|flat foundation|below the elevation datum|buried beneath the foundation/i.test(message)
    ), report.failures.join("; "));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
