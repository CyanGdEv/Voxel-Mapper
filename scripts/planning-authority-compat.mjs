#!/usr/bin/env node
import path from "node:path";
import { readFile } from "node:fs/promises";
import { appendArrayValues } from "../src/lib/array-utils.mjs";
import {
  readBundlePage,
  loadBundleManifest,
  AUTHORITY_BUNDLE_FORMAT,
  RESOLVED_BUNDLE_FORMAT
} from "../src/lib/planning-evidence-bundle.mjs";
import {
  buildImplementedApplicationProof,
  evaluateImplementedPlanningPage,
  mergeApplicationSnapshots,
  promoteCertifiedPageEvidence,
  promoteImplementedApplicationSupportEvidence
} from "../src/lib/planning-implemented-scheme-authority.mjs";
import { writeJson } from "../src/lib/io.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.manifest || !args.out) {
  console.error("Usage: planning-authority-compat.mjs --manifest planning-current-authority-evidence.json --out FILE");
  process.exit(2);
}

const pointerPath = path.resolve(args.manifest);
const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
if (pointer.format !== AUTHORITY_BUNDLE_FORMAT) throw new Error(`Unsupported authority manifest format: ${pointer.format || "unknown"}`);
const bundleRoot = path.resolve(path.dirname(pointerPath), pointer.bundlePath || ".");
const bundle = await loadBundleManifest(bundleRoot, AUTHORITY_BUNDLE_FORMAT);

let geometryCandidates = [];
let verticalObservations = [];
let materialObservations = [];
let rideStructureTemplates = [];
let drawingMetadata = [];
for (const page of bundle.manifest.pages || []) {
  const evidence = await readBundlePage(bundle.root, page);
  appendArrayValues(geometryCandidates, (evidence.geometryCandidates || []).filter(isAuthorityEntry));
  appendArrayValues(verticalObservations, (evidence.verticalObservations || []).filter(isAuthorityEntry));
  appendArrayValues(materialObservations, (evidence.materialObservations || []).filter(isAuthorityEntry));
  appendArrayValues(rideStructureTemplates, (evidence.rideStructureTemplates || []).filter(isCurrentTemplate));
  appendArrayValues(drawingMetadata, (evidence.drawingMetadata || []).filter(isAuthorityEntry));
}

// The strict revision resolver intentionally refuses to infer construction from
// planning approval. The world handoff adds a second, still fail-closed route:
// a plan may become current only when multiple independent post-decision current
// observations prove the implemented scheme. This is what allows verified
// planning geometry to differ from OSM instead of requiring every individual
// planning fragment to already exist in OSM.
const implementedSchemeAuthority = await collectImplementedSchemeAuthority(pointerPath);
appendArrayValues(geometryCandidates, implementedSchemeAuthority.geometryCandidates);
appendArrayValues(verticalObservations, implementedSchemeAuthority.verticalObservations);
appendArrayValues(materialObservations, implementedSchemeAuthority.materialObservations);
appendArrayValues(rideStructureTemplates, implementedSchemeAuthority.rideStructureTemplates);
appendArrayValues(drawingMetadata, implementedSchemeAuthority.drawingMetadata);

geometryCandidates = dedupeById(geometryCandidates);
verticalObservations = dedupeById(verticalObservations);
materialObservations = dedupeById(materialObservations);
rideStructureTemplates = dedupeTemplates(rideStructureTemplates);
drawingMetadata = dedupeById(drawingMetadata);

const hasAuthority = geometryCandidates.length || verticalObservations.length || materialObservations.length || drawingMetadata.length;
const output = {
  schemaVersion: 4,
  coordinateSpace: "local-world-metres-plus-nonspatial-templates",
  authorityScope: "planning-current-state-plus-independently-corroborated-implemented-schemes",
  sourceStorage: "chunked-page-ndjson",
  sourceBundle: pointer.bundlePath || null,
  worldGeometryReady: geometryCandidates.length > 0,
  worldGeometryAuthority: Boolean(hasAuthority),
  temporalResolutionRequired: false,
  geometryCandidates,
  verticalObservations,
  materialObservations,
  rideStructureTemplates,
  drawingMetadata,
  counts: {
    geometryCandidates: geometryCandidates.length,
    verticalObservations: verticalObservations.length,
    materialObservations: materialObservations.length,
    rideStructureTemplates: rideStructureTemplates.length,
    drawingMetadata: drawingMetadata.length
  },
  implementedSchemeAuthority: implementedSchemeAuthority.summary,
  templatePolicy: {
    spatialAuthority: false,
    worldGeometryAuthority: false,
    exactAuthoritativePlanAnchorLinkRequired: true,
    terrainGeometryMutable: false
  },
  terrainPolicy: {
    geometryAuthority: false,
    elevationAuthority: false,
    planningMayRepaintExistingTopSurfaceOnly: true
  },
  corroboration: pointer.corroboration || null
};
await writeJson(path.resolve(args.out), output);
console.log(JSON.stringify({
  out: path.resolve(args.out),
  counts: output.counts,
  worldGeometryAuthority: output.worldGeometryAuthority,
  implementedSchemeAuthority: output.implementedSchemeAuthority
}, null, 2));

async function collectImplementedSchemeAuthority(authorityPointerPath) {
  const empty = {
    geometryCandidates: [], verticalObservations: [], materialObservations: [],
    rideStructureTemplates: [], drawingMetadata: [],
    summary: { status: "unavailable", evaluatedPages: 0, certifiedSpatialPages: 0, certifiedContextPages: 0, implementedApplications: 0, promotedGeometryCandidates: 0, promotedVerticalObservations: 0, promotedMaterialObservations: 0, promotedRideStructureTemplates: 0, supportingEvidencePages: 0, pageProofs: [] }
  };
  const cwd = process.cwd();
  const resolvedPointerPath = path.resolve(path.dirname(authorityPointerPath), "planning-current-state-evidence.json");
  const resolvedPointer = await readJsonIfExists(resolvedPointerPath);
  const reference = await firstJson([
    path.resolve(cwd, "planning-georegistration-download/planning-georeg-reference.json"),
    path.resolve(cwd, "planning-georeg-reference.json")
  ]);
  const georegistration = await firstJson([
    path.resolve(cwd, "planning-georegistration-download/planning-georegistration.json"),
    path.resolve(cwd, "planning-georegistration.json")
  ]);
  const catalog = await readJsonIfExists(path.resolve(cwd, "planning-document-catalog.json"));
  const queue = await readJsonIfExists(path.resolve(cwd, "planning-document-queue.json"));
  if (!resolvedPointer || !reference?.features?.length || !catalog) return empty;
  if (resolvedPointer.format !== RESOLVED_BUNDLE_FORMAT) return { ...empty, summary: { ...empty.summary, status: "unsupported-resolved-bundle" } };

  const resolvedRoot = path.resolve(path.dirname(resolvedPointerPath), resolvedPointer.bundlePath || ".");
  const resolvedBundle = await loadBundleManifest(resolvedRoot, RESOLVED_BUNDLE_FORMAT);
  const applications = mergeApplicationSnapshots(catalog.applications || {}, queue?.planningApplicationSnapshot || {});
  const documentIndex = new Map((catalog.documents || []).map((document) => [document.contentHash, document]));
  const registrationIndex = new Map((georegistration?.registrations || []).map((entry) => [pageKey(entry.contentHash, entry.pageNumber), entry]));
  const pageRecords = [];

  for (const page of resolvedBundle.manifest.pages || []) {
    const evidence = await readBundlePage(resolvedBundle.root, page);
    const document = documentIndex.get(page.contentHash) || null;
    const applicationKeys = page.applicationKeys?.length ? page.applicationKeys : document?.applicationKeys || [];
    const applicationTemporal = applicationKeys.map((key) => applications[key]?.temporal).filter(Boolean);
    const drawingIssueDate = (evidence.drawingMetadata || []).find((entry) => entry.issueDate)?.issueDate || null;
    const registration = registrationIndex.get(pageKey(page.contentHash, page.pageNumber)) || null;
    const evaluation = evaluateImplementedPlanningPage({
      page,
      evidence,
      referenceFeatures: reference.features,
      applicationTemporal,
      drawingIssueDate,
      registration
    });
    pageRecords.push({ page, evidence, applicationKeys, applicationTemporal, registration, evaluation });
  }

  const applicationRecords = new Map();
  for (const record of pageRecords) {
    for (const applicationKey of record.applicationKeys) {
      if (!applicationRecords.has(applicationKey)) applicationRecords.set(applicationKey, []);
      applicationRecords.get(applicationKey).push(record);
    }
  }
  const applicationProofs = new Map();
  for (const [applicationKey, records] of applicationRecords) {
    const applicationTemporal = records.flatMap((record) => record.applicationTemporal || []);
    const proof = buildImplementedApplicationProof(applicationKey, records, applicationTemporal);
    if (proof.accepted) applicationProofs.set(applicationKey, proof);
  }

  const promoted = {
    geometryCandidates: [], verticalObservations: [], materialObservations: [],
    rideStructureTemplates: [], drawingMetadata: []
  };
  let supportingEvidencePages = 0;
  const pageProofs = [];
  for (const record of pageRecords) {
    let promotion = null;
    if (record.evaluation.certifiedSpatialAuthority || record.evaluation.certifiedContext) {
      promotion = promoteCertifiedPageEvidence(record.evidence, record.evaluation);
    } else {
      const proof = record.applicationKeys.map((key) => applicationProofs.get(key)).filter(Boolean)
        .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))[0] || null;
      if (proof) {
        promotion = promoteImplementedApplicationSupportEvidence(record.evidence, record.page, proof);
        if (promotion.verticalObservations.length || promotion.materialObservations.length || promotion.rideStructureTemplates.length || promotion.drawingMetadata.length) supportingEvidencePages += 1;
      }
    }
    if (promotion) {
      appendArrayValues(promoted.geometryCandidates, promotion.geometryCandidates);
      appendArrayValues(promoted.verticalObservations, promotion.verticalObservations);
      appendArrayValues(promoted.materialObservations, promotion.materialObservations);
      appendArrayValues(promoted.rideStructureTemplates, promotion.rideStructureTemplates);
      appendArrayValues(promoted.drawingMetadata, promotion.drawingMetadata);
    }
    if (record.evaluation.accepted || record.evaluation.anchorCount > 0) {
      pageProofs.push({
        contentHash: record.page.contentHash,
        pageNumber: record.page.pageNumber,
        classification: record.evaluation.classification,
        status: record.evaluation.status,
        anchors: record.evaluation.anchorCount,
        uniqueCurrentFeatures: record.evaluation.uniqueFeatureCount,
        uniqueFeatureKinds: record.evaluation.uniqueFeatureKinds,
        medianMatchScore: record.evaluation.medianMatchScore,
        registrationAnchors: record.evaluation.registrationAnchorCount,
        registrationUniqueFeatures: record.evaluation.registrationUniqueFeatureCount,
        registrationRmseM: record.evaluation.registrationRmseM,
        candidateProofChecks: record.evaluation.candidateProofChecks,
        proofBoundReached: record.evaluation.proofBoundReached,
        applicationKeys: record.applicationKeys
      });
    }
  }

  promoted.geometryCandidates = dedupeById(promoted.geometryCandidates);
  promoted.verticalObservations = dedupeById(promoted.verticalObservations);
  promoted.materialObservations = dedupeById(promoted.materialObservations);
  promoted.rideStructureTemplates = dedupeTemplates(promoted.rideStructureTemplates);
  promoted.drawingMetadata = dedupeById(promoted.drawingMetadata);
  return {
    ...promoted,
    summary: {
      status: applicationProofs.size || promoted.geometryCandidates.length ? "applied" : "no-implemented-scheme-proof",
      evaluatedPages: pageRecords.length,
      georegistrationProofAvailable: registrationIndex.size > 0,
      georegistrationRecords: registrationIndex.size,
      certifiedSpatialPages: pageRecords.filter((record) => record.evaluation.certifiedSpatialAuthority).length,
      certifiedContextPages: pageRecords.filter((record) => record.evaluation.certifiedContext).length,
      implementedApplications: applicationProofs.size,
      promotedGeometryCandidates: promoted.geometryCandidates.length,
      promotedVerticalObservations: promoted.verticalObservations.length,
      promotedMaterialObservations: promoted.materialObservations.length,
      promotedRideStructureTemplates: promoted.rideStructureTemplates.length,
      supportingEvidencePages,
      pageProofs: pageProofs.sort((a, b) => b.anchors - a.anchors || String(a.contentHash).localeCompare(String(b.contentHash))).slice(0, 200)
    }
  };
}

function isAuthorityEntry(entry) { return entry?.worldGeometryAuthority === true && entry?.planningTemporal?.state === "current"; }
function isCurrentTemplate(entry) {
  return entry?.templateAuthorityEligible === true && entry?.planningTemporal?.state === "current" && entry?.worldGeometryAuthority !== true;
}
function dedupeById(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const key = value?.id || `${value?.contentHash || ""}:p${value?.pageNumber || 0}:${JSON.stringify(value?.localGeometry || value?.raw || value?.attributes || {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result.sort((a, b) => String(a.contentHash || "").localeCompare(String(b.contentHash || "")) || Number(a.pageNumber || 0) - Number(b.pageNumber || 0) || String(a.id || "").localeCompare(String(b.id || "")));
}
function dedupeTemplates(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const key = value?.id || `${value?.contentHash || ""}:p${value?.pageNumber || 0}:${value?.supportCode || ""}:${value?.component || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result.sort((a, b) => String(a.contentHash || "").localeCompare(String(b.contentHash || "")) || Number(a.pageNumber || 0) - Number(b.pageNumber || 0) || String(a.id || "").localeCompare(String(b.id || "")));
}
function pageKey(contentHash, pageNumber) { return `${contentHash || ""}:p${Number(pageNumber || 1)}`; }
async function readJsonIfExists(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}
async function firstJson(files) {
  for (const file of files) {
    const value = await readJsonIfExists(file);
    if (value) return value;
  }
  return null;
}
function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = values[++index];
    if (value == null || value.startsWith("--")) throw new Error(`${token} requires a value`);
    result[key] = value;
  }
  return result;
}
