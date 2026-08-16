import { matchGeometryCandidate } from "./planning-authority-fusion.mjs";

const ELIGIBLE_CLASSES = new Set(["site_plan", "location_plan", "ride_layout", "landscape_plan"]);
const DEFAULT_MIN_SCORE = 0.78;
const DEFAULT_AMBIGUITY_GAP = 0.12;

/**
 * Approval is not implementation. This promotes only an individual registered
 * planning geometry candidate that is independently re-observed in a later
 * current OSM feature. The current observation must post-date the planning
 * decision; pre-decision geometry cannot prove that the proposal was built.
 */
export function corroboratePlanningGeometryCandidate(candidate, referenceFeatures, context = {}) {
  const classification = String(candidate?.classification || "").toLowerCase();
  if (!ELIGIBLE_CLASSES.has(classification)) return rejected("non-materializable-planning-class");
  if (!candidate?.localGeometry || candidate?.georegistrationStatus !== "registered") return rejected("candidate-not-spatially-registered");
  const decisionAt = latestPlanningDecisionDate(context.applicationTemporal || [], context.drawingIssueDate || null);
  if (!decisionAt) return rejected("missing-planning-decision-date");

  const match = matchGeometryCandidate(candidate, referenceFeatures || [], {
    planningAuthorityMinMatchScore: Number(context.minMatchScore ?? DEFAULT_MIN_SCORE),
    planningAuthorityAmbiguityGap: Number(context.ambiguityGap ?? DEFAULT_AMBIGUITY_GAP)
  });
  if (!match.accepted) return rejected(`geometry-${match.reason}`, { match });
  const observedAt = parsePlanningDate(match.feature?.source?.timestamp);
  if (!observedAt) return rejected("current-observation-missing-timestamp", { match });
  if (!(observedAt.getTime() > decisionAt.getTime())) {
    return rejected("observation-not-post-decision", {
      match,
      decisionAt: decisionAt.toISOString(),
      observedAt: observedAt.toISOString()
    });
  }

  const score = Number(match.score || 0);
  const temporalConfidence = clamp(0.82 + Math.max(0, score - DEFAULT_MIN_SCORE) * 0.55);
  return {
    accepted: true,
    match,
    decisionAt: decisionAt.toISOString(),
    observedAt: observedAt.toISOString(),
    temporal: {
      state: "current",
      confidence: round(temporalConfidence),
      reason: "post-decision-current-osm-geometry-corroboration",
      source: "cross-source-current-observation",
      observedAt: observedAt.toISOString(),
      planningDecisionAt: decisionAt.toISOString(),
      temporalResolved: true,
      worldGeometryAuthority: true,
      implementationCorroboration: {
        provider: match.feature?.source?.provider || "OpenStreetMap",
        featureId: match.feature?.id || null,
        elementType: match.feature?.source?.elementType || null,
        elementId: match.feature?.source?.elementId || null,
        version: match.feature?.source?.version ?? null,
        timestamp: match.feature?.source?.timestamp || null,
        matchScore: match.score ?? null,
        secondScore: match.secondScore ?? null
      }
    }
  };
}

export function latestPlanningDecisionDate(applicationTemporal, drawingIssueDate = null) {
  const values = [];
  for (const temporal of applicationTemporal || []) {
    for (const evidence of temporal?.dateEvidence || []) {
      if (!/decision[-_ ]?date/i.test(String(evidence?.kind || ""))) continue;
      const date = parsePlanningDate(evidence?.value);
      if (date) values.push(date);
    }
  }
  if (!values.length) return null;
  values.sort((a, b) => b.getTime() - a.getTime());
  return values[0];
}

export function parsePlanningDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  // UK local planning registers commonly emit DD/MM/YYYY. Parse this form
  // explicitly before the platform Date parser so 09/08/2016 is never treated
  // as 8 September or rejected differently across runtimes.
  const uk = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:\s+.*)?$/);
  if (uk) {
    const day = Number(uk[1]), month = Number(uk[2]), year = Number(uk[3]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      const date = new Date(Date.UTC(year, month - 1, day));
      if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) return date;
    }
    return null;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function rejected(reason, extra = {}) { return { accepted: false, reason, ...extra }; }
function clamp(value) { return Math.max(0, Math.min(0.995, Number(value) || 0)); }
function round(value) { return Math.round(Number(value) * 1000) / 1000; }
