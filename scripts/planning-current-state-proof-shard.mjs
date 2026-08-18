#!/usr/bin/env node
import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  REGISTERED_BUNDLE_FORMAT,
  loadBundleManifest,
  readBundlePage
} from "../src/lib/planning-evidence-bundle.mjs";
import {
  evaluateImplementedPlanningPage,
  mergeApplicationSnapshots
} from "../src/lib/planning-implemented-scheme-authority.mjs";
import { writeJson } from "../src/lib/io.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.registered || !args.plan || !args.reference || !args.catalog || !args.out) {
  console.error("Usage: planning-current-state-proof-shard.mjs --registered DIR --plan FILE --reference FILE --catalog FILE --out FILE [--queue FILE] [--shard N]");
  process.exit(2);
}

const bundle = await loadBundleManifest(path.resolve(args.registered), REGISTERED_BUNDLE_FORMAT);
const plan = await readJson(args.plan);
const reference = await readJson(args.reference);
const catalog = await readJson(args.catalog);
if (args.queue) {
  const queue = await readJson(args.queue);
  catalog.applications = mergeApplicationSnapshots(catalog.applications || {}, queue.planningApplicationSnapshot || {});
}
const documentIndex = new Map((catalog.documents || []).map((document) => [document.contentHash, document]));
const referenceFeatures = reference.features || [];
const pages = [];
const summary = {
  evaluatedPages: 0,
  certifiedSpatialPages: 0,
  certifiedContextPages: 0,
  rejectedPages: 0,
  registrationAnchorCount: 0,
  candidateProofChecks: 0,
  rejected: {}
};

for (const pageEntry of bundle.manifest.pages || []) {
  const key = pageKey(pageEntry.contentHash, pageEntry.pageNumber);
  const baseDecision = plan.pageDecisions?.[key] || unknownDecision();
  const evidence = await readBundlePage(bundle.root, pageEntry);
  const document = documentIndex.get(pageEntry.contentHash) || null;
  const applicationKeys = document?.applicationKeys?.length ? document.applicationKeys : pageEntry.applicationKeys || [];
  const applicationTemporal = applicationKeys
    .map((applicationKey) => catalog.applications?.[applicationKey]?.temporal)
    .filter(Boolean);
  const drawingIssueDate = (evidence.drawingMetadata || []).find((entry) => entry.issueDate)?.issueDate || null;
  const evaluation = evaluateImplementedPlanningPage({
    page: { ...pageEntry, planningTemporal: baseDecision },
    evidence,
    referenceFeatures,
    applicationTemporal,
    drawingIssueDate,
    registration: pageRegistration(pageEntry),
    options: implementedSchemeOptions()
  });

  pages.push({
    key,
    page: compactPage(pageEntry),
    baseDecision,
    applicationKeys,
    evaluation
  });
  summary.evaluatedPages += 1;
  summary.registrationAnchorCount += Number(evaluation.registrationAnchorCount || 0);
  summary.candidateProofChecks += Number(evaluation.candidateProofChecks || 0);
  if (evaluation.certifiedSpatialAuthority) summary.certifiedSpatialPages += 1;
  else if (evaluation.certifiedContext) summary.certifiedContextPages += 1;
  else summary.rejectedPages += 1;
  mergeCounts(summary.rejected, evaluation.rejected);
}

const shard = Number.isInteger(Number(args.shard)) ? Number(args.shard) : inferShard(bundle.manifest, args.registered);
const output = {
  schemaVersion: 1,
  format: "voxel-planning-current-state-proof-shard-v1",
  shard,
  sourceRegisteredBundle: path.resolve(args.registered),
  pageCount: pages.length,
  summary,
  pages: pages.sort((a, b) => pageSort(a.page, b.page))
};
await writeJson(path.resolve(args.out), output);
console.log(JSON.stringify({ shard, ...summary, out: path.resolve(args.out) }, null, 2));

function implementedSchemeOptions() {
  return {
    minAnchors: number(args.implementedSchemeMinAnchors, 4),
    minUniqueFeatures: number(args.implementedSchemeMinUniqueFeatures, 2),
    minMedianScore: number(args.implementedSchemeMinMedianScore, 0.78),
    minRegistrationFeatures: number(args.implementedSchemeMinRegistrationFeatures, 3),
    maxRegistrationMatchRmseM: number(args.implementedSchemeMaxRegistrationMatchRmseM, 1.0),
    maxRegistrationPageRmseM: number(args.implementedSchemeMaxRegistrationPageRmseM, 1.0),
    maxCandidateProofChecks: number(args.implementedSchemeMaxCandidateProofChecks, 2500),
    minMatchScore: number(args.corroborationMinMatchScore, 0.78),
    ambiguityGap: number(args.corroborationAmbiguityGap, 0.08),
    maxRetainedDiagnosticAnchors: number(args.maxRetainedDiagnosticAnchors, 24)
  };
}
function compactPage(page) {
  return {
    contentHash: page?.contentHash || null,
    pageNumber: Number(page?.pageNumber || 1),
    classification: page?.classification || null,
    applicationKeys: page?.applicationKeys || [],
    georegistrationStatus: page?.georegistrationStatus || null,
    geometryCount: Number(page?.geometryCount || 0),
    verticalCount: Number(page?.verticalCount || 0),
    materialCount: Number(page?.materialCount || 0),
    rideStructureTemplateCount: Number(page?.rideStructureTemplateCount || 0)
  };
}
function pageRegistration(pageEntry) {
  return {
    status: pageEntry?.georegistrationStatus || "unregistered",
    solution: pageEntry?.registration || null,
    automaticMatches: pageEntry?.automaticMatches || [],
    explicitControlPoints: Number(pageEntry?.explicitControlPoints || 0),
    automaticControlPoints: Number(pageEntry?.automaticControlPoints || 0)
  };
}
function inferShard(manifest, source) {
  const explicit = Number(manifest?.selectedShard);
  if (Number.isInteger(explicit) && explicit >= 0) return explicit;
  const match = String(source || "").match(/(?:shard[-_])(\d+)/i);
  return match ? Number(match[1]) : -1;
}
function unknownDecision() {
  return {
    state: "unknown",
    confidence: 0.45,
    reason: "missing-page-temporal-resolution",
    temporalResolved: false,
    worldGeometryAuthority: false,
    lineageMemberships: []
  };
}
function pageKey(contentHash, pageNumber) { return `${contentHash || "unknown-document"}:p${Number(pageNumber || 1)}`; }
function pageSort(a, b) { return String(a.contentHash || "").localeCompare(String(b.contentHash || "")) || Number(a.pageNumber || 0) - Number(b.pageNumber || 0); }
function mergeCounts(target, source) { for (const [key, value] of Object.entries(source || {})) target[key] = (target[key] || 0) + Number(value || 0); }
function number(value, fallback) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
async function readJson(filename) { return JSON.parse(await readFile(path.resolve(filename), "utf8")); }
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
