import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { acquireSources } from "../src/lib/sources.mjs";

test("acquireSources uses bbox registry and planning discovery without a park name", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-auto-source-"));
  const osmPath = path.join(root, "osm.json");
  await writeFile(osmPath, JSON.stringify({ version: 0.6, elements: [] }));
  try {
    const sources = await acquireSources({
      bbox: "52.98,-1.90,52.99,-1.88",
      osm: osmPath,
      elevation: "none",
      cache: path.join(root, "cache"),
      noCache: true,
      maxPlanningApplications: 5,
      fetchJsonImpl: async (url) => {
        const dataset = url.searchParams.get("dataset");
        if (dataset === "local-planning-authority") {
          return { entities: [{ entity: 6001, reference: "E06000001", name: "BBox Planning Authority" }] };
        }
        return { entities: [{ entity: 7001, reference: "26/00001/FUL", dataset: "planning-application", name: "BBox application" }] };
      }
    });

    assert.equal(sources.parkName, "Bounding Box Build");
    assert.equal(sources.sourcePlan.selected.osm.providerId, "openstreetmap-overpass");
    assert.equal(sources.sourcePlan.selected.planning.providerId, "planning-data-england");
    assert.equal(sources.autoSelection.planning, "planning-data-england");
    assert.equal(sources.planning.applicationCount, 1);
    assert.equal(sources.planning.jurisdictionCount, 1);
    assert.equal(sources.planning.applications[0].reference, "26/00001/FUL");
    assert.equal(sources.planning.jurisdictions[0].name, "BBox Planning Authority");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
