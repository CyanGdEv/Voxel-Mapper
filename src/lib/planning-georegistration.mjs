import * as base from "./planning-georegistration-base.mjs";

export * from "./planning-georegistration-base.mjs";

/**
 * Adds an independent-match confidence gate on top of the canonical robust
 * transform solver. Purely automatic registration normally needs agreement
 * across at least two distinct mapped reference features. A single matched
 * shape is accepted only when it contributes at least five controls and both
 * shape and solved-transform residuals are exceptionally small.
 */
export function georegisterPlanningEvidence(extraction, referenceFeatures = [], options = {}) {
  const result = base.georegisterPlanningEvidence(extraction, referenceFeatures, options);
  if (result.status !== "registered" || result.explicitControlPoints > 0) return result;

  const matches = result.automaticMatches || [];
  const distinctTargets = new Set(matches.map((entry) => entry.targetFeatureId).filter(Boolean));
  const strongest = [...matches].sort((a, b) => Number(a.rmseM ?? Infinity) - Number(b.rmseM ?? Infinity))[0] || null;
  const strongSingle = distinctTargets.size === 1 &&
    Number(strongest?.controlPoints || 0) >= 5 &&
    Number(strongest?.rmseM ?? Infinity) <= Number(options.maxExceptionalSingleShapeRmseM ?? 0.45) &&
    Number(result.solution?.rmseM ?? Infinity) <= Number(options.maxExceptionalSolvedRmseM ?? 0.6);

  if (distinctTargets.size >= 2 || strongSingle) {
    result.registrationConsensus = {
      pass: true,
      distinctReferenceFeatures: distinctTargets.size,
      mode: distinctTargets.size >= 2 ? "multi-feature-consensus" : "exceptional-single-shape"
    };
    return result;
  }

  const reason = "automatic registration lacks independent reference-feature consensus";
  return {
    ...result,
    status: "unregistered",
    registeredEvidence: null,
    originalEvidenceRetained: true,
    registrationConsensus: {
      pass: false,
      distinctReferenceFeatures: distinctTargets.size,
      mode: "insufficient-independent-matches",
      reason
    },
    solution: {
      ...result.solution,
      status: "rejected",
      pass: false,
      rejectionReasons: [...(result.solution?.rejectionReasons || []), reason],
      authority: {
        ...(result.solution?.authority || {}),
        spatialRegistrationPassed: false,
        worldGeometryAuthority: false
      }
    }
  };
}
