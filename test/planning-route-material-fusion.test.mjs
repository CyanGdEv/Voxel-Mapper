import test from "node:test";
import assert from "node:assert/strict";
import { applyPlanningRouteMaterials } from "../src/lib/planning-route-material-fusion.mjs";

function current(entry) {
  return {
    ...entry,
    worldGeometryAuthority: true,
    planningTemporal: { state: "current", confidence: 0.99, worldGeometryAuthority: true }
  };
}

function route() {
  return {
    id: "osm:way:100",
    name: "Ride approach",
    kind: "path",
    subtype: "footway",
    tags: { highway: "footway", surface: "gravel" },
    localGeometry: { type: "LineString", coordinates: [[0, 0], [20, 0]] },
    authority: { layer: "osm", rank: 100 },
    source: { provider: "OpenStreetMap" },
    planningTopologyResolution: { sourceRef: "plan:path:1", operation: "replace" }
  };
}

test("planning material label near a replaced linear path supersedes stale OSM material", () => {
  const feature = route();
  const candidate = current({
    id: "plan:path:1",
    contentHash: "drawing-a",
    pageNumber: 4,
    kind: "path",
    featureKind: "path",
    targetFeatureId: feature.id,
    localGeometry: feature.localGeometry
  });
  const material = current({
    id: "material:1",
    contentHash: "drawing-a",
    pageNumber: 4,
    localX: 10,
    localZ: 1.5,
    material: "resin_bound_beige",
    role: "surface",
    confidence: 0.92
  });
  const map = { features: [feature] };
  const result = applyPlanningRouteMaterials(map, {
    accuracyMode: "verified",
    planningAuthorityEvidenceData: { geometryCandidates: [candidate], materialObservations: [material] }
  });

  assert.equal(result.applied, 1);
  assert.equal(feature.tags.surface, "resin_bound_beige");
  assert.equal(feature.tags.material, "resin_bound_beige");
  assert.equal(feature.materialPalette.surface.key, "resin_bound_beige");
  assert.equal(feature.surfaceStyle.material, "resin_bound_beige");
  assert.equal(feature.surfaceStyle.appearanceStatus, "planning-authoritative");
  assert.equal(feature.planningSurfaceMaterial.method, "planning-material-label-near-route");
});

test("competing current planning material labels fail closed instead of choosing a wrong path material", () => {
  const feature = route();
  const candidate = current({
    id: "plan:path:1",
    contentHash: "drawing-a",
    pageNumber: 4,
    kind: "path",
    featureKind: "path",
    targetFeatureId: feature.id,
    localGeometry: feature.localGeometry
  });
  const observations = [
    current({ id: "material:1", contentHash: "drawing-a", pageNumber: 4, localX: 10, localZ: 1, material: "resin_bound_beige", role: "surface", confidence: 0.91 }),
    current({ id: "material:2", contentHash: "drawing-a", pageNumber: 4, localX: 10, localZ: 1, material: "resin_bound_grey", role: "surface", confidence: 0.9 })
  ];
  const map = { features: [feature] };
  const result = applyPlanningRouteMaterials(map, {
    accuracyMode: "verified",
    planningAuthorityEvidenceData: { geometryCandidates: [candidate], materialObservations: observations }
  });

  assert.equal(result.applied, 0);
  assert.equal(result.unresolved, 1);
  assert.equal(feature.tags.surface, "gravel");
  assert.equal(feature.materialPalette, undefined);
});

test("current planning plaza area receives its certified material without changing its footprint", () => {
  const polygon = { type: "Polygon", coordinates: [[[0, 0], [12, 0], [12, 10], [0, 10], [0, 0]]] };
  const feature = {
    id: "planning-current:plaza",
    kind: "path",
    subtype: "pedestrian_plaza",
    tags: { "area:highway": "pedestrian" },
    localGeometry: polygon,
    authority: { layer: "planning-current-authority", rank: 360 },
    source: { provider: "Planning current-state authority" },
    planningTopologyResolution: { sourceRef: "plan:plaza:1", operation: "add" }
  };
  const candidate = current({
    id: "plan:plaza:1",
    contentHash: "drawing-b",
    pageNumber: 1,
    kind: "path",
    featureKind: "path",
    targetFeatureId: feature.id,
    localGeometry: polygon
  });
  const material = current({
    id: "material:plaza",
    contentHash: "drawing-b",
    pageNumber: 1,
    localX: 6,
    localZ: 5,
    material: "paving_stones",
    role: "surface",
    confidence: 0.94
  });
  const original = JSON.stringify(feature.localGeometry);
  const result = applyPlanningRouteMaterials({ features: [feature] }, {
    accuracyMode: "verified",
    planningAuthorityEvidenceData: { geometryCandidates: [candidate], materialObservations: [material] }
  });

  assert.equal(result.applied, 1);
  assert.equal(feature.tags.surface, "paving_stones");
  assert.equal(feature.materialPalette.surface.key, "paving_stones");
  assert.equal(JSON.stringify(feature.localGeometry), original);
});
