import test from "node:test";
import assert from "node:assert/strict";
import { corroboratePlanningGeometryCandidate } from "../src/lib/planning-current-corroboration.mjs";

const square = (x) => ({
  type: "Polygon",
  coordinates: [[[x, 0], [x + 10, 0], [x + 10, 10], [x, 10], [x, 0]]]
});

const candidate = {
  id: "planning:site-plan:1",
  classification: "site_plan",
  semantic: "site-feature-or-building-footprint",
  georegistrationStatus: "registered",
  localGeometry: square(0)
};

const temporal = [{
  statusEvidence: ["Planning Permission - Approved"],
  dateEvidence: [{ kind: "decision-date", value: "02/06/2017" }]
}];

function currentBuilding(id, x) {
  return {
    id,
    kind: "building",
    localGeometry: square(x),
    source: {
      provider: "OpenStreetMap",
      elementType: "way",
      elementId: id,
      version: 2,
      timestamp: "2024-01-01T00:00:00Z"
    }
  };
}

test("current-state corroboration uses the canonical 0.08 ambiguity separation", () => {
  const result = corroboratePlanningGeometryCandidate(candidate, [
    currentBuilding(1, 0),
    currentBuilding(2, 1.5)
  ], { applicationTemporal: temporal });

  assert.equal(result.accepted, true);
  assert.equal(result.temporal.worldGeometryAuthority, true);
  assert.equal(result.temporal.implementationCorroboration.featureId, 1);
  assert.ok(result.temporal.implementationCorroboration.matchScore >= 0.78);
  assert.ok(result.temporal.implementationCorroboration.matchScore - result.temporal.implementationCorroboration.secondScore >= 0.08);
  assert.ok(result.temporal.implementationCorroboration.matchScore - result.temporal.implementationCorroboration.secondScore < 0.12);
});
