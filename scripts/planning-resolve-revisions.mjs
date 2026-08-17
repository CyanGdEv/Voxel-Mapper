#!/usr/bin/env node
import path from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolvePlanningRevisionAuthority } from "../src/lib/planning-revision-resolver.mjs";
import {
  buildImplementedApplicationProof,
  evaluateImplementedPlanningPage,
  promoteCertifiedPageEvidence,
  promoteImplementedApplicationSupportEvidence
} from "../src/lib/planning-implemented-scheme-authority.mjs";
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
  const referenceFeatures = reference?.features || [];
  const resolvedManifestPath = path.resolve(args.resolvedOut || "planning-current-state-evidence.json");
  const authorityManifestPath = path.resolve(args.authorityOut || "planning-current-authority-evidence.json");
  const resolvedRoot = siblingBundleRoot(resolvedManifestPath, "planning-current-state-bundle");
  const authorityRoot = siblingBundleRoot(authorityManifestPath, "planning-current-authority-bundle");
  await Promise.all([mkdir(resolvedRoot, { recursive: true }), mkdir(authorityRoot, { recursive: true })]);

  // Pass 1: prove implementation at page/scheme level. Individual raw vector
  // fragments are allowed to contribute anchors, but they cannot directly make
  // themselves authoritative. A coherent spatial page is promoted only after
  // multiple independent, post-decision current features prove the scheme was
  // actually implemented.
  const pageContexts = [];
  const implementedScheme = {
    schemaVersion: 1,
    evaluatedPages: 0,
    certifiedSpatialPages: 0,
    certifiedContextPages: 0,
    rejectedPages: 0,
    registrationAnchorCount: 0,
    candidateProofChecks: 0,
    applicationProofsAccepted: 0,
    applicationProofsRejected: 0,
    promotedGeometryCandidates: 0,
    promotedAttributeObservations: 0,
    rejected: {},
    pages: [],
    applications: []
  };

  for (const pageEntry of bundle.manifest.pages || []) {
    const key = pageKey(pageEntry.contentHash, pageEntry.pageNumber);
    const baseDecision = decisionByPage.get(key) || unknownDecision();
    const evidence = await readBundlePage(bundle.root, pageEntry);
    const document = documentIndex.get(pageEntry.contentHash) || null;
    const applicationKeys = document?.applicationKeys || pageEntry.applicationKeys || [];
    const applicationTemporal = applicationKeys
      .map((applicationKey) => catalog.applications?.[applicationKey]?.temporal)
      .filter(Boolean);
    const drawingIssueDate = evidence.drawingMetadata.find((entry) => entry.issueDate)?.issueDate || null;
    const registration = pageRegistration(pageEntry);
    const evaluation = evaluateImplementedPlanningPage({
      page: { ...pageEntry, planningTemporal: baseDecision },
      evidence,
      referenceFeatures,
      applicationTemporal,
      drawingIssueDate,
      registration,
      options: implementedSchemeOptions()
    });

    pageContexts.push({ key, pageEntry, baseDecision, applicationKeys, applicationTemporal, drawingIssueDate, evaluation });
    implementedScheme.evaluatedPages += 1;
    implementedScheme.registrationAnchorCount += Number(evaluation.registrationAnchorCount || 0);
    implementedScheme.candidateProofChecks += Number(evaluation.candidateProofChecks || 0);
    if (evaluation.certifiedSpatialAuthority) implementedScheme.certifiedSpatialPages += 1;
    else if (evaluation.certifiedContext) implementedScheme.certifiedContextPages += 1;
    else implementedScheme.rejectedPages += 1;
    mergeCounts(implementedScheme.rejected, evaluation.rejected);
    implementedScheme.pages.push(compactImplementedPage(pageEntry, evaluation));
  }

  // Application-level implementation proof lets supporting elevation/material
  // pages contribute attributes only after at least one spatial scheme page for
  // the same application has independently proved implementation.
  const contextsByApplication = new Map();
  for (const context of pageContexts) {
    for (const applicationKey of context.applicationKeys || []) {
      if (!contextsByApplication.has(applicationKey)) contextsByApplication.set(applicationKey, []);
      contextsByApplication.get(applicationKey).push({ page: context.pageEntry, evaluation: context.evaluation });
    }
  }
  const applicationProofs = new Map();
  for (const [applicationKey, contexts] of contextsByApplication) {
    const temporal = catalog.applications?.[applicationKey]?.temporal;
    const proof = buildImplementedApplicationProof(applicationKey, contexts, temporal ? [temporal] : []);
    applicationProofs.set(applicationKey, proof);
    if (proof.accepted) implementedScheme.applicationProofsAccepted += 1;
    else implementedScheme.applicationProofsRejected += 1;
    implementedScheme.applications.push({
      applicationKey,
      accepted: proof.accepted,
      confidence: proof.confidence || 0,
      summary: proof.summary || null
    });
  }

  const resolvedPages = [];
  const authorityPages = [];
  const corroboration = {
    attemptedGeometryCandidates: implementedScheme.candidateProofChecks,
    promotedGeometryCandidates: 0,
    rejected: implementedScheme.rejected,
    matches: []
  };

  // Pass 2: annotate the full evidence stream. Only a certified scheme page can
  // promote its spatial geometry wholesale; this is what allows planning to
  // correct incomplete/different OSM after implementation has been proved,
  // without requiring every proposed line to resemble OSM individually.
  for (const context of pageContexts) {
    const { pageEntry, baseDecision, applicationKeys, evaluation } = context;
    const evidence = await readBundlePage(bundle.root, pageEntry);
    const direct = annotateEvidence(evidence, baseDecision);
    let resolvedEvidence = direct;

    if (!isDirectCurrentAuthority(baseDecision)) {
      if (evaluation.accepted) {
        const promotion = promoteCertifiedPageEvidence(evidence, evaluation);
        resolvedEvidence = mergePromotion(direct, promotion);
      } else {
        const proof = strongestApplicationProof(applicationKeys, applicationProofs);
        if (proof?.accepted) {
          const support = promoteImplementedApplicationSupportEvidence(
            evidence,
            { ...pageEntry, planningTemporal: baseDecision },
            proof
          );
          resolvedEvidence = mergePromotion(direct, support);
        }
      }
    }

    const promotedGeometry = resolvedEvidence.geometryCandidates.filter(isSchemeAuthorityEntry).length;
    const promotedAttributes = resolvedEvidence.verticalObservations.filter(isSchemeAuthorityEntry).length +
      resolvedEvidence.materialObservations.filter(isSchemeAuthorityEntry).length;
    implementedScheme.promotedGeometryCandidates += promotedGeometry;
    implementedScheme.promotedAttributeObservations += promotedAttributes;
    corroboration.promotedGeometryCandidates += promotedGeometry;
    if (corroboration.matches.length < 1000) {
      corroboration.matches.push(...(evaluation.anchors || []).slice(0, 1000 - corroboration.matches.length).map((anchor) => ({
        contentHash: pageEntry.contentHash,
        pageNumber: pageEntry.pageNumber,
        source: anchor.source,
        candidateId: anchor.candidateId || null,
        featureId: anchor.featureId || null,
        featureKind: anchor.featureKind || null,
        matchScore: anchor.score ?? null,
        planningDecisionAt: anchor.decisionAt || null,
        observedAt: anchor.observedAt || null
      })));
    }

    const resolvedPage = await writeEvidencePageStreamsFast(resolvedRoot, {
      ...pageEntry,
      geometryFile: null,
      verticalFile: null,
      materialFile: null,
      templateFile: null,
      planningTemporal: baseDecision,
      implementedSchemeEvaluation: compactImplementedPage(pageEntry, evaluation)
    }, resolvedEvidence);
    resolvedPage.planningTemporal = baseDecision;
    resolvedPage.implementedSchemeEvaluation = compactImplementedPage(pageEntry, evaluation);
    resolvedPages.push(resolvedPage);

    const authorityEvidence = {
      geometryCandidates: resolvedEvidence.geometryCandidates.filter(isAuthorityEntry),
      verticalObservations: resolvedEvidence.verticalObservations.filter(isAuthorityEntry),
      materialObservations: resolvedEvidence.materialObservations.filter(isAuthorityEntry),
      rideStructureTemplates: resolvedEvidence.rideStructureTemplates.filter((entry) => entry.templateAuthorityEligible === true),
      drawingMetadata: resolvedEvidence.drawingMetadata.filter(isAuthorityEntry)
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
        planningTemporal: authorityEvidence.geometryCandidates[0]?.planningTemporal || authorityEvidence.verticalObservations[0]?.planningTemporal || baseDecision,
        implementedSchemeEvaluation: compactImplementedPage(pageEntry, evaluation)
      }, authorityEvidence);
      authorityPage.implementedSchemeEvaluation = compactImplementedPage(pageEntry, evaluation);
      authorityPages.push(authorityPage);
    }
  }

  implementedScheme.pages.sort(pageSort);
  implementedScheme.applications.sort((a, b) => String(a.applicationKey).localeCompare(String(b.applicationKey)));
  const resolvedBundleManifest = makeResolvedManifest(RESOLVED_BUNDLE_FORMAT, "resolved-current-state", resolvedPages, result, corroboration, implementedScheme);
  const authorityBundleManifest = makeResolvedManifest(AUTHORITY_BUNDLE_FORMAT, "strict-current-authority", authorityPages, result, corroboration, implementedScheme);
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
    corroboration,
    implementedScheme
  });

  console.log(JSON.stringify({
    status: result.status,
    pages: result.summary.pageCount,
    lineages: result.summary.lineageCount,
    authoritativeCurrentPages: result.summary.authoritativeCurrentPages,
    unresolvedPages: result.summary.unresolvedPages,
    conflicts: result.summary.conflicts,
    certifiedSpatialPages: implementedScheme.certifiedSpatialPages,
    certifiedContextPages: implementedScheme.certifiedContextPages,
    implementedApplications: implementedScheme.applicationProofsAccepted,
    authoritativeGeometryCandidates: countPages(authorityPages, "geometryCount"),
    authoritativeRideStructureTemplates: countPages(authorityPages, "rideStructureTemplateCount"),
    schemePromotedGeometryCandidates: implementedScheme.promotedGeometryCandidates,
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

function makeResolvedManifest(format, stage, pages, result, corroboration, implementedScheme = null) {
  return {
    schemaVersion: 3,
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
    },
    implementedScheme: implementedScheme ? {
      schemaVersion: implementedScheme.schemaVersion,
      evaluatedPages: implementedScheme.evaluatedPages,
      certifiedSpatialPages: implementedScheme.certifiedSpatialPages,
      certifiedContextPages: implementedScheme.certifiedContextPages,
      applicationProofsAccepted: implementedScheme.applicationProofsAccepted,
      applicationProofsRejected: implementedScheme.applicationProofsRejected,
      promotedGeometryCandidates: implementedScheme.promotedGeometryCandidates,
      promotedAttributeObservations: implementedScheme.promotedAttributeObservations,
      registrationAnchorCount: implementedScheme.registrationAnchorCount,
      candidateProofChecks: implementedScheme.candidateProofChecks
    } : null
  };
}

function annotateEvidence(evidence, decision) {
  return {
    geometryCandidates: (evidence.geometryCandidates || []).map((entry) => annotate(entry, decision)),
    verticalObservations: (evidence.verticalObservations || []).map((entry) => annotate(entry, decision)),
    materialObservations: (evidence.materialObservations || []).map((entry) => annotate(entry, decision)),
    drawingMetadata: (evidence.drawingMetadata || []).map((entry) => annotate(entry, decision)),
    rideStructureTemplates: (evidence.rideStructureTemplates || []).map((entry) => annotateTemplate(entry, decision))
  };
}
function mergePromotion(base, promotion) {
  return {
    geometryCandidates: promotion.geometryCandidates?.length ? promotion.geometryCandidates : base.geometryCandidates,
    verticalObservations: promotion.verticalObservations?.length ? promotion.verticalObservations : base.verticalObservations,
    materialObservations: promotion.materialObservations?.length ? promotion.materialObservations : base.materialObservations,
    drawingMetadata: promotion.drawingMetadata?.length ? promotion.drawingMetadata : base.drawingMetadata,
    rideStructureTemplates: promotion.rideStructureTemplates?.length ? promotion.rideStructureTemplates : base.rideStructureTemplates
  };
}
function annotate(entry, decision) {
  return {
    ...entry,
    planningTemporal: decision,
    temporalResolutionRequired: decision.state === "unknown",
    worldGeometryAuthority: Boolean(decision.worldGeometryAuthority),
    terrainGeometryAuthority: false,
    terrainElevationAuthority: false
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
    terrainGeometryMutable: false,
    terrainGeometryAuthority: false,
    terrainElevationAuthority: false
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
    ambiguityGap: number(args.corroborationAmbiguityGap, 0.08)
  };
}
function compactImplementedPage(page, evaluation) {
  return {
    contentHash: page?.contentHash || null,
    pageNumber: Number(page?.pageNumber || 1),
    classification: evaluation?.classification || page?.classification || null,
    status: evaluation?.status || "not-evaluated",
    accepted: Boolean(evaluation?.accepted),
    certifiedSpatialAuthority: Boolean(evaluation?.certifiedSpatialAuthority),
    certifiedContext: Boolean(evaluation?.certifiedContext),
    anchorCount: Number(evaluation?.anchorCount || 0),
    uniqueFeatureCount: Number(evaluation?.uniqueFeatureCount || 0),
    uniqueFeatureKinds: evaluation?.uniqueFeatureKinds || [],
    medianMatchScore: evaluation?.medianMatchScore ?? null,
    registrationAnchorCount: Number(evaluation?.registrationAnchorCount || 0),
    registrationUniqueFeatureCount: Number(evaluation?.registrationUniqueFeatureCount || 0),
    registrationMedianScore: evaluation?.registrationMedianScore ?? null,
    registrationRmseM: evaluation?.registrationRmseM ?? null,
    candidateProofChecks: Number(evaluation?.candidateProofChecks || 0),
    proofBoundReached: Boolean(evaluation?.proofBoundReached),
    rejected: evaluation?.rejected || {}
  };
}
function strongestApplicationProof(applicationKeys, proofs) {
  return (applicationKeys || [])
    .map((key) => proofs.get(key))
    .filter((proof) => proof?.accepted)
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0) || String(a.applicationKey).localeCompare(String(b.applicationKey)))[0] || null;
}
function isDirectCurrentAuthority(decision) {
  return decision?.state === "current" && decision?.worldGeometryAuthority === true;
}
function isSchemeAuthorityEntry(entry) { return entry?.implementationSchemeAuthority === true && isAuthorityEntry(entry); }
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
function mergeCounts(target, source) {
  for (const [key, value] of Object.entries(source || {})) target[key] = (target[key] || 0) + Number(value || 0);
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
