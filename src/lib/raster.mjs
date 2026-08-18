import * as base from "./raster-parking-base.mjs";
import { renderParkingMarkings } from "./parking-evidence.mjs";
import { renderParkingDetails } from "./parking-detail-evidence.mjs";

export * from "./raster-parking-base.mjs";

/**
 * Preserve the proven hydrology/building compiler and add parking detail only
 * after terrain and authoritative surfaces exist. Bays, kerbs, crossings,
 * arrows and hatching are emitted only from explicit evidence; a car-park
 * footprint alone can never create a guessed layout or paint pattern.
 */
export function compileMap(input) {
  const compilation = base.compileMap(input);
  const parking = renderParkingMarkings(compilation, input);
  const details = renderParkingDetails(compilation, input);
  compilation.meta ||= {};
  compilation.meta.parkingEvidence = parking;
  compilation.meta.parkingDetailEvidence = details;
  return compilation;
}
