import { corroboratePlanningGeometryCandidate } from "./planning-current-corroboration.mjs";

const SPATIAL_CERTIFICATION_CLASSES = new Set(["site_plan", "landscape_plan", "ride_layout"]);
const CONTEXT_ONLY_CLASSES = new Set(["location_plan"]);
const EXCLUDED_STATES = new Set(["refused", "withdrawn", "demolished", "superseded"]);

/**
 * Evaluate whether a registered planning page is independently proven to have
 * been implemented. Approval is never enough: every accepted anchor is first
 * checked against a post-decision current observation by the existing
 * candidate-level corroborator. Multiple independent anchors are then required
 * before the whole plan page may become spatial authority.
 *
 * A location plan can corroborate application context, but it can never make
 * all of its contextual linework world geometry authority.
 */
export function evaluateImplementedPlanningPage({
  page,
  evidence,
  referenceFeatures,
  applicationTemporal,
  drawingIssueDate = null,
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
  for (const candidate of evidence?.geometryCandidates || []) {
    if (candidate?.georegistrationStatus !== "registered" || candidate?.spatialAuthorityEligible === false) continue;
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
      candidateId: candidate.id || null,
      featureId: proof.match?.feature?.id || null,
      featureKind: proof.match?.feature?.kind || null,
      score: Number(proof.match?.score || 0),
      secondScore: proof.match?.secondScore ?? null,
      observedAt: proof.observedAt || null,
      decisionAt: proof.decisionAt || null,
      implementationCorroboration: proof.temporal?.implementationCorroboration || null
    });
  }

  const uniqueFeatures = new Set(anchors.map((entry) => entry.featureId).filter(Boolean));
  const uniqueKinds = new Set(anchors.map((entry) => entry.featureKind).filter(Boolean));
  const scores = anchors.map((entry) => entry.score).filter(Number.isFinite).sort((a, b) => a - b);
  const medianScore = median(scores);
  const minAnchors = Math.max(2, Number(options.minAnchors ?? 4));
  const minUniqueFeatures = Math.max(2, Number(options.minUniqueFeatures ?? 2));
  const minMedianScore = Number(options.minMedianScore ?? 0.78);
  const enoughIndependentReference = uniqueFeatures.size >= 3 || (uniqueFeatures.size >= 2 && uniqueKinds.size >= 2 && anchors.length >= 8);
  const evidencePass = anchors.length >= minAnchors &&
    uniqueFeatures.size >= minUniqueFeatures &&
    enoughIndependentReference &&
    medianScore >= minMedianScore;

  const contextOnly = CONTEXT_ONLY_CLASSES.has(classification);
  const certifiedSpatialAuthority = evidencePass && SPATIAL_CERTIFICATION_CLASSES.has(classification);
  const certifiedContext = evidencePass && contextOnly;
  const status = certifiedSpatialAuthority ? "implemented-plan-certified" :
    certifiedContext ? "implemented-context-certified" : "insufficient-independent-current-anchors";

  return {
    status,
    accepted: certifiedSpatialAuthority || certifiedContext,
    classification,
    certifiedSpatialAuthority,
    certifiedContext,
    anchorCount: anchors.length,
    uniqueFeatureCount: uniqueFeatures.size,
    uniqueFeatureKinds: [...uniqueKinds].sort(),
    medianMatchScore: round(medianScore),
    anchors,
    rejected: rejectionCounts,
    temporal: certifiedSpatialAuthority || certifiedContext ? implementedTemporal(baseTemporal, anchors, {
      classification,
      certifiedSpatialAuthority,
      certifiedContext
    }) : null
  };
}

/** Promote a certified plan page. Geometry is promoted only for a page that
 * passed the stronger spatial certification gate. Non-spatial observations and
 * templates can accompany that certified page. */
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

/**
 * Once at least one real spatial plan for an application is independently
 * certified as implemented, related section/elevation/detail pages may provide
 * non-spatial dimensions, materials and structural templates. Their geometry
 * remains non-authoritative and can never be placed directly in the world.
 */
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
  const uniqueFeatureIds = new Set(spatial.flatMap((entry) => entry.evaluation.anchors || []).map((entry) => entry.featureId).filter(Boolean));
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
    uniqueFeatureKinds: [],
    medianMatchScore: 0,
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
