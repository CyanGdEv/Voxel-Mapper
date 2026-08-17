import test from "node:test";
import assert from "node:assert/strict";
import { createProjector, geometryMapCoordinates } from "../src/lib/geo.mjs";
import { compilePlanningChangeSet } from "../src/lib/planning-changeset-compiler.mjs";
import { reconcileCompiledPlanningChanges } from "../src/lib/planning-change-reconciliation.mjs";

const projector = createProjector({ lat: 52.99, lon: -1.89 });
const polygon = (x0, z0, x1, z1) => ({
  type: "Polygon",
  coordinates: [[[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]]]
});
const line = (...coordinates) => ({ type: "LineString", coordinates });

function current(entry) {
  return {
    confidence: 0.95,
    ...entry,
    worldGeometryAuthority: true,
    planningTemporal: { state: "current", confidence: 0.99, reason: "test-current" }
  };
}

function feature(id, kind, localGeometry, rank = 100) {
  return {
    id,
    name: id,
    kind,
    subtype: kind,
    tags: {},
    geometry: geometryMapCoordinates(localGeometry, projector.inverse),
    localGeometry,
    vertical: { heightM: null, minHeightM: 0, elevationM: null, explicit: false },
    source: { provider: "OpenStreetMap", elementType: "way", elementId: id },
    verification: { plan: "public-map", vertical: "unknown" },
    authority: { layer: rank >= 400 ? "verified-override" : "osm", rank, geometryLocked: rank >= 400 }
  };
}

function mapWith(features = []) {
  return { projector, features: [...features] };
}

test("planning terrain geometry is always rejected and never materialized", () => {
  const map = mapWith([feature("osm:rock:1", "terrain_detail", polygon(0, 0, 10, 10))]);
  const evidence = {
    geometryCandidates: [current({
      id: "plan:terrain",
      kind: "terrain_detail",
      classification: "landscape_plan",
      semantic: "landform grading",
      localGeometry: polygon(-5, -5, 15, 15)
    })],
    materialObservations: []
  };
  const result = compilePlanningChangeSet(map, evidence);
  assert.equal(result.terrainPolicy.geometryMutable, false);
  assert.equal(result.terrainPolicy.elevationMutable, false);
  assert.equal(result.counts.review, 1);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.changes[0].reason, "terrain-geometry-immutable");
  assert.equal(result.changes[0].terrainMutationRejected, true);
});

test("landscape area with current material becomes paint-only and keeps terrain immutable", async () => {
  const map = mapWith([]);
  const evidence = {
    geometryCandidates: [current({
      id: "plan:grass-area",
      contentHash: "doc-a",
      pageNumber: 1,
      classification: "landscape_plan",
      semantic: "landscape-area-or-path",
      localGeometry: polygon(0, 0, 20, 20)
    })],
    materialObservations: [current({
      contentHash: "doc-a",
      pageNumber: 1,
      localX: 10,
      localZ: 10,
      material: "grass",
      confidence: 0.94
    })]
  };
  const compiled = compilePlanningChangeSet(map, evidence);
  assert.equal(compiled.counts.paint, 1);
  assert.equal(compiled.candidates[0].planningOperation, "paint");
  assert.equal(compiled.candidates[0].kind, "surface");
  assert.equal(compiled.candidates[0].compiledMaterial, "grass");

  const reconciled = await reconcileCompiledPlanningChanges(map, { planningAuthorityEvidenceData: evidence });
  assert.equal(reconciled.paint.applied, 1);
  const paint = map.features.find((entry) => entry.kind === "surface");
  assert.ok(paint);
  assert.equal(paint.tags.surface, "grass");
  assert.equal(paint.vertical.elevationM, null);
  assert.equal(paint.authority.terrainGeometryAuthority, false);
  assert.equal(paint.planningTopologyResolution.terrainGeometryChanged, false);
  assert.equal(paint.planningTopologyResolution.terrainElevationChanged, false);
});

test("verified-current ride layout fills a missing OSM ride gap", async () => {
  const map = mapWith([]);
  const evidence = {
    geometryCandidates: [current({
      id: "plan:ride",
      classification: "ride_layout",
      semantic: "ride-centerline-or-edge",
      localGeometry: line([0, 0], [10, 0], [20, 5])
    })],
    materialObservations: []
  };
  const compiled = compilePlanningChangeSet(map, evidence);
  assert.equal(compiled.counts.add, 1);
  assert.equal(compiled.candidates[0].kind, "ride_track");
  const reconciled = await reconcileCompiledPlanningChanges(map, { planningAuthorityEvidenceData: evidence });
  assert.equal(reconciled.added, 1);
  assert.equal(map.features[0].kind, "ride_track");
});

test("verified-current building footprint automatically replaces stale OSM geometry", async () => {
  const original = feature("osm:building:1", "building", polygon(0, 0, 10, 10));
  const map = mapWith([original]);
  const evidence = {
    geometryCandidates: [current({
      id: "plan:building",
      classification: "site_plan",
      semantic: "building-footprint-or-room",
      localGeometry: polygon(0, 0, 12, 12)
    })],
    materialObservations: []
  };
  const compiled = compilePlanningChangeSet(map, evidence);
  assert.equal(compiled.counts.replace, 1);
  assert.equal(compiled.candidates[0].targetFeatureId, "osm:building:1");
  const reconciled = await reconcileCompiledPlanningChanges(map, { planningAuthorityEvidenceData: evidence });
  assert.equal(reconciled.replaced, 1);
  assert.deepEqual(original.localGeometry, polygon(0, 0, 12, 12));
});

test("proposed planning never mutates the canonical map", async () => {
  const original = feature("osm:building:2", "building", polygon(0, 0, 10, 10));
  const map = mapWith([original]);
  const evidence = {
    geometryCandidates: [{
      id: "plan:proposed",
      classification: "site_plan",
      semantic: "building-footprint-or-room",
      localGeometry: polygon(0, 0, 15, 15),
      worldGeometryAuthority: false,
      planningTemporal: { state: "proposed", confidence: 0.98 }
    }],
    materialObservations: []
  };
  const compiled = compilePlanningChangeSet(map, evidence);
  assert.equal(compiled.counts.ignored, 1);
  assert.equal(compiled.candidates.length, 0);
  const reconciled = await reconcileCompiledPlanningChanges(map, { planningAuthorityEvidenceData: evidence });
  assert.equal(reconciled.added, 0);
  assert.equal(reconciled.replaced, 0);
  assert.equal(reconciled.deleted, 0);
  assert.deepEqual(original.localGeometry, polygon(0, 0, 10, 10));
});

test("confirmed demolition compiles to a targeted delete", async () => {
  const original = feature("osm:old-building", "building", polygon(0, 0, 10, 10));
  const map = mapWith([original]);
  const evidence = {
    geometryCandidates: [{
      id: "plan:demo",
      classification: "demolition_plan",
      semantic: "demolition-footprint",
      localGeometry: polygon(0, 0, 10, 10),
      worldGeometryAuthority: false,
      planningTemporal: { state: "demolished", confidence: 0.99 }
    }],
    materialObservations: []
  };
  const compiled = compilePlanningChangeSet(map, evidence);
  assert.equal(compiled.counts.delete, 1);
  assert.equal(compiled.candidates[0].targetFeatureId, "osm:old-building");
  const reconciled = await reconcileCompiledPlanningChanges(map, { planningAuthorityEvidenceData: evidence });
  assert.equal(reconciled.deleted, 1);
  assert.equal(map.features.length, 0);
});

test("ambiguous same-kind geometry fails closed", () => {
  const map = mapWith([
    feature("a", "building", polygon(0, 0, 10, 10)),
    feature("b", "building", polygon(0.1, 0.1, 10.1, 10.1))
  ]);
  const evidence = {
    geometryCandidates: [current({
      id: "plan:ambiguous",
      classification: "site_plan",
      semantic: "building-footprint-or-room",
      localGeometry: polygon(0.05, 0.05, 10.05, 10.05)
    })],
    materialObservations: []
  };
  const compiled = compilePlanningChangeSet(map, evidence);
  assert.equal(compiled.counts.review, 1);
  assert.equal(compiled.candidates.length, 0);
  assert.equal(compiled.changes[0].reason, "ambiguous-existing-feature-match");
});

test("post-decision corroboration target disambiguates otherwise ambiguous current planning geometry", () => {
  const map = mapWith([
    feature("osm:a", "building", polygon(0, 0, 10, 10)),
    feature("osm:b", "building", polygon(0.1, 0.1, 10.1, 10.1))
  ]);
  const candidate = current({
    id: "plan:corroborated",
    classification: "site_plan",
    semantic: "site-feature-or-building-footprint",
    localGeometry: polygon(0, 0, 12, 12)
  });
  candidate.planningTemporal.implementationCorroboration = { featureId: "osm:a", matchScore: 0.91 };
  candidate.planningTemporal.reason = "post-decision-current-osm-geometry-corroboration";
  const evidence = {
    geometryCandidates: [candidate],
    materialObservations: []
  };
  const compiled = compilePlanningChangeSet(map, evidence);
  assert.equal(compiled.counts.review, 0);
  assert.equal(compiled.changes[0].targetFeatureId, "osm:a");
  assert.equal(compiled.changes[0].semanticReason, "implementation-corroborated-existing-feature-kind");
  assert.ok(compiled.counts.replace + compiled.counts.retain === 1);
});
