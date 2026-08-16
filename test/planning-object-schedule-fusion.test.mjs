import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalObjectCode,
  collectPlanningObjectScheduleRecords,
  fusePlanningObjectSchedules
} from "../src/lib/planning-object-schedule-fusion.mjs";
import { mergePlanningExtractionManifests } from "../src/lib/planning-extraction-worker.mjs";

test("exact tree code links plan geometry to a current tree schedule without granting authority", () => {
  const evidence = fixtureEvidence({
    objectType: "tree",
    subtype: "tree",
    code: "T-01",
    schedule: schedule({ code: "T01", objectType: "tree", subtype: "tree", attributes: { objectCode: "T-01", species: "English Oak", heightM: 12, crownSpreadM: 8, status: "retained" } })
  });
  const summary = fusePlanningObjectSchedules(evidence);
  const fusion = evidence.geometryCandidates[0].planningObject.scheduleFusion;
  assert.equal(summary.resolvedObjectCount, 1);
  assert.equal(fusion.status, "resolved");
  assert.equal(fusion.canonicalObjectCode, "T01");
  assert.equal(fusion.scheduleAttributes.species, "English Oak");
  assert.equal(fusion.scheduleAttributes.heightM, 12);
  assert.equal(fusion.scheduleAttributes.crownSpreadM, 8);
  assert.equal(fusion.authority.grantsWorldGeometryAuthority, false);
  assert.equal(evidence.geometryCandidates[0].worldGeometryAuthority, false);
});

test("a later proposed schedule cannot displace an explicitly current record", () => {
  const evidence = fixtureEvidence({ objectType: "lighting", subtype: "lighting_column", code: "LC-12", schedule: null });
  evidence.drawingMetadata = [
    metadata("current-doc", "as-built", "P01", schedule({ code: "LC12", objectType: "lighting", subtype: "lighting_column", attributes: { objectCode: "LC-12", heightM: 6, ral: "RAL 9005" } })),
    metadata("proposed-doc", "planning", "P09", schedule({ code: "LC12", objectType: "lighting", subtype: "lighting_column", attributes: { objectCode: "LC-12", heightM: 9, ral: "RAL 9010", status: "proposed" } }))
  ];
  fusePlanningObjectSchedules(evidence);
  const fusion = evidence.geometryCandidates[0].planningObject.scheduleFusion;
  assert.equal(fusion.status, "resolved");
  assert.equal(fusion.scheduleAttributes.heightM, 6);
  assert.equal(fusion.scheduleAttributes.ral, "RAL 9005");
  assert.equal(fusion.sourceRecordCount, 1);
  assert.equal(fusion.sourceRecords[0].contentHash, "current-doc");
});

test("latest comparable current revision wins within the same drawing lineage", () => {
  const evidence = fixtureEvidence({ objectType: "barrier", subtype: "fence", code: "F-12", schedule: null });
  evidence.drawingMetadata = [
    metadata("fence-p01", "record", "P01", schedule({ code: "F12", objectType: "barrier", subtype: "fence", attributes: { objectCode: "F-12", heightM: 1.2 } }), "L-401"),
    metadata("fence-p02", "record", "P02", schedule({ code: "F12", objectType: "barrier", subtype: "fence", attributes: { objectCode: "F-12", heightM: 1.8 } }), "L-401")
  ];
  fusePlanningObjectSchedules(evidence);
  const fusion = evidence.geometryCandidates[0].planningObject.scheduleFusion;
  assert.equal(fusion.status, "resolved");
  assert.equal(fusion.scheduleAttributes.heightM, 1.8);
  assert.equal(fusion.sourceRecords[0].revision, "P02");
});

test("conflicting same-revision current records fail closed", () => {
  const evidence = fixtureEvidence({ objectType: "lighting", subtype: "lighting_column", code: "LC-7", schedule: null });
  evidence.drawingMetadata = [
    metadata("a", "as-built", "C03", schedule({ code: "LC7", objectType: "lighting", subtype: "lighting_column", attributes: { objectCode: "LC-7", heightM: 5 } }), "E-200"),
    metadata("b", "as-built", "C03", schedule({ code: "LC7", objectType: "lighting", subtype: "lighting_column", attributes: { objectCode: "LC-7", heightM: 7 } }), "E-200")
  ];
  const summary = fusePlanningObjectSchedules(evidence);
  const fusion = evidence.geometryCandidates[0].planningObject.scheduleFusion;
  assert.equal(summary.conflictingObjectCount, 1);
  assert.equal(fusion.status, "conflict");
  assert.deepEqual(fusion.conflictFields, ["heightM"]);
  assert.equal(fusion.reconstructionReady, false);
  assert.equal(fusion.grantsWorldGeometryAuthority, false);
});

test("same exact code in an incompatible object family is rejected", () => {
  const evidence = fixtureEvidence({
    objectType: "lighting",
    subtype: "lighting_column",
    code: "L-12",
    schedule: schedule({ code: "L12", objectType: "signage", subtype: "sign", attributes: { objectCode: "L-12", heightM: 2 } })
  });
  const summary = fusePlanningObjectSchedules(evidence);
  const fusion = evidence.geometryCandidates[0].planningObject.scheduleFusion;
  assert.equal(summary.incompatibleFamilyCount, 1);
  assert.equal(fusion.status, "unresolved");
  assert.equal(fusion.reason, "exact-code-records-have-incompatible-object-family");
});

test("object-code fusion is exact and never fuzzy", () => {
  const evidence = fixtureEvidence({
    objectType: "tree",
    subtype: "tree",
    code: "T-01",
    schedule: schedule({ code: "T11", objectType: "tree", subtype: "tree", attributes: { objectCode: "T-11", species: "Beech" } })
  });
  fusePlanningObjectSchedules(evidence);
  const fusion = evidence.geometryCandidates[0].planningObject.scheduleFusion;
  assert.equal(fusion.status, "unresolved");
  assert.equal(fusion.reason, "no-exact-current-schedule-record");
});

test("resolved planningTemporal metadata can qualify a schedule without spatial authority", () => {
  const evidence = fixtureEvidence({ objectType: "drainage", subtype: "manhole", code: "MH-4", schedule: null });
  const row = schedule({ code: "MH4", objectType: "drainage", subtype: "manhole", attributes: { objectCode: "MH-4", diameterMm: 1200 } });
  const meta = metadata("drain-doc", null, "C02", row, "D-100");
  meta.planningTemporal = { state: "current", confidence: 0.97, reason: "resolved-current", worldGeometryAuthority: false };
  evidence.drawingMetadata = [meta];
  const records = collectPlanningObjectScheduleRecords(evidence);
  assert.equal(records.length, 1);
  assert.equal(records[0].spatialAuthorityEligible, false);
  fusePlanningObjectSchedules(evidence);
  assert.equal(evidence.geometryCandidates[0].planningObject.scheduleFusion.status, "resolved");
  assert.equal(evidence.geometryCandidates[0].planningObject.scheduleFusion.scheduleAttributes.diameterMm, 1200);
});

test("merged extraction manifests perform cross-document schedule fusion automatically", () => {
  const geometryDocument = extractionDocument("plan-doc", {
    geometryCandidates: [candidate("tree", "tree", "T-22")],
    drawingMetadata: [{ contentHash: "plan-doc", pageNumber: 1, status: "as-built", drawingNumber: "L-100", revision: "C01" }]
  });
  const scheduleDocument = extractionDocument("schedule-doc", {
    geometryCandidates: [],
    drawingMetadata: [metadata("schedule-doc", "record", "C04", schedule({ code: "T22", objectType: "tree", subtype: "tree", attributes: { objectCode: "T-22", species: "Beech", heightM: 9, status: "retained" } }), "L-500")]
  });
  const merged = mergePlanningExtractionManifests([
    manifest(geometryDocument),
    manifest(scheduleDocument)
  ]);
  assert.equal(merged.planningObjectScheduleFusion.resolvedObjectCount, 1);
  assert.equal(merged.normalizedEvidence.geometryCandidates[0].planningObject.scheduleFusion.status, "resolved");
  assert.equal(merged.normalizedEvidence.geometryCandidates[0].planningObject.scheduleFusion.scheduleAttributes.species, "Beech");
  assert.equal(merged.normalizedEvidence.worldGeometryReady, false);
});

test("schedule fusion is deterministic across document ordering", () => {
  const make = (reverse = false) => {
    const evidence = fixtureEvidence({ objectType: "tree", subtype: "tree", code: "T-9", schedule: null });
    const rows = [
      metadata("a", "record", "C01", schedule({ code: "T9", objectType: "tree", subtype: "tree", attributes: { objectCode: "T-9", species: "Oak" } }), "TREE-SCH-A"),
      metadata("b", "as-built", "P02", schedule({ code: "T9", objectType: "tree", subtype: "tree", attributes: { objectCode: "T-9", species: "Oak" } }), "TREE-SCH-B")
    ];
    evidence.drawingMetadata = reverse ? rows.reverse() : rows;
    fusePlanningObjectSchedules(evidence);
    return evidence.geometryCandidates[0].planningObject.scheduleFusion;
  };
  assert.deepEqual(make(false), make(true));
});

test("canonical object codes normalize separators but reject prose and fuzzy identifiers", () => {
  assert.equal(canonicalObjectCode("LC-012"), "LC012");
  assert.equal(canonicalObjectCode("MH 4"), "MH4");
  assert.equal(canonicalObjectCode("Tree T01"), null);
  assert.equal(canonicalObjectCode("12"), null);
});

function fixtureEvidence({ objectType, subtype, code, schedule: row }) {
  return {
    schemaVersion: 2,
    coordinateSpace: "pdf-user-space-points",
    georegistrationStatus: "required",
    worldGeometryReady: false,
    geometryCandidates: [candidate(objectType, subtype, code)],
    verticalObservations: [],
    materialObservations: [],
    drawingMetadata: row ? [metadata("schedule-doc", "as-built", "C01", row, "SCH-001")] : []
  };
}

function candidate(objectType, subtype, objectCode) {
  return {
    id: `candidate-${objectCode}`,
    contentHash: "plan-doc",
    pageNumber: 1,
    kind: "structure",
    confidence: 0.95,
    georegistrationRequired: true,
    spatialAuthorityEligible: true,
    worldGeometryAuthority: false,
    planningObject: {
      schemaVersion: 1,
      id: `object-${objectCode}`,
      objectType,
      subtype,
      semantic: `${objectType}-${subtype}`,
      objectCode,
      attributes: { objectCode },
      authority: {
        georegistrationRequired: true,
        temporalResolutionRequired: true,
        worldGeometryAuthority: false,
        terrainGeometryAuthority: false,
        terrainElevationAuthority: false
      }
    }
  };
}

function schedule({ code, objectType, subtype, attributes }) {
  return {
    schemaVersion: 1,
    id: `schedule-${code}-${attributes?.heightM ?? attributes?.species ?? "row"}`,
    objectType,
    subtype,
    semantic: `${objectType}-${subtype}`,
    objectCode: attributes?.objectCode || code,
    attributes,
    raw: `${code} schedule record`,
    confidence: 0.94,
    source: "fixture-schedule",
    spatialAuthorityEligible: false,
    linkageRequired: true,
    worldGeometryAuthority: false
  };
}

function metadata(contentHash, status, revision, row, drawingNumber = "SCH-001") {
  return {
    contentHash,
    pageNumber: 1,
    drawingNumber,
    revision,
    status,
    issueDate: "2026-01-01T00:00:00.000Z",
    planningObjectTextObservations: [row]
  };
}

function extractionDocument(contentHash, { geometryCandidates, drawingMetadata }) {
  return {
    schemaVersion: 1,
    contentHash,
    objectPath: `${contentHash}.pdf`,
    contentType: "application/pdf",
    classification: "site_plan",
    status: "extracted",
    pageCount: 1,
    pages: [{ pageNumber: 1, widthPt: 100, heightPt: 100, rotation: 0, text: { itemCount: 0, characterCount: 0 }, vector: { pathCount: geometryCandidates.length, imagePaintOps: 0 }, metadata: drawingMetadata[0] || null }],
    normalizedEvidence: {
      schemaVersion: 1,
      geometryCandidates,
      verticalObservations: [],
      materialObservations: [],
      legendEntries: [],
      rideStructureTemplates: [],
      drawingMetadata
    }
  };
}

function manifest(document) {
  return {
    schemaVersion: 2,
    failures: [],
    rasterFallbackQueue: [],
    results: [{ status: "extracted", item: { contentHash: document.contentHash }, extraction: document }]
  };
}
