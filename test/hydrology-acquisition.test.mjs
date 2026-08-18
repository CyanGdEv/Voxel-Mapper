import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { gridSquaresForBbox, parseOpenMapLocalWaterGml } from "../src/lib/hydrology-acquisition.mjs";
import { resolveSourcePlan } from "../src/lib/source-registry.mjs";
import { RUNTIME_SOURCE_PROVIDERS } from "../src/lib/runtime-source-providers.mjs";
import { acquireSources } from "../src/lib/sources.mjs";
import { normalizeMap } from "../src/lib/osm.mjs";

const ALTON = { south: 52.9820, west: -1.9000, north: 52.9945, east: -1.8665 };
const ALTON_TEXT = "52.9820,-1.9000,52.9945,-1.8665";

test("Alton Towers bbox resolves to the OS SK 100 km OpenMap tile", () => {
  assert.deepEqual(gridSquaresForBbox(ALTON), ["SK"]);
});

test("runtime source registry selects independent OS OpenMap Local hydrology ahead of OSM in Great Britain", () => {
  const plan = resolveSourcePlan(ALTON, { providers: RUNTIME_SOURCE_PROVIDERS });
  assert.equal(plan.selected.hydrology.providerId, "os-openmap-local-water");
  assert.equal(plan.selected.hydrology.acquisition.adapter, "os-openmap-local-water");
});

test("OpenMap Local GML parser retains only bbox-intersecting surface-water geometry with independent provenance", () => {
  const xml = `<?xml version="1.0"?>
    <oml:SurfaceWater_Area gml:id="water-area-1">
      <oml:geometry><gml:Polygon srsName="urn:ogc:def:crs:EPSG::27700"><gml:exterior><gml:LinearRing>
        <gml:posList>406000 343000 408000 343000 408000 345000 406000 345000 406000 343000</gml:posList>
      </gml:LinearRing></gml:exterior></gml:Polygon></oml:geometry>
    </oml:SurfaceWater_Area>
    <oml:SurfaceWater_Line gml:id="water-line-far-away">
      <oml:geometry><gml:LineString><gml:posList>100000 100000 101000 101000</gml:posList></gml:LineString></oml:geometry>
    </oml:SurfaceWater_Line>`;
  const features = parseOpenMapLocalWaterGml(xml, ALTON, "SK", "fixture.gml");
  assert.equal(features.length, 1);
  assert.equal(features[0].id, "public:os-openmap-local:water-area-1");
  assert.equal(features[0].kind, "water");
  assert.equal(features[0].source.provider, "Ordnance Survey");
  assert.equal(features[0].source.license, "OGL-3.0");
  assert.equal(features[0].authority.rank, 300);
});

test("bbox source acquisition can inject independent water and normalization retains its provider authority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-hydrology-source-"));
  const osmPath = path.join(root, "osm.json");
  await writeFile(osmPath, JSON.stringify({
    version: 0.6,
    elements: [{
      type: "way", id: 1,
      tags: { natural: "water", water: "pond" },
      geometry: [
        { lon: -1.890, lat: 52.986 }, { lon: -1.888, lat: 52.986 },
        { lon: -1.888, lat: 52.988 }, { lon: -1.890, lat: 52.988 }, { lon: -1.890, lat: 52.986 }
      ]
    }]
  }));
  try {
    const sources = await acquireSources({
      bbox: ALTON_TEXT,
      osm: osmPath,
      elevation: "none",
      cache: path.join(root, "cache"),
      noCache: true,
      autoHydrologyWithLocalOsm: true,
      disablePlanItDiscovery: true,
      planningAcquirerImpl: async () => ({
        provider: "Mock Planning", providerId: "planning-data-england", status: "acquired",
        applicationCount: 0, jurisdictionCount: 0, applications: [], jurisdictions: []
      }),
      hydrologyAcquirerImpl: async (_options, provider) => ({
        provider: provider.providerName,
        providerId: provider.providerId,
        status: "acquired",
        bathymetryProvided: false,
        features: [{
          id: "public:os-openmap-local:test-water",
          kind: "water", subtype: "surface-water-area", name: null,
          tags: { natural: "water", water: "surface_water" },
          geometry: {
            type: "Polygon",
            coordinates: [[
              [-1.8901, 52.9859], [-1.8879, 52.9859], [-1.8879, 52.9881],
              [-1.8901, 52.9881], [-1.8901, 52.9859]
            ]]
          },
          source: { provider: "Ordnance Survey", license: "OGL-3.0", dataset: "OS OpenMap - Local" },
          verification: { plan: "licensed-public-observation", vertical: "unknown" },
          authority: { layer: "licensed-public-water", rank: 300, geometryLocked: false }
        }],
        featureCount: 1,
        acquisitionAttempts: [{ providerId: provider.providerId, status: "success" }]
      })
    });
    assert.equal(sources.autoSelection.hydrology, "os-openmap-local-water");
    assert.equal(sources.hydrology.featureCount, 1);
    const map = await normalizeMap(sources, {});
    const independent = map.features.find((feature) => feature.id === "public:os-openmap-local:test-water");
    assert.ok(independent);
    assert.equal(independent.source.provider, "Ordnance Survey");
    assert.equal(independent.authority.rank, 315);
    assert.equal(independent.authority.layer, "official-openmap-local-geometry");
    assert.ok(independent.localGeometry);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
