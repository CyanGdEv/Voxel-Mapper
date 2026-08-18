import * as base from "./planning-changeset-compiler-base.mjs";

export const resolvePlanningTargetCollisions = base.resolvePlanningTargetCollisions;

/**
 * Generic open vectors on a ride-layout sheet are not track authority. The PDF
 * parser deliberately starts them as `ride-centerline-or-edge` because it
 * cannot know whether a stroked line is rail, queue, dimensioning, drainage or
 * another drawing layer. Only the ride semantic enrichment pass (including its
 * strict same-style continuity recovery) may promote them to explicit track.
 */
export function compilePlanningChangeSet(map, evidence = {}, options = {}) {
  const inputCandidates = evidence?.geometryCandidates || [];
  const deferredRideLines = inputCandidates.filter(isUncertifiedRideLayoutLine);
  const safeEvidence = deferredRideLines.length
    ? { ...evidence, geometryCandidates: inputCandidates.filter((candidate) => !deferredRideLines.includes(candidate)) }
    : evidence;
  const output = base.compilePlanningChangeSet(map, safeEvidence, options);

  output.input ||= {};
  output.input.geometryCandidates = inputCandidates.length;
  for (const candidate of deferredRideLines) {
    output.changes.push({
      operation: "review",
      reason: "ride-layout-linework-not-explicitly-certified-as-track",
      sourceRef: candidateRef(candidate),
      featureKind: null,
      targetFeatureId: null,
      matchScore: null,
      currentAuthority: isCurrentAuthority(candidate),
      inference: {
        kind: null,
        confidence: 1,
        reason: "ride-track-semantic-enrichment-required",
        signals: ["generic-ride-layout-linework"]
      }
    });
    output.counts.review = (output.counts.review || 0) + 1;
  }
  if (deferredRideLines.length) {
    output.status = "compiled-with-review-items";
    output.rideTrackSemanticSafety = {
      schemaVersion: 1,
      deferredGenericRideLines: deferredRideLines.length,
      rule: "only explicitly enriched ride-track-centerline geometry may compile as ride_track"
    };
  }
  return output;
}

export function inferPlanningFeatureKind(candidate, map = null, options = {}) {
  if (isUncertifiedRideLayoutLine(candidate)) {
    return {
      kind: null,
      confidence: 1,
      reason: "ride-track-semantic-enrichment-required",
      signals: ["generic-ride-layout-linework"]
    };
  }
  return base.inferPlanningFeatureKind(candidate, map, options);
}

function isUncertifiedRideLayoutLine(candidate) {
  const classification = normalizeClass(candidate?.classification);
  if (classification !== "ride_layout") return false;
  const geometryType = String(candidate?.localGeometry?.type || candidate?.geometry?.type || "");
  if (!/LineString/.test(geometryType)) return false;
  if (explicitTrackSemantic(candidate)) return false;
  const kind = normalizeKind(candidate?.kind || candidate?.featureKind || candidate?.properties?.kind);
  if (kind && kind !== "ride_track") return false;
  const semantic = normalizeSemantic(candidate?.semantic);
  // Preserve explicitly classified supports/structures and other non-track ride
  // components; this gate targets only generic linework that the old fallback
  // incorrectly converted to track.
  if (/support|catwalk|platform|access|enclosure|building|barrier/.test(semantic)) return false;
  return semantic === "ride-centerline-or-edge" || semantic === "unclassified-linework" ||
    semantic === "ride-linework" || !semantic;
}

function explicitTrackSemantic(candidate) {
  const kind = normalizeKind(candidate?.kind || candidate?.featureKind || candidate?.properties?.kind);
  if (kind === "ride_track") return true;
  const semantic = normalizeSemantic(candidate?.semantic);
  if (semantic === "ride-track-centerline" || semantic === "ride_track_centerline") return true;
  const evidence = candidate?.rideStructureEvidence;
  return evidence?.role === "track" && evidence?.subtype === "ride_track_centerline" &&
    ["planning-pdf-ride-structure-semantic-enrichment", "planning-pdf-ride-track-style-continuity"].includes(evidence?.source);
}

function candidateRef(candidate) {
  return candidate?.id || (candidate?.contentHash ? `${candidate.contentHash}:p${candidate.pageNumber || 1}` : null);
}
function isCurrentAuthority(entry) { return entry?.worldGeometryAuthority === true && entry?.planningTemporal?.state === "current"; }
function normalizeClass(value) { return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_"); }
function normalizeKind(value) { return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_"); }
function normalizeSemantic(value) { return String(value || "").trim().toLowerCase().replace(/\s+/g, " "); }
