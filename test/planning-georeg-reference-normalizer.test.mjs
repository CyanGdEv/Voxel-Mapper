import test from "node:test";
import assert from "node:assert/strict";
import {
  clipGeometryToRect,
  deduplicateRelationWayFeatures,
  normalizePlanningGeoregReferenceFeatures
} from "../src/lib/planning-georeg-reference-normalizer.mjs";

const projector = { forward: ([lon, lat]) => [lon * 100, lat * 100] };
const bbox = { south: 0, west: 0, north: 10, east: 10 };

function line(id, coordinates, extra = {}) {
  return {
    id,
    name: extra.name || null,
    kind: extra.kind || "path",
    subtype: extra.subtype || "footway",
    tags: extra.tags || {},
    localGeometry: { type: "LineString", coordinates },
    source: { elementType: extra.elementType || "way", elementId: extra.elementId || id }
  };
}

test("line and polygon geometry is clipped to the bbox buffer instead of retaining full intersecting OSM geometry", () => {
  const clippedLine = clipGeometryToRect(
    { type: "LineString", coordinates: [[-500, 500], [500, 500], [1500, 500]] },
    { minX: 0, maxX: 1000, minZ: 0, maxZ: 1000 }
  );
  assert.equal(clippedLine.type, "LineString");
  assert.deepEqual(clippedLine.coordinates, [[0, 500], [500, 500], [1000, 500]]);

  const clippedPolygon = clipGeometryToRect({
    type: "Polygon",
    coordinates: [[[-100, -100], [1100, -100], [1100, 1100], [-100, 1100], [-100, -100]]]
  }, { minX: 0, maxX: 1000, minZ: 0, maxZ: 1000 });
  assert.equal(clippedPolygon.type, "Polygon");
  for (const [x, z] of clippedPolygon.coordinates[0]) {
    assert.ok(x >= 0 && x <= 1000);
    assert.ok(z >= 0 && z <= 1000);
  }
});

test("named relation wins over an overlapping same-feature way", () => {
  const relation = line("osm:relation:1", [[0, 500], [1000, 500]], {
    name: "River Example", kind: "water", subtype: "river", elementType: "relation"
  });
  const way = line("osm:way:1", [[100, 500], [900, 500]], {
    name: "River Example", kind: "water", subtype: "river", elementType: "way"
  });
  const unrelated = line("osm:way:2", [[0, 700], [1000, 700]], {
    name: "Different River", kind: "water", subtype: "river", elementType: "way"
  });
  const result = deduplicateRelationWayFeatures([way, relation, unrelated]);
  assert.equal(result.removed, 1);
  assert.deepEqual(result.features.map((entry) => entry.id).sort(), [relation.id, unrelated.id].sort());
});

test("reference normalization excludes building=no and bounds every retained feature", () => {
  const features = [
    line("long", [[-1000, 500], [2000, 500]]),
    {
      id: "not-a-building",
      name: "Ride footprint",
      kind: "building",
      subtype: "no",
      tags: { building: "no" },
      localGeometry: {
        type: "Polygon",
        coordinates: [[[100, 100], [200, 100], [200, 200], [100, 200], [100, 100]]]
      },
      source: { elementType: "way", elementId: 3 }
    },
    line("outside", [[1200, 1200], [1300, 1300]])
  ];
  const result = normalizePlanningGeoregReferenceFeatures(features, projector, bbox, { bufferM: 0 });
  assert.equal(result.summary.excludedBuildingNo, 1);
  assert.equal(result.summary.droppedOutsideBbox, 1);
  assert.equal(result.summary.clippedFeatureCount, 1);
  assert.equal(result.features.length, 1);
  assert.deepEqual(result.features[0].localGeometry.coordinates, [[0, 500], [1000, 500]]);
});
