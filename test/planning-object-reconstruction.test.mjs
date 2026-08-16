import test from "node:test";
import assert from "node:assert/strict";
import { reconstructPlanningObjects3dFromEvidence } from "../src/lib/planning-object-reconstruction.mjs";

test("verified-current registered tree reconstructs only with resolved schedule dimensions", () => {
  const tree = candidate({
    objectType: "tree",
    subtype: "tree",
    code: "T-22",
    geometry: { type: "Point", coordinates: [10, 20] },
    scheduleAttributes: { species: "Beech", heightM: 9, crownSpreadM: 7, diameterMm: 650 }
  });
  const result = reconstructPlanningObjects3dFromEvidence({ geometryCandidates: [tree] });
  assert.equal(result.summary.reconstructedObjects, 1);
  assert.equal(result.summary.trees, 1);
  assert.equal(result.objects[0].heightM, 9);
  assert.equal(result.objects[0].crownSpreadM, 7);
  assert.equal(result.objects[0].species, "Beech");
  assert.equal(result.objects[0].trunkDiameterM, 0.65);
  assert.equal(result.objects[0].authority.terrainElevationAuthority, false);
});

test("tree with missing crown spread is deferred instead of receiving an inferred size", () => {
  const tree = candidate({ objectType: "tree", subtype: "tree", code: "T-1", scheduleAttributes: { heightM: 11 } });
  const result = reconstructPlanningObjects3dFromEvidence({ geometryCandidates: [tree] });
  assert.equal(result.summary.reconstructedObjects, 0);
  assert.equal(result.summary.deferredMissingDimensions, 1);
  assert.equal(result.deferred[0].reason, "tree-schedule-crown-spread-missing-or-invalid");
});

test("proposed or non-authoritative geometry cannot enter object reconstruction", () => {
  const light = candidate({ objectType: "lighting", subtype: "lighting_column", code: "LC-7", scheduleAttributes: { heightM: 6 } });
  light.planningTemporal = { state: "proposed", confidence: 0.99 };
  light.worldGeometryAuthority = false;
  const result = reconstructPlanningObjects3dFromEvidence({ geometryCandidates: [light] });
  assert.equal(result.summary.reconstructedObjects, 0);
  assert.equal(result.summary.deferredNotCurrentAuthority, 1);
});

test("unregistered geometry is rejected even when schedule and temporal evidence are current", () => {
  const light = candidate({ objectType: "lighting", subtype: "lighting_column", code: "LC-8", scheduleAttributes: { heightM: 6 } });
  light.georegistrationStatus = "required";
  light.georegistrationRequired = true;
  delete light.localGeometry;
  const result = reconstructPlanningObjects3dFromEvidence({ geometryCandidates: [light] });
  assert.equal(result.summary.reconstructedObjects, 0);
  assert.equal(result.summary.deferredNotRegistered, 1);
});

test("conflicting schedule evidence fails closed", () => {
  const light = candidate({ objectType: "lighting", subtype: "lighting_column", code: "LC-9", scheduleAttributes: { heightM: 6 } });
  light.planningObject.scheduleFusion = { status: "conflict", canonicalObjectCode: "LC9", sourceRecordCount: 2 };
  const result = reconstructPlanningObjects3dFromEvidence({ geometryCandidates: [light] });
  assert.equal(result.summary.reconstructedObjects, 0);
  assert.equal(result.summary.deferredSchedule, 1);
  assert.equal(result.deferred[0].reason, "planning-object-schedule-conflict");
});

test("current lighting schedule produces an exact-height column model", () => {
  const light = candidate({
    objectType: "lighting",
    subtype: "lighting_column",
    code: "LC-12",
    geometry: { type: "Point", coordinates: [2, 3] },
    scheduleAttributes: { heightM: 6, ral: "RAL 9005" }
  });
  const result = reconstructPlanningObjects3dFromEvidence({ geometryCandidates: [light] });
  assert.equal(result.summary.lightingColumns, 1);
  assert.equal(result.objects[0].heightM, 6);
  assert.equal(result.objects[0].ral, "RAL 9005");
});

test("fence material is recovered from the resolved current schedule record and follows plan linework", () => {
  const fence = candidate({
    objectType: "barrier",
    subtype: "fence",
    code: "F-12",
    geometry: { type: "LineString", coordinates: [[0, 0], [5, 0]] },
    scheduleAttributes: { heightM: 1.8 },
    rawSchedule: "Timber fence F12 height 1.8m"
  });
  const result = reconstructPlanningObjects3dFromEvidence({ geometryCandidates: [fence] });
  assert.equal(result.summary.barriers, 1);
  assert.equal(result.objects[0].heightM, 1.8);
  assert.equal(result.objects[0].constructionMaterial, "timber");
  assert.deepEqual(result.objects[0].geometry.coordinates, [[0, 0], [5, 0]]);
});

test("barrier without explicit current material evidence is deferred", () => {
  const fence = candidate({
    objectType: "barrier",
    subtype: "fence",
    code: "F-13",
    geometry: { type: "LineString", coordinates: [[0, 0], [5, 0]] },
    scheduleAttributes: { heightM: 2 }
  });
  const result = reconstructPlanningObjects3dFromEvidence({ geometryCandidates: [fence] });
  assert.equal(result.summary.barriers, 0);
  assert.equal(result.deferred[0].reason, "barrier-schedule-construction-material-missing");
});

test("gates and bollards remain deferred until dedicated geometry adapters exist", () => {
  const gate = candidate({ objectType: "barrier", subtype: "gate", code: "GT-2", scheduleAttributes: { heightM: 2, constructionMaterial: "steel" } });
  const result = reconstructPlanningObjects3dFromEvidence({ geometryCandidates: [gate] });
  assert.equal(result.summary.reconstructedObjects, 0);
  assert.equal(result.deferred[0].reason, "barrier-subtype-requires-dedicated-adapter");
});

function candidate({
  objectType, subtype, code, scheduleAttributes = {},
  geometry = { type: "Point", coordinates: [1, 1] }, rawSchedule = null
}) {
  return {
    id: `candidate-${code}`,
    contentHash: "plan-doc",
    pageNumber: 1,
    confidence: 0.98,
    localGeometry: geometry,
    georegistrationRequired: false,
    georegistrationStatus: "registered",
    registration: { rmseM: 0.3 },
    worldGeometryAuthority: true,
    planningTemporal: { state: "current", confidence: 0.99, worldGeometryAuthority: true },
    planningObject: {
      id: `planning-object-${code}`,
      objectType,
      subtype,
      objectCode: code,
      confidence: 0.98,
      scheduleFusion: {
        status: "resolved",
        canonicalObjectCode: code.replace(/[^A-Z0-9]/gi, "").toUpperCase(),
        scheduleAttributes,
        sourceRecordCount: 1,
        sourceRecords: [{ id: `schedule-${code}`, raw: rawSchedule, attributes: scheduleAttributes, drawingStatus: "as-built" }]
      }
    }
  };
}
