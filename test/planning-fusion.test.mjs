import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjector, geometryMapCoordinates } from "../src/lib/geo.mjs";
import { fusePlanningApplications } from "../src/lib/planning.mjs";
import { deriveSurfaceStyle } from "../src/lib/fidelity.mjs";

function osmFeature({ id = "osm:way:1", kind = "path", name = "Main Path", localGeometry }) {
  const projector = createProjector({ lat: 51, lon: 0 });
  return {
    id, name, kind, subtype: kind === "path" ? "footway" : kind,
    tags: kind === "path" ? { highway: "footway", surface: "asphalt" } : {},
    geometry: geometryMapCoordinates(localGeometry, projector.inverse),
    localGeometry,
    vertical: { heightM: null, heightSource: null, minHeightM: 0, elevationM: null, explicit: false },
    source: { provider: "OpenStreetMap", elementType: "way", elementId: id.split(":").at(-1) },
    verification: { plan: "public-map", vertical: "unknown" },
    authority: { layer: "osm", rank: 100, geometryLocked: false }
  };
}

test("planning geometry automatically replaces a nearby compatible OSM feature and carries material authority", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "voxel-mapper-planning-"));
  const projector = createProjector({ lat: 51, lon: 0 });
  const localPlan = { type: "LineString", coordinates: [[0.5, 0.4], [10.5, 0.4]] };
  const manifest = {
    materials: [{ code: "P01", name: "Red tarmac", role: "surface", palette: "red_tarmac" }],
    applications: [{
      reference: "APP/001",
      source_url: "https://example.invalid/planning/APP-001",
      license: "test",
      features: [{
        type: "Feature",
        geometry: geometryMapCoordinates(localPlan, projector.inverse),
        properties: { name: "Main Path", kind: "path", material_code: "P01" }
      }]
    }]
  };
  const filename = path.join(directory, "planning.json");
  await writeFile(filename, JSON.stringify(manifest));
  const features = [osmFeature({ localGeometry: { type: "LineString", coordinates: [[0, 0], [10, 0]] } })];

  const result = await fusePlanningApplications(features, projector, { planning: [filename] });
  assert.equal(result.summary.replaced, 1);
  assert.equal(result.summary.automaticMatches, 1);
  assert.equal(features.length, 1);
  assert.equal(features[0].authority.layer, "planning");
  assert.equal(features[0].source.replaces, "osm:way:1");
  assert.equal(features[0].materialPalette.surface.key, "P01".toLowerCase());

  const style = deriveSurfaceStyle(features[0]);
  assert.equal(style.appearanceStatus, "planning-authoritative");
  assert.equal(style.primaryBlock, "minecraft:red_concrete");
  assert.equal(style.material, "p01");
});

test("planning delete operation removes an explicitly targeted OSM feature", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "voxel-mapper-planning-delete-"));
  const projector = createProjector({ lat: 51, lon: 0 });
  const manifest = {
    applications: [{ reference: "APP/002", features: [{
      type: "Feature", geometry: null,
      properties: { operation: "delete", target: "osm:way:2" }
    }] }]
  };
  const filename = path.join(directory, "planning.json");
  await writeFile(filename, JSON.stringify(manifest));
  const features = [osmFeature({ id: "osm:way:2", localGeometry: { type: "LineString", coordinates: [[0, 0], [5, 0]] } })];

  const result = await fusePlanningApplications(features, projector, { planning: [filename] });
  assert.equal(result.summary.deleted, 1);
  assert.equal(result.summary.explicitMatches, 1);
  assert.equal(features.length, 0);
});

test("planning manifest enforces the 680 application default safety limit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "voxel-mapper-planning-limit-"));
  const filename = path.join(directory, "planning.json");
  await writeFile(filename, JSON.stringify({
    applications: Array.from({ length: 681 }, (_, index) => ({ reference: `APP/${index + 1}`, features: [] }))
  }));
  const projector = createProjector({ lat: 51, lon: 0 });
  await assert.rejects(
    () => fusePlanningApplications([], projector, { planning: [filename] }),
    /contains 681 applications; limit is 680/
  );
});
