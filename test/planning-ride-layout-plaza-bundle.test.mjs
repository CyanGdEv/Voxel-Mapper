import test from "node:test";
import assert from "node:assert/strict";
import { enrichPlanningPedestrianEvidence } from "../src/lib/planning-pedestrian-enrichment.mjs";

test("closed explicit Wicker Man plaza on a ride-layout sheet is preserved without retyping track evidence", () => {
  const plaza = {
    id: "sw8:plaza",
    contentHash: "sw8",
    pageNumber: 1,
    classification: "ride_layout",
    semantic: "ride-centerline-or-edge",
    closed: true,
    boundsPt: { minX: 100, minY: 100, maxX: 210, maxY: 180 },
    confidence: 0.45,
    georegistrationRequired: true,
    worldGeometryAuthority: false
  };
  const track = {
    id: "sw8:track",
    contentHash: "sw8",
    pageNumber: 1,
    classification: "ride_layout",
    semantic: "ride-track-centerline",
    closed: true,
    boundsPt: { minX: 250, minY: 100, maxX: 420, maxY: 280 },
    kind: "ride_track",
    featureKind: "ride_track",
    rideStructureEvidence: { role: "track", subtype: "ride_track_centerline" },
    georegistrationRequired: true,
    worldGeometryAuthority: false
  };
  const extraction = {
    pages: [{
      pageNumber: 1,
      text: { items: [{ text: "WICKER MAN ENTRANCE PLAZA", xPt: 155, yPt: 140 }] }
    }],
    normalizedEvidence: { geometryCandidates: [plaza, track] }
  };

  const summary = enrichPlanningPedestrianEvidence(extraction);
  assert.equal(summary.counts.plaza, 1);
  assert.equal(plaza.kind, "path");
  assert.equal(plaza.subtype, "pedestrian_plaza");
  assert.equal(plaza.tags["area:highway"], "pedestrian");
  assert.equal(plaza.tags.area, "yes");
  assert.equal(plaza.pedestrianEvidence.source, "planning-pdf-explicit-ride-layout-plaza-label");
  assert.equal(plaza.pedestrianEvidence.worldGeometryAuthority, false);
  assert.equal(track.kind, "ride_track");
  assert.equal(track.rideStructureEvidence.role, "track");
});

test("open ride-layout queue wording is not retyped as a path", () => {
  const candidate = {
    id: "sw8:queue-line",
    pageNumber: 1,
    classification: "ride_layout",
    semantic: "ride-centerline-or-edge",
    closed: false,
    boundsPt: { minX: 100, minY: 100, maxX: 210, maxY: 102 },
    worldGeometryAuthority: false
  };
  const extraction = {
    pages: [{ pageNumber: 1, text: { items: [{ text: "QUEUE PATH", xPt: 150, yPt: 101 }] } }],
    normalizedEvidence: { geometryCandidates: [candidate] }
  };
  const summary = enrichPlanningPedestrianEvidence(extraction);
  assert.equal(summary.counts.path, 0);
  assert.equal(candidate.kind, undefined);
});
