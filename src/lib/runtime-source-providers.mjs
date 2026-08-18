import { BUILTIN_SOURCE_PROVIDERS } from "./source-registry.mjs";
import { PLANNING_DATA_ENGLAND_PROVIDER } from "./planning-acquisition.mjs";

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
  OS_OPENMAP_LOCAL_WATER_PROVIDER,
  PLANNING_DATA_ENGLAND_PROVIDER
]);