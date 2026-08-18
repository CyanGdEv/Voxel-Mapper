import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeParkingFeatures,
  preparePlanningParkingEvidence,
  renderParkingMarkings
} from "../src/lib/parking-evidence.mjs";
import { enrichPlanningPedestrianEvidence } from "../src/lib/planning-pedestrian-enrichment.mjs";

const square = (x1, z1, x2, z2) => ({
  type: "Polygon",
  coordinates: [[[x1, z1], [x2, z1], [x2, z2], [x1, z2], [x1, z1]]]
});

function feature(id, tags, localGeometry, extras = {}) {
  return {
    id,
    kind: "amenity",
    subtype: tags.amenity || "test",
    tags: { ...tags },
    localGeometry,
    geometry: localGeometry,
    source: { provider: "OpenStreetMap" },
    authority: { layer: "osm", rank: 100 },
    ...extras
  };
}

test("surface OSM parking is promoted to a drivable parking area but remains fallback authority", () => {
  const parking = feature("osm:parking", { amenity: "parking", surface: "asphalt" }, square(0, 0, 20, 20));
  const map = { features: [parking] };
  const summary = normalizeParkingFeatures(map);
  assert.equal(parking.kind, "road");
  assert.equal(parking.subtype, "parking_area");
  assert.equal(parking.tags["area:highway"], "parking");
  assert.equal(parking.parkingEvidence.role, "area");
  assert.equal(parking.parkingEvidence.osmFallback, true);
  assert.equal(parking.parkingEvidence.explicitBayCount, 0);
  assert.equal(summary.osmFallbackAreas, 1);
});

test("structured parking is not flattened into a surface car park", () => {
  const parking = feature("osm:multi", { amenity: "parking", parking: "multi-storey" }, square(0, 0, 20, 20));
  const map = { features: [parking] };
  const summary = normalizeParkingFeatures(map);
  assert.equal(parking.kind, "amenity");
  assert.equal(parking.parkingEvidence.role, "structured");
  assert.equal(summary.structuredParkingRetained, 1);
});

test("explicit parking spaces are preserved as bay evidence and linked to their car park", () => {
  const parking = feature("osm:parking", { amenity: "parking" }, square(0, 0, 20, 20));
  const bay = feature("osm:bay", { amenity: "parking_space" }, square(2, 2, 5, 8));
  const map = { features: [parking, bay] };
  normalizeParkingFeatures(map);
  assert.equal(bay.kind, "surface");
  assert.equal(bay.subtype, "parking_bay");
  assert.deepEqual(parking.parkingEvidence.explicitBayFeatureIds, ["osm:bay"]);
  assert.equal(parking.parkingEvidence.explicitBayCount, 1);
});

test("planning parking semantics produce topology areas/aisles and paint-only explicit bays", () => {
  const evidence = {
    geometryCandidates: [
      { id: "area", label: "Staff Car Park", localGeometry: square(0, 0, 30, 20), worldGeometryAuthority: true, planningTemporal: { state: "current" } },
      { id: "aisle", label: "Parking Aisle", localGeometry: { type: "LineString", coordinates: [[1, 10], [29, 10]] }, worldGeometryAuthority: true, planningTemporal: { state: "current" } },
      { id: "bay", label: "Accessible Parking Bay", localGeometry: square(2, 2, 5, 8), worldGeometryAuthority: true, planningTemporal: { state: "current" } }
    ]
  };
  const prepared = preparePlanningParkingEvidence(evidence).geometryCandidates;
  assert.equal(prepared[0].kind, "road");
  assert.equal(prepared[0].subtype, "parking_area");
  assert.equal(prepared[0].parkingEvidence.role, "area");
  assert.equal(prepared[1].kind, "road");
  assert.equal(prepared[1].subtype, "parking_aisle");
  assert.equal(prepared[2].kind, "surface");
  assert.equal(prepared[2].subtype, "accessible_parking_bay");
  assert.equal(prepared[2].parkingEvidence.inventedBayGridAllowed, false);
});

test("planning drawing nearby labels classify car parks and explicit bays without inferring a grid", () => {
  const extraction = {
    pages: [{
      pageNumber: 1,
      text: { items: [
        { text: "Visitor Car Park", xPt: 30, yPt: 30 },
        { text: "Accessible Parking Bay", xPt: 130, yPt: 30 }
      ] }
    }],
    normalizedEvidence: {
      geometryCandidates: [
        { id: "park", pageNumber: 1, classification: "site_plan", closed: true, boundsPt: { minX: 10, minY: 10, maxX: 80, maxY: 60 } },
        { id: "bay", pageNumber: 1, classification: "site_plan", closed: true, boundsPt: { minX: 110, minY: 10, maxX: 150, maxY: 60 } }
      ]
    }
  };
  const summary = enrichPlanningPedestrianEvidence(extraction, { planningPedestrianLabelRadiusPt: 15 });
  const [area, bay] = extraction.normalizedEvidence.geometryCandidates;
  assert.equal(area.kind, "road");
  assert.equal(area.subtype, "parking_area");
  assert.equal(area.parkingEvidence.role, "area");
  assert.equal(bay.kind, "surface");
  assert.equal(bay.subtype, "accessible_parking_bay");
  assert.equal(summary.counts.parkingArea, 1);
  assert.equal(summary.counts.parkingBay, 1);
  assert.equal(summary.policy.parkingBayGridInferenceAllowed, false);
});

test("parking footprint alone renders zero invented bay markings", () => {
  const parking = feature("osm:parking", { amenity: "parking" }, square(0, 0, 10, 10));
  const map = { features: [parking] };
  normalizeParkingFeatures(map);
  const compilation = baseCompilation();
  const result = renderParkingMarkings(compilation, { map, sources: { elevation: { sampleLocal: () => 100 } } });
  assert.equal(result.parkingAreas, 1);
  assert.equal(result.explicitBayFeatures, 0);
  assert.equal(result.markingCells, 0);
  assert.equal(result.inferredBayFeatures, 0);
  assert.equal(compilation.chunks.length, 0);
});

test("explicit bay geometry renders a real marking outline", () => {
  const parking = feature("official:parking", { amenity: "parking" }, square(0, 0, 10, 10), {
    source: { provider: "Official survey" }, authority: { layer: "official-transport-geometry", rank: 350 }
  });
  const bay = feature("official:bay", { amenity: "parking_space", "marking:colour": "yellow" }, square(2, 2, 5, 7), {
    source: { provider: "Official survey" }, authority: { layer: "official-transport-geometry", rank: 350 }
  });
  const map = { features: [parking, bay] };
  normalizeParkingFeatures(map);
  const compilation = baseCompilation();
  const result = renderParkingMarkings(compilation, { map, sources: { elevation: { sampleLocal: () => 100 } } });
  assert.equal(result.explicitBayFeatures, 1);
  assert.equal(result.markedBayFeatures, 1);
  assert.ok(result.markingCells > 0);
  assert.ok(compilation.palette.includes("minecraft:yellow_concrete"));
  assert.ok(compilation.chunks.some((chunk) => chunk.o.length > 0));
});

function baseCompilation() {
  return {
    meta: { bounds: { minX: -10, minZ: -10, maxX: 40, maxZ: 40 }, elevationDatumM: 100 },
    palette: ["minecraft:stone"],
    chunks: [],
    stats: { rawOperations: 0, estimatedBlocks: 0 }
  };
}
