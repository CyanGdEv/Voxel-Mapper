const GLOBAL_WORLD_PLAN_CLASSES = new Set([
  "site_plan",
  "location_plan",
  "landscape_plan",
  "ride_layout"
]);

/**
 * A whole site/location/landscape/ride sheet may not be promoted into local
 * world coordinates from one automatically matched object. One building can
 * provide several control points and therefore make the numerical transform
 * look excellent while locating an entire large drawing around that building.
 *
 * Explicit scoped control points remain eligible because they are intentional
 * georeferencing evidence. Automatic-only registration for global plan classes
 * requires several independent source/target feature matches. Detail/floor/
 * roof/elevation pages are not world-topology anchors and retain the lower-level
 * numerical registration behaviour for attribute/template extraction.
 */
export function enforcePlanningPageRegistrationPolicy(result, classification, options = {}) {
  if (!result || result.status !== "registered" || result.solution?.pass !== true) return result;
  const normalizedClass = normalizeClass(classification);
  if (!GLOBAL_WORLD_PLAN_CLASSES.has(normalizedClass)) return result;

  const explicitControls = Number(result.explicitControlPoints || 0);
  if (explicitControls > 0) return result;

  const matches = result.automaticMatches || [];
  const uniqueSources = new Set(matches.map((entry) => entry?.sourceCandidateId).filter(Boolean));
  const uniqueTargets = new Set(matches.map((entry) => entry?.targetFeatureId).filter(Boolean));
  const minimum = Math.max(2, Math.floor(Number(options.minAutomaticWorldPlanMatches ?? 3)));
  if (matches.length >= minimum && uniqueSources.size >= minimum && uniqueTargets.size >= minimum) return result;

  const reason = `global-plan-automatic-registration-requires-${minimum}-independent-shape-matches`;
  return {
    ...result,
    status: "unregistered",
    registeredEvidence: null,
    originalEvidenceRetained: true,
    policyRejection: {
      reason,
      classification: normalizedClass,
      automaticMatches: matches.length,
      uniqueSourceCandidates: uniqueSources.size,
      uniqueTargetFeatures: uniqueTargets.size,
      minimumIndependentMatches: minimum,
      explicitControlPoints: explicitControls
    },
    solution: {
      ...result.solution,
      status: "rejected",
      pass: false,
      rejectionReasons: [...new Set([...(result.solution?.rejectionReasons || []), reason])],
      authority: {
        ...(result.solution?.authority || {}),
        spatialRegistrationPassed: false,
        worldGeometryAuthority: false
      }
    }
  };
}

export function isGlobalWorldPlanClass(value) {
  return GLOBAL_WORLD_PLAN_CLASSES.has(normalizeClass(value));
}

function normalizeClass(value) {
  return String(value || "unknown").trim().toLowerCase().replace(/[\s-]+/g, "_");
}
