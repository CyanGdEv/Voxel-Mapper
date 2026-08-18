import path from "node:path";
import * as base from "./sources-base.mjs";
import { acquireOsOpenMapLocalHydrology } from "./hydrology-acquisition.mjs";

export * from "./sources-base.mjs";

/**
 * Adds independent bbox hydrology acquisition to the canonical source resolver.
 * Failure is non-fatal by default: OSM remains the explicit fallback and the
 * failed attempt is retained in provenance diagnostics.
 */
export async function acquireSources(options = {}) {
  const sources = await base.acquireSources(options);
  const selected = sources.sourcePlan?.selected?.hydrology;
  const acquirer = options.hydrologyAcquirerImpl || acquireOsOpenMapLocalHydrology;
  let hydrology;

  if (selected?.acquisition?.adapter === "os-openmap-local-water") {
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
      providerId: selected?.providerId || "openstreetmap-overpass",
      status: "osm-fallback",
      features: [],
      featureCount: 0,
      bathymetryProvided: false,
      acquisitionAttempts: []
    };
  }

  sources.hydrology = hydrology;
  sources.acquisitionAttempts ||= {};
  sources.acquisitionAttempts.hydrology = hydrology.acquisitionAttempts || [];
  sources.autoSelection ||= {};
  sources.autoSelection.hydrology = hydrology.providerId || selected?.providerId || null;
  return sources;
}
