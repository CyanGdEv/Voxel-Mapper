import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { resolveSourcePlan } from "../src/lib/source-registry.mjs";
import { RUNTIME_SOURCE_PROVIDERS } from "../src/lib/runtime-source-providers.mjs";
import {
  acquireEnglandPlanningData,
  bboxPolygonWkt,
  planningDataSearchUrl
} from "../src/lib/planning-acquisition.mjs";

const ALTON = { south: 52.97, west: -1.92, north: 53.01, east: -1.86 };

test("England bbox gets an executable planning provider without park-specific configuration", () => {
  const plan = resolveSourcePlan(ALTON, { kinds: ["planning"], providers: RUNTIME_SOURCE_PROVIDERS });
  assert.equal(plan.recommended.planning.providerId, "local-planning-authority");
  assert.equal(plan.selected.planning.providerId, "planning-data-england");
  assert.equal(plan.selected.planning.acquisition.adapter, "planning-data-england");
});

test("planning API query uses the bbox directly as WGS84 intersecting geometry", () => {
  const wkt = bboxPolygonWkt(ALTON);
  assert.equal(wkt, "POLYGON((-1.92 52.97,-1.86 52.97,-1.86 53.01,-1.92 53.01,-1.92 52.97))");
  const url = planningDataSearchUrl("https://www.planning.data.gov.uk/entity.json", {
    dataset: "planning-application", wkt, limit: 100, offset: 0
  });
  assert.equal(url.searchParams.get("dataset"), "planning-application");
  assert.equal(url.searchParams.get("geometry"), wkt);
  assert.equal(url.searchParams.get("geometry_relation"), "intersects");
});

test("planning acquisition discovers LPAs, deduplicates applications and respects the cap", async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "voxel-planning-"));
  const calls = [];
  try {
    const result = await acquireEnglandPlanningData({
      bbox: ALTON,
      cacheDir,
      noCache: true,
      maxPlanningApplications: 3,
      userAgent: "VoxelMapper-Test",
      fetchJsonImpl: async (url) => {
        calls.push(url.toString());
        const dataset = url.searchParams.get("dataset");
        if (dataset === "local-planning-authority") {
          return { entities: [{ entity: 9001, reference: "E06000021", name: "Test Planning Authority" }] };
        }
        return {
          entities: [
            { entity: 1, reference: "24/00001/FUL", dataset: "planning-application", name: "Ride works" },
            { entity: 1, reference: "24/00001/FUL", dataset: "planning-application", name: "Ride works duplicate" },
            { entity: 2, reference: "24/00002/FUL", dataset: "planning-application", name: "Building works" }
          ]
        };
      }
    });
    assert.equal(result.applicationCount, 2);
    assert.equal(result.jurisdictionCount, 1);
    assert.equal(result.applications[0].reference, "24/00001/FUL");
    assert.equal(result.jurisdictions[0].name, "Test Planning Authority");
    assert.ok(calls.some((url) => url.includes("dataset=planning-application")));
    assert.ok(calls.some((url) => url.includes("dataset=local-planning-authority")));
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("dateline-spanning bbox is rejected only by the England API adapter", () => {
  assert.throws(
    () => bboxPolygonWkt({ south: -10, west: 179, north: 10, east: -179 }),
    /must not cross the dateline/
  );
});
