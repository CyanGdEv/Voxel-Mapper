import test from "node:test";
import assert from "node:assert/strict";
import { applyOfficialSourceAuthority, resolveOfficialSourcePolicy, AUTHORITATIVE_SOURCE_CATALOG } from "../src/lib/official-source-authority.mjs";

function polygon(x0, z0, x1, z1) {
  return { type: "Polygon", coordinates: [[[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]]] };
}
function line(points) { return { type: "LineString", coordinates: points }; }
function feature({ id, provider, dataset, kind, subtype, geometry, rank = null, name = null }) {
  return {
    id, name, kind, subtype,
    geometry,
    localGeometry: geometry,
    tags: {},
    source: { provider, dataset, sourceUrl: provider === "OpenStreetMap" ? "https://openstreetmap.org" : "https://www.ordnancesurvey.co.uk" },
    verification: { plan: provider === "OpenStreetMap" ? "public-map" : "licensed-public-observation" },
    authority: rank === null ? undefined : { layer: "existing", rank, geometryLocked: rank >= 400 }
  };
}

test("official source catalog includes the requested OS building/structure/transport/land/identity sources", () => {
  const ids = new Set(AUTHORITATIVE_SOURCE_CATALOG.map((entry) => entry.id));
  for (const id of [
    "os-building-features", "os-structure-features", "os-transport-features",
    "os-land-features", "os-land-use-features", "os-open-greenspace",
    "os-open-roads", "os-open-uprn", "os-terrain-50", "planning-data-england"
  ]) assert.ok(ids.has(id), `missing ${id}`);
});

test("clear OS Building Features geometry replaces matching OSM building", () => {
  const osm = feature({ id: "osm:way:1", provider: "OpenStreetMap", kind: "building", subtype: "yes", geometry: polygon(0, 0, 10, 10), rank: 100 });
  const official = feature({ id: "public:os:building:1", provider: "Ordnance Survey", dataset: "OS Building Features", kind: "building", subtype: "building", geometry: polygon(0.2, 0.1, 10.1, 10.2) });
  const map = { features: [osm, official], sourceFusion: {} };
  const stats = applyOfficialSourceAuthority(map);
  assert.equal(stats.osmFallbackFeaturesRemoved, 1);
  assert.deepEqual(map.features.map((item) => item.id), [official.id]);
  assert.equal(official.authority.layer, "official-building-geometry");
  assert.ok(official.authority.rank > 100);
  assert.deepEqual(official.source.supersedes, [osm.id]);
});

test("OS Transport Features replaces a clearly matching OSM path but not a different nearby path", () => {
  const osmSame = feature({ id: "osm:way:path-a", provider: "OpenStreetMap", kind: "path", subtype: "footway", geometry: line([[0, 0], [20, 0]]), rank: 100, name: "Main Walk" });
  const osmOther = feature({ id: "osm:way:path-b", provider: "OpenStreetMap", kind: "path", subtype: "footway", geometry: line([[0, 8], [20, 8]]), rank: 100, name: "Other Walk" });
  const official = feature({ id: "public:os:path", provider: "Ordnance Survey", dataset: "OS Transport Features", kind: "path", subtype: "footway", geometry: line([[0, 0.5], [20, 0.5]]), name: "Main Walk" });
  const map = { features: [osmSame, osmOther, official], sourceFusion: {} };
  const stats = applyOfficialSourceAuthority(map, { sourceFusionToleranceM: 2 });
  assert.equal(stats.osmFallbackFeaturesRemoved, 1);
  assert.ok(!map.features.some((item) => item.id === osmSame.id));
  assert.ok(map.features.some((item) => item.id === osmOther.id));
});

test("ambiguous official polygon overlap is retained rather than deleting OSM", () => {
  const osm = feature({ id: "osm:way:surface", provider: "OpenStreetMap", kind: "surface", subtype: "grass", geometry: polygon(0, 0, 10, 10), rank: 100 });
  const official = feature({ id: "public:os:land", provider: "Ordnance Survey", dataset: "OS Land Features", kind: "surface", subtype: "grass", geometry: polygon(6, 0, 16, 10) });
  const map = { features: [osm, official], sourceFusion: {} };
  const stats = applyOfficialSourceAuthority(map);
  assert.equal(stats.osmFallbackFeaturesRemoved, 0);
  assert.equal(map.features.length, 2);
  assert.ok(stats.ambiguousOverlapsRetained >= 1);
});

test("OS Open Roads is topology corroboration and cannot replace detailed OSM geometry", () => {
  const osm = feature({ id: "osm:way:road", provider: "OpenStreetMap", kind: "road", subtype: "service", geometry: line([[0, 0], [20, 0]]), rank: 100 });
  const official = feature({ id: "public:os:road", provider: "Ordnance Survey", dataset: "OS Open Roads", kind: "road", subtype: "road", geometry: line([[0, 0], [20, 0]]) });
  const policy = resolveOfficialSourcePolicy(official);
  assert.equal(policy.geometryAuthority, false);
  const map = { features: [osm, official], sourceFusion: {} };
  const stats = applyOfficialSourceAuthority(map);
  assert.equal(stats.osmFallbackFeaturesRemoved, 0);
  assert.equal(official.authority.geometryRole, "transport-topology-corroboration");
});

test("planning/verified authority is never demoted by official-source policy", () => {
  const planning = feature({ id: "planning:building", provider: "Planning application", dataset: "current approved site plan", kind: "building", subtype: "building", geometry: polygon(0, 0, 10, 10), rank: 450 });
  const map = { features: [planning], sourceFusion: {} };
  applyOfficialSourceAuthority(map);
  assert.equal(planning.authority.rank, 450);
  assert.equal(planning.authority.layer, "existing");
});
