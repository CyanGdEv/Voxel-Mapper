#!/usr/bin/env node
import path from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolvePlanningRevisionAuthority } from "../src/lib/planning-revision-resolver.mjs";
import { corroboratePlanningGeometryCandidate } from "../src/lib/planning-current-corroboration.mjs";
import {
  AUTHORITY_BUNDLE_FORMAT,
  REGISTERED_BUNDLE_FORMAT,
  RESOLVED_BUNDLE_FORMAT,
  loadBundleManifest,
  readBundlePage,
  writeBundleManifest
} from "../src/lib/planning-evidence-bundle.mjs";
import { writeEvidencePageStreamsFast } from "../src/lib/planning-evidence-fast-write.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.registered || !args.catalog || !args.out) {
  console.error("Usage: planning-resolve-revisions.mjs --registered planning-registered-evidence --catalog planning-document-catalog.json --out FILE [--queue planning-document-queue.json] [--reference planning-georeg-reference.json] [--resolved-out FILE] [--authority-out FILE] [--reference-date ISO] [--strict]");
  process.exit(2);
}

const catalog = await readJson(args.catalog);
if (args.queue) {
  const queue = await readJson(args.queue);
  catalog.applications = mergeApplicationSnapshots(catalog.applications || {}, queue.planningApplicationSnapshot || {});
  catalog.planningApplicationSnapshotAt = queue.planningApplicationSnapshotAt || null;
  catalog.planningApplicationSnapshotProvider = queue.planningApplicationSnapshotProvider || null;
}
const reference = args.reference ? await readJson(args.reference) : null;
const bundleInput = await tryLoadRegisteredBundle(args.registered);

if (!bundleInput) await resolveLegacyJson();
else await resolveBundle(bundleInput);

async function resolveBundle(bundle) {
  const compactRegistered = compactRegisteredEvidence(bundle.manifest);
  const result = resolvePlanningRevisionAuthority(compactRegistered, catalog, {
    referenceDate: args.referenceDate,
    currentAuthorityConfidenceGate: number(args.currentAuthorityConfidenceGate, 0.85)
  });
  const decisionByPage = new Map(result.pages.map((page) => [pageKey(page.contentHash, page.pageNumber), page.decision]));
  const documentIndex = new Map((catalog.documents || []).map((document) => [document.contentHash, document]));
  const resolvedManifestPath = path.resolve(args.resolvedOut || "planning-current-state-evidence.json");
  const authorityManifestPath = path.resolve(args.authorityOut || "planning-current-authority-evidence.json");
  const resolvedRoot = siblingBundleRoot(resolvedManifestPath, "planning-current-state-bundle");
  const authorityRoot = siblingBundleRoot(authorityManifestPath, "planning-current-authority-bundle");
  await Promise.all([mkdir(resolvedRoot, { recursive: true }), mkdir(authorityRoot, { recursive: true })]);

  const resolvedPages = [];
  const authorityPages = [];
  const corroboration = {
    attemptedGeometryCandidates: 0,
    promotedGeometryCandidates: 0,
    rejected: {},
    matches: []
  };

  for (const pageEntry of bundle.manifest.pages || []) {
    const key = pageKey(pageEntry.contentHash, pageEntry.pageNumber);
    const baseDecision = decisionByPage.get(key) || unknownDecision();
    const evidence = await readBundlePage(bundle.root, pageEntry);
    const document = documentIndex.get(pageEntry.contentHash) || null;
    const applicationTemporal = (document?.applicationKeys || pageEntry.applicationKeys || [])
      .map((applicationKey) => catalog.applications?.[applicationKey]?.temporal)
      .filter(Boolean);
    const drawingIssueDate = evidence.drawingMetadata.find((entry) => entry.issueDate)?.issueDate || null;

    const geometryCandidates = [];
    for (const candidate of evidence.geometryCandidates || []) {
      let temporal = baseDecision;
      let authority = Boolean(baseDecision.worldGeometryAuthority);
      let implementationCorroboration = null;
      if (!authority && baseDecision.state === "proposed" && reference?.features?.length) {
        corroboration.attemptedGeometryCandidates += 1;
        const proof = corroboratePlanningGeometryCandidate(candidate, reference.features, {
          applicationTemporal,
          drawingIssueDate,
          minMatchScore: number(args.corroborationMinMatchScore, 0.78),
          ambiguityGap: number(args.corroborationAmbiguityGap, 0.12)
        });
        if (proof.accepted) {
          temporal = {
            ...baseDecision,
            ...proof.temporal,
            lineageMemberships: baseDecision.lineageMemberships || []
          };
          authority = true;
          implementationCorroboration = proof.temporal.implementationCorroboration;
          corroboration.promotedGeometryCandidates += 1;
          if (corroboration.matches.length < 1000) corroboration.matches.push({
            contentHash: pageEntry.contentHash,
            pageNumber: pageEntry.pageNumber,
            candidateId: candidate.id || null,
            semantic: candidate.semantic || null,
            classification: candidate.classification || pageEntry.classification || null,
            featureId: proof.match.feature?.id || null,
            featureKind: proof.match.feature?.kind || null,
            matchScore: proof.match.score ?? null,
            secondScore: proof.match.secondScore ?? null,
            planningDecisionAt: proof.decisionAt,
            observedAt: proof.observedAt
          });
        } else {
          corroboration.rejected[proof.reason] = (corroboration.rejected[proof.reason] || 0) + 1;
        }
      }
      geometryCandidates.push({
        ...candidate,
        planningTemporal: temporal,
        temporalResolutionRequired: temporal.state === "unknown",
        worldGeometryAuthority: authority,
        ...(implementationCorroboration ? { implementationCorroboration } : {})
      });
    }
    const verticalObservations = (evidence.verticalObservations || []).map((entry) => annotate(entry, baseDecision));
    const materialObservations = (evidence.materialObservations || []).map((entry) => annotate(entry, baseDecision));
    const drawingMetadata = (evidence.drawingMetadata || []).map((entry) => annotate(entry, baseDecision));
    const rideStructureTemplates = (evidence.rideStructureTemplates || []).map((entry) => annotateTemplate(entry, baseDecision));
    const resolvedEvidence = { geometryCandidates, verticalObservations, materialObservations, rideStructureTemplates, drawingMetadata };
    const resolvedPage = await writeEvidencePageStreamsFast(resolvedRoot, {
      ...pageEntry,
      geometryFile: null,
      verticalFile: null,
      materialFile: null,
      templateFile: null,
      planningTemporal: baseDecision
    }, resolvedEvidence);
    resolvedPage.planningTemporal = baseDecision;
    resolvedPages.push(resolvedPage);

    const authorityEvidence = {
      geometryCandidates: geometryCandidates.filter(isAuthorityEntry),
      verticalObservations: verticalObservations.filter(isAuthorityEntry),
      materialObservations: materialObservations.filter(isAuthorityEntry),
      rideStructureTemplates: rideStructureTemplates.filter((entry) => entry.templateAuthorityEligible === true),
      drawingMetadata: drawingMetadata.filter(isAuthorityEntry)
    };
    const authorityCount = authorityEvidence.geometryCandidates.length + authorityEvidence.verticalObservations.length +
      authorityEvidence.materialObservations.length + authorityEvidence.rideStructureTemplates.length;
    if (authorityCount > 0) {
      const authorityPage = await writeEvidencePageStreamsFast(authorityRoot, {
        ...pageEntry,
        geometryFile: null,
        verticalFile: null,
        materialFile: null,
        templateFile: null,
        planningTemporal: authorityEvidence.geometryCandidates[0]?.planningTemporal || authorityEvidence.rideStructureTemplates[0]?.planningTemporal || baseDecision
      }, authorityEvidence);
      authorityPages.push(authorityPage);
    }
  }

  const resolvedBundleManifest = makeResolvedManifest(RESOLVED_BUNDLE_FORMAT, "resolved-current-state", resolvedPages, result, corroboration);
  const authorityBundleManifest = makeResolvedManifest(AUTHORITY_BUNDLE_FORMAT, "strict-current-authority", authorityPages, result, corroboration);
  authorityBundleManifest.authorityScope = "planning-current-state-only";
  authorityBundleManifest.worldGeometryAuthority = authorityPages.some(hasWorldAuthorityEvidence);
  authorityBundleManifest.worldGeometryReady = authorityPages.some((page) => Number(page.geometryCount || 0) > 0);
  authorityBundleManifest.templateAuthorityRule = "current template is non-spatial and usable only through exact authoritative plan-anchor linkage";
  await writeBundleManifest(resolvedRoot, resolvedBundleManifest);
  await writeBundleManifest(authorityRoot, authorityBundleManifest);
  await writeJson(resolvedManifestPath, {
    ...resolvedBundleManifest,
    bundlePath: path.relative(path.dirname(resolvedManifestPath), resolvedRoot) || "."
  });
  await writeJson(authorityManifestPath, {
    ...authorityBundleManifest,
    bundlePath: path.relative(path.dirname(authorityManifestPath), authorityRoot) || "."
  });
  await writeJson(args.out, {
    ...withoutResolvedEvidence(result),
    applicationSnapshotAt: catalog.planningApplicationSnapshotAt || null,
    applicationSnapshotProvider: catalog.planningApplicationSnapshotProvider || null,
    evidenceStorage: "chunked-page-ndjson",
    currentStateBundle: path.relative(path.dirname(path.resolve(args.out)), resolvedRoot),
    authorityBundle: path.relative(path.dirname(path.resolve(args.out)), authorityRoot),
    corroboration
  });

  console.log(JSON.stringify({
    status: result.status,
    pages: result.summary.pageCount,
    lineages: result.summary.lineageCount,
    authoritativeCurrentPages: result.summary.authoritativeCurrentPages,
    unresolvedPages: result.summary.unresolvedPages,
    conflicts: result.summary.conflicts,
    authoritativeGeometryCandidates: countPages(authorityPages, "geometryCount"),
    authoritativeRideStructureTemplates: countPages(authorityPages, "rideStructureTemplateCount"),
    corroboratedGeometryCandidates: corroboration.promotedGeometryCandidates,
    resolvedEvidencePages: resolvedPages.length,
    authorityEvidencePages: authorityPages.length,
    out: path.resolve(args.out),
    resolvedOut: resolvedManifestPath,
    authorityOut: authorityManifestPath
  }, null, 2));
  if (args.strict && result.summary.unresolvedPages > 0) process.exitCode = 1;
}

async function resolveLegacyJson() {
  const registered = await readJson(args.registered);
  const result = resolvePlanningRevisionAuthority(registered, catalog, {
    referenceDate: args.referenceDate,
    currentAuthorityConfidenceGate: number(args.currentAuthorityConfidenceGate, 0.85)
  });
  await writeJson(args.out, {
    ...result,
    applicationSnapshotAt: catalog.planningApplicationSnapshotAt || null,
    applicationSnapshotProvider: catalog.planningApplicationSnapshotProvider || null
  });
  if (args.resolvedOut) await writeJson(args.resolvedOut, result.resolvedEvidence);
  const authorityEvidence = filterAuthorityEvidence(result.resolvedEvidence);
  if (args.authorityOut) await writeJson(args.authorityOut, authorityEvidence);
  console.log(JSON.stringify({
    status: result.status,
    pages: result.summary.pageCount,
    lineages: result.summary.lineageCount,
    authoritativeCurrentPages: result.summary.authoritativeCurrentPages,
    unresolvedPages: result.summary.unresolvedPages,
    conflicts: result.summary.conflicts,
    authoritativeGeometryCandidates: result.summary.authoritativeGeometryCandidates,
    authoritativeRideStructureTemplates: authorityEvidence.rideStructureTemplates?.length || 0,
    out: path.resolve(args.out),
    resolvedOut: args.resolvedOut ? path.resolve(args.resolvedOut) : null,
    authorityOut: args.authorityOut ? path.resolve(args.authorityOut) : null
  }, null, 2));
  if (args.strict && result.summary.unresolvedPages > 0) process.exitCode = 1;
}

function compactRegisteredEvidence(manifest) {
  const drawingMetadata = [];
  const pageRefs = [];
  for (const page of manifest.pages || []) {
    drawingMetadata.push(...(page.drawingMetadata || []).map((entry) => ({
      ...entry,
      contentHash: entry.contentHash || page.contentHash,
      pageNumber: Number(entry.pageNumber || page.pageNumber || 1)
    })));
    if ((page.geometryCount || 0) + (page.verticalCount || 0) + (page.materialCount || 0) + (page.rideStructureTemplateCount || 0) > 0) {
      pageRefs.push({ contentHash: page.contentHash, pageNumber: page.pageNumber });
    }
  }
  return {
    schemaVersion: 3,
    coordinateSpace: "local-world-metres-plus-nonspatial-templates",
    worldGeometryReady: (manifest.geometryCandidateCount || 0) > 0,
    worldGeometryAuthority: false,
    temporalResolutionRequired: true,
    drawingMetadata,
    geometryCandidates: pageRefs,
    verticalObservations: [],
    materialObservations: [],
    rideStructureTemplates: []
  };
}

function makeResolvedManifest(format, stage, pages, result, corroboration) {
  return {
    schemaVersion: 2,
    format,
    stage,
    coordinateSpace: "local-world-metres-plus-nonspatial-templates",
    temporalResolutionRequired: result.summary.unresolvedPages > 0,
    temporalResolutionStatus: result.summary.unresolvedPages > 0 ? "partial" : "resolved",
    pageCount: pages.length,
    geometryCandidateCount: countPages(pages, "geometryCount"),
    verticalObservationCount: countPages(pages, "verticalCount"),
    materialObservationCount: countPages(pages, "materialCount"),
    rideStructureTemplateCount: countPages(pages, "rideStructureTemplateCount"),
    pages: pages.sort(pageSort),
    corroboration: {
      attemptedGeometryCandidates: corroboration.attemptedGeometryCandidates,
      promotedGeometryCandidates: corroboration.promotedGeometryCandidates,
      rejected: corroboration.rejected
    }
  };
}

function annotate(entry, decision) {
  return {
    ...entry,
    planningTemporal: decision,
    temporalResolutionRequired: decision.state === "unknown",
    worldGeometryAuthority: Boolean(decision.worldGeometryAuthority)
  };
}
function annotateTemplate(entry, decision) {
  return {
    ...entry,
    planningTemporal: decision,
    temporalResolutionRequired: decision.state === "unknown",
    templateAuthorityEligible: decision.state === "current" && Boolean(decision.worldGeometryAuthority),
    spatialAuthorityEligible: false,
    worldGeometryReady: false,
    worldGeometryAuthority: false,
    linkageRequired: true,
    terrainGeometryMutable: false
  };
}
function isAuthorityEntry(entry) { return entry?.worldGeometryAuthority === true && entry?.planningTemporal?.state === "current"; }
function hasWorldAuthorityEvidence(page) {
  return Number(page.geometryCount || 0) + Number(page.verticalCount || 0) + Number(page.materialCount || 0) > 0;
}
function filterAuthorityEvidence(evidence) {
  const geometryCandidates = (evidence?.geometryCandidates || []).filter(isAuthorityEntry);
  const verticalObservations = (evidence?.verticalObservations || []).filter(isAuthorityEntry);
  const materialObservations = (evidence?.materialObservations || []).filter(isAuthorityEntry);
  const rideStructureTemplates = (evidence?.rideStructureTemplates || []).filter((entry) => entry.templateAuthorityEligible === true);
  const drawingMetadata = (evidence?.drawingMetadata || []).filter(isAuthorityEntry);
  const hasAuthority = geometryCandidates.length > 0 || verticalObservations.length > 0 || materialObservations.length > 0 || drawingMetadata.length > 0;
  return {
    schemaVersion: 2,
    coordinateSpace: "local-world-metres-plus-nonspatial-templates",
    authorityScope: "planning-current-state-only",
    worldGeometryReady: geometryCandidates.length > 0,
    worldGeometryAuthority: hasAuthority,
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
    }
  };
}
function mergeApplicationSnapshots(existing, snapshot) {
  const keys = new Set([...Object.keys(existing || {}), ...Object.keys(snapshot || {})]);
  return Object.fromEntries([...keys].sort().map((key) => [key, {
    ...(existing[key] || {}),
    ...(snapshot[key] || {}),
    temporal: snapshot[key]?.temporal || existing[key]?.temporal || null
  }]));
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
function withoutResolvedEvidence(result) { const { resolvedEvidence, ...rest } = result; return rest; }
function siblingBundleRoot(manifestPath, fallbackName) {
  const basename = path.basename(manifestPath, path.extname(manifestPath));
  return path.join(path.dirname(manifestPath), basename ? `${basename}-bundle` : fallbackName);
}
async function tryLoadRegisteredBundle(filename) {
  try {
    const details = await stat(path.resolve(filename));
    if (!details.isDirectory()) return null;
    return await loadBundleManifest(filename, REGISTERED_BUNDLE_FORMAT);
  } catch { return null; }
}
function pageKey(contentHash, pageNumber) { return `${contentHash || "unknown-document"}:p${Number(pageNumber || 1)}`; }
function countPages(pages, key) { return (pages || []).reduce((sum, page) => sum + Number(page?.[key] || 0), 0); }
function pageSort(a, b) { return String(a.contentHash || "").localeCompare(String(b.contentHash || "")) || Number(a.pageNumber || 0) - Number(b.pageNumber || 0); }
async function readJson(filename) { return JSON.parse(await readFile(path.resolve(filename), "utf8")); }
async function writeJson(filename, value) {
  const resolved = path.resolve(filename);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, JSON.stringify(value, null, 2) + "\n");
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
