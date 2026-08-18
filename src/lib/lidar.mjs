import * as base from "./lidar-base.mjs";

export const acquireLidarSourceSet = base.acquireLidarSourceSet;
export const readGeoTiffRaster = base.readGeoTiffRaster;
export const createProjectedRasterSampler = base.createProjectedRasterSampler;

const DEFAULT_RECONSTRUCTION_SAMPLE_SPACING_M = 0.25;

/**
 * Preserve the authoritative native LiDAR resolution while sampling the
 * bilinear raster more densely for reconstruction. This does not claim new
 * source measurements: it reduces one-block aliasing/no-data edge failures in
 * building roofs and other DSM/DTM consumers without changing the terrain
 * source or its provenance.
 */
export async function acquireLidarElevation(options, provider) {
  const elevation = await base.acquireLidarElevation(options, provider);
  return enhanceLidarReconstructionSampling(elevation, options);
}

export function enhanceLidarReconstructionSampling(elevation, options = {}) {
  if (!elevation || typeof elevation.samplePairLocal !== "function") return elevation;
  if (elevation.highDensitySampling?.enabled) return elevation;

  const nativePair = elevation.samplePairLocal.bind(elevation);
  const spacingM = clampSpacing(options.lidarReconstructionSampleSpacingM ?? DEFAULT_RECONSTRUCTION_SAMPLE_SPACING_M);
  const offsets = sampleOffsets(spacingM);
  elevation.samplePairLocalNative = nativePair;
  elevation.nativeResolutionM = elevation.resolutionM ?? null;
  elevation.reconstructionSampleSpacingM = spacingM;
  elevation.highDensitySampling = {
    schemaVersion: 1,
    enabled: true,
    nativeResolutionM: elevation.resolutionM ?? null,
    reconstructionSampleSpacingM: spacingM,
    subSamplesPerCell: offsets.length * offsets.length,
    method: "median of bilinearly interpolated native DSM/DTM sub-samples",
    sourceResolutionUnchanged: true
  };
  elevation.samplePairLocal = (x, z) => robustPair(nativePair, x, z, offsets);
  return elevation;
}

function robustPair(samplePair, x, z, offsets) {
  const terrain = [];
  const surface = [];
  for (const dz of offsets) {
    for (const dx of offsets) {
      const pair = samplePair(x + dx, z + dz);
      if (Number.isFinite(pair?.terrain)) terrain.push(pair.terrain);
      if (Number.isFinite(pair?.surface)) surface.push(pair.surface);
    }
  }
  return {
    terrain: terrain.length ? median(terrain) : null,
    surface: surface.length ? median(surface) : null
  };
}

function sampleOffsets(spacingM) {
  const count = Math.max(2, Math.min(8, Math.round(1 / spacingM)));
  const step = 1 / count;
  return Array.from({ length: count }, (_, index) => -0.5 + step * (index + 0.5));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function clampSpacing(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_RECONSTRUCTION_SAMPLE_SPACING_M;
  return Math.max(0.125, Math.min(0.5, number));
}
