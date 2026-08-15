import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import {
  BBOX_RASTER_SAFETY_LIMIT,
  parseGenerateArgs,
  buildBboxWorldOptions,
  writeBboxBoundaryOverride,
  parseBboxText
} from "../scripts/generate-bbox-world.mjs";

test("bbox-only orchestration does not require a park name or manual planning flag", async () => {
  const args = parseGenerateArgs(["--bbox", "51.1,-1.2,51.2,-1.0"]);
  const handoff = await buildBboxWorldOptions(args, async () => false, false);

  assert.equal(handoff.options.bbox, "51.1,-1.2,51.2,-1.0");
  assert.equal(handoff.options.parkName, undefined);
  assert.equal(handoff.options.planningAuthorityEvidence, undefined);
  assert.equal(handoff.options.noAddon, true);
  assert.equal(handoff.options.buildings, "shells");
  assert.equal(handoff.options.maxCells, 8_000_000);
  assert.equal(handoff.generationEnvelope.rasterSafetyLimitCells, BBOX_RASTER_SAFETY_LIMIT);
  assert.equal(handoff.authority.mode, "lower-authority-fallback");
  assert.equal(handoff.generationEnvelope.mode, "bbox");
  assert.deepEqual(handoff.options.override, [handoff.generationEnvelope.path]);
});

test("current authority artifact is automatically handed to world generation when present", async () => {
  const args = parseGenerateArgs([
    "--bbox", "51.1,-1.2,51.2,-1.0",
    "--authority", "planning-current-authority-evidence.json",
    "--out", "out/test-world"
  ]);
  const handoff = await buildBboxWorldOptions(
    args,
    async (filename) => filename.endsWith("planning-current-authority-evidence.json"),
    false
  );

  assert.equal(handoff.authority.available, true);
  assert.equal(handoff.authority.mode, "current-planning-authority");
  assert.equal(
    handoff.options.planningAuthorityEvidence,
    path.resolve("planning-current-authority-evidence.json")
  );
});

test("bbox world envelope is emitted as a verified park-boundary override", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-bbox-envelope-"));
  try {
    const filename = path.join(root, "boundary.geojson");
    await writeBboxBoundaryOverride("52.9813,-1.8942,52.9953,-1.8722", filename);
    const collection = JSON.parse(await readFile(filename, "utf8"));
    assert.equal(collection.features.length, 1);
    const feature = collection.features[0];
    assert.equal(feature.properties.kind, "park_boundary");
    assert.equal(feature.properties.subtype, "generation_bbox");
    assert.equal(feature.properties.verified, true);
    assert.deepEqual(feature.geometry.coordinates[0][0], [-1.8942, 52.9813]);
    assert.deepEqual(feature.geometry.coordinates[0][2], [-1.8722, 52.9953]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bbox parsing rejects reversed or malformed generation envelopes", () => {
  assert.deepEqual(parseBboxText("51.1,-1.2,51.2,-1.0"), {
    south: 51.1, west: -1.2, north: 51.2, east: -1.0
  });
  assert.throws(() => parseBboxText("51.2,-1.2,51.1,-1.0"), /invalid or reversed/);
  assert.throws(() => parseBboxText("not,a,bbox"), /south,west,north,east/);
});

test("developer-only knobs are not part of the bbox player contract", () => {
  assert.throws(
    () => parseGenerateArgs(["--bbox", "51.1,-1.2,51.2,-1.0", "--planning-authority-min-match-score", "0.7"]),
    /Unknown option/
  );
});
