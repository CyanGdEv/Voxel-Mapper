import test from "node:test";
import assert from "node:assert/strict";
import { buildEvidenceGraph, buildFeatureEvidence, resolveTemporalState, snapshotFeatureEvidence } from "../src/lib/evidence-graph.mjs";

function building(overrides = {}) {
  return {
    id: "planning:A:building-1",
    kind: "building",
    geometry: { type: "Polygon", coordinates: [[[0,0],[0,1],[1,1],[1,0],[0,0]]] },
    vertical: { heightM: 12, heightSource: "planning-drawing", elevationM: null },
    roof: { source: "lidar-dsm-surface", confidence: 0.94, resolutionM: 1, profile: [11.8, 12.2] },
    tags: { application_status: "implemented", material: "brick" },
    source: { provider: "Planning application / architect drawing", applicationReference: "A", timestamp: "2025-06-01" },
    authority: { layer: "planning", rank: 300 },
    verification: { plan: "planning-authoritative", vertical: "planning-drawing" },
    ...overrides
  };
}

test("per-attribute evidence keeps planning height while preferring LiDAR roof evidence", () => {
  const feature = building();
  const graph = buildFeatureEvidence(feature, { elevation: { resolutionM: 1 } }, { referenceDate: "2026-08-15" });
  assert.equal(graph.attributes.height.winner.value, 12);
  assert.equal(graph.attributes.height.winner.method, "planning-drawing");
  assert.equal(graph.attributes.roof.winner.method, "lidar-dsm-surface");
  assert.ok(graph.attributes.roof.winner.score > 0.8);
});

test("replaced OSM geometry remains as an alternative instead of being discarded", () => {
  const prior = {
    id: "osm:way:42",
    kind: "building",
    geometry: { type: "Polygon", coordinates: [[[2,2],[2,3],[3,3],[3,2],[2,2]]] },
    vertical: { heightM: 9, heightSource: "height" },
    tags: { material: "concrete" },
    source: { provider: "OpenStreetMap", timestamp: "2024-01-01" },
    authority: { layer: "osm", rank: 100 },
    verification: { plan: "public-map", vertical: "tagged" }
  };
  const feature = building({ evidenceHistory: [snapshotFeatureEvidence(prior, "planning-replaced")] });
  const graph = buildFeatureEvidence(feature, {}, { referenceDate: "2026-08-15" });
  assert.equal(graph.attributes.geometry.winner.authorityLayer, "planning");
  assert.equal(graph.attributes.geometry.alternatives[0].authorityLayer, "osm");
  assert.equal(graph.attributes.height.winner.value, 12);
  assert.equal(graph.attributes.height.alternatives[0].value, 9);
});

test("planning approval alone is proposed, not proof that construction exists", () => {
  const state = resolveTemporalState(building({ tags: { application_status: "approved" } }), new Date("2026-08-15"));
  assert.equal(state.state, "proposed");
  assert.match(state.reason, /approval-does-not-prove-construction/);
});

test("evidence graph creates a prioritized acquisition queue for missing high-impact attributes", () => {
  const path = {
    id: "osm:way:7",
    kind: "path",
    geometry: { type: "LineString", coordinates: [[0,0],[2,0]] },
    tags: {},
    source: { provider: "OpenStreetMap", timestamp: "2026-01-01" },
    authority: { layer: "osm", rank: 100 },
    verification: { plan: "public-map" }
  };
  const map = { features: [path] };
  const summary = buildEvidenceGraph(map, {}, { referenceDate: "2026-08-15" });
  const attrs = summary.acquisitionQueue.map((item) => item.attribute);
  assert.ok(attrs.includes("width"));
  assert.ok(attrs.includes("material"));
  assert.ok(summary.acquisitionQueue[0].priority >= summary.acquisitionQueue.at(-1).priority);
});

test("temporal current-state gap does not corrupt required-attribute fidelity counts", () => {
  const feature = building({ tags: { application_status: "approved", material: "brick" } });
  const map = { features: [feature] };
  const summary = buildEvidenceGraph(map, {}, { referenceDate: "2026-08-15" });
  assert.equal(summary.byKind.building.required, 4);
  assert.equal(summary.byKind.building.evidenced, 4);
  assert.equal(summary.byKind.building.missing, 0);
  assert.ok(summary.acquisitionQueue.some((item) => item.attribute === "currentState"));
});

test("nested evidence objects compare recursively so real roof/material conflicts are retained", () => {
  const prior = {
    id: "osm:way:roof-conflict",
    kind: "building",
    geometry: { type: "Polygon", coordinates: [[[0,0],[0,1],[1,1],[1,0],[0,0]]] },
    roof: { source: "planning-roof", profile: { ridge: { heightM: 15, direction: "N-S" }, eavesM: 11 } },
    tags: { material: { palette: { wall: "stone", trim: "oak" }, pattern: "random" } },
    source: { provider: "Architect planning", timestamp: "2025-06-01" },
    authority: { layer: "planning", rank: 295 },
    verification: { plan: "planning-authoritative" }
  };
  const feature = building({
    roof: { source: "planning-roof", profile: { ridge: { heightM: 15, direction: "E-W" }, eavesM: 11 } },
    materialPalette: { palette: { wall: "brick", trim: "oak" }, pattern: "random" },
    evidenceHistory: [snapshotFeatureEvidence(prior, "alternate-drawing")]
  });
  const graph = buildFeatureEvidence(feature, {}, { referenceDate: "2026-08-15" });
  assert.equal(graph.attributes.roof.conflict, true);
  assert.equal(graph.attributes.material.conflict, true);
});
