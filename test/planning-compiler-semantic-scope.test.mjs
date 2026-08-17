import test from "node:test";
import assert from "node:assert/strict";
import { inferPlanningFeatureKind } from "../src/lib/planning-changeset-compiler.mjs";

const line = (...coordinates) => ({ type: "LineString", coordinates });

function feature(id, kind, geometry) {
  return {
    id,
    kind,
    localGeometry: geometry,
    authority: { rank: 100 }
  };
}

test("scheme-certified generic site route cannot be inferred as ride track", () => {
  const geometry = line([0, 0], [10, 5], [20, 0]);
  const map = { features: [feature("ride", "ride_track", geometry)] };
  const candidate = {
    classification: "site_plan",
    semantic: "site-edge-or-route",
    localGeometry: geometry,
    worldGeometryAuthority: true,
    planningTemporal: { state: "current" }
  };
  const result = inferPlanningFeatureKind(candidate, map);
  assert.equal(result.kind, null);
  assert.notEqual(result.reason, "unambiguous-existing-feature-kind");
});

test("ride layout line can still be inferred as ride track", () => {
  const geometry = line([0, 0], [10, 5], [20, 0]);
  const map = { features: [feature("ride", "ride_track", geometry)] };
  const candidate = {
    classification: "ride_layout",
    semantic: "ride-centerline-or-edge",
    localGeometry: geometry,
    worldGeometryAuthority: true,
    planningTemporal: { state: "current" }
  };
  const result = inferPlanningFeatureKind(candidate, map);
  assert.equal(result.kind, "ride_track");
});

test("explicit ride kind on non-ride planning evidence is rejected", () => {
  const candidate = {
    kind: "ride_track",
    classification: "site_plan",
    semantic: "site-edge-or-route",
    localGeometry: line([0, 0], [10, 0])
  };
  const result = inferPlanningFeatureKind(candidate, { features: [] });
  assert.equal(result.kind, null);
  assert.equal(result.reason, "explicit-kind-incompatible-with-planning-semantic");
});
