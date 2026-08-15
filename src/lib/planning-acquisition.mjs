import path from "node:path";
import { cachedJson, fetchJson, sha256 } from "./io.mjs";

const DEFAULT_PLANNING_DATA_ENDPOINT = "https://www.planning.data.gov.uk/entity.json";
const DEFAULT_MAX_APPLICATIONS = 680;
const PAGE_SIZE = 100;

export const PLANNING_DATA_ENGLAND_PROVIDER = Object.freeze({
  id: "planning-data-england",
  name: "Planning Data / MHCLG (England)",
  kinds: Object.freeze(["planning"]),
  coverage: Object.freeze({ south: 49.8, west: -6.5, north: 55.9, east: 2.1 }),
  authority: 0.9,
  freshness: 0.78,
  directness: 0.96,
  completeness: Object.freeze({ planning: 0.62 }),
  jurisdictionDiscovery: true,
  acquisition: Object.freeze({ adapter: "planning-data-england", mode: "api", implemented: true }),
  license: "OGL-3.0"
});

export async function acquirePlanningForBbox(options, selectedPlanning = null) {
  const adapter = selectedPlanning?.acquisition?.adapter;
  if (adapter !== "planning-data-england") {
    return {
      provider: "none",
      status: selectedPlanning ? "adapter-not-supported" : "no-executable-provider",
      applicationCount: 0,
      jurisdictionCount: 0,
      applications: [],
      jurisdictions: []
    };
  }
  return acquireEnglandPlanningData(options);
}

export async function acquireEnglandPlanningData(options) {
  const endpoint = options.planningDataUrl || DEFAULT_PLANNING_DATA_ENDPOINT;
  const maxApplications = Math.max(0, Math.min(
    DEFAULT_MAX_APPLICATIONS,
    Number(options.maxPlanningApplications ?? options.maxPlanningApplicationsPerBuild ?? DEFAULT_MAX_APPLICATIONS)
  ));
  const wkt = bboxPolygonWkt(options.bbox);
  const applications = await fetchPagedDataset({
    ...options,
    endpoint,
    dataset: "planning-application",
    wkt,
    maxResults: maxApplications
  });
  const jurisdictions = await fetchPagedDataset({
    ...options,
    endpoint,
    dataset: "local-planning-authority",
    wkt,
    maxResults: 50
  });

  const normalizedApplications = dedupeEntities(applications.entities).slice(0, maxApplications);
  const normalizedJurisdictions = dedupeEntities(jurisdictions.entities);
  return {
    provider: "Planning Data / MHCLG (England)",
    providerId: "planning-data-england",
    status: "acquired",
    endpoint,
    dataset: "planning-application",
    applicationCount: normalizedApplications.length,
    jurisdictionCount: normalizedJurisdictions.length,
    applications: normalizedApplications,
    jurisdictions: normalizedJurisdictions,
    bboxWkt: wkt,
    pagesFetched: applications.pagesFetched,
    cacheHits: applications.cacheHits + jurisdictions.cacheHits,
    attribution: "Planning Data; © Crown copyright and database right",
    license: "Open Government Licence v3.0",
    dataHash: sha256({ applications: normalizedApplications, jurisdictions: normalizedJurisdictions })
  };
}

async function fetchPagedDataset({
  endpoint, dataset, wkt, maxResults, cacheDir, noCache, userAgent, fetchJsonImpl
}) {
  if (maxResults <= 0) return { entities: [], pagesFetched: 0, cacheHits: 0 };
  const requestJson = fetchJsonImpl || fetchJson;
  const entities = [];
  let pagesFetched = 0;
  let cacheHits = 0;

  for (let offset = 0; offset < maxResults; offset += PAGE_SIZE) {
    const limit = Math.min(PAGE_SIZE, maxResults - offset);
    const url = planningDataSearchUrl(endpoint, { dataset, wkt, limit, offset });
    const { data, cacheHit } = await cachedJson({
      cacheDir: path.join(cacheDir, "planning-data-england", dataset),
      key: url.toString(),
      noCache,
      fetcher: () => requestJson(url, {
        headers: { "User-Agent": userAgent || "VoxelMapper/0.12", Accept: "application/json" }
      }, { retries: 2 })
    });
    const page = extractEntities(data);
    entities.push(...page);
    pagesFetched += 1;
    if (cacheHit) cacheHits += 1;
    if (page.length < limit) break;
  }

  return { entities, pagesFetched, cacheHits };
}

export function planningDataSearchUrl(endpoint, { dataset, wkt, limit = 100, offset = 0 }) {
  const url = new URL(endpoint);
  url.searchParams.set("dataset", dataset);
  url.searchParams.set("geometry", wkt);
  url.searchParams.set("geometry_relation", "intersects");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  return url;
}

export function bboxPolygonWkt({ south, west, north, east }) {
  if (![south, west, north, east].every(Number.isFinite)) throw new Error("Planning acquisition requires a finite bbox");
  if (south >= north || west >= east) throw new Error("Planning Data bbox must not cross the dateline");
  return `POLYGON((${west} ${south},${east} ${south},${east} ${north},${west} ${north},${west} ${south}))`;
}

export function extractEntities(data) {
  if (Array.isArray(data?.entities)) return data.entities.map(normalizeEntity);
  if (Array.isArray(data?.results)) return data.results.map(normalizeEntity);
  if (Array.isArray(data?.features)) return data.features.map((feature) => normalizeEntity({
    ...(feature.properties || {}),
    geometry_geojson: feature.geometry || null
  }));
  if (Array.isArray(data)) return data.map(normalizeEntity);
  return [];
}

function normalizeEntity(entity) {
  return {
    ...entity,
    entity: entity.entity ?? entity.id ?? null,
    reference: entity.reference ?? entity.ref ?? null,
    dataset: entity.dataset ?? null
  };
}

function dedupeEntities(entities) {
  const seen = new Set();
  const result = [];
  for (const entity of entities) {
    const key = entity.entity != null ? `entity:${entity.entity}`
      : entity.reference ? `reference:${entity.reference}`
        : `hash:${sha256(entity)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entity);
  }
  return result;
}
