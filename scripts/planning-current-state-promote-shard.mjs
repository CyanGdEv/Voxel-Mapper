#!/usr/bin/env node
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import {
  AUTHORITY_BUNDLE_FORMAT,
  REGISTERED_BUNDLE_FORMAT,
  RESOLVED_BUNDLE_FORMAT,
  loadBundleManifest,
  readBundlePage,
  writeBundleManifest
} from "../src/lib/planning-evidence-bundle.mjs";
import { writeEvidencePageStreamsFast } from "../src/lib/planning-evidence-fast-write.mjs";
import {
  promoteCertifiedPageEvidence,
  promoteImplementedApplicationSupportEvidence
} from "../src/lib/planning-implemented-scheme-authority.mjs";
import { writeJson } from "../src/lib/io.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.registered || !args.plan || !args.proof || !args.applications || !args.resolvedOut || !args.authorityOut || !args.summaryOut) {
  console.error("Usage: planning-current-state-promote-shard.mjs --registered DIR --plan FILE --proof FILE --applications FILE --resolved-out DIR --authority-out DIR --summary-out FILE [--shard N]");
  process.exit(2);
}

const bundle = await loadBundleManifest(path.resolve(args.registered), REGISTERED_BUNDLE_FORMAT);
const plan = await readJson(args.plan);
const proofShard = await readJson(args.proof);
const applicationProofs = await readJson(args.applications);
if (proofShard.format !== "voxel-planning-current-state-proof-shard-v1") throw new Error("Unsupported current-state proof shard format");
if (applicationProofs.format !== "voxel-planning-current-state-application-proofs-v1") throw new Error("Unsupported application proof format");

const proofByPage = new Map((proofShard.pages || []).map((record) => [record.key || pageKey(record.page?.contentHash, record.page?.pageNumber), record]));
const resolvedRoot = path.resolve(args.resolvedOut);
const authorityRoot = path.resolve(args.authorityOut);
await Promise.all([mkdir(resolvedRoot, { recursive: true }), mkdir(authorityRoot, { recursive: true })]);
const resolvedPages = [];
const authorityPages = [];
const matches = [];
const rejected = {};
let promotedGeometryCandidates = 0;
let promotedAttributeObservations = 0;
let evaluatedPages = 0;
let certifiedSpatialPages = 0;
let certifiedContextPages = 0;
let registrationAnchorCount = 0;
let candidateProofChecks = 0;

for (const pageEntry of bundle.manifest.pages || []) {
  const key = pageKey(pageEntry.contentHash, pageEntry.pageNumber);
  const proofRecord = proofByPage.get(key);
  if (!proofRecord) throw new Error(`Missing implementation proof for registered page ${key}`);
  const baseDecision = plan.pageDecisions?.[key] || proofRecord.baseDecision || unknownDecision();
  const evaluation = proofRecord.evaluation || {};
  const applicationKeys = proofRecord.applicationKeys || pageEntry.applicationKeys || [];
  const evidence = await readBundlePage(bundle.root, pageEntry);
  const direct = annotateEvidence(evidence, baseDecision);
  let resolvedEvidence = direct;

  if (!isDirectCurrentAuthority(baseDecision)) {
    if (evaluation.accepted) {
      const promotion = promoteCertifiedPageEvidence(evidence, evaluation);
      resolvedEvidence = mergePromotion(direct, promotion);
    } else {
      const proof = strongestApplicationProof(applicationKeys, applicationProofs.proofs || {});
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
  promotedGeometryCandidates += promotedGeometry;
  promotedAttributeObservations += promotedAttributes;
  evaluatedPages += 1;
  registrationAnchorCount += Number(evaluation.registrationAnchorCount || 0);
  candidateProofChecks += Number(evaluation.candidateProofChecks || 0);
  if (evaluation.certifiedSpatialAuthority) certifiedSpatialPages += 1;
  else if (evaluation.certifiedContext) certifiedContextPages += 1;
  mergeCounts(rejected, evaluation.rejected);
  if (matches.length < 64) {
    matches.push(...(evaluation.anchors || []).slice(0, 64 - matches.length).map((anchor) => ({
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

  const compactEvaluation = compactImplementedPage(pageEntry, evaluation);
  const resolvedPage = await writeEvidencePageStreamsFast(resolvedRoot, {
    ...pageEntry,
    geometryFile: null,
    verticalFile: null,
    materialFile: null,
    templateFile: null,
    planningTemporal: baseDecision,
    implementedSchemeEvaluation: compactEvaluation
  }, resolvedEvidence);
  resolvedPage.planningTemporal = baseDecision;
  resolvedPage.implementedSchemeEvaluation = compactEvaluation;
  resolvedPages.push(resolvedPage);

  const authorityEvidence = {
    geometryCandidates: resolvedEvidence.geometryCandidates.filter(isAuthorityEntry),
    verticalObservations: resolvedEvidence.verticalObservations.filter(isAuthorityEntry),
    materialObservations: resolvedEvidence.materialObservations.filter(isAuthorityEntry),
    rideStructureTemplates: resolvedEvidence.rideStructureTemplates.filter((entry) => entry.templateAuthorityEligible === true),
    drawingMetadata: resolvedEvidence.drawingMetadata.filter(isAuthorityEntry)
  };
  const authorityCount = authorityEvidence.geometryCandidates.length + authorityEvidence.verticalObservations.length +
    authorityEvidence.materialObservations.length + authorityEvidence.rideStructureTemplates.length + authorityEvidence.drawingMetadata.length;
  if (authorityCount > 0) {
    const authorityPage = await writeEvidencePageStreamsFast(authorityRoot, {
      ...pageEntry,
      geometryFile: null,
      verticalFile: null,
      materialFile: null,
      templateFile: null,
      planningTemporal: firstTemporal(authorityEvidence) || baseDecision,
      implementedSchemeEvaluation: compactEvaluation
    }, authorityEvidence);
    authorityPage.implementedSchemeEvaluation = compactEvaluation;
    authorityPages.push(authorityPage);
  }
}

const shard = Number.isInteger(Number(args.shard)) ? Number(args.shard) : inferShard(bundle.manifest, args.registered);
const revisionSummary = plan.revision?.summary || {};
const shardSummary = {
  schemaVersion: 1,
  format: "voxel-planning-current-state-promoted-shard-v1",
  shard,
  evaluatedPages,
  certifiedSpatialPages,
  certifiedContextPages,
  registrationAnchorCount,
  candidateProofChecks,
  promotedGeometryCandidates,
  promotedAttributeObservations,
  resolvedEvidencePages: resolvedPages.length,
  authorityEvidencePages: authorityPages.length,
  authorityGeometryCandidates: sum(resolvedPages.length ? authorityPages : [], "geometryCount"),
  authorityVerticalObservations: sum(authorityPages, "verticalCount"),
  authorityMaterialObservations: sum(authorityPages, "materialCount"),
  authorityRideStructureTemplates: sum(authorityPages, "rideStructureTemplateCount"),
  rejected,
  matches
};

const resolvedManifest = makeManifest(RESOLVED_BUNDLE_FORMAT, "resolved-current-state-shard", resolvedPages, revisionSummary, shardSummary);
resolvedManifest.selectedShard = shard;
const authorityManifest = makeManifest(AUTHORITY_BUNDLE_FORMAT, "strict-current-authority-shard", authorityPages, revisionSummary, shardSummary);
authorityManifest.selectedShard = shard;
authorityManifest.authorityScope = "planning-current-state-only";
authorityManifest.worldGeometryAuthority = authorityPages.some(hasWorldAuthorityEvidence);
authorityManifest.worldGeometryReady = authorityPages.some((page) => Number(page.geometryCount || 0) > 0);
authorityManifest.templateAuthorityRule = "current template is non-spatial and usable only through exact authoritative plan-anchor linkage";
await writeBundleManifest(resolvedRoot, resolvedManifest);
await writeBundleManifest(authorityRoot, authorityManifest);
await writeJson(path.resolve(args.summaryOut), shardSummary);

console.log(JSON.stringify({
  shard,
  evaluatedPages,
  certifiedSpatialPages,
  certifiedContextPages,
  promotedGeometryCandidates,
  resolvedEvidencePages: resolvedPages.length,
  authorityEvidencePages: authorityPages.length,
  authorityGeometryCandidates: authorityManifest.geometryCandidateCount,
  resolvedOut: resolvedRoot,
  authorityOut: authorityRoot,
  summaryOut: path.resolve(args.summaryOut)
}, null, 2));

function makeManifest(format, stage, pages, revisionSummary, shardSummary) {
  return {
    schemaVersion: 3,
    format,
    stage,
    coordinateSpace: "local-world-metres-plus-nonspatial-templates",
    temporalResolutionRequired: Number(revisionSummary.unresolvedPages || 0) > 0,
    temporalResolutionStatus: Number(revisionSummary.unresolvedPages || 0) > 0 ? "partial" : "resolved",
    pageCount: pages.length,
    geometryCandidateCount: sum(pages, "geometryCount"),
    verticalObservationCount: sum(pages, "verticalCount"),
    materialObservationCount: sum(pages, "materialCount"),
    rideStructureTemplateCount: sum(pages, "rideStructureTemplateCount"),
    pages: pages.sort(pageSort),
    corroboration: {
      attemptedGeometryCandidates: shardSummary.candidateProofChecks,
      promotedGeometryCandidates: shardSummary.promotedGeometryCandidates,
      rejected: shardSummary.rejected
    },
    implementedScheme: {
      schemaVersion: 1,
      evaluatedPages: shardSummary.evaluatedPages,
      certifiedSpatialPages: shardSummary.certifiedSpatialPages,
      certifiedContextPages: shardSummary.certifiedContextPages,
      promotedGeometryCandidates: shardSummary.promotedGeometryCandidates,
      promotedAttributeObservations: shardSummary.promotedAttributeObservations,
      registrationAnchorCount: shardSummary.registrationAnchorCount,
      candidateProofChecks: shardSummary.candidateProofChecks
    }
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
    .map((key) => proofs?.[key])
    .filter((proof) => proof?.accepted)
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0) || String(a.applicationKey).localeCompare(String(b.applicationKey)))[0] || null;
}
function firstTemporal(evidence) {
  return evidence.geometryCandidates[0]?.planningTemporal || evidence.verticalObservations[0]?.planningTemporal ||
    evidence.materialObservations[0]?.planningTemporal || evidence.rideStructureTemplates[0]?.planningTemporal ||
    evidence.drawingMetadata[0]?.planningTemporal || null;
}
function isDirectCurrentAuthority(decision) { return decision?.state === "current" && decision?.worldGeometryAuthority === true; }
function isSchemeAuthorityEntry(entry) { return entry?.implementationSchemeAuthority === true && isAuthorityEntry(entry); }
function isAuthorityEntry(entry) { return entry?.worldGeometryAuthority === true && entry?.planningTemporal?.state === "current"; }
function hasWorldAuthorityEvidence(page) { return Number(page.geometryCount || 0) + Number(page.verticalCount || 0) + Number(page.materialCount || 0) > 0; }
function inferShard(manifest, source) {
  const explicit = Number(manifest?.selectedShard);
  if (Number.isInteger(explicit) && explicit >= 0) return explicit;
  const match = String(source || "").match(/(?:shard[-_])(\d+)/i);
  return match ? Number(match[1]) : -1;
}
function unknownDecision() {
  return { state: "unknown", confidence: 0.45, reason: "missing-page-temporal-resolution", temporalResolved: false, worldGeometryAuthority: false, lineageMemberships: [] };
}
function pageKey(contentHash, pageNumber) { return `${contentHash || "unknown-document"}:p${Number(pageNumber || 1)}`; }
function pageSort(a, b) { return String(a.contentHash || "").localeCompare(String(b.contentHash || "")) || Number(a.pageNumber || 0) - Number(b.pageNumber || 0); }
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
