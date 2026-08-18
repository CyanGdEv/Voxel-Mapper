import * as base from "./official-source-authority-base.mjs";

export * from "./official-source-authority-base.mjs";

/**
 * Preserves a removed OSM duplicate as lower-authority evidence on the official
 * replacement. That allows the per-attribute evidence graph to reuse useful OSM
 * metadata (for example width/material/name context) without allowing OSM to
 * regain geometry authority.
 */
export function applyOfficialSourceAuthority(map, options = {}) {
  const osmSnapshots = new Map();
  for (const feature of map?.features || []) {
    if (feature?.source?.provider !== "OpenStreetMap") continue;
    osmSnapshots.set(feature.id, snapshot(feature));
  }

  const summary = base.applyOfficialSourceAuthority(map, options);
  let preserved = 0;
  for (const feature of map?.features || []) {
    const ids = feature?.source?.supersedes || [];
    for (const id of ids) {
      const fallback = osmSnapshots.get(id);
      if (!fallback) continue;
      feature.evidenceHistory ||= [];
      if (feature.evidenceHistory.some((entry) => entry.featureId === id)) continue;
      feature.evidenceHistory.push(fallback);
      feature.source.fallbackEvidenceIds ||= [];
      feature.source.fallbackEvidenceIds.push(id);
      preserved += 1;
    }
  }
  summary.preservedOsmFallbackEvidence = preserved;
  summary.policy ||= {};
  summary.policy.removedOsmMetadata = "preserved as lower-authority per-attribute fallback evidence";
  return summary;
}

function snapshot(feature) {
  return {
    reason: "superseded-by-official-geometry",
    featureId: feature.id,
    kind: feature.kind,
    geometry: clone(feature.geometry),
    vertical: clone(feature.vertical),
    roof: clone(feature.roof),
    materialPalette: clone(feature.materialPalette),
    tags: clone(feature.tags) || {},
    source: clone(feature.source) || {},
    authority: clone(feature.authority) || {},
    verification: clone(feature.verification) || {}
  };
}

function clone(value) {
  if (value == null) return value;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
