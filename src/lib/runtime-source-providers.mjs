import { BUILTIN_SOURCE_PROVIDERS } from "./source-registry.mjs";
import { PLANNING_DATA_ENGLAND_PROVIDER } from "./planning-acquisition.mjs";

export const RUNTIME_SOURCE_PROVIDERS = Object.freeze([
  ...BUILTIN_SOURCE_PROVIDERS,
  PLANNING_DATA_ENGLAND_PROVIDER
]);
