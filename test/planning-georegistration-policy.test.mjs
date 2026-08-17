import test from "node:test";
import assert from "node:assert/strict";
import { enforcePlanningPageRegistrationPolicy } from "../src/lib/planning-georegistration-policy.mjs";

function registered(overrides = {}) {
  return {
    status: "registered",
    solution: {
      status: "registered",
      pass: true,
      rejectionReasons: [],
      authority: { spatialRegistrationPassed: true, worldGeometryAuthority: false }
    },
    automaticMatches: [],
    explicitControlPoints: 0,
    automaticControlPoints: 0,
    registeredEvidence: { geometryCandidates: [{ id: "x" }] },
    ...overrides
  };
}

test("one automatic shape match cannot register a whole site plan", () => {
  const result = enforcePlanningPageRegistrationPolicy(registered({
    automaticMatches: [{ sourceCandidateId: "plan:a", targetFeatureId: "osm:a" }],
    automaticControlPoints: 4
  }), "site_plan");
  assert.equal(result.status, "unregistered");
  assert.equal(result.registeredEvidence, null);
  assert.equal(result.solution.pass, false);
  assert.match(result.solution.rejectionReasons.join(" "), /requires-3-independent-shape-matches/);
});

test("three independent automatic source/target matches can retain numerical registration", () => {
  const result = enforcePlanningPageRegistrationPolicy(registered({
    automaticMatches: [
      { sourceCandidateId: "plan:a", targetFeatureId: "osm:a" },
      { sourceCandidateId: "plan:b", targetFeatureId: "osm:b" },
      { sourceCandidateId: "plan:c", targetFeatureId: "osm:c" }
    ],
    automaticControlPoints: 12
  }), "landscape_plan");
  assert.equal(result.status, "registered");
  assert.equal(result.solution.pass, true);
  assert.ok(result.registeredEvidence);
});

test("several control points from the same automatic matched object are not independent", () => {
  const result = enforcePlanningPageRegistrationPolicy(registered({
    automaticMatches: [
      { sourceCandidateId: "plan:a", targetFeatureId: "osm:a" },
      { sourceCandidateId: "plan:a", targetFeatureId: "osm:a" },
      { sourceCandidateId: "plan:a", targetFeatureId: "osm:a" }
    ],
    automaticControlPoints: 12
  }), "ride_layout");
  assert.equal(result.status, "unregistered");
  assert.equal(result.policyRejection.uniqueSourceCandidates, 1);
  assert.equal(result.policyRejection.uniqueTargetFeatures, 1);
});

test("scoped explicit control points remain eligible for site plans", () => {
  const result = enforcePlanningPageRegistrationPolicy(registered({
    explicitControlPoints: 4,
    automaticMatches: []
  }), "site_plan");
  assert.equal(result.status, "registered");
  assert.equal(result.solution.pass, true);
});

test("non-world detail classes keep numerical registration for attribute extraction", () => {
  const result = enforcePlanningPageRegistrationPolicy(registered({
    automaticMatches: [{ sourceCandidateId: "plan:a", targetFeatureId: "osm:a" }],
    automaticControlPoints: 4
  }), "floor_plan");
  assert.equal(result.status, "registered");
});
