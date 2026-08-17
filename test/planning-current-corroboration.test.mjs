import test from "node:test";
import assert from "node:assert/strict";
import { corroboratePlanningGeometryCandidate, latestPlanningDecisionDate, parsePlanningDate } from "../src/lib/planning-current-corroboration.mjs";

function candidate(overrides = {}) {
  return {
    id: "plan:p1:ride",
    contentHash: "plan",
    pageNumber: 1,
    classification: "ride_layout",
    semantic: "ride-centerline-or-edge",
    georegistrationStatus: "registered",
    localGeometry: {
      type: "LineString",
      coordinates: [[0, 0], [10, 8], [20, 4], [30, 15]]
    },
    ...overrides
  };
}

function currentRide(timestamp = "2018-03-01T12:00:00Z", overrides = {}) {
  return {
    id: "osm:way:123",
    kind: "ride_track",
    localGeometry: {
      type: "LineString",
      coordinates: [[0, 0], [10, 8], [20, 4], [30, 15]]
    },
    source: {
      provider: "OpenStreetMap",
      elementType: "way",
      elementId: 123,
      version: 7,
      timestamp
    },
    ...overrides
  };
}

const temporal = [{
  statusEvidence: ["approved"],
  dateEvidence: [{ kind: "decision-date", value: "2017-04-01" }]
}];

test("post-decision current OSM geometry can prove an approved planning geometry was implemented", () => {
  const result = corroboratePlanningGeometryCandidate(candidate(), [currentRide()], { applicationTemporal: temporal });
  assert.equal(result.accepted, true);
  assert.equal(result.temporal.state, "current");
  assert.equal(result.temporal.worldGeometryAuthority, true);
  assert.equal(result.temporal.reason, "post-decision-current-osm-geometry-corroboration");
  assert.equal(result.temporal.implementationCorroboration.featureId, "osm:way:123");
  assert.ok(result.temporal.implementationCorroboration.matchScore >= 0.78);
});

test("stale 0.12 caller override cannot make canonical 0.08 corroboration ambiguous", () => {
  const shifted = currentRide("2019-01-01T00:00:00Z", {
    id: "osm:way:456",
    localGeometry: {
      type: "LineString",
      coordinates: [[4, 0], [14, 8], [24, 4], [34, 15]]
    },
    source: { ...currentRide().source, elementId: 456, timestamp: "2019-01-01T00:00:00Z" }
  });
  const result = corroboratePlanningGeometryCandidate(candidate(), [currentRide(), shifted], {
    applicationTemporal: temporal,
    ambiguityGap: 0.12
  });
  assert.equal(result.accepted, true);
  assert.equal(result.match.feature.id, "osm:way:123");
  assert.ok(result.match.score - result.match.secondScore >= 0.08);
  assert.ok(result.match.score - result.match.secondScore < 0.12);
});

test("matching geometry observed before the planning decision cannot prove implementation", () => {
  const result = corroboratePlanningGeometryCandidate(candidate(), [currentRide("2016-03-01T12:00:00Z")], { applicationTemporal: temporal });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "observation-not-post-decision");
});

test("approval without a decision date remains non-authoritative even when current geometry matches", () => {
  const result = corroboratePlanningGeometryCandidate(candidate(), [currentRide()], {
    applicationTemporal: [{ statusEvidence: ["approved"], dateEvidence: [] }]
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "missing-planning-decision-date");
});

test("ambiguous current geometry fails closed instead of choosing one observation", () => {
  const result = corroboratePlanningGeometryCandidate(candidate(), [
    currentRide(),
    currentRide("2019-01-01T00:00:00Z", { id: "osm:way:456", source: { ...currentRide().source, elementId: 456, timestamp: "2019-01-01T00:00:00Z" } })
  ], { applicationTemporal: temporal });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "geometry-ambiguous");
});

test("floor and roof drawings cannot gain world geometry authority through current-map coincidence", () => {
  for (const classification of ["floor_plan", "roof_plan"]) {
    const result = corroboratePlanningGeometryCandidate(candidate({ classification }), [currentRide()], { applicationTemporal: temporal });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, "non-materializable-planning-class");
  }
});

test("latestPlanningDecisionDate considers only explicit decision-date evidence", () => {
  const result = latestPlanningDecisionDate([{
    dateEvidence: [
      { kind: "received-date", value: "2020-01-01" },
      { kind: "decision-date", value: "2020-03-01" },
      { kind: "decision-date", value: "2020-04-01" }
    ]
  }]);
  assert.equal(result.toISOString(), "2020-04-01T00:00:00.000Z");
});

test("UK DD/MM/YYYY decision dates are parsed deterministically", () => {
  assert.equal(parsePlanningDate("09/08/2016").toISOString(), "2016-08-09T00:00:00.000Z");
  assert.equal(parsePlanningDate("31/02/2016"), null);
  const result = latestPlanningDecisionDate([{
    dateEvidence: [{ kind: "decision-date", value: "09/08/2016" }]
  }]);
  assert.equal(result.toISOString(), "2016-08-09T00:00:00.000Z");
});
