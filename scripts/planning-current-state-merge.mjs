#!/usr/bin/env node
import path from "node:path";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import {
  AUTHORITY_BUNDLE_FORMAT,
  RESOLVED_BUNDLE_FORMAT,
  findBundleManifests,
  writeBundleManifest
} from "../src/lib/planning-evidence-bundle.mjs";
import { writeJson } from "../src/lib/io.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.shards || !args.plan || !args.applications || !args.revisionOut || !args.resolvedOut || !args.authorityOut) {
  console.error("Usage: planning-current-state-merge.mjs --shards DIR --plan FILE --applications FILE --revision-out FILE --resolved-out FILE --authority-out FILE [--georeg-out FILE] [--registered-manifest-out FILE]");
  process.exit(2);
}

const plan = await readJson(args.plan);
const applicationProofs = await readJson(args.applications);
const shardRoot = path.resolve(args.shards);
const resolvedLocated = await findBundleManifests(shardRoot, RESOLVED_BUNDLE_FORMAT);
const authorityLocated = await findBundleManifests(shardRoot, AUTHORITY_BUNDLE_FORMAT);
if (!resolvedLocated.length) throw new Error("No resolved current-state shard bundles found");
if (!authorityLocated.length) throw new Error("No authority current-state shard bundles found");

const resolvedManifestPath = path.resolve(args.resolvedOut);
const authorityManifestPath = path.resolve(args.authorityOut);
const resolvedRoot = siblingBundleRoot(resolvedManifestPath, "planning-current-state-evidence-bundle");
const authorityRoot = siblingBundleRoot(authorityManifestPath, "planning-current-authority-pointer-bundle");
const resolved = await mergeBundles(resolvedLocated, resolvedRoot, RESOLVED_BUNDLE_FORMAT, "resolved-current-state");
const authority = await mergeBundles(authorityLocated, authorityRoot, AUTHORITY_BUNDLE_FORMAT, "strict-current-authority");

const shardSummaries = resolvedLocated.map((entry) => ({
  shard: Number(entry.manifest.selectedShard ?? -1),
  ...(entry.manifest.implementedScheme || {}),
  corroboration: entry.manifest.corroboration || null
})).sort((a, b) => a.shard - b.shard);
const implementedScheme = aggregateImplementedScheme(resolved.pages, shardSummaries, applicationProofs);
const corroboration = aggregateCorroboration(shardSummaries);

resolved.manifest.implementedScheme = compactImplementedScheme(implementedScheme);
resolved.manifest.corroboration = compactCorroboration(corroboration);
authority.manifest.implementedScheme = compactImplementedScheme(implementedScheme);
authority.manifest.corroboration = compactCorroboration(corroboration);
authority.manifest.authorityScope = "planning-current-state-only";
authority.manifest.worldGeometryAuthority = authority.pages.some(hasWorldAuthorityEvidence);
authority.manifest.worldGeometryReady = authority.pages.some((page) => Number(page.geometryCount || 0) > 0);
authority.manifest.templateAuthorityRule = "current template is non-spatial and usable only through exact authoritative plan-anchor linkage";
await writeBundleManifest(resolvedRoot, resolved.manifest);
await writeBundleManifest(authorityRoot, authority.manifest);

await writeJson(resolvedManifestPath, {
  ...resolved.manifest,
  bundlePath: path.relative(path.dirname(resolvedManifestPath), resolvedRoot) || "."
});
await writeJson(authorityManifestPath, {
  ...authority.manifest,
  bundlePath: path.relative(path.dirname(authorityManifestPath), authorityRoot) || "."
});

const revision = {
  ...(plan.revision || {}),
  applicationSnapshotAt: plan.applicationSnapshotAt || null,
  applicationSnapshotProvider: plan.applicationSnapshotProvider || null,
  evidenceStorage: "sharded-page-ndjson",
  currentStateBundle: path.relative(path.dirname(path.resolve(args.revisionOut)), resolvedRoot),
  authorityBundle: path.relative(path.dirname(path.resolve(args.revisionOut)), authorityRoot),
  corroboration,
  implementedScheme
};
await writeJson(path.resolve(args.revisionOut), revision);

if (args.registeredManifestOut) {
  const registeredPath = path.resolve(args.registeredManifestOut);
  await mkdir(path.dirname(registeredPath), { recursive: true });
  await writeJson(registeredPath, plan.registeredManifest || emptyRegisteredManifest());
}
if (args.georegOut) await writeJson(path.resolve(args.georegOut), georegistrationAudit(plan.registeredManifest || emptyRegisteredManifest()));

console.log(JSON.stringify({
  status: plan.revision?.status || "unknown",
  shardBundles: resolvedLocated.length,
  resolvedPages: resolved.pages.length,
  authorityPages: authority.pages.length,
  authoritativeGeometryCandidates: authority.manifest.geometryCandidateCount,
  authoritativeVerticalObservations: authority.manifest.verticalObservationCount,
  authoritativeMaterialObservations: authority.manifest.materialObservationCount,
  authoritativeRideStructureTemplates: authority.manifest.rideStructureTemplateCount,
  certifiedSpatialPages: implementedScheme.certifiedSpatialPages,
  implementedApplications: implementedScheme.applicationProofsAccepted,
  revisionOut: path.resolve(args.revisionOut),
  resolvedOut: resolvedManifestPath,
  authorityOut: authorityManifestPath
}, null, 2));

async function mergeBundles(located, outRoot, format, stage) {
  await mkdir(path.join(outRoot, "pages"), { recursive: true });
  const pages = [];
  const seen = new Set();
  for (const entry of located.sort((a, b) => Number(a.manifest.selectedShard ?? -1) - Number(b.manifest.selectedShard ?? -1) || a.filename.localeCompare(b.filename))) {
    const shard = Number(entry.manifest.selectedShard ?? inferShard(entry.filename));
    for (const page of entry.manifest.pages || []) {
      const key = pageKey(page.contentHash, page.pageNumber);
      if (seen.has(key)) throw new Error(`Duplicate ${format} page across promoted shards: ${key}`);
      seen.add(key);
      const copied = { ...page };
      for (const field of ["geometryFile", "verticalFile", "materialFile", "templateFile"]) {
        if (!page[field]) continue;
        const source = path.resolve(entry.root, page[field]);
        const relative = `pages/s${shard}-${path.basename(page[field])}`;
        await copyFile(source, path.join(outRoot, relative));
        copied[field] = relative;
      }
      pages.push(copied);
    }
  }
  pages.sort(pageSort);
  const revisionSummary = plan.revision?.summary || {};
  const manifest = {
    schemaVersion: 3,
    format,
    stage,
    coordinateSpace: "local-world-metres-plus-nonspatial-templates",
    temporalResolutionRequired: Number(revisionSummary.unresolvedPages || 0) > 0,
    temporalResolutionStatus: Number(revisionSummary.unresolvedPages || 0) > 0 ? "partial" : "resolved",
    inputShardBundles: located.length,
    pageCount: pages.length,
    geometryCandidateCount: sum(pages, "geometryCount"),
    verticalObservationCount: sum(pages, "verticalCount"),
    materialObservationCount: sum(pages, "materialCount"),
    rideStructureTemplateCount: sum(pages, "rideStructureTemplateCount"),
    pages
  };
  return { root: outRoot, pages, manifest };
}

function aggregateImplementedScheme(resolvedPages, shardSummaries, applicationProofsValue) {
  const appSummary = applicationProofsValue.summary || {};
  const rejected = {};
  for (const shard of shardSummaries) mergeCounts(rejected, shard.corroboration?.rejected);
  return {
    schemaVersion: 1,
    evaluatedPages: Number(appSummary.evaluatedPages || resolvedPages.length),
    certifiedSpatialPages: Number(appSummary.certifiedSpatialPages || 0),
    certifiedContextPages: Number(appSummary.certifiedContextPages || 0),
    rejectedPages: Number(appSummary.rejectedPages || 0),
    registrationAnchorCount: Number(appSummary.registrationAnchorCount || 0),
    candidateProofChecks: Number(appSummary.candidateProofChecks || 0),
    applicationProofsAccepted: Number(appSummary.applicationProofsAccepted || 0),
    applicationProofsRejected: Number(appSummary.applicationProofsRejected || 0),
    promotedGeometryCandidates: shardSummaries.reduce((sumValue, shard) => sumValue + Number(shard.promotedGeometryCandidates || 0), 0),
    promotedAttributeObservations: shardSummaries.reduce((sumValue, shard) => sumValue + Number(shard.promotedAttributeObservations || 0), 0),
    rejected,
    pages: resolvedPages.map((page) => page.implementedSchemeEvaluation).filter(Boolean).sort(pageSort),
    applications: Object.entries(applicationProofsValue.proofs || {}).map(([applicationKey, proof]) => ({
      applicationKey,
      accepted: Boolean(proof?.accepted),
      confidence: Number(proof?.confidence || 0),
      summary: proof?.summary || null
    })).sort((a, b) => a.applicationKey.localeCompare(b.applicationKey))
  };
}
function aggregateCorroboration(shards) {
  const rejected = {};
  let attemptedGeometryCandidates = 0;
  let promotedGeometryCandidates = 0;
  const matches = [];
  for (const shard of shards) {
    attemptedGeometryCandidates += Number(shard.corroboration?.attemptedGeometryCandidates || shard.candidateProofChecks || 0);
    promotedGeometryCandidates += Number(shard.corroboration?.promotedGeometryCandidates || shard.promotedGeometryCandidates || 0);
    mergeCounts(rejected, shard.corroboration?.rejected);
    if (matches.length < 1000) matches.push(...(shard.matches || []).slice(0, 1000 - matches.length));
  }
  return { attemptedGeometryCandidates, promotedGeometryCandidates, rejected, matches };
}
function compactImplementedScheme(value) {
  return {
    schemaVersion: value.schemaVersion,
    evaluatedPages: value.evaluatedPages,
    certifiedSpatialPages: value.certifiedSpatialPages,
    certifiedContextPages: value.certifiedContextPages,
    applicationProofsAccepted: value.applicationProofsAccepted,
    applicationProofsRejected: value.applicationProofsRejected,
    promotedGeometryCandidates: value.promotedGeometryCandidates,
    promotedAttributeObservations: value.promotedAttributeObservations,
    registrationAnchorCount: value.registrationAnchorCount,
    candidateProofChecks: value.candidateProofChecks
  };
}
function compactCorroboration(value) {
  return {
    attemptedGeometryCandidates: value.attemptedGeometryCandidates,
    promotedGeometryCandidates: value.promotedGeometryCandidates,
    rejected: value.rejected
  };
}
function georegistrationAudit(manifest) {
  const pages = manifest.pages || [];
  const registrations = pages.map((page) => ({
    contentHash: page.contentHash,
    pageNumber: page.pageNumber,
    classification: page.classification || null,
    status: page.georegistrationStatus || "registered",
    solution: page.registration || null,
    automaticMatches: page.automaticMatches || [],
    explicitControlPoints: Number(page.explicitControlPoints || 0),
    automaticControlPoints: Number(page.automaticControlPoints || 0),
    rideStructureTemplateCount: Number(page.rideStructureTemplateCount || 0)
  }));
  return {
    schemaVersion: 4,
    status: manifest.georegistrationStatus || "unknown",
    mode: "parallel-sharded-manifest-merge",
    groupCount: Number(manifest.pageCount || pages.length),
    registeredGroupCount: Number(manifest.registeredPageCount || 0),
    templateOnlyGroupCount: Number(manifest.templateOnlyPageCount || 0),
    unregisteredGroupCount: Number(manifest.unregisteredPageCount || 0),
    registrations,
    unregisteredPages: manifest.unregisteredPages || [],
    registeredEvidence: {
      format: manifest.format,
      coordinateSpace: manifest.coordinateSpace,
      worldGeometryReady: Boolean(manifest.worldGeometryReady),
      worldGeometryAuthority: false,
      temporalResolutionRequired: true,
      registeredPageCount: Number(manifest.registeredPageCount || 0),
      templateOnlyPageCount: Number(manifest.templateOnlyPageCount || 0),
      geometryCandidateCount: Number(manifest.geometryCandidateCount || 0),
      verticalObservationCount: Number(manifest.verticalObservationCount || 0),
      materialObservationCount: Number(manifest.materialObservationCount || 0),
      rideStructureTemplateCount: Number(manifest.rideStructureTemplateCount || 0)
    },
    parallelGeoregistration: {
      shardBundles: Number(manifest.inputShardBundles || plan.sourceShardCount || 0)
    }
  };
}
function emptyRegisteredManifest() {
  return { schemaVersion: 1, format: "voxel-planning-registered-bundle-v1", stage: "registered-shard-manifest-merge", coordinateSpace: "local-world-metres-plus-nonspatial-templates", georegistrationStatus: "unregistered", worldGeometryReady: false, worldGeometryAuthority: false, temporalResolutionRequired: true, pageCount: 0, evidencePageCount: 0, registeredPageCount: 0, templateOnlyPageCount: 0, unregisteredPageCount: 0, geometryCandidateCount: 0, verticalObservationCount: 0, materialObservationCount: 0, rideStructureTemplateCount: 0, pages: [], unregisteredPages: [] };
}
function hasWorldAuthorityEvidence(page) { return Number(page.geometryCount || 0) + Number(page.verticalCount || 0) + Number(page.materialCount || 0) > 0; }
function siblingBundleRoot(manifestPath, fallbackName) {
  const basename = path.basename(manifestPath, path.extname(manifestPath));
  return path.join(path.dirname(manifestPath), basename ? `${basename}-bundle` : fallbackName);
}
function inferShard(filename) { const match = String(filename || "").match(/(?:shard[-_])(\d+)/i); return match ? Number(match[1]) : -1; }
function pageKey(contentHash, pageNumber) { return `${contentHash || "unknown-document"}:p${Number(pageNumber || 1)}`; }
function pageSort(a, b) { return String(a?.contentHash || "").localeCompare(String(b?.contentHash || "")) || Number(a?.pageNumber || 0) - Number(b?.pageNumber || 0); }
function sum(values, key) { return (values || []).reduce((total, value) => total + Number(value?.[key] || 0), 0); }
function mergeCounts(target, source) { for (const [key, value] of Object.entries(source || {})) target[key] = (target[key] || 0) + Number(value || 0); }
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
