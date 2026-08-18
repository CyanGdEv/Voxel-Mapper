import path from "node:path";
import * as base from "./sources-base.mjs";
import { acquireOsOpenMapLocalHydrology } from "./hydrology-acquisition.mjs";
import { acquireGlobalTerrainElevation } from "./global-terrain.mjs";
import { AUTHORITATIVE_SOURCE_CATALOG } from "./official-source-authority.mjs";

export * from "./sources-base.mjs";

/**
 * Extends the canonical resolver with independent global-terrain and hydrology
 * acquisition. National/high-resolution terrain remains authoritative; the
 * global DEM is used only when the source planner selects it or the existing
 * terrain result is weaker. Explicit elevation input is never replaced.
 */
export async function acquireSources(options = {}) {
  const sources = await base.acquireSources(options);
  await upgradeGlobalTerrain(sources, options);

  const selected = sources.sourcePlan?.selected?.hydrology;
  const acquirer = options.hydrologyAcquirerImpl || acquireOsOpenMapLocalHydrology;
  const automaticAllowed = !options.osm || options.autoHydrologyWithLocalOsm === true;
  let hydrology;

  if (automaticAllowed && selected?.acquisition?.adapter === "os-openmap-local-water") {
    try {
      hydrology = await acquirer({
        ...options,
        bbox: sources.bbox,
        cacheDir: path.resolve(options.cache || ".tpmap-cache")
      }, selected);
      hydrology.providerId ||= selected.providerId;
      hydrology.acquisitionAttempts ||= [{ providerId: selected.providerId, status: "success" }];
    } catch (error) {
      if (options.strictSourceAcquisition) throw error;
      hydrology = {
        provider: selected.providerName,
        providerId: selected.providerId,
        status: "failed",
        features: [],
        featureCount: 0,
        bathymetryProvided: false,
        warning: `Independent hydrology acquisition failed; retaining OSM as fallback: ${error?.message || String(error)}`,
        acquisitionAttempts: [{ providerId: selected.providerId, status: "failed", message: error?.message || String(error) }]
      };
    }
  } else {
    hydrology = {
      provider: sources.osm?.source === "local" ? "local OSM fallback" : "OpenStreetMap fallback",
      providerId: "openstreetmap-overpass",
      status: sources.osm?.source === "local" ? "local-osm-fallback" : "osm-fallback",
      features: [],
      featureCount: 0,
      bathymetryProvided: false,
      acquisitionAttempts: automaticAllowed ? [] : [{
        providerId: selected?.providerId || null,
        status: "skipped-offline-local-osm",
        message: "Explicit --osm input keeps source acquisition offline unless autoHydrologyWithLocalOsm is enabled."
      }]
    };
  }

  sources.hydrology = hydrology;
  sources.acquisitionAttempts ||= {};
  sources.acquisitionAttempts.hydrology = hydrology.acquisitionAttempts || [];
  sources.autoSelection ||= {};
  sources.autoSelection.hydrology = hydrology.providerId || null;
  sources.authoritativeSourceCatalog = AUTHORITATIVE_SOURCE_CATALOG.map((entry) => ({ ...entry }));
  return sources;
}

async function upgradeGlobalTerrain(sources, options) {
  if (options.elevation != null) return;
  if (options.osm && options.autoGlobalTerrainWithLocalOsm !== true) return;

  const selected = sources.sourcePlan?.selected?.terrain;
  if (selected?.acquisition?.adapter !== "aws-terrain-tiles") return;

  const current = sources.elevation;
  if (isHigherResolutionMeasuredTerrain(current, selected)) return;

  const acquirer = options.globalTerrainAcquirerImpl || acquireGlobalTerrainElevation;
  try {
    const terrain = await acquirer({
      ...options,
      bbox: sources.bbox,
      cacheDir: path.resolve(options.cache || ".tpmap-cache")
    }, selected);
    sources.elevation = terrain;
    sources.acquisitionAttempts ||= {};
    const existing = sources.acquisitionAttempts.terrain || [];
    sources.acquisitionAttempts.terrain = [
      ...existing.filter((entry) => entry.providerId !== selected.providerId),
      { providerId: selected.providerId, adapter: "aws-terrain-tiles", status: "success" }
    ];
    sources.autoSelection ||= {};
    sources.autoSelection.terrain = selected.providerId;
  } catch (error) {
    if (options.strictSourceAcquisition) throw error;
    sources.acquisitionAttempts ||= {};
    sources.acquisitionAttempts.terrain ||= [];
    sources.acquisitionAttempts.terrain.push({
      providerId: selected.providerId,
      adapter: "aws-terrain-tiles",
      status: "failed",
      message: error?.message || String(error)
    });
    // Keep the base resolver's lower-authority result (for example Open-Meteo)
    // rather than ever turning a recoverable global-source failure into flat terrain.
  }
}

function isHigherResolutionMeasuredTerrain(current, candidate) {
  if (!current) return false;
  if (["ea-lidar", "geotiff"].includes(current.sourceKind)) return true;
  const currentResolution = Number(current.resolutionM);
  const candidateResolution = Number(candidate?.resolutionM);
  return Number.isFinite(currentResolution) && Number.isFinite(candidateResolution) && currentResolution <= candidateResolution;
}
