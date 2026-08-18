import * as base from "./planning-authority-fusion-base.mjs";
import { summarizeRideProfiles } from "./ride-profile.mjs";
import {
  attachPlanningRideProfileCandidates,
  materializePlanningRideProfileWinners
} from "./planning-ride-profile-authority.mjs";

export const resolveGeometryCandidateMatch = base.resolveGeometryCandidateMatch;
export const matchGeometryCandidate = base.matchGeometryCandidate;
export const matchPointObservation = base.matchPointObservation;

/**
 * Preserve the established planning-current authority fusion unchanged, then
 * add the one attribute it previously could not construct: a ride-track
 * verticalProfile derived from strict-current, georegistered absolute planning
 * level anchors. The candidate still has to win the normal Evidence Graph.
 */
export async function integratePlanningAuthorityEvidence(map, options = {}) {
  const summary = await base.integratePlanningAuthorityEvidence(map, options);
  const rideVerticalProfiles = attachPlanningRideProfileCandidates(map, options);
  summary.accepted ||= {};
  summary.accepted.verticalProfile = rideVerticalProfiles.acceptedProfiles;
  summary.rideVerticalProfiles = rideVerticalProfiles;
  if (rideVerticalProfiles.acceptedProfiles > 0) summary.status = "integrated";
  if (rideVerticalProfiles.matches?.length) {
    summary.matches = [
      ...(summary.matches || []),
      ...rideVerticalProfiles.matches.map((match) => ({
        type: "verticalProfile-anchor",
        sourceRef: match.sourceRef,
        featureId: match.featureId,
        featureKind: "ride_track",
        score: match.score,
        distanceM: match.distanceM,
        label: match.label,
        valueM: match.valueM
      }))
    ].slice(0, Math.max(1, Number(options.maxPlanningAuthorityQaMatches || 500)));
  }
  return summary;
}

export function fusePlanningAuthorityIntoEvidenceGraph(map, options = {}) {
  return base.fusePlanningAuthorityIntoEvidenceGraph(map, options);
}

/**
 * Let the established materializer apply every pre-existing planning winner,
 * then materialize verticalProfile winners that passed the same graph. The
 * ride-profile summary object is refreshed in place so pipeline references
 * created before authority fusion see the final 3D state too.
 */
export function applyPlanningAuthorityWinners(map) {
  const summary = base.applyPlanningAuthorityWinners(map);
  const rideVerticalProfiles = materializePlanningRideProfileWinners(map);
  summary.rideVerticalProfiles = rideVerticalProfiles;

  if (rideVerticalProfiles.applied > 0) {
    summary.appliedAttributes += rideVerticalProfiles.applied;
    summary.byAttribute ||= {};
    summary.byAttribute.verticalProfile = (summary.byAttribute.verticalProfile || 0) + rideVerticalProfiles.applied;
    summary.changes = [...(summary.changes || []), ...rideVerticalProfiles.changes];
    summary.affectedFeatures = new Set((summary.changes || []).map((change) => change.featureId).filter(Boolean)).size;

    const existing = map?.rideProfiles;
    const refreshed = summarizeRideProfiles(map?.features || [], existing?.sourceCatalog || []);
    if (existing && typeof existing === "object") Object.assign(existing, refreshed);
    else if (map) map.rideProfiles = refreshed;
  }
  return summary;
}
