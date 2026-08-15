const GLOBAL_BBOX = Object.freeze({ south: -90, west: -180, north: 90, east: 180 });

export const SOURCE_KINDS = Object.freeze([
  "osm", "terrain", "lidar", "planning", "trees", "imagery", "hydrology", "landcover"
]);

export const BUILTIN_SOURCE_PROVIDERS = Object.freeze([
  provider({
    id: "openstreetmap-overpass", name: "OpenStreetMap / Overpass",
    kinds: ["osm", "hydrology", "landcover", "trees"], coverage: GLOBAL_BBOX,
    authority: 0.72, freshness: 0.88, directness: 0.92,
    completeness: { osm: 0.72, hydrology: 0.58, landcover: 0.54, trees: 0.34 },
    acquisition: { adapter: "overpass", mode: "direct", implemented: true }, license: "ODbL-1.0"
  }),
  provider({
    id: "copernicus-dem-glo30", name: "Copernicus DEM GLO-30", kinds: ["terrain"], coverage: GLOBAL_BBOX,
    authority: 0.82, freshness: 0.64, directness: 0.82, completeness: { terrain: 0.99 }, resolutionM: 30,
    acquisition: { adapter: "copernicus-dem", mode: "tile", implemented: false }
  }),
  provider({
    id: "open-meteo-copernicus-glo90", name: "Open-Meteo / Copernicus DEM GLO-90", kinds: ["terrain"], coverage: GLOBAL_BBOX,
    authority: 0.7, freshness: 0.62, directness: 0.98, completeness: { terrain: 0.98 }, resolutionM: 90,
    acquisition: { adapter: "open-meteo", mode: "direct", implemented: true }
  }),
  provider({
    id: "esa-worldcover-10m", name: "ESA WorldCover", kinds: ["trees", "landcover"], coverage: GLOBAL_BBOX,
    authority: 0.8, freshness: 0.7, directness: 0.84, completeness: { trees: 0.82, landcover: 0.94 }, resolutionM: 10,
    acquisition: { adapter: "worldcover", mode: "tile", implemented: false }
  }),
  provider({
    id: "sentinel-2-l2a", name: "Copernicus Sentinel-2 L2A", kinds: ["imagery", "landcover", "trees"],
    coverage: Object.freeze({ south: -84, west: -180, north: 84, east: 180 }),
    authority: 0.7, freshness: 0.98, directness: 0.72,
    completeness: { imagery: 0.96, landcover: 0.76, trees: 0.64 }, resolutionM: 10,
    acquisition: { adapter: "sentinel-2-stac", mode: "stac", implemented: false }
  }),
  provider({
    id: "openaerialmap", name: "OpenAerialMap", kinds: ["imagery"], coverage: GLOBAL_BBOX, sparse: true,
    authority: 0.66, freshness: 0.72, directness: 0.78, completeness: { imagery: 0.38 },
    acquisition: { adapter: "openaerialmap", mode: "search", implemented: false }
  }),
  provider({
    id: "local-planning-authority", name: "Local planning / development-control authority", kinds: ["planning"],
    coverage: GLOBAL_BBOX, jurisdictionDiscovery: true, authority: 0.98, freshness: 0.9, directness: 0.94,
    completeness: { planning: 0.72 }, acquisition: { adapter: "jurisdiction-planning", mode: "discover", implemented: false }
  }),
  provider({
    id: "environment-agency-lidar-england", name: "Environment Agency LiDAR", kinds: ["terrain", "lidar"],
    coverage: Object.freeze({ south: 49.8, west: -6.5, north: 55.9, east: 2.1 }),
    authority: 0.96, freshness: 0.82, directness: 0.95, completeness: { terrain: 0.9, lidar: 0.88 }, resolutionM: 1,
    acquisition: { adapter: "ea-lidar", mode: "tile", implemented: true }
  }),
  provider({
    id: "usgs-3dep", name: "USGS 3D Elevation Program", kinds: ["terrain", "lidar"],
    coverage: Object.freeze({ south: 18, west: -179, north: 72, east: -65 }),
    authority: 0.97, freshness: 0.82, directness: 0.92, completeness: { terrain: 0.98, lidar: 0.72 }, resolutionM: 1,
    acquisition: { adapter: "usgs-3dep", mode: "tile", implemented: false }
  }),
  provider({
    id: "national-hydrography-discovery", name: "National hydrography authority discovery", kinds: ["hydrology"],
    coverage: GLOBAL_BBOX, jurisdictionDiscovery: true, authority: 0.9, freshness: 0.76, directness: 0.78,
    completeness: { hydrology: 0.78 }, acquisition: { adapter: "jurisdiction-hydrography", mode: "discover", implemented: false }
  })
]);

export function resolveSourcePlan(bbox, options = {}) {
  validateBbox(bbox);
  const requestedKinds = normalizeKinds(options.kinds || SOURCE_KINDS);
  const providers = options.providers || BUILTIN_SOURCE_PROVIDERS;
  const preferred = new Set(options.preferredProviderIds || []);
  const excluded = new Set(options.excludedProviderIds || []);
  const maxPerKind = Math.max(1, Number(options.maxPerKind || 5));
  const minScore = clamp01(options.minScore ?? 0.2);
  const candidates = [];

  for (const source of providers) {
    if (excluded.has(source.id)) continue;
    const coverageRatio = bboxCoverageRatio(bbox, source.coverage);
    if (coverageRatio <= 0) continue;
    for (const kind of source.kinds) {
      if (!requestedKinds.includes(kind)) continue;
      const score = scoreProvider(source, kind, coverageRatio, preferred.has(source.id));
      if (score < minScore) continue;
      candidates.push(candidate(source, kind, score, coverageRatio, preferred.has(source.id)));
    }
  }

  const candidatesByKind = {};
  const recommended = {};
  const selected = {};
  for (const kind of requestedKinds) {
    const ranked = candidates.filter((entry) => entry.kind === kind).sort(compareCandidates).slice(0, maxPerKind);
    candidatesByKind[kind] = ranked;
    recommended[kind] = ranked[0] || null;
    selected[kind] = ranked.find((entry) => entry.implemented) || null;
  }

  const gaps = requestedKinds.filter((kind) => !selected[kind]).map((kind) => ({
    kind,
    reason: recommended[kind] ? "adapter-not-implemented" : "no-provider-with-bbox-coverage",
    recommendedProviderId: recommended[kind]?.providerId || null
  }));

  return {
    schemaVersion: 1,
    bbox: { ...bbox },
    requestedKinds,
    recommended,
    selected,
    candidatesByKind,
    gaps,
    summary: {
      requestedKinds: requestedKinds.length,
      recommendedKinds: requestedKinds.filter((kind) => recommended[kind]).length,
      executableKinds: requestedKinds.filter((kind) => selected[kind]).length,
      gaps: gaps.length,
      candidateCount: candidates.length
    }
  };
}

export function scoreProvider(source, kind, coverageRatio = 1, preferred = false) {
  const completeness = clamp01(source.completeness?.[kind] ?? 0.5);
  const sparsePenalty = source.sparse ? 0.12 : 0;
  const discoveryPenalty = source.jurisdictionDiscovery ? 0.05 : 0;
  const preferredBoost = preferred ? 0.08 : 0;
  return roundScore(clamp01(
    coverageRatio * 0.26 +
    clamp01(source.authority ?? 0.5) * 0.21 +
    clamp01(source.freshness ?? 0.5) * 0.12 +
    clamp01(source.directness ?? 0.5) * 0.12 +
    completeness * 0.2 +
    resolutionScore(source.resolutionM, kind) * 0.09 +
    preferredBoost - sparsePenalty - discoveryPenalty
  ));
}

export function bboxCoverageRatio(target, coverage = GLOBAL_BBOX) {
  validateBbox(target);
  validateBbox(coverage);
  const south = Math.max(target.south, coverage.south);
  const north = Math.min(target.north, coverage.north);
  if (north <= south) return 0;
  const targetLon = lonIntervals(target.west, target.east);
  const coverageLon = lonIntervals(coverage.west, coverage.east);
  let lonOverlap = 0;
  for (const [a0, a1] of targetLon) for (const [b0, b1] of coverageLon) {
    lonOverlap += Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  }
  if (lonOverlap <= 0) return 0;
  const targetLonWidth = targetLon.reduce((sum, [a, b]) => sum + (b - a), 0);
  const targetArea = Math.max(1e-12, (target.north - target.south) * targetLonWidth);
  const overlapArea = (north - south) * Math.min(targetLonWidth, lonOverlap);
  return roundScore(clamp01(overlapArea / targetArea));
}

function candidate(source, kind, score, coverageRatio, preferred) {
  return {
    providerId: source.id,
    providerName: source.name,
    kind,
    score,
    coverageRatio,
    resolutionM: source.resolutionM ?? null,
    implemented: Boolean(source.acquisition?.implemented),
    acquisition: source.acquisition,
    reasons: scoreReasons(source, kind, coverageRatio, preferred)
  };
}

function scoreReasons(source, kind, coverageRatio, preferred) {
  const reasons = [
    `coverage=${coverageRatio.toFixed(3)}`,
    `authority=${clamp01(source.authority ?? 0.5).toFixed(2)}`,
    `freshness=${clamp01(source.freshness ?? 0.5).toFixed(2)}`,
    `completeness=${clamp01(source.completeness?.[kind] ?? 0.5).toFixed(2)}`
  ];
  if (Number.isFinite(source.resolutionM)) reasons.push(`resolution=${source.resolutionM}m`);
  if (source.jurisdictionDiscovery) reasons.push("requires-jurisdiction-discovery");
  if (source.sparse) reasons.push("sparse-coverage");
  if (preferred) reasons.push("preferred-provider");
  if (!source.acquisition?.implemented) reasons.push("adapter-pending");
  return reasons;
}

function compareCandidates(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const ar = Number.isFinite(a.resolutionM) ? a.resolutionM : Infinity;
  const br = Number.isFinite(b.resolutionM) ? b.resolutionM : Infinity;
  if (ar !== br) return ar - br;
  return a.providerId.localeCompare(b.providerId);
}

function resolutionScore(resolutionM, kind) {
  if (!Number.isFinite(resolutionM) || resolutionM <= 0) return 0.45;
  const target = kind === "lidar" ? 1 : kind === "imagery" ? 0.5 : kind === "terrain" ? 2 : 5;
  return clamp01(target / Math.max(target, resolutionM));
}
function normalizeKinds(kinds) {
  const result = [];
  for (const raw of kinds) {
    const kind = String(raw).trim().toLowerCase();
    if (!SOURCE_KINDS.includes(kind)) throw new Error(`Unsupported source kind: ${raw}`);
    if (!result.includes(kind)) result.push(kind);
  }
  return result;
}
function validateBbox(bbox) {
  if (!bbox || ![bbox.south, bbox.west, bbox.north, bbox.east].every(Number.isFinite)) throw new Error("A finite south/west/north/east bbox is required");
  if (bbox.south < -90 || bbox.north > 90 || bbox.south >= bbox.north) throw new Error("Invalid bbox latitude range");
  if (bbox.west < -180 || bbox.west > 180 || bbox.east < -180 || bbox.east > 180) throw new Error("Invalid bbox longitude range");
}
function lonIntervals(west, east) { return west <= east ? [[west, east]] : [[west, 180], [-180, east]]; }
function provider(value) { return Object.freeze({ ...value, kinds: Object.freeze([...value.kinds]) }); }
function clamp01(value) { return Math.max(0, Math.min(1, Number(value))); }
function roundScore(value) { return Math.round(value * 10000) / 10000; }
