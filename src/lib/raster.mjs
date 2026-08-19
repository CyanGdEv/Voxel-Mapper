import * as base from "./raster-parking-base.mjs";
import { sealLidarBuildingShells } from "./building-shell-sealer.mjs";
import { renderParkingMarkings } from "./parking-evidence.mjs";
import { renderParkingDetails } from "./parking-detail-evidence.mjs";

export * from "./raster-parking-base.mjs";
export { sealLidarBuildingShells } from "./building-shell-sealer.mjs";

/**
 * Preserve the proven hydrology/building compiler, run a final LiDAR shell
 * sanitation/sealing pass, then add parking detail only after terrain and
 * authoritative surfaces exist. Bays, kerbs, crossings, arrows and hatching
 * are emitted only from explicit evidence; a car-park footprint alone can
 * never create a guessed layout or paint pattern.
 */
export function compileMap(input) {
  const compilation = base.compileMap(input);
  const shellSeal = sealLidarBuildingShells(compilation, input);
  const parking = renderParkingMarkings(compilation, input);
  const details = renderParkingDetails(compilation, input);
  compilation.meta ||= {};
  compilation.meta.verticalStats ||= {};
  compilation.meta.verticalStats.buildingShellFinalSeal = shellSeal;
  compilation.meta.parkingEvidence = parking;
  compilation.meta.parkingDetailEvidence = details;
  compilation.stats ||= {};
  compilation.stats.buildingShellFinalSealOperations = shellSeal.operations;
  compilation.stats.buildingShellRejectedDsmOutliers = shellSeal.outlierSamplesRejected;
  compilation.stats.buildingShellInternalStepWallColumns = shellSeal.internalStepWallColumns;
  compilation.stats.buildingShellClearedStaleBlocks = shellSeal.clearedBlocks;
  return compilation;
}
