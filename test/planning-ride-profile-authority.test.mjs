import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildEvidenceGraph } from "../src/lib/evidence-graph.mjs";
import {
  applyPlanningAuthorityWinners,
  fusePlanningAuthorityIntoEvidenceGraph,
  integratePlanningAuthorityEvidence
} from "../src/lib/planning-authority-fusion.mjs";
import { buildPlanningRideProfile } from "../src/lib/planning-ride-profile-authority.mjs";

function rideFeature() {
  return {
    id: "osm:way:galactica",
    name: "Galactica",
    kind: "ride_track",
    subtype: "coaster",
    tags: {},
    geometry: { type: "LineString", coordinates: [[-1.9, 52.99], [-1.899, 52.99]] },
    localGeometry: { type: "LineString", coordinates: [[0, 0], [100, 0]] },
    vertical: { heightM: null, minHeightM: 0, elevationM: null, explicit: false },
    verification: { plan: "surveyed", vertical: "none" },
    source: { provider: "OpenStreetMap", timestamp: "2026-08-01T00:00:00Z" },
    authority: { layer: "osm", rank: 100 }
  };
}

function observation(x, valueM, extra = {}) {
  return {
    contentHash: "ride-plan",
    pageNumber: 1,
    classification: "ride_layout",
    localX: x,
    localZ: 0,
    label: "AOD",
    valueM,
    datum: "AOD",
    raw: `TRACK LEVEL ${valueM} m AOD`,
    confidence: 0.95,
    worldGeometryAuthority: true,
    planningTemporal: { state: "current", confidence: 0.99, worldGeometryAuthority: true },
    ...extra
  };
}

test("strict current planning AOD anchors become the winning 3D ride profile", async () => {
  const feature = rideFeature();
  const map = { features: [feature], rideProfiles: { schemaVersion: 1, sourceCatalog: [], totals: {}, rides: [], profiles: [] } };
  const authority = {
    geometryCandidates: [],
    materialObservations: [],
    verticalObservations: [observation(0, 100), observation(50, 118), observation(100, 130)]
  };

  const integration = await integratePlanningAuthorityEvidence(map, { planningAuthorityEvidenceData: authority });
  assert.equal(integration.accepted.verticalProfile, 1);
  assert.equal(integration.rideVerticalProfiles.acceptedProfiles, 1);

  buildEvidenceGraph(map, {}, { referenceDate: "2026-08-18T00:00:00Z" });
  const fused = fusePlanningAuthorityIntoEvidenceGraph(map);
  assert.equal(fused.winningAttributes > 0, true);
  assert.equal(feature.evidenceGraph.attributes.verticalProfile.winner.authorityLayer, "planning-current-authority");

  const applied = applyPlanningAuthorityWinners(map);
  assert.equal(applied.byAttribute.verticalProfile, 1);
  assert.equal(feature.rideProfile.coverage.vertical, 1);
  assert.deepEqual(feature.rideProfile.heightRangeM, { min: 100, max: 130 });
  assert.equal(feature.rideProfile.validation.extrapolatedSamples, 0);
  assert.equal(feature.verification.vertical, "planning-current-authority");
  assert.equal(map.rideProfiles.rides[0].name, "Galactica");
  assert.equal(map.rideProfiles.rides[0].status, "full-3d-elevation");
  assert.equal(map.rideProfiles.rides[0].verticalCoverage, 1);
});

test("production planning authority file handoff feeds ride-profile reconstruction", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "voxel-ride-profile-authority-"));
  const authorityPath = path.join(directory, "planning-current-authority-evidence.json");
  const authority = {
    geometryCandidates: [],
    materialObservations: [],
    verticalObservations: [observation(0, 100), observation(50, 118), observation(100, 130)]
  };
  await writeFile(authorityPath, `${JSON.stringify(authority)}\n`, "utf8");

  try {
    const feature = rideFeature();
    const map = { features: [feature] };
    const integration = await integratePlanningAuthorityEvidence(map, { planningAuthorityEvidence: authorityPath });
    assert.equal(integration.rideVerticalProfiles.inputObservations, 3);
    assert.equal(integration.accepted.verticalProfile, 1);
    assert.equal(feature.planningAuthorityCandidates?.some((candidate) => candidate.attribute === "verticalProfile"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("planning ride profile never extrapolates outside proven anchor span", () => {
  const result = buildPlanningRideProfile(rideFeature(), [observation(20, 105), observation(80, 125)]);
  assert.equal(result.accepted, true);
  assert.ok(result.profile.coverage.vertical > 0.5 && result.profile.coverage.vertical < 0.7);
  const samples = result.profile.parts[0];
  assert.equal(samples[0].elevationM, null);
  assert.equal(samples.at(-1).elevationM, null);
  assert.equal(result.profile.validation.extrapolatedSamples, 0);
  assert.match(result.profile.warnings.join("\n"), /no vertical extrapolation/i);
});

test("relative ride RL values without an absolute datum are not promoted to 3D", async () => {
  const feature = rideFeature();
  const map = { features: [feature] };
  const relative = [
    observation(0, 5, { label: "RL", datum: null, raw: "TRACK RL 5.00" }),
    observation(100, 25, { label: "RL", datum: null, raw: "TRACK RL 25.00" })
  ];
  const integration = await integratePlanningAuthorityEvidence(map, {
    planningAuthorityEvidenceData: { geometryCandidates: [], materialObservations: [], verticalObservations: relative }
  });
  assert.equal(integration.accepted.verticalProfile, 0);
  assert.equal(feature.planningAuthorityCandidates?.some((candidate) => candidate.attribute === "verticalProfile") || false, false);
});
