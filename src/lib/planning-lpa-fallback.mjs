import path from "node:path";
import { cachedJson } from "./io.mjs";

const PORTAL_ADAPTERS = Object.freeze([
  Object.freeze({
    id: "staffordshire-moorlands-publicaccess",
    jurisdiction: /staffordshire\s+moorlands/i,
    listingUrl: "https://publicaccess.staffsmoorlands.gov.uk/portal/servlets/MajorContentiousDevelopmentservlet",
    parse: parsePublicAccessMajorApplications
  })
]);

export async function augmentPlanningFromLocalPortals(options, planning, osmData) {
  const applications = Array.isArray(planning?.applications) ? [...planning.applications] : [];
  const jurisdictions = Array.isArray(planning?.jurisdictions) ? planning.jurisdictions : [];
  const hints = extractOsmPlanningHints(osmData);
  const attempts = [];

  if (!jurisdictions.length || !hints.length) {
    return {
      ...planning,
      coverageStatus: planning?.coverageStatus || "partial-or-unknown",
      localPortalFallback: { attempted: false, hints, attempts, addedApplications: 0 }
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
        cacheHit: discovery.cacheHit
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
  return {
    ...planning,
    applications: merged,
    applicationCount: merged.length,
    coverageStatus: attempts.length ? "national-plus-local-portal" : (planning?.coverageStatus || "partial-or-unknown"),
    status: addedApplications > 0 ? "acquired-with-local-portal-fallback" : planning?.status,
    localPortalFallback: {
      attempted: attempts.length > 0,
      hints,
      attempts,
      addedApplications
    }
  };
}

export function extractOsmPlanningHints(osmData) {
  const result = [];
  for (const element of osmData?.elements || []) {
    const tags = element.tags || {};
    if (tags.tourism !== "theme_park") continue;
    for (const value of [tags.name, tags["name:en"], tags["addr:postcode"]]) {
      const text = String(value || "").trim();
      if (text && !result.includes(text)) result.push(text);
    }
  }
  return result.slice(0, 8);
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
    if (normalizedHints.length && !normalizedHints.some((hint) => normalizedRow.includes(hint))) continue;
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
  const cacheDir = path.join(options.cacheDir || ".tpmap-cache", "planning-lpa-fallback");
  const cacheKey = `${adapter.id}\n${adapter.listingUrl}`;
  const { data, cacheHit } = await cachedJson({
    cacheDir,
    key: cacheKey,
    noCache: options.noCache,
    fetcher: async () => ({ html: await fetchText(adapter.listingUrl, options) })
  });
  return {
    applications: adapter.parse(data.html, adapter.listingUrl, hints),
    cacheHit
  };
}

async function fetchText(url, options) {
  const implementation = options.fetchPlanningPortalImpl || globalThis.fetch;
  if (typeof implementation !== "function") throw new Error("No fetch implementation is available for local planning portal discovery");
  const response = await implementation(url, {
    redirect: "follow",
    headers: {
      "User-Agent": options.userAgent || "VoxelMapper/0.12",
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5"
    }
  });
  if (!response?.ok) throw new Error(`HTTP ${response?.status ?? "?"} fetching local planning portal`);
  return response.text();
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
