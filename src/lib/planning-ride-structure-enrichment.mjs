import * as base from "./planning-ride-structure-enrichment-base.mjs";
import { recoverPlanningRideTrackContinuity } from "./planning-ride-layout-continuity.mjs";
import { enrichPlanningPedestrianEvidence } from "./planning-pedestrian-enrichment.mjs";

export const classifyRideStructureText = base.classifyRideStructureText;
export const extractSupportCode = base.extractSupportCode;

/**
 * Run the established text-driven ride component classifier first, then extend
 * only explicit track seeds through same-style endpoint-connected PDF vectors.
 * The same raw-page semantic stage also identifies explicitly labelled
 * pedestrian paths/plazas on site and landscape plans. None of these semantic
 * passes grants spatial/current/world authority.
 */
export function enrichPlanningRideStructureEvidence(extraction, options = {}) {
  const summary = base.enrichPlanningRideStructureEvidence(extraction, options);
  const continuity = recoverPlanningRideTrackContinuity(extraction, options);
  const pedestrian = enrichPlanningPedestrianEvidence(extraction, options);
  summary.counts ||= {};
  summary.counts.rideTrack = Number(summary.counts.rideTrack || 0) + continuity.recoveredTrackFragments;
  summary.counts.continuityRecoveredTrack = continuity.recoveredTrackFragments;
  summary.counts.unresolved = Math.max(0, Number(summary.counts.unresolved || 0) - continuity.recoveredTrackFragments);
  summary.rideTrackContinuity = continuity;
  summary.pedestrian = pedestrian;
  summary.policy = {
    ...(summary.policy || {}),
    fragmentedTrackRecoveryRequiresExplicitSeed: true,
    fragmentedTrackRecoveryRequiresStyleMatch: true,
    fragmentedTrackRecoveryRequiresEndpointContinuity: true,
    fragmentedTrackRecoveryGrantsAuthority: false,
    pedestrianSemanticLabelsGrantAuthority: false
  };
  if (continuity.recoveredTrackFragments > 0) summary.status = "enriched-with-track-continuity";
  extraction.rideStructureExtraction = summary;
  return summary;
}
