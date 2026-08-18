import * as base from "./osm-base.mjs";
import { geometryMapCoordinates } from "./geo.mjs";

export * from "./osm-base.mjs";

/**
 * Extends the canonical normalized map with automatically acquired licensed
 * hydrology features. These retain their own provider/provenance and remain
 * below planning/verified overrides in authority.
 */
export async function normalizeMap(sources, options = {}) {
  const map = await base.normalizeMap(sources, options);
  const projector = map.projector;
  const additions = [];
  for (const raw of sources.hydrology?.features || []) {
    if (!raw?.geometry || raw.kind !== "water") continue;
    additions.push({
      id: raw.id,
      name: raw.name || null,
      kind: "water",
      subtype: raw.subtype || "public-water",
      tags: { ...(raw.tags || {}) },
      geometry: raw.geometry,
      localGeometry: geometryMapCoordinates(raw.geometry, projector.forward),
      vertical: {
        heightM: null,
        heightSource: null,
        minHeightM: 0,
        elevationM: Number.isFinite(Number(raw.vertical?.elevationM)) ? Number(raw.vertical.elevationM) : null,
        explicit: Number.isFinite(Number(raw.vertical?.elevationM))
      },
      source: { ...(raw.source || {}) },
      verification: { plan: "licensed-public-observation", vertical: "unknown", ...(raw.verification || {}) },
      authority: { layer: "licensed-public-water", rank: 300, geometryLocked: false, ...(raw.authority || {}) }
    });
  }
  if (!additions.length) return map;
  map.features.push(...additions);
  map.geojson.features.push(...additions.map((feature) => ({
    type: "Feature",
    id: feature.id,
    geometry: feature.geometry,
    properties: {
      name: feature.name,
      kind: feature.kind,
      subtype: feature.subtype,
      source: feature.source,
      verification: feature.verification,
      authority: feature.authority,
      ...feature.tags
    }
  })));
  map.sourceFusion ||= {};
  map.sourceFusion.automaticHydrology = {
    providerId: sources.hydrology?.providerId || null,
    status: sources.hydrology?.status || null,
    accepted: additions.length,
    bathymetryProvided: Boolean(sources.hydrology?.bathymetryProvided)
  };
  return map;
}
