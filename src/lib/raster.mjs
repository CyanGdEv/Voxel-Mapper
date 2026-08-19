import * as base from "./raster-parking-base.mjs";
import { sealLidarBuildingShells } from "./building-shell-sealer.mjs";
import { renderParkingMarkings } from "./parking-evidence.mjs";
import { renderParkingDetails } from "./parking-detail-evidence.mjs";
import {
  prepareGroundRouteCollisionSafeInput,
  reassertProtectedGroundSurfaces
} from "./ground-route-collision.mjs";

export * from "./raster-parking-base.mjs";
export { sealLidarBuildingShells } from "./building-shell-sealer.mjs";
export {
  prepareGroundRouteCollisionSafeInput,
  reassertProtectedGroundSurfaces
} from "./ground-route-collision.mjs";

/**
 * Preserve the proven hydrology/building compiler, first removing lower/equal
 * authority ground-route collisions with protected water/ride footprints.
 * Protected surfaces are then reasserted at a late terrain phase so area paths,
 * parking paint and later planning surface paint cannot cover them. Finally run
 * LiDAR shell sanitation/sealing and explicit parking detail rendering.
 */
export function compileMap(input) {
  const collision = prepareGroundRouteCollisionSafeInput(input);
  const compilation = base.compileMap(collision.input);
  const shellSeal = sealLidarBuildingShells(compilation, collision.input);
  const parking = renderParkingMarkings(compilation, collision.input);
  const details = renderParkingDetails(compilation, collision.input);
  reassertProtectedGroundSurfaces(compilation, collision.input, collision.summary);
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
