import { sha256 } from "./io.mjs";

export const PLANNING_DOCUMENT_CLASSES = Object.freeze([
  "site-plan",
  "location-plan",
  "floor-plan",
  "roof-plan",
  "elevation",
  "section",
  "ride-layout",
  "landscape",
  "materials",
  "demolition",
  "drainage",
  "survey",
  "design-access",
  "decision",
  "supporting",
  "unknown"
]);

const CLASS_PRIORITY = Object.freeze({
  "site-plan": 100,
  "location-plan": 94,
  "ride-layout": 96,
  elevation: 92,
  section: 91,
  "floor-plan": 88,
  "roof-plan": 88,
  materials: 84,
  landscape: 80,
  demolition: 78,
  survey: 75,
  drainage: 68,
  "design-access": 55,
  decision: 45,
  supporting: 35,
  unknown: 20
});

const DOCUMENT_EXTENSIONS = new Set([
  ".pdf", ".dwg", ".dxf", ".doc", ".docx", ".xls", ".xlsx", ".csv",
  ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".zip"
]);

export function buildPlanningDocumentQueue(planning, options = {}) {
  const applications = Array.isArray(planning?.applications) ? planning.applications : [];
  const maxItems = Math.max(0, Number(options.maxPlanningDocumentQueueItems ?? 25_000));
  const shardCount = Math.max(1, Math.min(256, Number(options.planningDocumentShards ?? 256)));
  const items = [];
  const seen = new Set();

  for (const application of applications) {
    const app = applicationIdentity(application);
    const directUrls = collectDirectDocumentUrls(application);
    for (const entry of directUrls) {
      addQueueItem(items, seen, {
        application: app,
        url: entry.url,
        label: entry.label,
        source: entry.source,
        action: "download",
        direct: true,
        shardCount
      });
      if (items.length >= maxItems) break;
    }
    if (items.length >= maxItems) break;

    const documentationUrl = firstUrl(application["documentation-url"] ?? application.documentationUrl);
    if (documentationUrl) {
      addQueueItem(items, seen, {
        application: app,
        url: documentationUrl,
        label: application.description || application.name || application.reference || "Planning application page",
        source: "documentation-url",
        action: "discover",
        direct: false,
        shardCount
      });
    }
    if (items.length >= maxItems) break;
  }

  items.sort(compareQueueItems);
  const classCounts = countBy(items, (item) => item.classification);
  const actionCounts = countBy(items, (item) => item.action);
  const shardCounts = countBy(items, (item) => String(item.shard));
  const applicationsQueued = new Set(items.map((item) => item.application.key)).size;

  return {
    schemaVersion: 1,
    sourceProviderId: planning?.providerId || null,
    applicationCount: applications.length,
    applicationsQueued,
    itemCount: items.length,
    shardCount,
    truncated: items.length >= maxItems && applicationsQueued < applications.length,
    classCounts,
    actionCounts,
    shardCounts,
    items
  };
}

export function classifyPlanningDocument(label = "", url = "") {
  const text = `${label} ${decodeURIComponentSafe(url)}`.toLowerCase()
    .replace(/[._+%/\\?&=#-]+/g, " ")
    .replace(/\s+/g, " ");

  const rules = [
    ["ride-layout", /\b(coaster|roller coaster|ride layout|track layout|ride plan|track plan|ride profile|track profile)\b/],
    ["roof-plan", /\b(roof plan|roof layout)\b/],
    ["floor-plan", /\b(floor plan|ground floor|first floor|second floor|floor layout)\b/],
    ["supporting", /\b(landscape and visual impact assessment|visual impact assessment|lvia|environmental impact assessment|environmental statement|heritage statement|ecology report|arboricultural impact assessment)\b/],
    ["landscape", /\b(landscape site plan|landscape plan|landscaping plan|landscape layout|planting plan|tree plan|soft landscape(?: plan| layout)?|hard landscape(?: plan| layout| materials schedule)?|arboricultural plan)\b/],
    ["site-plan", /\b(proposed site plan|site plan|block plan|general arrangement|masterplan|master plan|layout plan)\b/],
    ["location-plan", /\b(location plan|site location|red line plan)\b/],
    ["elevation", /\b(elevation|elevations|facade|façade)\b/],
    ["section", /\b(section|sections|cross section|longitudinal section)\b/],
    ["materials", /\b(material|materials|finishes|finish schedule|material schedule|colour schedule|color schedule)\b/],
    ["demolition", /\b(demolition|demolitions|removal plan|existing and proposed)\b/],
    ["drainage", /\b(drainage|flood|surface water|sewer|utilities|utility plan)\b/],
    ["survey", /\b(topographic|topographical|survey|measured survey|levels plan|level survey)\b/],
    ["design-access", /\b(design and access|design access|design statement|planning statement)\b/],
    ["decision", /\b(decision notice|delegated report|committee report|officer report|approval notice|consent notice)\b/]
  ];
  for (const [classification, pattern] of rules) if (pattern.test(text)) return classification;
  if (looksLikeDocumentUrl(url)) return "supporting";
  return "unknown";
}

export function planningDocumentPriority(classification, action = "download") {
  const base = CLASS_PRIORITY[classification] ?? CLASS_PRIORITY.unknown;
  return base + (action === "download" ? 4 : 0);
}

export function shardForApplication(applicationKey, shardCount = 256) {
  const count = Math.max(1, Math.floor(Number(shardCount) || 1));
  const hex = sha256(String(applicationKey)).slice(0, 8);
  return Number.parseInt(hex, 16) % count;
}

export function selectPlanningDocumentShard(queue, shardIndex) {
  const index = Number(shardIndex);
  if (!Number.isInteger(index) || index < 0 || index >= Number(queue?.shardCount || 0)) {
    throw new Error(`Planning document shard index must be 0..${Math.max(0, Number(queue?.shardCount || 1) - 1)}`);
  }
  return {
    ...queue,
    items: (queue.items || []).filter((item) => item.shard === index),
    selectedShard: index
  };
}

export function extractDocumentLinks(html, baseUrl) {
  const links = [];
  const seen = new Set();
  const anchorPattern = /<a\b([^>]*?)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(String(html || "")))) {
    const rawHref = htmlDecode(match[2] || match[3] || match[4] || "").trim();
    if (!rawHref || rawHref.startsWith("#") || /^javascript:/i.test(rawHref) || /^mailto:/i.test(rawHref)) continue;
    let resolved;
    try { resolved = new URL(rawHref, baseUrl); } catch { continue; }
    if (!isSafePublicHttpUrl(resolved)) continue;
    const label = stripHtml(match[6] || "");
    if (!isLikelyPlanningDocumentLink(resolved.toString(), label)) continue;
    const normalized = normalizeUrl(resolved.toString());
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    links.push({
      url: normalized,
      label,
      classification: classifyPlanningDocument(label, normalized),
      direct: looksLikeDocumentUrl(normalized) || /\b(download|document|attachment|file)\b/i.test(`${label} ${normalized}`)
    });
  }
  return links.sort((a, b) => planningDocumentPriority(b.classification) - planningDocumentPriority(a.classification));
}

export function isLikelyPlanningDocumentLink(url, label = "") {
  const text = `${url} ${label}`.toLowerCase();
  if (looksLikeDocumentUrl(url)) return true;
  return /\b(plan|drawing|elevation|section|layout|material|landscape|survey|drainage|document|attachment|download|decision|report|supporting|file)\b/.test(
    text.replace(/[._+%/\\?&=#-]+/g, " ")
  );
}

export function looksLikeDocumentUrl(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const dot = pathname.lastIndexOf(".");
    return dot >= 0 && DOCUMENT_EXTENSIONS.has(pathname.slice(dot));
  } catch {
    return false;
  }
}

export function isSafePublicHttpUrl(value) {
  let url;
  try { url = value instanceof URL ? value : new URL(value); } catch { return false; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".local") || host === "::1" || host === "0.0.0.0") return false;
  if (/^127\./.test(host) || /^10\./.test(host) || /^169\.254\./.test(host) || /^192\.168\./.test(host)) return false;
  const private172 = host.match(/^172\.(\d{1,3})\./);
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return false;
  return true;
}

function addQueueItem(items, seen, { application, url, label, source, action, direct, shardCount }) {
  if (!isSafePublicHttpUrl(url)) return;
  const normalizedUrl = normalizeUrl(url);
  const key = `${application.key}\n${normalizedUrl}\n${action}`;
  if (seen.has(key)) return;
  seen.add(key);
  const classification = classifyPlanningDocument(label, normalizedUrl);
  items.push({
    id: sha256(key).slice(0, 24),
    application,
    url: normalizedUrl,
    label: String(label || "").trim() || null,
    source,
    action,
    direct,
    classification,
    priority: planningDocumentPriority(classification, action),
    shard: shardForApplication(application.key, shardCount),
    status: "pending"
  });
}

function applicationIdentity(application) {
  const entity = application.entity ?? application.id ?? null;
  const reference = application.reference ?? null;
  const key = entity != null ? `entity:${entity}` : reference ? `reference:${reference}` : `hash:${sha256(application).slice(0, 20)}`;
  return {
    key,
    entity,
    reference,
    description: application.description ?? application.name ?? null,
    organisationEntity: application["organisation-entity"] ?? application.organisationEntity ?? null,
    documentationUrl: firstUrl(application["documentation-url"] ?? application.documentationUrl)
  };
}

function collectDirectDocumentUrls(application) {
  const fields = [
    ["document-url", application["document-url"]],
    ["document-urls", application["document-urls"]],
    ["documents", application.documents],
    ["attachment-url", application["attachment-url"]],
    ["attachment-urls", application["attachment-urls"]]
  ];
  const result = [];
  for (const [source, value] of fields) {
    for (const entry of splitUrls(value)) {
      if (typeof entry === "string") result.push({ url: entry, label: source, source });
      else if (entry?.url) result.push({ url: entry.url, label: entry.name || entry.title || entry.label || source, source });
    }
  }
  return result;
}

function splitUrls(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(splitUrls);
  if (typeof value === "object") {
    if (value.url) return [value];
    return Object.values(value).flatMap(splitUrls);
  }
  return String(value).split(/[;\n]+/).map((entry) => entry.trim()).filter((entry) => /^https?:\/\//i.test(entry));
}

function firstUrl(value) {
  const values = splitUrls(value);
  const first = values[0];
  return typeof first === "string" ? first : first?.url || null;
}

function normalizeUrl(value) {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

function compareQueueItems(a, b) {
  if (b.priority !== a.priority) return b.priority - a.priority;
  if (a.shard !== b.shard) return a.shard - b.shard;
  const app = a.application.key.localeCompare(b.application.key);
  return app || a.url.localeCompare(b.url);
}

function countBy(items, keyFn) {
  const result = {};
  for (const item of items) {
    const key = keyFn(item);
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

function stripHtml(value) {
  return htmlDecode(String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}
function htmlDecode(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}
function decodeURIComponentSafe(value) {
  try { return decodeURIComponent(String(value)); } catch { return String(value); }
}
