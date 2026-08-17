import test from "node:test";
import assert from "node:assert/strict";
import { createProjector, geometryMapCoordinates } from "../src/lib/geo.mjs";
import {
  integratePlanningAuthorityEvidence,
  matchGeometryCandidate,
  resolveGeometryCandidateMatch
} from "../src/lib/planning-authority-fusion.mjs";

const projector = createProjector({ lat: 52.99, lon: -1.89 });
const polygon = (x0, z0, x1, z1) => ({
  type: "Polygon",
  coordinates: [[[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]]]
});

function feature(id, localGeometry, kind = "building") {
  return {
    id,
    name: id,
    kind,
    subtype: kind,
    tags: {},
    geometry: geometryMapCoordinates(localGeometry, projector.inverse),
    localGeometry,
    vertical: { heightM: null, elevationM: null, explicit: false },
    source: { provider: "OpenStreetMap", timestamp: "2026-08-01T00:00:00Z" },
    verification: { plan: "public-map", vertical: "unknown" },
    authority: { layer: "osm", rank: 100, geometryLocked: false }
  };
}

function current(entry) {
  return {
    ...entry,
    worldGeometryAuthority: true,
    planningTemporal: {
      state: "current",
      confidence: 0.99,
      reason: "post-decision-current-feature-corroboration",
      implementationCorroboration: entry.implementationCorroboration || null
    }
  };
}

test("certified current feature bypasses a redundant ambiguous park-wide rematch", async () => {
  const a = feature("osm:way:100", polygon(0, 0, 10, 10));
  const b = feature("osm:way:101", polygon(0.2, 0.2, 10.2, 10.2));
  const candidate = current({
    id: "plan:certified-building",
    contentHash: "doc-certified",
    pageNumber: 1,
    semantic: "building-footprint-or-room",
    classification: "site_plan",
    confidence: 0.94,
    localGeometry: polygon(0.1, 0.1, 10.1, 10.1),
    implementationCorroboration: {
      featureId: a.id,
      featureKind: "building",
      matchScore: 0.84,
      secondScore: 0.75,
      observedAt: "2026-08-01T00:00:00Z",
      planningDecisionAt: "2025-05-01T00:00:00Z"
    }
  });

  const generic = matchGeometryCandidate(candidate, [a, b], { planningAuthorityAmbiguityGap: 0.08 });
  assert.equal(generic.accepted, false);
  assert.equal(generic.reason, "ambiguous");

  const certified = resolveGeometryCandidateMatch(candidate, [a, b], { planningAuthorityAmbiguityGap: 0.08 });
  assert.equal(certified.accepted, true);
  assert.equal(certified.feature.id, a.id);
  assert.equal(certified.method, "certified-current-target");

  const map = { projector, features: [a, b] };
  const association = await integratePlanningAuthorityEvidence(map, {
    planningAuthorityEvidenceData: {
      geometryCandidates: [candidate],
      materialObservations: [],
      verticalObservations: []
    }
  });

  assert.equal(association.accepted.geometry, 1);
  assert.equal(association.association.certifiedGeometryTargets, 1);
  assert.equal(association.association.genericGeometryMatches, 0);
  assert.equal(association.rejected["geometry-ambiguous"], undefined);
  assert.equal(a.planningAuthorityCandidates?.filter((entry) => entry.attribute === "geometry").length, 1);
  assert.equal(b.planningAuthorityCandidates, undefined);
  assert.equal(association.matches[0].featureId, a.id);
  assert.equal(association.matches[0].method, "certified-current-target");
});

test("missing certified target fails closed instead of falling back to geometry search", () => {
  const a = feature("osm:way:200", polygon(0, 0, 10, 10));
  const candidate = current({
    id: "plan:missing-target",
    semantic: "building-footprint-or-room",
    classification: "site_plan",
    localGeometry: polygon(0, 0, 10, 10),
    implementationCorroboration: {
      featureId: "osm:way:missing",
      featureKind: "building",
      matchScore: 0.9
    }
  });
  const result = resolveGeometryCandidateMatch(candidate, [a]);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "certified-target-not-found");
  assert.equal(result.targetFeatureId, "osm:way:missing");
});

test("semantically incompatible certified target fails closed", () => {
  const ride = feature("osm:way:ride", polygon(0, 0, 10, 10), "ride_track");
  const candidate = current({
    id: "plan:wrong-kind",
    semantic: "building-footprint-or-room",
    classification: "site_plan",
    localGeometry: polygon(0, 0, 10, 10),
    implementationCorroboration: {
      featureId: ride.id,
      featureKind: "ride_track",
      matchScore: 0.9
    }
  });
  const result = resolveGeometryCandidateMatch(candidate, [ride]);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "certified-target-kind-mismatch");
});

test("uncertified targetFeatureId does not bypass ordinary ambiguity protection", () => {
  const a = feature("a", polygon(0, 0, 10, 10));
  const b = feature("b", polygon(0.2, 0.2, 10.2, 10.2));
  const candidate = current({
    id: "plan:untrusted-target-hint",
    targetFeatureId: a.id,
    semantic: "building-footprint-or-room",
    classification: "site_plan",
    localGeometry: polygon(0.1, 0.1, 10.1, 10.1)
  });
  const result = resolveGeometryCandidateMatch(candidate, [a, b], { planningAuthorityAmbiguityGap: 0.08 });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "ambiguous");
});
