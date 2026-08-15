import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { acquireSources } from "../src/lib/sources.mjs";

async function withOsmFixture(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-auto-source-"));
  const osmPath = path.join(root, "osm.json");
  await writeFile(osmPath, JSON.stringify({ version: 0.6, elements: [] }));
  try {
    return await callback({ root, osmPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const ENGLAND_BBOX = "52.98,-1.90,52.99,-1.88";

test("acquireSources uses bbox registry and planning discovery without a park name", async () => {
  await withOsmFixture(async ({ root, osmPath }) => {
    const sources = await acquireSources({
      bbox: ENGLAND_BBOX,
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
  });
});

test("automatic terrain acquisition falls back when the best executable provider fails", async () => {
  await withOsmFixture(async ({ root, osmPath }) => {
    const attempts = [];
    const sources = await acquireSources({
      bbox: ENGLAND_BBOX,
      osm: osmPath,
      cache: path.join(root, "cache"),
      acceptOpenMeteoTerms: true,
      acquireElevationImpl: async ({ elevation }) => {
        attempts.push(elevation);
        if (elevation === "ea-lidar") throw new Error("mock EA coverage miss");
        return { provider: "Mock Open-Meteo", resolutionM: 90, points: [] };
      },
      planningAcquirerImpl: async () => ({
        provider: "Mock Planning", providerId: "planning-data-england", status: "acquired",
        applicationCount: 0, jurisdictionCount: 0, applications: [], jurisdictions: []
      })
    });

    assert.deepEqual(attempts, ["ea-lidar", "open-meteo"]);
    assert.equal(sources.elevation.provider, "Mock Open-Meteo");
    assert.equal(sources.autoSelection.terrain, "open-meteo-copernicus-glo90");
    assert.deepEqual(sources.acquisitionAttempts.terrain.map((entry) => entry.status), ["failed", "success"]);
  });
});

test("planning provider failure degrades fidelity instead of aborting the bbox build", async () => {
  await withOsmFixture(async ({ root, osmPath }) => {
    const sources = await acquireSources({
      bbox: ENGLAND_BBOX,
      osm: osmPath,
      elevation: "none",
      cache: path.join(root, "cache"),
      planningAcquirerImpl: async () => { throw new Error("mock planning API outage"); }
    });

    assert.equal(sources.planning.status, "failed");
    assert.equal(sources.planning.applicationCount, 0);
    assert.equal(sources.planning.jurisdictionCount, 0);
    assert.match(sources.planning.warning, /continuing with lower-authority evidence/);
    assert.equal(sources.acquisitionAttempts.planning[0].status, "failed");
  });
});

test("terrain and planning acquisition start concurrently once bbox/source selection is resolved", async () => {
  await withOsmFixture(async ({ root, osmPath }) => {
    let releaseTerrain;
    let releasePlanning;
    let terrainStartedResolve;
    let planningStartedResolve;
    const terrainGate = new Promise((resolve) => { releaseTerrain = resolve; });
    const planningGate = new Promise((resolve) => { releasePlanning = resolve; });
    const terrainStarted = new Promise((resolve) => { terrainStartedResolve = resolve; });
    const planningStarted = new Promise((resolve) => { planningStartedResolve = resolve; });
    let acquisition;
    try {
      acquisition = acquireSources({
        bbox: ENGLAND_BBOX,
        osm: osmPath,
        elevation: "none",
        cache: path.join(root, "cache"),
        acquireElevationImpl: async () => {
          terrainStartedResolve();
          await terrainGate;
          return { provider: "Mock Terrain", resolutionM: null, points: [] };
        },
        planningAcquirerImpl: async () => {
          planningStartedResolve();
          await planningGate;
          return {
            provider: "Mock Planning", providerId: "planning-data-england", status: "acquired",
            applicationCount: 0, jurisdictionCount: 0, applications: [], jurisdictions: []
          };
        }
      });
      await Promise.race([
        Promise.all([terrainStarted, planningStarted]),
        new Promise((_, reject) => setTimeout(() => reject(new Error("independent source acquisition did not overlap")), 250))
      ]);
    } finally {
      releaseTerrain?.();
      releasePlanning?.();
      await acquisition?.catch(() => {});
    }
  });
});
