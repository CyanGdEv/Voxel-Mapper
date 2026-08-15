import test from "node:test";
import assert from "node:assert/strict";
import {
  comparePlanningRevisions,
  resolvePlanningLifecycleEvidence,
  resolvePlanningRevisionAuthority
} from "../src/lib/planning-revision-resolver.mjs";
import { enrichDrawingLifecycleMetadata } from "../src/lib/planning-text-evidence.mjs";

function pageEvidence(contentHash, revision, status, geometryId) {
  return {
    drawingMetadata: [{
      contentHash,
      pageNumber: 1,
      drawingNumber: "TP-100",
      revision,
      status,
      issueDate: "2026-01-01T00:00:00.000Z"
    }],
    geometryCandidates: [{
      id: geometryId,
      contentHash,
      pageNumber: 1,
      coordinateSpace: "local-world-metres",
      spatialAuthorityEligible: true,
      worldGeometryAuthority: false,
      localGeometry: { type: "Polygon", coordinates: [[[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]]] }
    }]
  };
}

function registered(...pages) {
  return {
    schemaVersion: 1,
    coordinateSpace: "local-world-metres",
    worldGeometryReady: true,
    worldGeometryAuthority: false,
    temporalResolutionRequired: true,
    drawingMetadata: pages.flatMap((page) => page.drawingMetadata),
    geometryCandidates: pages.flatMap((page) => page.geometryCandidates),
    verticalObservations: [],
    materialObservations: []
  };
}

function catalog(documents, temporal = { statusEvidence: [] }) {
  return {
    applications: {
      "entity:100": {
        key: "entity:100",
        reference: "APP/100",
        temporal
      }
    },
    documents: documents.map((document) => ({
      classification: "site-plan",
      labels: ["Proposed Site Plan"],
      applicationKeys: ["entity:100"],
      previousContentHashes: [],
      ...document
    }))
  };
}

test("a newer proposed drawing supersedes the document revision but not the older as-built physical state", () => {
  const oldPage = pageEvidence("old", "A", "as-built", "old-geometry");
  const newPage = pageEvidence("new", "B", "planning", "new-geometry");
  const result = resolvePlanningRevisionAuthority(
    registered(oldPage, newPage),
    catalog([{ contentHash: "old" }, { contentHash: "new" }]),
    { referenceDate: "2026-08-15T00:00:00Z" }
  );

  const oldGeometry = result.resolvedEvidence.geometryCandidates.find((entry) => entry.contentHash === "old");
  const newGeometry = result.resolvedEvidence.geometryCandidates.find((entry) => entry.contentHash === "new");
  assert.equal(oldGeometry.planningTemporal.state, "current");
  assert.equal(oldGeometry.worldGeometryAuthority, true);
  assert.equal(oldGeometry.planningTemporal.lineageMemberships[0].documentRevisionState, "superseded");
  assert.equal(oldGeometry.planningTemporal.lineageMemberships[0].worldSelectionState, "selected-current");
  assert.equal(newGeometry.planningTemporal.state, "proposed");
  assert.equal(newGeometry.worldGeometryAuthority, false);
});

test("a newer as-built revision becomes the sole physical-current authority", () => {
  const oldPage = pageEvidence("old", "A", "as-built", "old-geometry");
  const newPage = pageEvidence("new", "B", "as-built", "new-geometry");
  const result = resolvePlanningRevisionAuthority(
    registered(oldPage, newPage),
    catalog([{ contentHash: "old" }, { contentHash: "new" }])
  );
  const oldGeometry = result.resolvedEvidence.geometryCandidates.find((entry) => entry.contentHash === "old");
  const newGeometry = result.resolvedEvidence.geometryCandidates.find((entry) => entry.contentHash === "new");
  assert.equal(oldGeometry.worldGeometryAuthority, false);
  assert.equal(newGeometry.worldGeometryAuthority, true);
  assert.equal(result.summary.authoritativeCurrentPages, 1);
});

test("planning approval alone remains proposed and cannot become world authority", () => {
  const page = pageEvidence("approved", "P01", null, "approved-geometry");
  const result = resolvePlanningRevisionAuthority(
    registered(page),
    catalog([{ contentHash: "approved" }], { statusEvidence: ["approved"] })
  );
  assert.equal(result.pages[0].decision.state, "proposed");
  assert.equal(result.pages[0].decision.worldGeometryAuthority, false);
});

test("refused application state blocks spatially registered geometry", () => {
  const page = pageEvidence("refused", "P03", "planning", "refused-geometry");
  const result = resolvePlanningRevisionAuthority(
    registered(page),
    catalog([{ contentHash: "refused" }], { statusEvidence: ["refused"] })
  );
  assert.equal(result.pages[0].decision.state, "refused");
  assert.equal(result.resolvedEvidence.geometryCandidates[0].worldGeometryAuthority, false);
});

test("revision ordering is conservative across incompatible revision schemes", () => {
  assert.equal(comparePlanningRevisions("A", "B"), -1);
  assert.equal(comparePlanningRevisions("P02", "P10"), -1);
  assert.equal(comparePlanningRevisions("07", "6"), 1);
  assert.equal(comparePlanningRevisions("P03", "C01"), null);
  assert.equal(comparePlanningRevisions("A", "01"), null);
});

test("for-construction status is delivery intent, not proof that geometry exists", () => {
  const state = resolvePlanningLifecycleEvidence({ drawingStatus: "construction", applicationTemporal: { statusEvidence: ["approved"] } });
  assert.equal(state.state, "proposed");
  assert.ok(state.confidence >= 0.8);
});

test("title block enrichment recognizes as-built state and a UK issue date", () => {
  const metadata = enrichDrawingLifecycleMetadata(
    { pageNumber: 1, drawingNumber: "TP-100", revision: "C", status: null, scaleDenominator: 100, source: "pdf-text-title-block" },
    [
      { text: "STATUS: AS BUILT" },
      { text: "DATE: 14/07/2026" }
    ],
    1
  );
  assert.equal(metadata.status, "as-built");
  assert.equal(metadata.issueDate, "2026-07-14T00:00:00.000Z");
});
