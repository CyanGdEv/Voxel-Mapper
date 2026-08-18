import * as base from "./planning-ride-structure-enrichment-base.mjs";
import { recoverPlanningRideTrackContinuity } from "./planning-ride-layout-continuity.mjs";

export const classifyRideStructureText = base.classifyRideStructureText;
export const extractSupportCode = base.extractSupportCode;

/**
 * Run the established text-driven ride component classifier first, then extend
 * only explicit track seeds through same-style endpoint-connected PDF vectors.
 * This preserves the stronger support/enclosure/catwalk classifications and
 * never promotes unseeded generic ride-layout linework.
 */
export function enrichPlanningRideStructureEvidence(extraction, options = {}) {
  const summary = base.enrichPlanningRideStructureEvidence(extraction, options);
  const continuity = recoverPlanningRideTrackContinuity(extraction, options);
  summary.counts ||= {};
  summary.counts.rideTrack = Number(summary.counts.rideTrack || 0) + continuity.recoveredTrackFragments;
  summary.counts.continuityRecoveredTrack = continuity.recoveredTrackFragments;
  summary.counts.unresolved = Math.max(0, Number(summary.counts.unresolved || 0) - continuity.recoveredTrackFragments);
  summary.rideTrackContinuity = continuity;
  summary.policy = {
    ...(summary.policy || {}),
    fragmentedTrackRecoveryRequiresExplicitSeed: true,
    fragmentedTrackRecoveryRequiresStyleMatch: true,
    fragmentedTrackRecoveryRequiresEndpointContinuity: true,
    fragmentedTrackRecoveryGrantsAuthority: false
  };
  if (continuity.recoveredTrackFragments > 0) summary.status = "enriched-with-track-continuity";
  extraction.rideStructureExtraction = summary;
  return summary;
}
