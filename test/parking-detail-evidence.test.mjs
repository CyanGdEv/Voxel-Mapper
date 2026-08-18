import test from "node:test";
import assert from "node:assert/strict";
import { normalizeParkingFeatures } from "../src/lib/parking-evidence.mjs";
import {
  normalizeParkingDetailFeatures,
  preparePlanningParkingDetailEvidence,
  renderParkingDetails
} from "../src/lib/parking-detail-evidence.mjs";

const square = (x1, z1, x2, z2) => ({
  type: "Polygon",
  coordinates: [[[x1, z1], [x2, z1], [x2, z2], [x1, z2], [x1, z1]]]
});
const line = (...points) => ({ type: "LineString", coordinates: points });

function feature(id, tags, localGeometry, extras = {}) {
  return {
    id,
    kind: extras.kind || "amenity",
    subtype: extras.subtype || tags.amenity || "test",
    tags: { ...tags },
    localGeometry,
    geometry: localGeometry,
    source: extras.source || { provider: "Official survey" },
    authority: extras.authority || { layer: "official-transport-geometry", rank: 350 },
    ...extras
  };
}

function baseCompilation() {
  return {
    meta: { bounds: { minX: -10, minZ: -10, maxX: 40, maxZ: 40 }, elevationDatumM: 100, statefulBlockReplacements: [] },
    palette: ["minecraft:stone"],
    chunks: [],
    stats: { rawOperations: 0, estimatedBlocks: 0 }
  };
}

test("explicit bay polygon records measured orientation rather than synthesizing a layout", () => {
  const parking = feature("park", { amenity: "parking" }, square(0, 0, 30, 30));
  const bay = feature("bay", { amenity: "parking_space" }, {
    type: "Polygon",
    coordinates: [[[2, 2], [8, 2], [8, 5], [2, 5], [2, 2]]]
  });
  const map = { features: [parking, bay] };
  normalizeParkingFeatures(map);
  const summary = normalizeParkingDetailFeatures(map);
  assert.equal(summary.orientedBays, 1);
  assert.equal(bay.parkingEvidence.orientation.method, "longest-explicit-polygon-edge");
  assert.equal(bay.parkingEvidence.orientation.angleDeg, 0);
  assert.equal(bay.parkingEvidence.orientation.inferred, false);
});

test("explicit kerb line inside a car park renders as raised stateful slab cells", () => {
  const parking = feature("park", { amenity: "parking" }, square(0, 0, 30, 30));
  const kerb = feature("kerb", { barrier: "kerb", "parking:detail": "parking_kerb" }, line([2, 4], [12, 4]), { kind: "barrier", subtype: "kerb" });
  const map = { features: [parking, kerb] };
  normalizeParkingFeatures(map);
  const evidence = normalizeParkingDetailFeatures(map);
  assert.equal(evidence.kerbs, 1);

  const compilation = baseCompilation();
  const result = renderParkingDetails(compilation, { map, sources: { elevation: { sampleLocal: () => 100 } } });
  assert.ok(result.kerbCells > 0);
  assert.ok(compilation.meta.statefulBlockReplacements.some((entry) =>
    entry.kind === "parking-kerb-slab" && entry.name === "minecraft:stone_brick_slab" && entry.states["minecraft:vertical_half"] === "bottom"
  ));
});

test("explicit arrow and hatching linework renders but polygon-only pattern evidence is deferred", () => {
  const parking = feature("park", { amenity: "parking" }, square(0, 0, 30, 30));
  const arrow = feature("arrow", { road_marking: "direction_arrow", "parking:detail": "parking_direction_arrow" }, line([4, 8], [9, 8]), { kind: "surface", subtype: "parking_direction_arrow" });
  const hatchArea = feature("hatch", { road_marking: "hatching", "parking:detail": "parking_hatching" }, square(15, 10, 22, 18), { kind: "surface", subtype: "parking_hatching" });
  const map = { features: [parking, arrow, hatchArea] };
  normalizeParkingFeatures(map);
  normalizeParkingDetailFeatures(map);
  const compilation = baseCompilation();
  const result = renderParkingDetails(compilation, { map, sources: { elevation: { sampleLocal: () => 100 } } });
  assert.equal(result.arrowFeatures, 1);
  assert.equal(result.hatchingFeatures, 1);
  assert.ok(result.markingCells > 0);
  assert.equal(result.polygonPatternsDeferred, 1);
});

test("planning parking detail labels are classified without granting authority or inferred patterns", () => {
  const prepared = preparePlanningParkingDetailEvidence({
    geometryCandidates: [
      { id: "kerb", label: "Car Park Kerb Line", localGeometry: line([0, 0], [10, 0]), worldGeometryAuthority: true, planningTemporal: { state: "current" } },
      { id: "cross", label: "Pedestrian Crossing", localGeometry: square(2, 2, 8, 5), worldGeometryAuthority: true, planningTemporal: { state: "current" } },
      { id: "hatch", label: "Hatched Area", localGeometry: line([2, 8], [8, 12]), worldGeometryAuthority: true, planningTemporal: { state: "current" } }
    ]
  }).geometryCandidates;
  assert.equal(prepared[0].parkingDetailEvidence.role, "kerb");
  assert.equal(prepared[0].kind, "barrier");
  assert.equal(prepared[1].parkingDetailEvidence.role, "crossing");
  assert.equal(prepared[1].parkingDetailEvidence.inferredPatternAllowed, false);
  assert.equal(prepared[2].parkingDetailEvidence.role, "hatching");
  assert.equal(prepared[2].parkingDetailEvidence.exactLinework, true);
});
