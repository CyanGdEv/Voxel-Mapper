import test from "node:test";
import assert from "node:assert/strict";
import {
  bboxCoverageRatio,
  BUILTIN_SOURCE_PROVIDERS,
  resolveSourcePlan,
  scoreProvider
} from "../src/lib/source-registry.mjs";

const ALTON = { south: 52.97, west: -1.92, north: 53.01, east: -1.86 };
const ORLANDO = { south: 28.35, west: -81.62, north: 28.45, east: -81.5 };
const TOKYO = { south: 35.61, west: 139.86, north: 35.67, east: 139.92 };

test("England bbox recommends and executes EA LiDAR for terrain/lidar", () => {
  const plan = resolveSourcePlan(ALTON, { kinds: ["terrain", "lidar", "osm"] });
  assert.equal(plan.recommended.terrain.providerId, "environment-agency-lidar-england");
  assert.equal(plan.selected.terrain.providerId, "environment-agency-lidar-england");
  assert.equal(plan.selected.lidar.providerId, "environment-agency-lidar-england");
  assert.equal(plan.selected.osm.providerId, "openstreetmap-overpass");
  assert.equal(plan.gaps.length, 0);
});

test("US bbox recommends 3DEP but falls back to executable global terrain until adapter exists", () => {
  const plan = resolveSourcePlan(ORLANDO, { kinds: ["terrain", "lidar"] });
  assert.equal(plan.recommended.terrain.providerId, "usgs-3dep");
  assert.equal(plan.selected.terrain.providerId, "open-meteo-copernicus-glo90");
  assert.equal(plan.recommended.lidar.providerId, "usgs-3dep");
  assert.equal(plan.selected.lidar, null);
  assert.deepEqual(plan.gaps, [{ kind: "lidar", reason: "adapter-not-implemented", recommendedProviderId: "usgs-3dep" }]);
});

test("global bbox location remains useful without country-specific providers", () => {
  const plan = resolveSourcePlan(TOKYO, { kinds: ["terrain", "planning", "imagery", "landcover"] });
  assert.equal(plan.selected.terrain.providerId, "open-meteo-copernicus-glo90");
  assert.equal(plan.recommended.planning.providerId, "local-planning-authority");
  assert.equal(plan.selected.planning, null);
  assert.equal(plan.recommended.imagery.providerId, "sentinel-2-l2a");
  assert.equal(plan.selected.imagery, null);
  assert.equal(plan.recommended.landcover.providerId, "esa-worldcover-10m");
});

test("coverage ratio handles regional and dateline-spanning bounds", () => {
  const england = BUILTIN_SOURCE_PROVIDERS.find((entry) => entry.id === "environment-agency-lidar-england");
  assert.equal(bboxCoverageRatio(ALTON, england.coverage), 1);
  assert.equal(bboxCoverageRatio(TOKYO, england.coverage), 0);
  const dateline = { south: -10, west: 179, north: 10, east: -179 };
  assert.equal(bboxCoverageRatio(dateline), 1);
});

test("provider preference is a bounded tie-break boost rather than blanket authority", () => {
  const openMeteo = BUILTIN_SOURCE_PROVIDERS.find((entry) => entry.id === "open-meteo-copernicus-glo90");
  const normal = scoreProvider(openMeteo, "terrain", 1, false);
  const preferred = scoreProvider(openMeteo, "terrain", 1, true);
  assert.ok(preferred > normal);
  assert.ok(preferred <= 1);
});

test("excluded providers are never selected or recommended", () => {
  const plan = resolveSourcePlan(ALTON, {
    kinds: ["terrain"],
    excludedProviderIds: ["environment-agency-lidar-england", "copernicus-dem-glo30"]
  });
  assert.equal(plan.recommended.terrain.providerId, "open-meteo-copernicus-glo90");
  assert.equal(plan.selected.terrain.providerId, "open-meteo-copernicus-glo90");
});
