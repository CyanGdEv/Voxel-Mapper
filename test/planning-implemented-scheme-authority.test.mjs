import test from "node:test";
import assert from "node:assert/strict";
import {
  buildImplementedApplicationProof,
  evaluateImplementedPlanningPage,
  promoteCertifiedPageEvidence,
  promoteImplementedApplicationSupportEvidence
} from "../src/lib/planning-implemented-scheme-authority.mjs";

const applicationTemporal = [{
  statusEvidence: ["approved"],
  dateEvidence: [{ kind: "decision-date", value: "2017-04-01" }]
}];

function reference(id, kind, coordinates, timestamp = "2024-05-01T00:00:00Z") {
  return {
    id,
    kind,
    localGeometry: { type: "LineString", coordinates },
    source: { provider: "OpenStreetMap", elementType: "way", elementId: id, version: 3, timestamp }
  };
}

function candidate(id, coordinates, classification = "site_plan", semantic = "site-edge-or-route") {
  return {
    id,
    contentHash: "plan-a",
    pageNumber: 1,
    classification,
    semantic,
    localGeometry: { type: "LineString", coordinates },
    georegistrationStatus: "registered",
    spatialAuthorityEligible: true,
    worldGeometryAuthority: false,
    terrainGeometryAuthority: false,
    terrainElevationAuthority: false
  };
}

function page(classification = "site_plan", temporal = proposedTemporal()) {
  return {
    contentHash: "plan-a",
    pageNumber: 1,
    classification,
    georegistrationStatus: "registered",
    applicationKeys: ["reference:TEST/1"],
    planningTemporal: temporal
  };
}

function proposedTemporal() {
  return {
    state: "proposed",
    confidence: 0.74,
    reason: "approval-does-not-prove-construction",
    worldGeometryAuthority: false,
    lineageMemberships: []
  };
}

function ambiguousProposedTemporal() {
  return {
    state: "unknown",
    confidence: 0.6,
    reason: "ambiguous-document-revision-lineage",
    worldGeometryAuthority: false,
    lineageMemberships: [{ documentRevisionState: "ambiguous" }]
  };
}

function multiAnchorEvidence(classification = "site_plan") {
  const a = [[0, 0], [10, 0], [20, 2]];
  const b = [[100, 100], [110, 104], [120, 101]];
  return {
    geometryCandidates: [
      candidate("a1", a, classification), candidate("a2", a, classification),
      candidate("a3", a, classification), candidate("a4", a, classification),
      candidate("b1", b, classification), candidate("b2", b, classification),
      candidate("b3", b, classification), candidate("b4", b, classification)
    ],
    verticalObservations: [{ id: "level-1", contentHash: "plan-a", pageNumber: 1, valueM: 12 }],
    materialObservations: [{ id: "mat-1", contentHash: "plan-a", pageNumber: 1, material: "red_tarmac" }],
    drawingMetadata: [{ id: "meta-1", contentHash: "plan-a", pageNumber: 1, issueDate: "2017-02-01" }],
    rideStructureTemplates: [{ id: "template-1", contentHash: "plan-a", pageNumber: 1, supportCode: "SUP-12" }]
  };
}

const references = [
  reference("osm-path", "path", [[0, 0], [10, 0], [20, 2]]),
  reference("osm-barrier", "barrier", [[100, 100], [110, 104], [120, 101]])
];

test("one current OSM feature cannot certify an entire proposed planning page", () => {
  const evidence = {
    geometryCandidates: Array.from({ length: 12 }, (_, index) => candidate(`only-${index}`, [[0, 0], [10, 0], [20, 2]]))
  };
  const result = evaluateImplementedPlanningPage({
    page: page(), evidence,
    referenceFeatures: [references[0]], applicationTemporal
  });
  assert.equal(result.certifiedSpatialAuthority, false);
  assert.equal(result.uniqueFeatureCount, 1);
  assert.equal(result.status, "insufficient-independent-current-anchors");
});

test("multiple independent post-decision anchors certify an implemented site plan", () => {
  const result = evaluateImplementedPlanningPage({
    page: page(), evidence: multiAnchorEvidence(), referenceFeatures: references, applicationTemporal
  });
  assert.equal(result.certifiedSpatialAuthority, true);
  assert.equal(result.status, "implemented-plan-certified");
  assert.equal(result.anchorCount, 8);
  assert.equal(result.uniqueFeatureCount, 2);
  assert.deepEqual(result.uniqueFeatureKinds, ["barrier", "path"]);
  assert.equal(result.temporal.state, "current");
  assert.equal(result.temporal.worldGeometryAuthority, true);
});

test("approved scheme with ambiguous drawing lineage may be corroborated but approval alone stays non-authoritative", () => {
  const result = evaluateImplementedPlanningPage({
    page: page("site_plan", ambiguousProposedTemporal()),
    evidence: multiAnchorEvidence(), referenceFeatures: references, applicationTemporal
  });
  assert.equal(result.certifiedSpatialAuthority, true);
  assert.equal(result.temporal.reason, "implemented-plan-multi-anchor-corroboration");

  const noCurrentObservation = evaluateImplementedPlanningPage({
    page: page("site_plan", ambiguousProposedTemporal()),
    evidence: multiAnchorEvidence(), referenceFeatures: [], applicationTemporal
  });
  assert.equal(noCurrentObservation.accepted, false);
});

test("location plans can corroborate context but never gain page-wide spatial geometry authority", () => {
  const result = evaluateImplementedPlanningPage({
    page: page("location_plan"),
    evidence: multiAnchorEvidence("location_plan"),
    referenceFeatures: references,
    applicationTemporal
  });
  assert.equal(result.certifiedContext, true);
  assert.equal(result.certifiedSpatialAuthority, false);
  assert.equal(result.temporal.worldGeometryAuthority, false);
  const promoted = promoteCertifiedPageEvidence(multiAnchorEvidence("location_plan"), result);
  assert.equal(promoted.geometryCandidates.length, 0);
});

test("certified plan promotes unmatched registered planning geometry and attributes without terrain authority", () => {
  const evidence = multiAnchorEvidence();
  evidence.geometryCandidates.push(candidate("planning-only-new-geometry", [[300, 300], [315, 306], [330, 300]]));
  const evaluation = evaluateImplementedPlanningPage({
    page: page(), evidence, referenceFeatures: references, applicationTemporal
  });
  const promoted = promoteCertifiedPageEvidence(evidence, evaluation);
  const planningOnly = promoted.geometryCandidates.find((entry) => entry.id === "planning-only-new-geometry");
  assert.ok(planningOnly, "planning geometry that differs from OSM must survive once its plan is independently certified");
  assert.equal(planningOnly.worldGeometryAuthority, true);
  assert.equal(planningOnly.planningTemporal.state, "current");
  assert.equal(planningOnly.terrainGeometryAuthority, false);
  assert.equal(planningOnly.terrainElevationAuthority, false);
  assert.equal(promoted.materialObservations[0].worldGeometryAuthority, true);
  assert.equal(promoted.verticalObservations[0].worldGeometryAuthority, true);
  assert.equal(promoted.rideStructureTemplates[0].worldGeometryAuthority, false);
  assert.equal(promoted.rideStructureTemplates[0].templateAuthorityEligible, true);
});

test("implemented application can unlock supporting section evidence but never its drawing geometry", () => {
  const evaluation = evaluateImplementedPlanningPage({
    page: page(), evidence: multiAnchorEvidence(), referenceFeatures: references, applicationTemporal
  });
  const proof = buildImplementedApplicationProof("reference:TEST/1", [{ page: page(), evaluation }], applicationTemporal);
  assert.equal(proof.accepted, true);

  const supportingEvidence = {
    geometryCandidates: [candidate("section-vector", [[0, 0], [5, 9]], "section", "building-footprint-or-room")],
    verticalObservations: [{ id: "section-level", valueM: 18 }],
    materialObservations: [{ id: "section-material", material: "timber" }],
    drawingMetadata: [{ id: "section-meta" }],
    rideStructureTemplates: [{ id: "support-detail", supportCode: "SUP-12" }]
  };
  const supportingPage = page("section", ambiguousProposedTemporal());
  const promoted = promoteImplementedApplicationSupportEvidence(supportingEvidence, supportingPage, proof);
  assert.equal(promoted.geometryCandidates.length, 0);
  assert.equal(promoted.verticalObservations.length, 1);
  assert.equal(promoted.materialObservations.length, 1);
  assert.equal(promoted.rideStructureTemplates.length, 1);
  assert.equal(promoted.rideStructureTemplates[0].templateAuthorityEligible, true);
  assert.equal(promoted.rideStructureTemplates[0].worldGeometryAuthority, false);
});

test("refused or superseded supporting pages remain excluded even when another page proves implementation", () => {
  const proof = {
    accepted: true,
    confidence: 0.9,
    applicationTemporal,
    summary: { applicationKey: "reference:TEST/1" }
  };
  for (const state of ["refused", "withdrawn", "superseded", "demolished"]) {
    const supportingPage = page("section", { state, confidence: 0.99, reason: state, worldGeometryAuthority: false });
    const promoted = promoteImplementedApplicationSupportEvidence(multiAnchorEvidence("section"), supportingPage, proof);
    assert.equal(promoted.geometryCandidates.length, 0);
    assert.equal(promoted.materialObservations.length, 0);
    assert.equal(promoted.rideStructureTemplates.length, 0);
  }
});
