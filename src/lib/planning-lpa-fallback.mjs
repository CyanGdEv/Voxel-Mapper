import path from "node:path";
import { cachedJson } from "./io.mjs";
import {
  buildOsmPlanningSearchIndex,
  rankPlanningApplicationsByOsm
} from "./osm-planning-reconciliation.mjs";

const MAX_PLANNING_APPLICATIONS = 2_500;

const PORTAL_ADAPTERS = Object.freeze([
  Object.freeze({
    id: "staffordshire-moorlands-publicaccess",
    jurisdiction: /staffordshire\s+moorlands/i,
    // PublicAccess is reachable over HTTPS on the current council register,
    // but the legacy HTTP transport is retained as a bounded fallback because
    // council edge/TLS behaviour has varied from hosted CI runners.
    listingUrls: Object.freeze([
      "https://publicaccess.staffsmoorlands.gov.uk/portal/servlets/MajorContentiousDevelopmentservlet",
      "http://publicaccess.staffsmoorlands.gov.uk/portal/servlets/MajorContentiousDevelopmentservlet"
    ]),
    parse: parsePublicAccessMajorApplications
  })
]);

export async function augmentPlanningFromLocalPortals(options, planning, osmData) {
  const jurisdictions = Array.isArray(planning?.jurisdictions) ? planning.jurisdictions : [];
  const osmDiscovery = buildOsmPlanningSearchIndex(osmData, options);
  const hints = osmDiscovery.searchTerms;
  const maxApplications = Math.max(0, Math.min(
    MAX_PLANNING_APPLICATIONS,
    Number(options.maxPlanningApplications ?? options.maxPlanningApplicationsPerBuild ?? MAX_PLANNING_APPLICATIONS)
  ));
  const applications = rankPlanningApplicationsByOsm(
    Array.isArray(planning?.applications) ? [...planning.applications] : [],
    osmDiscovery,
    options
  );
  const attempts = [];

  if (!jurisdictions.length || !hints.length) {
    const bounded = applications.slice(0, maxApplications);
    return {
      ...planning,
      applications: bounded,
      applicationCount: bounded.length,
      coverageStatus: planning?.coverageStatus || "partial-or-unknown",
      osmPlanningDiscovery: compactDiscovery(osmDiscovery),
      localPortalFallback: {
        attempted: false,
        successfulAdapters: 0,
        sourceFailure: false,
        hints,
        attempts,
        addedApplications: 0
      }
    };
  }

  for (const jurisdiction of jurisdictions) {
    const name = String(jurisdiction.name || jurisdiction.reference || "");
    const adapter = PORTAL_ADAPTERS.find((entry) => entry.jurisdiction.test(name));
    if (!adapter) continue;
    try {
      const discovery = await discoverPortalApplications(adapter, options, hints);
      attempts.push({
        adapterId: adapter.id,
        jurisdiction: name,
        status: "success",
        candidates: discovery.applications.length,
        cacheHit: discovery.cacheHit,
        sourceUrl: discovery.sourceUrl,
        transportAttempts: discovery.transportAttempts
      });
      applications.push(...discovery.applications.map((application) => ({
        ...application,
        "organisation-entity": jurisdiction.entity ?? jurisdiction.reference ?? null,
        organisationEntity: jurisdiction.entity ?? jurisdiction.reference ?? null
      })));
    } catch (error) {
      attempts.push({
        adapterId: adapter.id,
        jurisdiction: name,
        status: "failed",
        message: error?.message || String(error)
      });
      if (options.strictSourceAcquisition) throw error;
    }
  }

  const merged = dedupeApplications(applications);
  const addedApplications = Math.max(0, merged.length - (planning?.applications?.length || 0));
  const ranked = rankPlanningApplicationsByOsm(merged, osmDiscovery, options).slice(0, maxApplications);
  const successfulAttempts = attempts.filter((attempt) => attempt.status === "success");
  const sourceFailure = attempts.length > 0 && successfulAttempts.length === 0;
  return {
    ...planning,
    applications: ranked,
    applicationCount: ranked.length,
    coverageStatus: successfulAttempts.length
      ? "national-plus-local-portal"
      : (planning?.coverageStatus || "partial-or-unknown"),
    status: addedApplications > 0
      ? "acquired-with-local-portal-fallback"
      : sourceFailure && !ranked.length
        ? "local-portal-source-failed"
        : planning?.status,
    osmPlanningDiscovery: compactDiscovery(osmDiscovery),
    localPortalFallback: {
      attempted: attempts.length > 0,
      successfulAdapters: successfulAttempts.length,
      sourceFailure,
      hints,
      attempts,
      addedApplications
    }
  };
}

/**
 * Backwards-compatible string view used by local planning-register adapters.
 * Unlike the old implementation this includes high-signal named rides,
 * attractions and mapped park areas, not only the theme-park boundary name.
 */
export function extractOsmPlanningHints(osmData, options = {}) {
  return buildOsmPlanningSearchIndex(osmData, options).searchTerms;
}

export function parsePublicAccessMajorApplications(html, listingUrl, hints = []) {
  const normalizedHints = hints.map(normalizeText).filter((value) => value.length >= 3);
  const applications = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let row;
  while ((row = rowPattern.exec(String(html || "")))) {
    const rowHtml = row[1];
    const anchor = rowHtml.match(/<a\b[^>]*href\s*=\s*["']([^"']*ApplicationSearchServlet\?PKID=\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const reference = stripHtml(anchor[2]).trim();
    if (!reference) continue;
    const cells = [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((match) => stripHtml(match[1]).replace(/\s+/g, " ").trim());
    const rowText = cells.filter(Boolean).join(" | ") || stripHtml(rowHtml).replace(/\s+/g, " ").trim();
    const normalizedRow = normalizeText(rowText);
    // Match normalized token sequences, not arbitrary substrings. The previous
    // includes() check treated ride names such as "Rita" as a match inside
    // unrelated words such as "heritage", which could enqueue hundreds of
    // irrelevant portal attachments and dominate generation wall-clock time.
    if (normalizedHints.length && !normalizedHints.some((hint) => containsNormalizedPhrase(normalizedRow, hint))) continue;
    const documentationUrl = new URL(htmlDecode(anchor[1]), listingUrl).toString();
    const receivedDate = cells[1] || null;
    const validDate = cells[2] || null;
    const address = cells[3] || null;
    const description = cells[4] || rowText;
    const decision = cells[5] || null;
    const decisionDate = cells[6] || null;
    applications.push({
      reference,
      name: address || description || rowText,
      description,
      address,
      decision,
      status: decision,
      "received-date": receivedDate,
      receivedDate,
      "valid-date": validDate,
      validDate,
      "decision-date": decisionDate,
      decisionDate,
      dataset: "local-planning-register",
      "documentation-url": documentationUrl,
      documentationUrl,
      source: "local-planning-authority-public-register"
    });
  }
  return dedupeApplications(applications);
}

async function discoverPortalApplications(adapter, options, hints) {
  // Never turn a failed transport into a successful empty planning result.
  // Try every declared public transport and retain transport diagnostics. A
  // fetched page with zero relevant rows is valid only after all transports
  // have been attempted, so a stale/partial endpoint cannot hide a working one.
  const cacheDir = path.join(options.cacheDir || ".tpmap-cache", "planning-data-england", "lpa-fallback");
  const urls = adapter.listingUrls || [adapter.listingUrl].filter(Boolean);
  const transportAttempts = [];
  let emptySuccess = null;

  for (const listingUrl of urls) {
    try {
      const cacheKey = `${adapter.id}\n${listingUrl}`;
      const { data, cacheHit } = await cachedJson({
        cacheDir,
        key: cacheKey,
        noCache: options.noCache,
        fetcher: async () => ({ html: await fetchText(listingUrl, options) })
      });
      const applications = adapter.parse(data.html, listingUrl, hints);
      transportAttempts.push({
        url: listingUrl,
        status: "success",
        cacheHit,
        candidates: applications.length
      });
      const result = { applications, cacheHit, sourceUrl: listingUrl, transportAttempts };
      if (applications.length) return result;
      emptySuccess ||= result;
    } catch (error) {
      transportAttempts.push({
        url: listingUrl,
        status: "failed",
        message: error?.message || String(error)
      });
    }
  }

  if (emptySuccess) return { ...emptySuccess, transportAttempts };
  throw new Error(
    `All local planning portal transports failed: ${transportAttempts.map((entry) => `${entry.url}: ${entry.message || entry.status}`).join("; ")}`
  );
}

async function fetchText(url, options) {
  const implementation = options.fetchPlanningPortalImpl || globalThis.fetch;
  if (typeof implementation !== "function") {
    throw new Error("No fetch implementation is available for local planning portal discovery");
  }

  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await implementation(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": options.userAgent || "VoxelMapper/0.12",
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5"
        }
      });
      if (!response?.ok) throw new Error(`HTTP ${response?.status ?? "?"} fetching local planning portal`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("Local planning portal fetch failed");
}

function dedupeApplications(applications) {
  const seen = new Set();
  const result = [];
  for (const application of applications || []) {
    const key = application.entity != null
      ? `entity:${application.entity}`
      : application.reference
        ? `reference:${String(application.reference).toUpperCase()}`
        : `url:${application.documentationUrl || application["documentation-url"] || JSON.stringify(application)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(application);
  }
  return result;
}

function compactDiscovery(index) {
  return {
    schemaVersion: index.schemaVersion,
    anchorCount: index.anchorCount,
    searchTermCount: index.searchTermCount,
    byRole: index.byRole,
    searchTerms: index.searchTerms
  };
}

function containsNormalizedPhrase(text, phrase) {
  const haystack = String(text || "").split(" ").filter(Boolean);
  const needle = String(phrase || "").split(" ").filter(Boolean);
  if (!needle.length || needle.length > haystack.length) return false;
  outer: for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/&amp;/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

function stripHtml(value) {
  return htmlDecode(String(value || "").replace(/<[^>]+>/g, " "));
}

function htmlDecode(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}
