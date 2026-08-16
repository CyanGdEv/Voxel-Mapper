#!/usr/bin/env node
import path from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { georegisterPlanningEvidence } from "../src/lib/planning-georegistration.mjs";
import { georegisterPlanningEvidenceBatch } from "../src/lib/planning-georegistration-batch.mjs";
import {
  EXTRACTION_BUNDLE_FORMAT,
  REGISTERED_BUNDLE_FORMAT,
  loadBundleManifest,
  readBundlePage,
  writeBundleManifest,
  writeEvidencePageStreams
} from "../src/lib/planning-evidence-bundle.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.evidence || !args.reference || !args.out) {
  console.error("Usage: planning-georegister.mjs --evidence planning-vector-evidence --reference planning-georeg-reference.json --out FILE [--registered-out PATH] [--control-points FILE] [--strict]");
  process.exit(2);
}

const reference = await readJson(args.reference);
const controlPoints = args.controlPoints ? normalizeControlPointFile(await readJson(args.controlPoints)) : [];
const evidencePath = path.resolve(args.evidence);
const evidenceStat = await stat(evidencePath);

if (evidenceStat.isDirectory()) await georegisterBundle(evidencePath, reference, controlPoints);
else await georegisterLegacyJson(evidencePath, reference, controlPoints);

async function georegisterLegacyJson(evidencePath, reference, controlPoints) {
  const extraction = await readJson(evidencePath);
  const result = georegisterPlanningEvidenceBatch(extraction, reference.features || [], registrationOptions(controlPoints));
  await writeJson(args.out, {
    ...result,
    bbox: reference.bbox || null,
    referenceProvider: reference.provider || null,
    referenceFeatureCount: reference.featureCount ?? reference.features?.length ?? 0
  });
  if (args.registeredOut) await writeJson(args.registeredOut, result.registeredEvidence);

  console.log(JSON.stringify({
    status: result.status,
    mode: "legacy-json",
    groups: result.groupCount,
    registeredGroups: result.registeredGroupCount,
    unregisteredGroups: result.unregisteredGroupCount,
    registeredGeometryCandidates: result.registeredEvidence?.geometryCandidates?.length || 0,
    registeredVerticalObservations: result.registeredEvidence?.verticalObservations?.length || 0,
    registeredMaterialObservations: result.registeredEvidence?.materialObservations?.length || 0,
    rideStructureTemplates: result.registeredEvidence?.rideStructureTemplates?.length || 0,
    out: path.resolve(args.out),
    registeredOut: args.registeredOut ? path.resolve(args.registeredOut) : null
  }, null, 2));
  if (args.strict && result.status !== "registered") process.exitCode = 1;
}

async function georegisterBundle(evidencePath, reference, controlPoints) {
  const bundle = await loadBundleManifest(evidencePath, EXTRACTION_BUNDLE_FORMAT);
  const registeredRoot = path.resolve(args.registeredOut || "planning-registered-evidence");
  await mkdir(registeredRoot, { recursive: true });
  const registrations = [];
  const evidencePages = [];
  let spatialRegisteredPages = 0;
  let templateOnlyPages = 0;
  let registeredGeometryCandidates = 0;
  let registeredVerticalObservations = 0;
  let registeredMaterialObservations = 0;
  let rideStructureTemplates = 0;

  for (const pageEntry of bundle.manifest.pages || []) {
    const evidence = await readBundlePage(bundle.root, pageEntry);
    const templates = (evidence.rideStructureTemplates || []).map(markTemplateSpace);
    const hasSpatialEvidence = (evidence.geometryCandidates?.length || 0) + (evidence.verticalObservations?.length || 0) + (evidence.materialObservations?.length || 0) > 0;

    // Side elevations/sections can contain valuable support-frame design but
    // are not overhead map geometry. Preserve a template-only page without
    // attempting to manufacture a page->world transform for it.
    if (!hasSpatialEvidence && templates.length) {
      const compact = {
        contentHash: pageEntry.contentHash,
        pageNumber: pageEntry.pageNumber,
        classification: pageEntry.classification || null,
        status: "template-only",
        solution: null,
        automaticMatches: [],
        explicitControlPoints: 0,
        automaticControlPoints: 0,
        rideStructureTemplateCount: templates.length
      };
      registrations.push(compact);
      const templatePage = await writeEvidencePageStreams(registeredRoot, {
        ...pageEntry,
        georegistrationStatus: "template-only",
        registration: null,
        geometryFile: null,
        verticalFile: null,
        materialFile: null,
        templateFile: null
      }, {
        geometryCandidates: [],
        verticalObservations: [],
        materialObservations: [],
        rideStructureTemplates: templates,
        drawingMetadata: evidence.drawingMetadata || []
      });
      templatePage.georegistrationStatus = "template-only";
      evidencePages.push(templatePage);
      templateOnlyPages += 1;
      rideStructureTemplates += templates.length;
      continue;
    }

    const extraction = {
      schemaVersion: 1,
      contentHash: pageEntry.contentHash,
      pageCount: 1,
      normalizedEvidence: {
        schemaVersion: 1,
        coordinateSpace: "pdf-user-space-points",
        georegistrationStatus: "required",
        worldGeometryReady: false,
        geometryCandidates: evidence.geometryCandidates,
        verticalObservations: evidence.verticalObservations,
        materialObservations: evidence.materialObservations,
        drawingMetadata: evidence.drawingMetadata
      }
    };
    const scopedControls = controlsForPage(controlPoints, pageEntry, bundle.manifest.pageCount || 1);
    const result = georegisterPlanningEvidence(extraction, reference.features || [], registrationOptions(scopedControls));
    const compact = {
      contentHash: pageEntry.contentHash,
      pageNumber: pageEntry.pageNumber,
      classification: pageEntry.classification || null,
      status: result.status,
      solution: result.solution ? compactSolution(result.solution) : null,
      automaticMatches: result.automaticMatches || [],
      explicitControlPoints: result.explicitControlPoints || 0,
      automaticControlPoints: result.automaticControlPoints || 0,
      rideStructureTemplateCount: templates.length
    };
    registrations.push(compact);
    if (result.status !== "registered" || !result.registeredEvidence) continue;
    result.registeredEvidence.rideStructureTemplates = templates;
    const registeredPage = await writeEvidencePageStreams(registeredRoot, {
      ...pageEntry,
      georegistrationStatus: "registered",
      registration: compact.solution,
      geometryFile: null,
      verticalFile: null,
      materialFile: null,
      templateFile: null
    }, result.registeredEvidence);
    registeredPage.registration = compact.solution;
    registeredPage.georegistrationStatus = "registered";
    evidencePages.push(registeredPage);
    spatialRegisteredPages += 1;
    registeredGeometryCandidates += registeredPage.geometryCount || 0;
    registeredVerticalObservations += registeredPage.verticalCount || 0;
    registeredMaterialObservations += registeredPage.materialCount || 0;
    rideStructureTemplates += registeredPage.rideStructureTemplateCount || 0;
  }

  const spatialRegistrations = registrations.filter((entry) => entry.status !== "template-only");
  const failed = spatialRegistrations.filter((entry) => entry.status !== "registered");
  const unregisteredPages = failed.map((entry) => ({
    contentHash: entry.contentHash,
    pageNumber: entry.pageNumber,
    classification: entry.classification,
    rejectionReasons: entry.solution?.rejectionReasons || ["registration-failed"]
  }));
  const status = !spatialRegistrations.length
    ? (templateOnlyPages ? "template-only" : "unregistered")
    : spatialRegisteredPages === spatialRegistrations.length ? "registered" : spatialRegisteredPages ? "partially-registered" : "unregistered";
  const registeredManifest = {
    schemaVersion: 1,
    format: REGISTERED_BUNDLE_FORMAT,
    stage: "registered",
    coordinateSpace: "local-world-metres-plus-nonspatial-templates",
    georegistrationStatus: status,
    worldGeometryReady: registeredGeometryCandidates > 0,
    worldGeometryAuthority: false,
    spatialAuthorityEligible: true,
    temporalResolutionRequired: true,
    sourceBundleFormat: bundle.manifest.format,
    pageCount: registrations.length,
    evidencePageCount: evidencePages.length,
    registeredPageCount: spatialRegisteredPages,
    templateOnlyPageCount: templateOnlyPages,
    unregisteredPageCount: unregisteredPages.length,
    geometryCandidateCount: registeredGeometryCandidates,
    verticalObservationCount: registeredVerticalObservations,
    materialObservationCount: registeredMaterialObservations,
    rideStructureTemplateCount: rideStructureTemplates,
    pages: evidencePages.sort(pageSort),
    unregisteredPages
  };
  await writeBundleManifest(registeredRoot, registeredManifest);
  const report = {
    schemaVersion: 3,
    status,
    groupCount: registrations.length,
    registeredGroupCount: spatialRegisteredPages,
    templateOnlyGroupCount: templateOnlyPages,
    unregisteredGroupCount: unregisteredPages.length,
    registrations,
    unregisteredPages,
    bbox: reference.bbox || null,
    referenceProvider: reference.provider || null,
    referenceFeatureCount: reference.featureCount ?? reference.features?.length ?? 0,
    registeredEvidence: {
      format: REGISTERED_BUNDLE_FORMAT,
      manifest: path.relative(path.dirname(path.resolve(args.out)), path.join(registeredRoot, "manifest.json")),
      coordinateSpace: "local-world-metres-plus-nonspatial-templates",
      worldGeometryReady: registeredGeometryCandidates > 0,
      worldGeometryAuthority: false,
      temporalResolutionRequired: true,
      registeredPageCount: spatialRegisteredPages,
      templateOnlyPageCount: templateOnlyPages,
      geometryCandidateCount: registeredGeometryCandidates,
      verticalObservationCount: registeredVerticalObservations,
      materialObservationCount: registeredMaterialObservations,
      rideStructureTemplateCount: rideStructureTemplates
    }
  };
  await writeJson(args.out, report);

  console.log(JSON.stringify({
    status,
    mode: "chunked-bundle",
    groups: registrations.length,
    registeredGroups: spatialRegisteredPages,
    templateOnlyGroups: templateOnlyPages,
    unregisteredGroups: unregisteredPages.length,
    registeredGeometryCandidates,
    registeredVerticalObservations,
    registeredMaterialObservations,
    rideStructureTemplates,
    out: path.resolve(args.out),
    registeredOut: registeredRoot
  }, null, 2));
  if (args.strict && failed.length > 0) process.exitCode = 1;
}

function markTemplateSpace(template) {
  return {
    ...template,
    coordinateSpace: "pdf-template-space",
    georegistrationRequired: false,
    georegistrationStatus: "not-applicable-template",
    spatialAuthorityEligible: false,
    worldGeometryReady: false,
    worldGeometryAuthority: false,
    linkageRequired: true,
    terrainGeometryMutable: false
  };
}

function registrationOptions(controlPoints) {
  return {
    controlPoints,
    model: args.model || "similarity",
    inlierThresholdM: number(args.inlierThresholdM, 1.5),
    maxRmseM: number(args.maxRmseM, 1.25),
    maxResidualM: number(args.maxResidualM, 3.5),
    minInliers: number(args.minInliers, 3),
    maxScaleRelativeError: number(args.maxScaleRelativeError, 0.22),
    maxAutoScaleRelativeError: number(args.maxAutoScaleRelativeError, 0.28),
    maxAutoShapeRmseM: number(args.maxAutoShapeRmseM, 1.8)
  };
}
function compactSolution(solution) {
  return {
    status: solution.status,
    pass: solution.pass,
    model: solution.model,
    transform: solution.transform,
    controlPointCount: solution.controlPointCount,
    inlierCount: solution.inlierCount,
    outlierCount: solution.outlierCount,
    rmseM: solution.rmseM,
    maxResidualM: solution.maxResidualM,
    medianResidualM: solution.medianResidualM,
    scaleMPerPt: solution.scaleMPerPt,
    rotationDeg: solution.rotationDeg,
    determinant: solution.determinant,
    expectedScaleMPerPt: solution.expectedScaleMPerPt,
    scaleRelativeError: solution.scaleRelativeError,
    qualityGates: solution.qualityGates,
    rejectionReasons: solution.rejectionReasons || []
  };
}
function controlsForPage(values, page, pageCount) {
  if (pageCount === 1) return values || [];
  return (values || []).filter((point) => {
    if (!point.contentHash && !point.pageNumber) return false;
    return (!point.contentHash || point.contentHash === page.contentHash) &&
      (!point.pageNumber || Number(point.pageNumber) === Number(page.pageNumber));
  });
}
function pageSort(a, b) { return String(a.contentHash || "").localeCompare(String(b.contentHash || "")) || Number(a.pageNumber || 0) - Number(b.pageNumber || 0); }
async function readJson(filename) { return JSON.parse(await readFile(path.resolve(filename), "utf8")); }
async function writeJson(filename, value) {
  const resolved = path.resolve(filename);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, JSON.stringify(value, null, 2) + "\n");
}
function normalizeControlPointFile(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.controlPoints)) return value.controlPoints;
  throw new Error("Control-point file must be an array or an object with controlPoints[]");
}
function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (token === "--strict") { result.strict = true; continue; }
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = values[++index];
    if (value == null || value.startsWith("--")) throw new Error(`${token} requires a value`);
    result[key] = value;
  }
  return result;
}
function number(value, fallback) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
