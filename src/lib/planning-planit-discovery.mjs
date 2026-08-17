import path from "node:path";
import { cachedJson } from "./io.mjs";

const DEFAULT_PLANIT_ENDPOINT = "https://www.planit.org.uk/api/applics/json";
const DEFAULT_PAGE_SIZE = 300;
const MAX_RESULTS = 2_500;
const MIN_REQUEST_INTERVAL_MS = 60_000;

/**
 * Uses UK PlanIt only as a navigation/discovery index when first-party planning
 * application discovery is incomplete or unavailable.
 *
 * IMPORTANT AUTHORITY RULE:
 * PlanIt-derived application records deliberately omit decision/status/date
 * evidence. The index may tell us which official application page to inspect,
 * but it can never establish planning approval/current/as-built authority.
 * Downstream authority must come from the official documents plus the existing
 * current-world implementation corroboration gates.
 */
export async function discoverPlanningApplicationsFromPlanIt(options = {}) {
  const bbox = normalizeBbox(options.bbox);
  const maxResults = Math.max(0, Math.min(MAX_RESULTS, Number(options.maxResults ?? MAX_RESULTS)));
  if (!bbox || maxResults <= 0) return emptyResult("not-requested");

  const pageSize = Math.max(1, Math.min(DEFAULT_PAGE_SIZE, maxResults));
  const cacheDir = path.join(options.cacheDir || ".tpmap-cache", "planning-planit-discovery");
  const endpoint = options.planItUrl || DEFAULT_PLANIT_ENDPOINT;
  const records = [];
  const pages = [];
  let page = 1;
  let reportedTotal = null;
  let lastNetworkRequestAt = 0;

  while (records.length < maxResults) {
    const url = buildPlanItSearchUrl(endpoint, {
      bbox,
      page,
      pageSize: Math.min(pageSize, maxResults - records.length)
    });
    const cacheKey = url.toString();
    let networkRequested = false;
    const { data, cacheHit } = await cachedJson({
      cacheDir,
      key: cacheKey,
      noCache: options.noCache,
      fetcher: async () => {
        networkRequested = true;
        const elapsed = Date.now() - lastNetworkRequestAt;
        if (lastNetworkRequestAt && elapsed < MIN_REQUEST_INTERVAL_MS) {
          await delay(MIN_REQUEST_INTERVAL_MS - elapsed);
        }
        const result = await fetchPlanItJson(url, options);
        lastNetworkRequestAt = Date.now();
        return result;
      }
    });

    const pageRecords = Array.isArray(data?.records) ? data.records : [];
    if (Number.isFinite(Number(data?.total))) reportedTotal = Number(data.total);
    pages.push({
      page,
      cacheHit,
      networkRequested,
      records: pageRecords.length,
      from: finiteOrNull(data?.from),
      to: finiteOrNull(data?.to),
      total: finiteOrNull(data?.total)
    });
    records.push(...pageRecords);

    if (!pageRecords.length) break;
    if (reportedTotal != null && records.length >= reportedTotal) break;
    if (pageRecords.length < pageSize) break;
    page += 1;
  }

  const applications = dedupeApplications(
    records.slice(0, maxResults).map(normalizePlanItRecord).filter(Boolean)
  );
  return {
    provider: "UK PlanIt discovery index",
    providerId: "planit-discovery-index",
    status: "acquired",
    discoveryOnly: true,
    authoritativePlanningMetadata: false,
    bbox,
    applicationCount: applications.length,
    applications,
    pages,
    pagesFetched: pages.length,
    reportedTotal,
    truncated: reportedTotal != null ? applications.length < reportedTotal : records.length >= maxResults,
    maxResults
  };
}

export function buildPlanItSearchUrl(endpoint, { bbox, page = 1, pageSize = DEFAULT_PAGE_SIZE }) {
  const normalized = normalizeBbox(bbox);
  if (!normalized) throw new Error("PlanIt discovery requires a finite bbox");
  const url = new URL(endpoint || DEFAULT_PLANIT_ENDPOINT);
  url.searchParams.set("bbox", `${normalized.west},${normalized.south},${normalized.east},${normalized.north}`);
  url.searchParams.set("pg_sz", String(Math.max(1, Math.min(DEFAULT_PAGE_SIZE, Number(pageSize) || DEFAULT_PAGE_SIZE))));
  url.searchParams.set("page", String(Math.max(1, Math.floor(Number(page) || 1))));
  url.searchParams.set("compress", "on");
  return url;
}

export function normalizePlanItRecord(record) {
  if (!record || typeof record !== "object") return null;
  const reference = firstText(record.reference, record.uid, record.name, record.altid);
  const officialUrl = firstPublicHttpUrl(
    record.url,
    record.other_fields?.docs_url,
    record.other_fields?.source_url
  );
  const planItUrl = firstPublicHttpUrl(record.link);
  if (!reference && !officialUrl && !planItUrl) return null;
  const location = normalizeLocation(record);
  const area = firstText(record.area_name, record.scraper_name);

  return {
    reference,
    name: firstText(record.address, record.description, reference),
    description: firstText(record.description),
    address: firstText(record.address),
    dataset: "planning-application-discovery-index",
    source: "planit-discovery-index",
    discoveryOnly: true,
    discoveryProvider: "UK PlanIt",
    discoveryArea: area,
    discoveryLocation: location,
    "documentation-url": officialUrl || planItUrl,
    documentationUrl: officialUrl || planItUrl,
    officialDocumentationUrl: officialUrl,
    discoveryIndexUrl: planItUrl
  };
}

async function fetchPlanItJson(url, options) {
  const implementation = options.fetchPlanItImpl || globalThis.fetch;
  if (typeof implementation !== "function") throw new Error("No fetch implementation is available for PlanIt discovery");
  const userAgent = options.userAgent || "VoxelMapper/0.12 (public planning discovery; https://github.com/CyanGdEv/Voxel-Mapper)";
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      const response = await implementation(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": userAgent, Accept: "application/json" }
      });
      if (!response?.ok) {
        const retryAfter = Number(response?.headers?.get?.("retry-after"));
        const error = new Error(`HTTP ${response?.status ?? "?"} fetching PlanIt planning discovery`);
        if (response?.status === 429 && attempt < 2) {
          await delay(Number.isFinite(retryAfter) ? retryAfter * 1000 : MIN_REQUEST_INTERVAL_MS);
          lastError = error;
          continue;
        }
        if (Number(response?.status) >= 500 && attempt < 2) {
          await delay(1_000 * (attempt + 1));
          lastError = error;
          continue;
        }
        throw error;
      }
      if (typeof response.json === "function") return await response.json();
      const text = await response.text();
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      if (attempt < 2 && !/^HTTP 4\d\d/.test(error?.message || "")) {
        await delay(1_000 * (attempt + 1));
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("PlanIt planning discovery failed");
}

function normalizeBbox(value) {
  const bbox = typeof value === "string"
    ? (() => {
        const [south, west, north, east] = value.split(",").map(Number);
        return { south, west, north, east };
      })()
    : value;
  if (!bbox) return null;
  const result = {
    south: Number(bbox.south), west: Number(bbox.west),
    north: Number(bbox.north), east: Number(bbox.east)
  };
  if (!Object.values(result).every(Number.isFinite)) return null;
  if (result.south >= result.north || result.west >= result.east) return null;
  return result;
}

function normalizeLocation(record) {
  const coords = record.location?.type === "Point" ? record.location.coordinates : null;
  const longitude = Number(coords?.[0] ?? record.location_x ?? record.other_fields?.lng ?? record.other_fields?.longitude);
  const latitude = Number(coords?.[1] ?? record.location_y ?? record.other_fields?.lat ?? record.other_fields?.latitude);
  return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
}

function firstPublicHttpUrl(...values) {
  for (const value of values) {
    if (!value) continue;
    try {
      const url = new URL(String(value));
      if (url.protocol === "https:" || url.protocol === "http:") return url.toString();
    } catch {}
  }
  return null;
}
function firstText(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}
function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function dedupeApplications(applications) {
  const seen = new Set();
  const result = [];
  for (const application of applications) {
    const key = `${String(application.discoveryArea || "").toLowerCase()}|${String(application.reference || application.documentationUrl || "").toUpperCase()}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(application);
  }
  return result;
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))); }
function emptyResult(status) {
  return {
    provider: "UK PlanIt discovery index",
    providerId: "planit-discovery-index",
    status,
    discoveryOnly: true,
    authoritativePlanningMetadata: false,
    applicationCount: 0,
    applications: [],
    pages: [],
    pagesFetched: 0,
    reportedTotal: 0,
    truncated: false,
    maxResults: 0
  };
}
