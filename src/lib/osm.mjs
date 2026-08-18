import * as base from "./osm-base.mjs";
import { geometryMapCoordinates } from "./geo.mjs";
import { applyOfficialSourceAuthority } from "./official-source-authority.mjs";
import { normalizeParkingFeatures } from "./parking-evidence.mjs";
import { normalizeParkingDetailFeatures } from "./parking-detail-evidence.mjs";

export * from "./osm-base.mjs";

/**
 * Extends the canonical normalized map with automatically acquired licensed
 * hydrology features, promotes parking into a dedicated drivable-surface
 * evidence model, then applies the common official-source authority policy.
 * Planning/verified overrides remain above official base data; OSM is retained
 * only where no stronger compatible observation clearly represents the feature.
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
      authority: { layer: "licensed-public-water", rank: 315, geometryLocked: false, ...(raw.authority || {}) }
    });
  }

  if (additions.length) {
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
  }

  // This happens before official-source fusion so an official parking polygon
  // and an OSM amenity=parking polygon are comparable as the same drivable
  // feature kind. OSM parking can therefore be suppressed as a true fallback.
  const parking = normalizeParkingFeatures(map);
  const parkingDetails = normalizeParkingDetailFeatures(map);
  map.sourceFusion ||= {};
  map.sourceFusion.parking = parking;
  map.sourceFusion.parkingDetails = parkingDetails;

  applyOfficialSourceAuthority(map, options);
  base.refreshMapDerivedData(map);
  syncGeoJsonParkingProperties(map);
  return map;
}

function syncGeoJsonParkingProperties(map) {
  const byId = new Map((map.features || []).map((feature) => [String(feature.id), feature]));
  for (const raw of map.geojson?.features || []) {
    const feature = byId.get(String(raw.id));
    if (!feature?.parkingEvidence && !feature?.parkingDetailEvidence) continue;
    raw.properties ||= {};
    raw.properties.kind = feature.kind;
    raw.properties.subtype = feature.subtype;
    if (feature.parkingEvidence) raw.properties.parkingEvidence = feature.parkingEvidence;
    if (feature.parkingDetailEvidence) raw.properties.parkingDetailEvidence = feature.parkingDetailEvidence;
  }
}
