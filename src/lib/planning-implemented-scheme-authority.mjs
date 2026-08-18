import {
  corroboratePlanningGeometryCandidate,
  latestPlanningDecisionDate,
  parsePlanningDate
} from "./planning-current-corroboration.mjs";

const SPATIAL_CERTIFICATION_CLASSES = new Set(["site_plan", "landscape_plan", "ride_layout"]);
const CONTEXT_ONLY_CLASSES = new Set(["location_plan"]);
const CORROBORATABLE_CLASSES = new Set(["site_plan", "landscape_plan", "ride_layout", "location_plan"]);
const EXCLUDED_STATES = new Set(["refused", "withdrawn", "demolished", "superseded"]);
const DEFAULT_RETAINED_DIAGNOSTIC_ANCHORS = 32;

export function evaluateImplementedPlanningPage({
  page,
  evidence,
  referenceFeatures,
  applicationTemporal,
  drawingIssueDate = null,
  registration = null,
  options = {}
}) {
  const classification = normalizeClass(page?.classification || evidence?.geometryCandidates?.[0]?.classification);
  const baseTemporal = page?.planningTemporal || evidence?.geometryCandidates?.[0]?.planningTemporal || null;
  const baseState = String(baseTemporal?.state || "unknown").toLowerCase();
  const baseReason = String(baseTemporal?.reason || "");

  if (EXCLUDED_STATES.has(baseState)) return rejected("page-explicitly-non-current", classification);
  if (page?.georegistrationStatus !== "registered") return rejected("page-not-spatially-registered", classification);
  if (!SPATIAL_CERTIFICATION_CLASSES.has(classification) && !CONTEXT_ONLY_CLASSES.has(classification)) {
    return rejected("page-class-not-implementation-anchor", classification);
  }
  if (!eligibleLifecycleForCorroboration(baseState, baseReason, applicationTemporal)) {
    return rejected("page-lifecycle-not-eligible-for-corroboration", classification);
  }

  const anchors = [];
  const rejectionCounts = {};
  const referenceById = new Map((referenceFeatures || []).map((feature) => [feature?.id, feature]));
  const registrationProof = collectRegistrationAnchors({
    registration,
    referenceById,
    applicationTemporal,
    drawingIssueDate,
    options
  });
  anchors.push(...registrationProof.anchors);
  mergeCounts(rejectionCounts, registrationProof.rejected);

  const minAnchors = Math.max(2, Number(options.minAnchors ?? 4));
  const minUniqueFeatures = Math.max(2, Number(options.minUniqueFeatures ?? 2));
  const minMedianScore = Number(options.minMedianScore ?? 0.78);
  const minRegistrationFeatures = Math.max(3, Number(options.minRegistrationFeatures ?? 3));
  const maxCandidateProofChecks = Math.max(0, Number(options.maxCandidateProofChecks ?? 2500));

  let evidencePass = registrationProof.pass && registrationProof.uniqueFeatureCount >= minRegistrationFeatures;
  let candidateProofChecks = 0;

  if (!evidencePass && maxCandidateProofChecks > 0) {
    for (const candidate of proofCandidates(evidence?.geometryCandidates || [])) {
      if (candidateProofChecks >= maxCandidateProofChecks) break;
      candidateProofChecks += 1;
      const proof = corroboratePlanningGeometryCandidate(candidate, referenceFeatures || [], {
        applicationTemporal: applicationTemporal || [],
        drawingIssueDate,
        minMatchScore: Number(options.minMatchScore ?? 0.78),
        ambiguityGap: Number(options.ambiguityGap ?? 0.12)
      });
      if (!proof.accepted) {
        rejectionCounts[proof.reason] = (rejectionCounts[proof.reason] || 0) + 1;
        continue;
      }
      anchors.push({
        source: "candidate-corroboration",
        candidateId: candidate.id || null,
        featureId: proof.match?.feature?.id || null,
        featureKind: proof.match?.feature?.kind || null,
        score: Number(proof.match?.score || 0),
        secondScore: proof.match?.secondScore ?? null,
        observedAt: proof.observedAt || null,
        decisionAt: proof.decisionAt || null,
        implementationCorroboration: proof.temporal?.implementationCorroboration || null
      });
      if (candidateAnchorThresholdPassed(anchors, { minAnchors, minUniqueFeatures, minMedianScore })) {
        evidencePass = true;
        break;
      }
    }
  }

  if (!evidencePass) {
    evidencePass = candidateAnchorThresholdPassed(anchors, { minAnchors, minUniqueFeatures, minMedianScore });
  }

  const uniqueFeatures = new Set(anchors.map((entry) => entry.featureId).filter(Boolean));
  const uniqueKinds = new Set(anchors.map((entry) => entry.featureKind).filter(Boolean));
  const scores = anchors.map((entry) => entry.score).filter(Number.isFinite).sort((a, b) => a - b);
  const medianScore = median(scores);
  const contextOnly = CONTEXT_ONLY_CLASSES.has(classification);
  const certifiedSpatialAuthority = evidencePass && SPATIAL_CERTIFICATION_CLASSES.has(classification);
  const certifiedContext = evidencePass && contextOnly;
  const status = certifiedSpatialAuthority ? "implemented-plan-certified" :
    certifiedContext ? "implemented-context-certified" : "insufficient-independent-current-anchors";
  const temporal = certifiedSpatialAuthority || certifiedContext ? implementedTemporal(baseTemporal, anchors, {
    classification,
    certifiedSpatialAuthority,
    certifiedContext
  }) : null;
  const retainedAnchors = retainDiagnosticAnchors(
    anchors,
    options.maxRetainedDiagnosticAnchors ?? DEFAULT_RETAINED_DIAGNOSTIC_ANCHORS
  );

  return {
    status,
    accepted: certifiedSpatialAuthority || certifiedContext,
    classification,
    certifiedSpatialAuthority,
    certifiedContext,
    anchorCount: anchors.length,
    uniqueFeatureCount: uniqueFeatures.size,
    uniqueFeatureIds: [...uniqueFeatures].sort(),
    uniqueFeatureKinds: [...uniqueKinds].sort(),
    medianMatchScore: round(medianScore),
    registrationAnchorCount: registrationProof.anchors.length,
    registrationUniqueFeatureCount: registrationProof.uniqueFeatureCount,
    registrationMedianScore: registrationProof.medianScore,
    registrationRmseM: registrationProof.registrationRmseM,
    candidateProofChecks,
    proofBoundReached: candidateProofChecks >= maxCandidateProofChecks && !evidencePass,
    retainedAnchorCount: retainedAnchors.length,
    anchors: retainedAnchors,
    rejected: rejectionCounts,
    temporal
  };
}

export function promoteCertifiedPageEvidence(evidence, evaluation) {
  if (!evaluation?.accepted || !evaluation?.temporal) return emptyPromotion();
  const temporal = evaluation.temporal;
  const geometryCandidates = evaluation.certifiedSpatialAuthority
    ? (evidence?.geometryCandidates || [])
      .filter(isRegisteredSpatialCandidate)
      .map((entry) => promoteSpatialEntry(entry, temporal))
    : [];
  const verticalObservations = (evidence?.verticalObservations || []).map((entry) => promoteAttributeEntry(entry, temporal));
  const materialObservations = (evidence?.materialObservations || []).map((entry) => promoteAttributeEntry(entry, temporal));
  const drawingMetadata = (evidence?.drawingMetadata || []).map((entry) => promoteAttributeEntry(entry, temporal));
  const rideStructureTemplates = (evidence?.rideStructureTemplates || []).map((entry) => promoteTemplate(entry, temporal));
  return { geometryCandidates, verticalObservations, materialObservations, drawingMetadata, rideStructureTemplates };
}

export function promoteImplementedApplicationSupportEvidence(evidence, page, applicationProof) {
  if (!applicationProof?.accepted) return emptyPromotion();
  const base = page?.planningTemporal || evidence?.geometryCandidates?.[0]?.planningTemporal || evidence?.drawingMetadata?.[0]?.planningTemporal || null;
  const state = String(base?.state || "unknown").toLowerCase();
  if (EXCLUDED_STATES.has(state)) return emptyPromotion();
  const reason = String(base?.reason || "");
  if (!eligibleLifecycleForCorroboration(state, reason, applicationProof.applicationTemporal || [])) return emptyPromotion();

  const temporal = {
    state: "current",
    confidence: round(Math.min(0.96, Math.max(0.86, Number(applicationProof.confidence || 0.86)))),
    reason: "implemented-application-supporting-evidence",
    source: "implemented-planning-scheme-multi-anchor",
    temporalResolved: true,
    worldGeometryAuthority: true,
    implementationScheme: applicationProof.summary || null,
    lineageMemberships: base?.lineageMemberships || []
  };
  return {
    geometryCandidates: [],
    verticalObservations: (evidence?.verticalObservations || []).map((entry) => promoteAttributeEntry(entry, temporal)),
    materialObservations: (evidence?.materialObservations || []).map((entry) => promoteAttributeEntry(entry, temporal)),
    drawingMetadata: (evidence?.drawingMetadata || []).map((entry) => promoteAttributeEntry(entry, temporal)),
    rideStructureTemplates: (evidence?.rideStructureTemplates || []).map((entry) => promoteTemplate(entry, temporal))
  };
}

export function buildImplementedApplicationProof(applicationKey, pageEvaluations, applicationTemporal = []) {
  const spatial = (pageEvaluations || []).filter((entry) => entry?.evaluation?.certifiedSpatialAuthority);
  if (!spatial.length) return { accepted: false, applicationKey, applicationTemporal, confidence: 0, summary: null };
  const totalAnchors = spatial.reduce((sum, entry) => sum + Number(entry.evaluation.anchorCount || 0), 0);
  const uniqueFeatureIds = new Set(spatial.flatMap((entry) =>
    entry.evaluation.uniqueFeatureIds || (entry.evaluation.anchors || []).map((anchor) => anchor.featureId)
  ).filter(Boolean));
  const confidence = Math.min(0.96, 0.84 + Math.min(0.1, uniqueFeatureIds.size * 0.015) + Math.min(0.02, totalAnchors * 0.001));
  return {
    accepted: true,
    applicationKey,
    applicationTemporal,
    confidence: round(confidence),
    summary: {
      applicationKey,
      certifiedPlanPages: spatial.map((entry) => ({
        contentHash: entry.page?.contentHash || null,
        pageNumber: entry.page?.pageNumber || null,
        classification: entry.evaluation.classification,
        anchors: entry.evaluation.anchorCount,
        uniqueCurrentFeatures: entry.evaluation.uniqueFeatureCount,
        registrationAnchors: entry.evaluation.registrationAnchorCount || 0,
        medianMatchScore: entry.evaluation.medianMatchScore
      })),
      totalAnchors,
      uniqueCurrentFeatures: uniqueFeatureIds.size
    }
  };
}

export function mergeApplicationSnapshots(existing = {}, snapshot = {}) {
  const keys = new Set([...Object.keys(existing || {}), ...Object.keys(snapshot || {})]);
  return Object.fromEntries([...keys].sort().map((key) => [key, {
    ...(existing[key] || {}),
    ...(snapshot[key] || {}),
    temporal: snapshot[key]?.temporal || existing[key]?.temporal || null
  }]));
}

function collectRegistrationAnchors({ registration, referenceById, applicationTemporal, drawingIssueDate, options }) {
  const result = {
    anchors: [], rejected: {}, pass: false, uniqueFeatureCount: 0,
    medianScore: 0, registrationRmseM: null
  };
  if (registration?.status !== "registered" || registration?.solution?.pass !== true) {
    result.rejected["registration-not-passed"] = 1;
    return result;
  }
  const decisionAt = latestPlanningDecisionDate(applicationTemporal || [], drawingIssueDate || null);
  if (!decisionAt) {
    result.rejected["missing-planning-decision-date"] = 1;
    return result;
  }
  const maxMatchRmseM = Math.max(0.1, Number(options.maxRegistrationMatchRmseM ?? 1.0));
  const maxPageRmseM = Math.max(0.1, Number(options.maxRegistrationPageRmseM ?? 1.0));
  const pageRmse = Number(registration?.solution?.rmseM);
  result.registrationRmseM = Number.isFinite(pageRmse) ? round(pageRmse) : null;
  if (!Number.isFinite(pageRmse) || pageRmse > maxPageRmseM) {
    result.rejected["registration-page-rmse-above-proof-gate"] = 1;
    return result;
  }

  for (const match of registration?.automaticMatches || []) {
    const feature = referenceById.get(match?.targetFeatureId);
    if (!feature) {
      result.rejected["registration-reference-feature-missing"] = (result.rejected["registration-reference-feature-missing"] || 0) + 1;
      continue;
    }
    const observedAt = parsePlanningDate(feature?.source?.timestamp);
    if (!observedAt) {
      result.rejected["current-observation-missing-timestamp"] = (result.rejected["current-observation-missing-timestamp"] || 0) + 1;
      continue;
    }
    if (!(observedAt.getTime() > decisionAt.getTime())) {
      result.rejected["observation-not-post-decision"] = (result.rejected["observation-not-post-decision"] || 0) + 1;
      continue;
    }
    const rmseM = Number(match?.rmseM);
    if (!Number.isFinite(rmseM) || rmseM > maxMatchRmseM) {
      result.rejected["registration-match-rmse-above-proof-gate"] = (result.rejected["registration-match-rmse-above-proof-gate"] || 0) + 1;
      continue;
    }
    const score = Math.max(0, Math.min(1, 1 - rmseM / 4));
    const anchor = {
      source: "robust-georegistration-current-anchor",
      candidateId: match?.sourceCandidateId || null,
      featureId: feature.id || match?.targetFeatureId || null,
      featureKind: feature.kind || null,
      score: round(score),
      registrationRmseM: round(rmseM),
      controlPoints: Number(match?.controlPoints || 0),
      observedAt: observedAt.toISOString(),
      decisionAt: decisionAt.toISOString(),
      implementationCorroboration: {
        provider: feature?.source?.provider || "OpenStreetMap",
        featureId: feature.id || null,
        elementType: feature?.source?.elementType || null,
        elementId: feature?.source?.elementId || null,
        version: feature?.source?.version ?? null,
        timestamp: feature?.source?.timestamp || null,
        registrationRmseM: round(rmseM),
        controlPoints: Number(match?.controlPoints || 0)
      }
    };
    if (!duplicateRegistrationAnchor(result.anchors, anchor)) result.anchors.push(anchor);
  }

  const uniqueFeatures = new Set(result.anchors.map((entry) => entry.featureId).filter(Boolean));
  const scores = result.anchors.map((entry) => entry.score).filter(Number.isFinite);
  result.uniqueFeatureCount = uniqueFeatures.size;
  result.medianScore = round(median(scores));
  result.pass = result.anchors.length >= 3 && uniqueFeatures.size >= 3 && result.medianScore >= Number(options.minMedianScore ?? 0.78);
  return result;
}

function candidateAnchorThresholdPassed(anchors, { minAnchors, minUniqueFeatures, minMedianScore }) {
  const uniqueFeatures = new Set((anchors || []).map((entry) => entry.featureId).filter(Boolean));
  const uniqueKinds = new Set((anchors || []).map((entry) => entry.featureKind).filter(Boolean));
  const medianScore = median((anchors || []).map((entry) => Number(entry.score)).filter(Number.isFinite));
  const enoughIndependentReference = uniqueFeatures.size >= 3 ||
    (uniqueFeatures.size >= 2 && uniqueKinds.size >= 2 && anchors.length >= 8);
  return anchors.length >= minAnchors &&
    uniqueFeatures.size >= minUniqueFeatures &&
    enoughIndependentReference &&
    medianScore >= minMedianScore;
}

function proofCandidates(candidates) {
  return (candidates || [])
    .filter((candidate) => {
      const classification = normalizeClass(candidate?.classification);
      const semantic = String(candidate?.semantic || "").toLowerCase();
      if (!CORROBORATABLE_CLASSES.has(classification)) return false;
      if (!candidate?.localGeometry || candidate?.georegistrationStatus !== "registered" || candidate?.spatialAuthorityEligible === false) return false;
      if (!semantic || /roof|vertical-profile|demolition|building-linework|unclassified/.test(semantic)) return false;
      return true;
    })
    .sort((a, b) => proofPriority(b) - proofPriority(a) || String(a.id || "").localeCompare(String(b.id || "")));
}

function proofPriority(candidate) {
  const geometry = candidate?.localGeometry;
  if (!geometry) return 0;
  const points = [];
  collectPoints(geometry.coordinates, points);
  if (points.length < 2) return 0;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    minX = Math.min(minX, x); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxZ = Math.max(maxZ, z);
  }
  if (!Number.isFinite(minX)) return 0;
  return Math.hypot(maxX - minX, maxZ - minZ);
}

function collectPoints(value, target) {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
    target.push([Number(value[0]), Number(value[1])]);
    return;
  }
  for (const item of value) collectPoints(item, target);
}

function eligibleLifecycleForCorroboration(state, reason, applicationTemporal) {
  if (state === "proposed") return true;
  if (state === "current") return true;
  if (state !== "unknown") return false;
  if (!/ambiguous-document-revision-lineage/i.test(String(reason || ""))) return false;
  return (applicationTemporal || []).some((entry) => {
    const statuses = (entry?.statusEvidence || []).map((value) => String(value).toLowerCase());
    return statuses.some((value) => /approved|granted|permitted|consent/.test(value));
  });
}

function implementedTemporal(baseTemporal, anchors, flags) {
  const scores = anchors.map((entry) => Number(entry.score || 0));
  const newestObservedAt = anchors.map((entry) => entry.observedAt).filter(Boolean).sort().at(-1) || null;
  const decisionAt = anchors.map((entry) => entry.decisionAt).filter(Boolean).sort().at(-1) || null;
  return {
    ...(baseTemporal || {}),
    state: "current",
    confidence: round(Math.min(0.97, 0.86 + Math.max(0, median(scores) - 0.78) * 0.45 + Math.min(0.06, anchors.length * 0.002))),
    reason: flags.certifiedSpatialAuthority ? "implemented-plan-multi-anchor-corroboration" : "implemented-context-multi-anchor-corroboration",
    source: "cross-source-current-observation",
    observedAt: newestObservedAt,
    planningDecisionAt: decisionAt,
    temporalResolved: true,
    worldGeometryAuthority: Boolean(flags.certifiedSpatialAuthority),
    implementationScheme: {
      classification: flags.classification,
      anchorCount: anchors.length,
      uniqueCurrentFeatures: new Set(anchors.map((entry) => entry.featureId).filter(Boolean)).size,
      uniqueFeatureKinds: [...new Set(anchors.map((entry) => entry.featureKind).filter(Boolean))].sort(),
      medianMatchScore: round(median(scores))
    },
    lineageMemberships: baseTemporal?.lineageMemberships || []
  };
}

function retainDiagnosticAnchors(anchors, requestedLimit) {
  const parsed = Number(requestedLimit);
  const limit = Math.max(0, Number.isFinite(parsed) ? Math.floor(parsed) : DEFAULT_RETAINED_DIAGNOSTIC_ANCHORS);
  if (limit === 0 || !(anchors || []).length) return [];
  if (anchors.length <= limit) return anchors;

  const retained = [];
  const retainedRefs = new Set();
  const featureIds = new Set();
  for (const anchor of anchors) {
    const featureId = anchor?.featureId || null;
    if (!featureId || featureIds.has(featureId)) continue;
    retained.push(anchor);
    retainedRefs.add(anchor);
    featureIds.add(featureId);
    if (retained.length >= limit) return retained;
  }
  for (const anchor of anchors) {
    if (retainedRefs.has(anchor)) continue;
    retained.push(anchor);
    if (retained.length >= limit) break;
  }
  return retained;
}

function promoteSpatialEntry(entry, temporal) {
  return {
    ...entry,
    planningTemporal: temporal,
    temporalResolutionRequired: false,
    worldGeometryAuthority: true,
    terrainGeometryAuthority: false,
    terrainElevationAuthority: false,
    implementationSchemeAuthority: true
  };
}
function promoteAttributeEntry(entry, temporal) {
  return {
    ...entry,
    planningTemporal: { ...temporal, worldGeometryAuthority: true },
    temporalResolutionRequired: false,
    worldGeometryAuthority: true,
    terrainGeometryAuthority: false,
    terrainElevationAuthority: false,
    implementationSchemeAuthority: true
  };
}
function promoteTemplate(entry, temporal) {
  return {
    ...entry,
    planningTemporal: { ...temporal, worldGeometryAuthority: false },
    temporalResolutionRequired: false,
    templateAuthorityEligible: true,
    spatialAuthorityEligible: false,
    worldGeometryReady: false,
    worldGeometryAuthority: false,
    linkageRequired: true,
    terrainGeometryMutable: false,
    terrainGeometryAuthority: false,
    terrainElevationAuthority: false,
    implementationSchemeAuthority: true
  };
}
function isRegisteredSpatialCandidate(entry) {
  return entry?.georegistrationStatus === "registered" && entry?.localGeometry && entry?.spatialAuthorityEligible !== false;
}
function duplicateRegistrationAnchor(anchors, candidate) {
  return (anchors || []).some((entry) => entry.featureId && candidate.featureId && entry.featureId === candidate.featureId);
}
function mergeCounts(target, source) {
  for (const [key, value] of Object.entries(source || {})) target[key] = (target[key] || 0) + Number(value || 0);
}
function emptyPromotion() {
  return { geometryCandidates: [], verticalObservations: [], materialObservations: [], drawingMetadata: [], rideStructureTemplates: [] };
}
function rejected(reason, classification) {
  return {
    status: reason,
    accepted: false,
    classification,
    certifiedSpatialAuthority: false,
    certifiedContext: false,
    anchorCount: 0,
    uniqueFeatureCount: 0,
    uniqueFeatureIds: [],
    uniqueFeatureKinds: [],
    medianMatchScore: 0,
    registrationAnchorCount: 0,
    registrationUniqueFeatureCount: 0,
    registrationMedianScore: 0,
    registrationRmseM: null,
    candidateProofChecks: 0,
    proofBoundReached: false,
    retainedAnchorCount: 0,
    anchors: [],
    rejected: {},
    temporal: null
  };
}
function normalizeClass(value) { return String(value || "").trim().toLowerCase().replace(/[ -]+/g, "_"); }
function median(values) {
  const sorted = [...(values || [])].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function round(value) { return Math.round(Number(value || 0) * 1000) / 1000; }
