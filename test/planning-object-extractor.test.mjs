import test from "node:test";
import assert from "node:assert/strict";
import {
  PLANNING_OBJECT_TYPES,
  classifyPlanningObjectText,
  enrichPlanningObjectEvidence,
  extractPlanningObjectAttributes
} from "../src/lib/planning-object-extractor.mjs";
import { enrichPlanningTextEvidence } from "../src/lib/planning-text-evidence.mjs";

test("universal object ontology covers the major planning reconstruction families", () => {
  for (const type of [
    "ride_component", "structure", "roof_element", "facade_element", "tree", "landscape",
    "barrier", "lighting", "drainage", "water", "signage", "street_furniture",
    "path_detail", "utility", "accessibility", "transport_detail"
  ]) assert.ok(PLANNING_OBJECT_TYPES.includes(type), `missing ${type}`);
});

test("tree schedules expose identity, species, size and retention state", () => {
  const text = "TREE T01 species: English Oak height 12m crown spread 8m retained";
  const classification = classifyPlanningObjectText(text);
  assert.equal(classification.objectType, "tree");
  assert.equal(classification.subtype, "tree");
  const attributes = extractPlanningObjectAttributes(text, classification);
  assert.equal(attributes.objectCode, "T-01");
  assert.equal(attributes.species, "English Oak");
  assert.equal(attributes.heightM, 12);
  assert.equal(attributes.crownSpreadM, 8);
  assert.equal(attributes.status, "retained");
});

test("roof, lighting, barriers and drainage retain measurable design attributes", () => {
  const roof = classifyPlanningObjectText("Roof ridge line pitch 35 degrees");
  assert.equal(roof.objectType, "roof_element");
  assert.equal(extractPlanningObjectAttributes("Roof ridge line pitch 35 degrees", roof).pitchDeg, 35);

  const light = classifyPlanningObjectText("Lighting column LC12 height 6m RAL 9005");
  assert.equal(light.objectType, "lighting");
  assert.deepEqual(extractPlanningObjectAttributes("Lighting column LC12 height 6m RAL 9005", light), {
    objectCode: "LC-12",
    heightM: 6,
    ral: "RAL 9005"
  });

  const fence = classifyPlanningObjectText("Timber fence F12 height 1.8m");
  assert.equal(fence.objectType, "barrier");
  assert.equal(extractPlanningObjectAttributes("Timber fence F12 height 1.8m", fence).heightM, 1.8);

  const drain = classifyPlanningObjectText("Surface water 150mm pipe to outfall OF3");
  assert.equal(drain.objectType, "drainage");
  assert.equal(drain.subtype, "pipe");
});

test("accessibility, utilities, furniture and transport details do not collapse into generic structure", () => {
  assert.equal(classifyPlanningObjectText("Accessible ramp gradient 1:20").objectType, "accessibility");
  assert.equal(classifyPlanningObjectText("Electrical substation U4").objectType, "utility");
  assert.equal(classifyPlanningObjectText("Picnic table P03").objectType, "street_furniture");
  assert.equal(classifyPlanningObjectText("Loading bay LB2").objectType, "transport_detail");
  assert.equal(extractPlanningObjectAttributes("Accessible ramp gradient 1:20", classifyPlanningObjectText("Accessible ramp gradient 1:20")).gradientRatio, "1:20");
});

test("generic ambiguous words fail closed instead of inventing a planning object", () => {
  assert.equal(classifyPlanningObjectText("wall"), null);
  assert.equal(classifyPlanningObjectText("plant"), null);
  assert.equal(classifyPlanningObjectText("light"), null);
  assert.equal(classifyPlanningObjectText("path"), null);
});

test("geometry-linked extraction annotates candidates without mutating kind or authority", () => {
  const extraction = fixture({
    candidateText: "Lighting column LC7 height 5m",
    materialObservations: [{ contentHash: "doc", pageNumber: 1, xPt: 12, yPt: 12, material: "steel", confidence: 0.91, source: "fixture" }],
    verticalObservations: [{ contentHash: "doc", pageNumber: 1, xPt: 12, yPt: 12, label: "TOP", valueM: 105.2, datum: "AOD", confidence: 0.9, source: "fixture" }]
  });
  const originalKind = extraction.normalizedEvidence.geometryCandidates[0].kind;
  const summary = enrichPlanningObjectEvidence(extraction);
  const candidate = extraction.normalizedEvidence.geometryCandidates[0];
  assert.equal(summary.objectCount, 1);
  assert.equal(candidate.kind, originalKind);
  assert.equal(candidate.planningObject.objectType, "lighting");
  assert.equal(candidate.planningObject.objectCode, "LC-7");
  assert.equal(candidate.planningObject.attributes.materialCandidates[0].material, "steel");
  assert.equal(candidate.planningObject.attributes.levelCandidates[0].valueM, 105.2);
  assert.equal(candidate.planningObject.authority.worldGeometryAuthority, false);
  assert.equal(candidate.planningObject.authority.terrainGeometryAuthority, false);
  assert.equal(candidate.planningObject.authority.terrainElevationAuthority, false);
});

test("ride semantic evidence becomes a ride component without reclassifying the candidate", () => {
  const extraction = fixture({ candidateText: "" });
  const candidate = extraction.normalizedEvidence.geometryCandidates[0];
  candidate.kind = "structure";
  candidate.rideStructureEvidence = { subtype: "sound_tunnel", confidence: 0.99 };
  enrichPlanningObjectEvidence(extraction);
  assert.equal(candidate.kind, "structure");
  assert.equal(candidate.planningObject.objectType, "ride_component");
  assert.equal(candidate.planningObject.subtype, "sound_tunnel");
  assert.equal(candidate.planningObject.authority.worldGeometryAuthority, false);
});

test("text-only schedule rows survive as linkage-only metadata rather than fake map geometry", () => {
  const extraction = {
    contentHash: "schedule-doc",
    classification: "landscape_plan",
    pages: [{
      pageNumber: 1,
      text: { items: [
        { text: "TREE T22", xPt: 10, yPt: 100 },
        { text: "species: Beech", xPt: 80, yPt: 100 },
        { text: "height 9m retained", xPt: 180, yPt: 100 }
      ] },
      metadata: null
    }],
    normalizedEvidence: {
      geometryCandidates: [],
      verticalObservations: [],
      materialObservations: [],
      drawingMetadata: []
    }
  };
  enrichPlanningTextEvidence(extraction);
  assert.equal(extraction.normalizedEvidence.geometryCandidates.length, 0);
  assert.equal(extraction.normalizedEvidence.planningObjectTextObservations.length, 1);
  const observation = extraction.normalizedEvidence.planningObjectTextObservations[0];
  assert.equal(observation.objectType, "tree");
  assert.equal(observation.objectCode, "T-22");
  assert.equal(observation.attributes.species, "Beech");
  assert.equal(observation.attributes.heightM, 9);
  assert.equal(observation.spatialAuthorityEligible, false);
  assert.equal(observation.linkageRequired, true);
  assert.equal(observation.worldGeometryAuthority, false);
  assert.equal(extraction.normalizedEvidence.drawingMetadata[0].planningObjectTextObservations.length, 1);
});

test("ride support detail templates receive universal object metadata but remain non-spatial", () => {
  const extraction = fixture({ candidateText: "" });
  extraction.normalizedEvidence.geometryCandidates = [];
  extraction.normalizedEvidence.rideStructureTemplates = [{
    id: "support-template-1",
    contentHash: "doc",
    pageNumber: 2,
    classification: "section",
    component: "support_frame",
    supportCode: "SUP-12",
    confidence: 0.98,
    explicitHeightM: 8.2,
    scaleDenominator: 50,
    worldGeometryAuthority: false
  }];
  const summary = enrichPlanningObjectEvidence(extraction);
  const template = extraction.normalizedEvidence.rideStructureTemplates[0];
  assert.equal(summary.objectCount, 1);
  assert.equal(template.planningObject.objectType, "ride_component");
  assert.equal(template.planningObject.geometryRole, "non-spatial-design-template");
  assert.equal(template.planningObject.objectCode, "SUP-12");
  assert.equal(template.planningObject.authority.spatialAuthorityEligible, false);
  assert.equal(template.planningObject.authority.linkageRequired, true);
});

function fixture({ candidateText, materialObservations = [], verticalObservations = [] }) {
  return {
    contentHash: "doc",
    classification: "site_plan",
    pages: [{
      pageNumber: 1,
      text: { items: candidateText ? [{ text: candidateText, xPt: 12, yPt: 12 }] : [] },
      metadata: null
    }],
    normalizedEvidence: {
      geometryCandidates: [{
        id: "candidate-1",
        contentHash: "doc",
        pageNumber: 1,
        vectorPathIndex: 0,
        classification: "site_plan",
        kind: "structure",
        closed: true,
        boundsPt: { minX: 10, minY: 10, maxX: 14, maxY: 14 },
        commands: [],
        confidence: 0.95,
        georegistrationRequired: true,
        spatialAuthorityEligible: true,
        worldGeometryAuthority: false
      }],
      verticalObservations,
      materialObservations,
      drawingMetadata: [],
      rideStructureTemplates: []
    }
  };
}
