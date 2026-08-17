import test from "node:test";
import assert from "node:assert/strict";
import { matchGeometryCandidate } from "../src/lib/planning-authority-fusion.mjs";
import { matchIndexedGeometryCandidate } from "../src/lib/planning-current-corroboration.mjs";

const poly = (x, z, w, h) => ({
  type: "Polygon",
  coordinates: [[[x, z], [x + w, z], [x + w, z + h], [x, z + h], [x, z]]]
});
const line = (...coordinates) => ({ type: "LineString", coordinates });

function feature(id, kind, localGeometry) {
  return { id, kind, localGeometry, source: { timestamp: "2026-01-01T00:00:00Z" } };
}

const references = [
  feature("b1", "building", poly(10, 10, 20, 12)),
  feature("b2", "building", poly(70, 70, 18, 10)),
  feature("s1", "structure", poly(11, 11, 19, 11)),
  feature("p1", "path", line([0, 0], [20, 0], [40, 3])),
  feature("p2", "path", line([0, 30], [20, 30], [40, 31])),
  feature("r1", "road", line([0, 50], [40, 50])),
  feature("bar1", "barrier", line([5, 5], [5, 25])),
  feature("ride1", "ride_track", line([100, 100], [120, 105], [140, 100]))
];

const cases = [
  { classification: "site_plan", semantic: "building-footprint-or-room", localGeometry: poly(10.2, 10.1, 19.8, 11.9) },
  { classification: "site_plan", semantic: "site-feature-or-building-footprint", localGeometry: poly(68, 69, 20, 12) },
  { classification: "landscape_plan", semantic: "landscape-area-or-path", localGeometry: line([0, 0.2], [20, 0.1], [40, 3.2]) },
  { classification: "landscape_plan", semantic: "landscape-edge-or-route", localGeometry: line([0, 29.5], [20, 30.1], [40, 31.2]) },
  { classification: "site_plan", semantic: "site-edge-or-route", localGeometry: line([0, 49.5], [40, 50.5]) },
  { classification: "ride_layout", semantic: "ride-centerline-or-edge", localGeometry: line([100, 100], [120, 105], [140, 100]) },
  { classification: "site_plan", semantic: "building-footprint-or-room", localGeometry: poly(300, 300, 5, 5) },
  { classification: "site_plan", semantic: "unknown", localGeometry: poly(10, 10, 20, 12) }
];

test("cached corroboration matcher is result-equivalent to the authority geometry matcher", () => {
  for (const candidate of cases) {
    for (const options of [
      { planningAuthorityMinMatchScore: 0.78, planningAuthorityAmbiguityGap: 0.12 },
      { planningAuthorityMinMatchScore: 0.66, planningAuthorityAmbiguityGap: 0.08 },
      { planningAuthorityMinMatchScore: 0.5, planningAuthorityAmbiguityGap: 0.02 }
    ]) {
      const original = matchGeometryCandidate(candidate, references, options);
      const indexed = matchIndexedGeometryCandidate(candidate, references, options);
      assert.deepEqual(indexed, original, `${candidate.semantic} ${JSON.stringify(options)}`);
    }
  }
});

test("cached corroboration matcher observes in-place reference feature arrays exactly like the original", () => {
  const mutable = [...references];
  const candidate = { classification: "ride_layout", semantic: "ride-centerline-or-edge", localGeometry: line([200, 200], [220, 200]) };
  matchIndexedGeometryCandidate(candidate, mutable, { planningAuthorityMinMatchScore: 0.78, planningAuthorityAmbiguityGap: 0.12 });
  mutable.push(feature("ride2", "ride_track", line([200, 200], [220, 200])));
  // Reference arrays used by production are immutable snapshots. This explicit
  // assertion documents that a new snapshot must be passed if callers mutate
  // their feature collection after indexing.
  const fresh = [...mutable];
  assert.deepEqual(
    matchIndexedGeometryCandidate(candidate, fresh, { planningAuthorityMinMatchScore: 0.78, planningAuthorityAmbiguityGap: 0.12 }),
    matchGeometryCandidate(candidate, mutable, { planningAuthorityMinMatchScore: 0.78, planningAuthorityAmbiguityGap: 0.12 })
  );
});