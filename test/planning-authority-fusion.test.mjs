import test from "node:test";
import assert from "node:assert/strict";
import { createProjector, geometryMapCoordinates } from "../src/lib/geo.mjs";
import { buildEvidenceGraph } from "../src/lib/evidence-graph.mjs";
import {
  integratePlanningAuthorityEvidence,
  fusePlanningAuthorityIntoEvidenceGraph,
  applyPlanningAuthorityWinners,
  matchGeometryCandidate
} from "../src/lib/planning-authority-fusion.mjs";

const projector = createProjector({ lat: 52.99, lon: -1.89 });
const polygon = (x0, z0, x1, z1) => ({
  type: "Polygon",
  coordinates: [[[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]]]
});

function featureFromLocal(id, kind, localGeometry, extra = {}) {
  return {
    id,
    name: id,
    kind,
    subtype: kind,
    tags: { ...(extra.tags || {}) },
    geometry: geometryMapCoordinates(localGeometry, projector.inverse),
    localGeometry,
    vertical: { heightM: extra.heightM ?? null, elevationM: extra.elevationM ?? null, explicit: true },
    source: { provider: "OpenStreetMap", timestamp: "2026-01-01T00:00:00Z", elementId: id },
    verification: { plan: "public-map", vertical: extra.heightM != null ? "tagged" : "unknown" },
    authority: { layer: "osm", rank: 100, geometryLocked: false }
  };
}

function current(entry) {
  return {
    ...entry,
    worldGeometryAuthority: true,
    planningTemporal: { state: "current", confidence: 0.99, reason: "test-current" }
  };
}

test("current planning evidence wins geometry, height, elevation and material attribute-by-attribute", async () => {
  const building = featureFromLocal("osm:building:1", "building", polygon(0, 0, 8, 8), {
    heightM: 6,
    elevationM: 90,
    tags: { surface: "concrete" }
  });
  const map = { projector, features: [building], evidenceGraph: null };
  const authority = {
    geometryCandidates: [current({
      id: "plan:g1",
      contentHash: "doc-a",
      pageNumber: 1,
      semantic: "site-feature-or-building-footprint",
      classification: "site_plan",
      confidence: 0.94,
      localGeometry: polygon(0, 0, 10, 10)
    })],
    materialObservations: [current({
      contentHash: "doc-a", pageNumber: 1, localX: 5, localZ: 5,
      material: "brick", raw: "Brickwork", confidence: 0.91
    })],
    verticalObservations: [
      current({ contentHash: "doc-a", pageNumber: 1, localX: 4, localZ: 4, label: "FFL", valueM: 100, confidence: 0.94, datum: "AOD" }),
      current({ contentHash: "doc-a", pageNumber: 1, localX: 4.5, localZ: 4.5, label: "RIDGE", valueM: 112, confidence: 0.93, datum: "AOD" })
    ]
  };

  const association = await integratePlanningAuthorityEvidence(map, { planningAuthorityEvidenceData: authority });
  assert.equal(association.status, "integrated");
  assert.equal(association.matchedFeatures, 1);
  assert.equal(association.accepted.geometry, 1);
  assert.equal(association.accepted.height, 1);
  assert.equal(association.accepted.groundElevation, 1);
  assert.equal(association.accepted.material, 1);

  buildEvidenceGraph(map, {}, { referenceDate: "2026-08-15T00:00:00Z" });
  const graphBridge = fusePlanningAuthorityIntoEvidenceGraph(map);
  assert.ok(graphBridge.winningAttributes >= 4);
  assert.equal(building.evidenceGraph.attributes.geometry.winner.authorityLayer, "planning-current-authority");
  assert.equal(building.evidenceGraph.attributes.height.winner.value, 12);
  assert.equal(building.evidenceGraph.attributes.groundElevation.winner.value, 100);
  assert.equal(building.evidenceGraph.attributes.material.winner.value, "brick");
  assert.ok(building.evidenceGraph.attributes.geometry.alternatives.some((entry) => entry.authorityLayer === "osm"));

  const resolution = applyPlanningAuthorityWinners(map);
  assert.equal(resolution.affectedFeatures, 1);
  assert.ok(resolution.appliedAttributes >= 4);
  assert.deepEqual(building.localGeometry, polygon(0, 0, 10, 10));
  assert.equal(building.vertical.heightM, 12);
  assert.equal(building.vertical.elevationM, 100);
  assert.equal(building.tags.material, "brick");
  assert.equal(building.materialPalette.wall.key, "brick");
  assert.equal(building.evidenceResolution.geometry.authorityLayer, "planning-current-authority");
});

test("non-current or non-authoritative planning entries never enter the Evidence Graph", async () => {
  const building = featureFromLocal("osm:building:2", "building", polygon(0, 0, 10, 10), { heightM: 7 });
  const map = { projector, features: [building] };
  const association = await integratePlanningAuthorityEvidence(map, {
    planningAuthorityEvidenceData: {
      geometryCandidates: [{
        id: "proposed", localGeometry: polygon(0, 0, 12, 12), semantic: "building-footprint-or-room",
        worldGeometryAuthority: false, planningTemporal: { state: "proposed", confidence: 0.95 }
      }],
      verticalObservations: [], materialObservations: []
    }
  });
  assert.equal(association.status, "no-accepted-authority-evidence");
  assert.equal(building.planningAuthorityCandidates, undefined);
});

test("ambiguous planning geometry association fails closed", () => {
  const a = featureFromLocal("a", "building", polygon(0, 0, 10, 10));
  const b = featureFromLocal("b", "building", polygon(0.2, 0.2, 10.2, 10.2));
  const result = matchGeometryCandidate(
    { localGeometry: polygon(0.1, 0.1, 10.1, 10.1), semantic: "building-footprint-or-room" },
    [a, b],
    { planningAuthorityAmbiguityGap: 0.08 }
  );
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "ambiguous");
});

test("current planning material does not replace a stronger manually surveyed override", async () => {
  const building = featureFromLocal("verified", "building", polygon(0, 0, 10, 10), { tags: { material: "stone" } });
  building.source.provider = "User verified override";
  building.verification.plan = "surveyed";
  building.authority = { layer: "verified-override", rank: 400, geometryLocked: true };
  building.confidence = 0.99;
  const map = { projector, features: [building] };
  await integratePlanningAuthorityEvidence(map, {
    planningAuthorityEvidenceData: {
      geometryCandidates: [], verticalObservations: [],
      materialObservations: [current({ contentHash: "doc", pageNumber: 1, localX: 5, localZ: 5, material: "brick", raw: "Brickwork", confidence: 0.9 })]
    }
  });
  buildEvidenceGraph(map, {}, { referenceDate: "2026-08-15T00:00:00Z" });
  fusePlanningAuthorityIntoEvidenceGraph(map);
  assert.notEqual(building.evidenceGraph.attributes.material.winner.authorityLayer, "planning-current-authority");
  const resolution = applyPlanningAuthorityWinners(map);
  assert.equal(resolution.appliedAttributes, 0);
  assert.equal(building.tags.material, "stone");
});
