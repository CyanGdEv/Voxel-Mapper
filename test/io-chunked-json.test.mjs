import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readJson, writeJson } from "../src/lib/io.mjs";

test("writeJson transparently streams and rehydrates large top-level arrays", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-chunked-json-"));
  const filename = path.join(root, "planning-current-authority-evidence.json");
  const previous = process.env.VOXEL_CHUNKED_JSON_ARRAY_ITEMS;
  process.env.VOXEL_CHUNKED_JSON_ARRAY_ITEMS = "3";
  try {
    const value = {
      schemaVersion: 4,
      worldGeometryAuthority: true,
      terrainPolicy: { geometryAuthority: false, elevationAuthority: false },
      geometryCandidates: Array.from({ length: 7 }, (_, index) => ({
        id: `candidate-${index}`,
        classification: "site_plan",
        semantic: "site-feature-or-building-footprint",
        localGeometry: { type: "Polygon", coordinates: [[[index, 0], [index + 1, 0], [index + 1, 1], [index, 0]]] },
        worldGeometryAuthority: true,
        planningTemporal: { state: "current", observedAt: "2026-08-17T00:00:00Z" }
      })),
      verticalObservations: [
        { id: "vertical-1", valueM: 12.4, worldGeometryAuthority: true, planningTemporal: { state: "current" } }
      ],
      materialObservations: [
        { id: "material-1", material: "brick", worldGeometryAuthority: true, planningTemporal: { state: "current" } }
      ],
      rideStructureTemplates: [],
      drawingMetadata: []
    };

    await writeJson(filename, value);
    const bytes = await readFile(filename);
    assert.equal(bytes[0], 0x1f);
    assert.equal(bytes[1], 0x8b);
    assert.deepEqual(await readJson(filename), value);
  } finally {
    if (previous == null) delete process.env.VOXEL_CHUNKED_JSON_ARRAY_ITEMS;
    else process.env.VOXEL_CHUNKED_JSON_ARRAY_ITEMS = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("writeJson keeps ordinary small artifacts as readable JSON text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-small-json-"));
  const filename = path.join(root, "small.json");
  const previous = process.env.VOXEL_CHUNKED_JSON_ARRAY_ITEMS;
  delete process.env.VOXEL_CHUNKED_JSON_ARRAY_ITEMS;
  try {
    const value = { schemaVersion: 1, items: [{ id: "a" }, { id: "b" }] };
    await writeJson(filename, value);
    const text = await readFile(filename, "utf8");
    assert.equal(text.trimStart()[0], "{");
    assert.deepEqual(await readJson(filename), value);
  } finally {
    if (previous == null) delete process.env.VOXEL_CHUNKED_JSON_ARRAY_ITEMS;
    else process.env.VOXEL_CHUNKED_JSON_ARRAY_ITEMS = previous;
    await rm(root, { recursive: true, force: true });
  }
});
