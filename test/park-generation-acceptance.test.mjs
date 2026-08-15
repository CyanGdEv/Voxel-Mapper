import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  summarizeBboxIntersection,
  validateParkGeneration
} from "../scripts/validate-park-generation.mjs";

const BBOX = "0,0,0.01,0.01";

test("park acceptance certifies a complete data map and world roster", async () => {
  const root = await createFixture({ chunks: 5_000 });
  try {
    const report = await validateParkGeneration({
      root,
      bbox: BBOX,
      report: path.join(root, "acceptance.json"),
      markdown: path.join(root, "acceptance.md")
    });
    assert.equal(report.status, "passed");
    assert.equal(report.dataMap.rideFeatureCount, 1);
    assert.equal(report.dataMap.accessFeatureCount, 20);
    assert.equal(report.dataMap.bboxGenerationEnvelopePresent, true);
    assert.equal(report.topDownPreview.finalFeatureCoverage, 1);
    assert.equal(report.world.validation, "passed");
    assert.deepEqual(report.warnings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("park acceptance rejects the historical small-world failure mode", async () => {
  const root = await createFixture({ chunks: 400 });
  try {
    const report = await validateParkGeneration({
      root,
      bbox: BBOX,
      report: path.join(root, "acceptance.json"),
      markdown: path.join(root, "acceptance.md")
    });
    assert.equal(report.status, "failed");
    assert.match(report.failures.join("\n"), /Chunk roster is too small/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("acceptance surfaces inactive public evidence as fidelity limitations without failing the world", async () => {
  const root = await createFixture({ chunks: 5_000 });
  const evidenceDir = path.join(root, "evidence");
  const preparationDir = path.join(root, "preparation", "out", "bbox-world");
  try {
    await json(path.join(preparationDir, "path-topology-qa.geojson"), {
      type: "FeatureCollection", status: "not-supplied", mode: "off", features: []
    });
    await json(path.join(preparationDir, "orthophoto-qa.geojson"), {
      type: "FeatureCollection", status: "not-supplied", features: []
    });
    await json(path.join(preparationDir, "build-result.json"), {
      confidence: 0.785,
      grade: "C",
      stats: { worldChunks: 5_000, planningApplications: 0, planningAuthorityAppliedAttributes: 0 }
    });
    await json(path.join(preparationDir, "evidence.json"), {
      source: {
        osm: { provider: "OpenStreetMap" },
        elevation: { provider: "Environment Agency LiDAR" },
        planning: { provider: "Planning Data / MHCLG (England)", status: "acquired", applicationCount: 0 }
      }
    });
    await json(path.join(evidenceDir, "bbox-generation-result.json"), {
      worldChunks: 5_000,
      worldValidation: "passed",
      confidence: 0.785,
      grade: "C",
      planningAuthorityAppliedAttributes: 0,
      parallelWorldBuild: { shards: 20, copiedLevelDbEntries: 1000 }
    });

    const report = await validateParkGeneration({
      root,
      bbox: BBOX,
      report: path.join(root, "acceptance.json"),
      markdown: path.join(root, "acceptance.md")
    });

    assert.equal(report.status, "passed");
    assert.equal(report.qaLayers.pathTopology.status, "not-supplied");
    assert.equal(report.qaLayers.pathTopology.mode, "off");
    assert.equal(report.qaLayers.orthophoto.status, "not-supplied");
    assert.equal(report.sources.planning.applications, 0);
    assert.match(report.warnings.join("\n"), /Path topology QA is not-supplied/);
    assert.match(report.warnings.join("\n"), /Orthophoto QA is not-supplied/);
    assert.match(report.warnings.join("\n"), /Planning discovery returned zero applications/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bbox intersection accepts whole crossing ways but rejects unrelated outside geometry", () => {
  const bbox = { south: 0, west: 0, north: 1, east: 1 };
  const crossing = lineFeature("crossing", "road", [[-1, 0.5], [2, 0.5]]);
  const outside = lineFeature("outside", "road", [[-2, 0.4], [-1, 0.6]]);
  const result = summarizeBboxIntersection([crossing, outside], bbox);
  assert.equal(result.entirelyOutsideFeatures, 1);
  assert.equal(result.totalCoordinates, 4);
  assert.equal(result.outsideCoordinates, 4);
});

test("real acceptance covers the complete Alton park and binds the newly dispatched run", async () => {
  const workflow = await readFile(".github/workflows/park-generation-acceptance.yml", "utf8");
  assert.match(workflow, /52\.9820,-1\.9000,52\.9945,-1\.8665/);
  assert.match(workflow, /before_id=/);
  assert.match(workflow, /select\(\.databaseId > \$\{before_id\}\)/);
  assert.doesNotMatch(workflow, /--jq\s+--argjson/);
  assert.doesNotMatch(workflow, /--limit 1 --json databaseId --jq '\.\[0\]\.databaseId \/\/ empty'/);
});

test("parallel preparation retains the canonical top-down preview", async () => {
  const source = await readFile("scripts/prepare-bbox-world-shards.mjs", "utf8");
  assert.match(source, /noPreview:\s*false/);
  assert.doesNotMatch(source, /noPreview:\s*true/);
});

async function createFixture({ chunks }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-park-acceptance-"));
  const evidenceDir = path.join(root, "evidence");
  const preparationDir = path.join(root, "preparation", "out", "bbox-world");
  const planDir = path.join(root, "preparation", "world-shard-inputs");
  const worldDir = path.join(root, "world");
  await Promise.all([
    mkdir(evidenceDir, { recursive: true }),
    mkdir(preparationDir, { recursive: true }),
    mkdir(planDir, { recursive: true }),
    mkdir(worldDir, { recursive: true })
  ]);

  const features = [];
  for (let index = 0; index < 20; index += 1) {
    const lat = 0.001 + index * 0.0003;
    features.push(lineFeature(`path-${index}`, "path", [[0.001, lat], [0.0016, lat]]));
  }
  for (let index = 0; index < 10; index += 1) {
    const x = 0.003 + index * 0.0003;
    features.push(polygonFeature(`building-${index}`, "building", x, 0.003, 0.00015));
  }
  features.push(lineFeature("ride", "ride_track", [[0.005, 0.005], [0.006, 0.005]]));
  features.push(polygonFeature("water", "water", 0.007, 0.007, 0.0004));
  features.push(polygonFeature("bbox", "park_boundary", 0, 0, 0.01, {
    subtype: "generation_bbox",
    verified: true
  }));
  while (features.length < 100) {
    const index = features.length;
    const x = 0.001 + (index % 20) * 0.00035;
    const y = 0.006 + (index % 8) * 0.00035;
    features.push(polygonFeature(`vegetation-${index}`, "vegetation", x, y, 0.00008));
  }

  await json(path.join(preparationDir, "synthetic.geojson"), {
    type: "FeatureCollection",
    features
  });
  await writeFile(path.join(preparationDir, "preview.svg"),
    `<svg>${features.map((_, index) => `<path id="f${index}" d="M0 0 L1 1"/>`).join("")}</svg>`);
  await json(path.join(preparationDir, "path-geometry-qa.geojson"), {
    type: "FeatureCollection", status: "supplied", features: []
  });
  await json(path.join(preparationDir, "path-topology-qa.geojson"), {
    type: "FeatureCollection", status: "supplied", features: []
  });
  await json(path.join(preparationDir, "orthophoto-qa.geojson"), {
    type: "FeatureCollection", status: "supplied", features: []
  });
  await json(path.join(evidenceDir, "bbox-generation-result.json"), {
    worldChunks: chunks,
    worldValidation: "passed",
    confidence: 0.9,
    grade: "A",
    planningAuthorityAppliedAttributes: 2,
    parallelWorldBuild: { shards: 20, copiedLevelDbEntries: 1000 }
  });
  await json(path.join(preparationDir, "build-result.json"), {
    confidence: 0.9,
    grade: "A",
    stats: { worldChunks: chunks, planningApplications: 3, planningAuthorityAppliedAttributes: 2 }
  });
  await json(path.join(preparationDir, "evidence.json"), {
    source: {
      osm: { provider: "OpenStreetMap" },
      elevation: { provider: "Test LiDAR" },
      planning: { provider: "planning", applicationCount: 3 }
    }
  });
  await json(path.join(preparationDir, "world-manifest.json"), {
    chunks,
    validation: { status: "passed", chunksVerified: chunks },
    parallelBuild: { shards: 20, copiedLevelDbEntries: 1000 }
  });
  await json(path.join(planDir, "world-shard-plan.json"), { chunkCount: chunks });
  await writeFile(path.join(worldDir, "synthetic.mcworld"), Buffer.alloc(20_000, 1));
  return root;
}

function lineFeature(id, kind, coordinates) {
  return { type: "Feature", id, properties: { id, kind }, geometry: { type: "LineString", coordinates } };
}

function polygonFeature(id, kind, x, y, size, extraProperties = {}) {
  return {
    type: "Feature",
    id,
    properties: { id, kind, ...extraProperties },
    geometry: {
      type: "Polygon",
      coordinates: [[
        [x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]
      ]]
    }
  };
}

const json = (filename, value) => writeFile(filename, `${JSON.stringify(value, null, 2)}\n`);
