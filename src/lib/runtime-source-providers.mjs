import { BUILTIN_SOURCE_PROVIDERS } from "./source-registry.mjs";
import { PLANNING_DATA_ENGLAND_PROVIDER } from "./planning-acquisition.mjs";

export const GLOBAL_TERRAIN_TILES_PROVIDER = Object.freeze({
  id: "aws-terrain-tiles",
  name: "AWS Open Data / Mapzen Terrain Tiles",
  kinds: Object.freeze(["terrain"]),
  coverage: Object.freeze({ south: -85.05112878, west: -180, north: 85.05112878, east: 180 }),
  authority: 0.78,
  freshness: 0.56,
  directness: 0.94,
  completeness: Object.freeze({ terrain: 0.99 }),
  resolutionM: 5,
  acquisition: Object.freeze({ adapter: "aws-terrain-tiles", mode: "web-mercator-geotiff", implemented: true }),
  license: "mixed-open-source-attribution"
});

export const OS_OPENMAP_LOCAL_WATER_PROVIDER = Object.freeze({
  id: "os-openmap-local-water",
  name: "Ordnance Survey OS OpenMap - Local / Surface Water",
  kinds: Object.freeze(["hydrology"]),
  coverage: Object.freeze({ south: 49.8, west: -8.8, north: 60.9, east: 2.1 }),
  authority: 0.9,
  freshness: 0.9,
  directness: 0.94,
  completeness: Object.freeze({ hydrology: 0.9 }),
  acquisition: Object.freeze({ adapter: "os-openmap-local-water", mode: "100km-grid-tile", implemented: true }),
  license: "OGL-3.0"
});

export const RUNTIME_SOURCE_PROVIDERS = Object.freeze([
  ...BUILTIN_SOURCE_PROVIDERS,
  GLOBAL_TERRAIN_TILES_PROVIDER,
  OS_OPENMAP_LOCAL_WATER_PROVIDER,
  PLANNING_DATA_ENGLAND_PROVIDER
]);
