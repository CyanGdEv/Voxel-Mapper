import * as base from "./raster-parking-base.mjs";
import { renderParkingMarkings } from "./parking-evidence.mjs";

export * from "./raster-parking-base.mjs";

/**
 * Preserve the proven hydrology/building compiler and add parking markings only
 * after the terrain and authoritative surfaces exist. Individual bays are
 * painted only when explicit bay geometry survived source/planning authority;
 * a car-park footprint alone can never create a guessed grid.
 */
export function compileMap(input) {
  const compilation = base.compileMap(input);
  const parking = renderParkingMarkings(compilation, input);
  compilation.meta ||= {};
  compilation.meta.parkingEvidence = parking;
  return compilation;
}
