import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import {
  ensureDir, exists, readJson, sha256, writeBinary, writeJson
} from "./io.mjs";
import {
  classifyPlanningDocument,
  extractDocumentLinks,
  isSafePublicHttpUrl,
  planningDocumentPriority,
  selectPlanningDocumentShard
} from "./planning-documents.mjs";
import { extractPortalPlanningDocumentLinks } from "./planning-portal-documents.mjs";
import { fetchViaPublicDns } from "./public-dns-http.mjs";
import { fetchArchivedPublicUrl, originalUrlFromWaybackReplay } from "./public-web-archive.mjs";

const DEFAULT_CONCURRENCY = 6;
const DEFAULT_MAX_DOCUMENT_MB = 120;
const DEFAULT_MAX_DISCOVERY_HTML_MB = 8;
const DEFAULT_CACHE_MAX_AGE_HOURS = 168;
const DEFAULT_DISCOVERY_CACHE_MAX_AGE_HOURS = 24;
const DEFAULT_MAX_DISCOVERED_LINKS_PER_APPLICATION = 120;
const DISCOVERY_PARSER_VERSION = 3;

export async function processPlanningDocumentShard(queue, options = {}) {
  const selected = options.shardIndex == null ? queue : selectPlanningDocumentShard(queue, Number(options.shardIndex));
  const cacheDir = path.resolve(options.cacheDir || ".tpmap-cache");
  const concurrency = clampInt(options.concurrency ?? DEFAULT_CONCURRENCY, 1, 16);
  const items = [...(selected.items || [])].sort((a, b) => (b.priority || 0) - (a.priority || 0));
  const downloadMemo = new Map();

  const results = await mapLimit(items, concurrency, async (item) => {
    try {
      if (item.action === "download") {
        const document = await memoizedDownload(item, item.url, item.label, options, cacheDir, downloadMemo);
        return { itemId: item.id, application: item.application, action: item.action, status: document.status, documents: [document], discovered: [] };
      }
      if (item.action === "discover") {
        const discovery = await discoverPlanningPage(item, { ...options, cacheDir });
        const candidates = discovery.links.slice(0, clampInt(
          options.maxDiscoveredLinksPerApplication ?? DEFAULT_MAX_DISCOVERED_LINKS_PER_APPLICATION, 1, 500
        ));
        let documents = [];
        if (options.downloadDiscovered !== false) {
          const direct = candidates.filter((entry) => entry.direct);
          documents = await mapLimit(direct, concurrency, async (link) => {
            try {
              return await memoizedDownload(item, link.url, link.label, options, cacheDir, downloadMemo, link.classification);
            } catch (error) {
              if (options.strictPlanningDocuments) throw error;
              return {
                status: "failed",
                url: link.url,
                classification: link.classification,
                error: error?.message || String(error)
              };
            }
          });
        }
        return {
          itemId: item.id,
          application: item.application,
          action: item.action,
          status: "discovered",
          discovery: withoutHtml(discovery),
          documents,
          discovered: candidates.map((link) => ({
            ...link,
            application: item.application,
            source: link.source || "portal-discovery",
            action: link.direct ? "download" : "discover",
            priority: planningDocumentPriority(link.classification, link.direct ? "download" : "discover"),
            shard: item.shard
          }))
        };
      }
      return { itemId: item.id, application: item.application, action: item.action, status: "skipped", documents: [], discovered: [] };
    } catch (error) {
      if (options.strictPlanningDocuments) throw error;
      return {
        itemId: item.id,
        application: item.application,
        action: item.action,
        status: "failed",
        error: error?.message || String(error),
        documents: [],
        discovered: []
      };
    }
  });

  const documents = results.flatMap((result) => result.documents || []);
  const discovered = dedupeDiscovered(results.flatMap((result) => result.discovered || []));
  const downloaded = documents.filter((entry) => entry.status === "downloaded" || entry.status === "cached");
  const failures = [
    ...results.filter((result) => result.status === "failed").map((result) => ({ itemId: result.itemId, error: result.error })),
    ...documents.filter((entry) => entry.status === "failed").map((entry) => ({ url: entry.url, error: entry.error }))
  ];
  const contentHashes = [...new Set(downloaded.map((entry) => entry.contentHash).filter(Boolean))];

  return {
    schemaVersion: 1,
    selectedShard: selected.selectedShard ?? null,
    shardCount: selected.shardCount,
    inputItems: items.length,
    processedItems: results.length,
    downloadedDocuments: downloaded.length,
    uniqueContentObjects: contentHashes.length,
    discoveredLinks: discovered.length,
    pendingPortalLinks: discovered.filter((entry) => !entry.direct).length,
    failures,
    contentHashes,
    results,
    discovered
  };
}

export async function discoverPlanningPage(item, options = {}) {
  if (!isSafePublicHttpUrl(item.url)) throw new Error(`Unsafe planning documentation URL: ${item.url}`);
  const cacheDir = path.join(options.cacheDir || ".tpmap-cache", "planning-documents", "discovery");
  await ensureDir(cacheDir);
  // Parser upgrades must not reuse discovery results produced by an older
  // HTML/portal adapter. The underlying page can still be cached for the normal
  // TTL once it has been parsed by this schema version.
  const cacheFile = path.join(cacheDir, `${sha256(`${DISCOVERY_PARSER_VERSION}\n${item.url}`)}.json`);
  const maxAgeHours = Number(options.discoveryCacheMaxAgeHours ?? DEFAULT_DISCOVERY_CACHE_MAX_AGE_HOURS);
  if (!options.refreshPlanningDocuments && await isFreshCache(cacheFile, maxAgeHours)) {
    return { ...(await readJson(cacheFile)), cacheHit: true };
  }

  const fetched = await fetchResponse(item.url, {
    headers: {
      "User-Agent": options.userAgent || "VoxelMapper/0.12",
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5"
    }
  }, options);
  const { response, retrieval } = fetched;
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  const contentLength = Number(response.headers?.get?.("content-length") || 0);
  const maxBytes = Number(options.maxDiscoveryHtmlMb ?? DEFAULT_MAX_DISCOVERY_HTML_MB) * 1024 * 1024;
  if (contentLength && contentLength > maxBytes) throw new Error(`Planning application page exceeds ${options.maxDiscoveryHtmlMb ?? DEFAULT_MAX_DISCOVERY_HTML_MB} MiB`);
  const html = await response.text();
  if (Buffer.byteLength(html) > maxBytes) throw new Error(`Planning application page exceeds ${options.maxDiscoveryHtmlMb ?? DEFAULT_MAX_DISCOVERY_HTML_MB} MiB`);

  // Archive replay is a transport source, not the authority URL. Parse raw
  // archived HTML against the captured first-party URL so relative document
  // links remain council URLs and downstream authority provenance is unchanged.
  const finalUrl = retrieval.mode === "web-archive"
    ? (retrieval.capturedOriginalUrl || item.url)
    : (response.url || item.url);
  const links = mergeDiscoveredLinks(
    restoreArchivedOriginalLinks(extractDocumentLinks(html, finalUrl), retrieval),
    restoreArchivedOriginalLinks(extractPortalPlanningDocumentLinks(html, finalUrl).map((link) => ({
      ...link,
      classification: classifyPlanningDocument(link.label || "", link.url),
      direct: true
    })), retrieval)
  );
  const result = {
    parserVersion: DISCOVERY_PARSER_VERSION,
    url: item.url,
    finalUrl,
    retrievalMode: retrieval.mode,
    retrievalUrl: retrieval.replayUrl || response.url || finalUrl,
    archiveCaptureAt: retrieval.captureAt || null,
    archiveCaptureTimestamp: retrieval.captureTimestamp || null,
    archiveDigest: retrieval.digest || null,
    contentType,
    fetchedAt: new Date().toISOString(),
    htmlHash: sha256(html),
    linkCount: links.length,
    links,
    cacheHit: false
  };
  await writeJson(cacheFile, result);
  return result;
}

export async function downloadImmutablePlanningDocument(item, url, label, options = {}, cacheDir = ".tpmap-cache", forcedClassification = null) {
  if (!isSafePublicHttpUrl(url)) throw new Error(`Unsafe planning document URL: ${url}`);
  const root = path.join(path.resolve(cacheDir), "planning-documents");
  const indexDir = path.join(root, "url-index");
  const objectDir = path.join(root, "objects");
  await Promise.all([ensureDir(indexDir), ensureDir(objectDir)]);
  const indexFile = path.join(indexDir, `${sha256(url)}.json`);
  const maxAgeHours = Number(options.planningDocumentCacheMaxAgeHours ?? DEFAULT_CACHE_MAX_AGE_HOURS);

  let previous = null;
  if (await exists(indexFile)) {
    try { previous = await readJson(indexFile); } catch { previous = null; }
  }
  if (!options.refreshPlanningDocuments && previous && await isFreshCache(indexFile, maxAgeHours)) {
    const previousObject = previous.objectPath ? path.resolve(root, previous.objectPath) : null;
    if (previousObject && await exists(previousObject)) return { ...previous, status: "cached", cacheHit: true };
  }

  const fetched = await fetchResponse(url, {
    headers: {
      "User-Agent": options.userAgent || "VoxelMapper/0.12",
      Accept: "application/pdf,image/*,application/octet-stream,*/*;q=0.5"
    }
  }, options);
  const { response, retrieval } = fetched;
  const contentType = String(response.headers?.get?.("content-type") || "application/octet-stream").split(";")[0].trim().toLowerCase();
  const contentLength = Number(response.headers?.get?.("content-length") || 0);
  const maxBytes = Number(options.maxPlanningDocumentMb ?? DEFAULT_MAX_DOCUMENT_MB) * 1024 * 1024;
  if (contentLength && contentLength > maxBytes) throw new Error(`Planning document exceeds ${options.maxPlanningDocumentMb ?? DEFAULT_MAX_DOCUMENT_MB} MiB: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error(`Planning document exceeds ${options.maxPlanningDocumentMb ?? DEFAULT_MAX_DOCUMENT_MB} MiB: ${url}`);
  if (!bytes.length) throw new Error(`Planning document is empty: ${url}`);

  // For archived content the first-party URL remains canonical. The replay URL
  // is recorded separately and never enters geometry classification/authority.
  const finalUrl = retrieval.mode === "web-archive"
    ? (retrieval.capturedOriginalUrl || url)
    : (response.url || url);
  const contentHash = sha256(bytes);
  const extension = extensionForDocument(finalUrl, contentType);
  const objectFilename = `${contentHash}${extension}`;
  const objectPath = path.join(objectDir, objectFilename);
  if (!await exists(objectPath)) await writeBinary(objectPath, bytes);

  const contentDisposition = String(response.headers?.get?.("content-disposition") || "");
  const dispositionName = filenameFromDisposition(contentDisposition);
  const classification = forcedClassification || classifyPlanningDocument(dispositionName || label || "", finalUrl);
  const record = {
    schemaVersion: 1,
    status: "downloaded",
    cacheHit: false,
    application: item.application,
    sourceItemId: item.id,
    url,
    finalUrl,
    retrievalMode: retrieval.mode,
    retrievalUrl: retrieval.replayUrl || response.url || finalUrl,
    archiveCaptureAt: retrieval.captureAt || null,
    archiveCaptureTimestamp: retrieval.captureTimestamp || null,
    archiveDigest: retrieval.digest || null,
    label: label || null,
    filename: dispositionName || path.basename(new URL(finalUrl).pathname) || null,
    classification,
    contentType,
    byteLength: bytes.length,
    contentHash,
    objectPath: path.relative(root, objectPath),
    fetchedAt: new Date().toISOString(),
    etag: response.headers?.get?.("etag") || null,
    lastModified: response.headers?.get?.("last-modified") || null,
    previousContentHash: previous?.contentHash || null,
    revisionChanged: Boolean(previous?.contentHash && previous.contentHash !== contentHash)
  };
  await writeJson(indexFile, record);
  return record;
}

async function memoizedDownload(item, url, label, options, cacheDir, memo, classification = null) {
  const key = String(url);
  if (!memo.has(key)) {
    memo.set(key, downloadImmutablePlanningDocument(item, url, label, options, cacheDir, classification));
  }
  const downloaded = await memo.get(key);
  return {
    ...downloaded,
    application: item.application,
    sourceItemId: item.id,
    classification: classification || downloaded.classification
  };
}

async function fetchResponse(url, init, options) {
  const implementation = options.fetchImpl || globalThis.fetch;
  if (typeof implementation !== "function") throw new Error("No fetch implementation is available");
  const retries = clampInt(options.fetchRetries ?? 2, 0, 5);
  const timeoutMs = clampInt(options.fetchTimeoutMs ?? 120_000, 1_000, 600_000);
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await implementation(url, { ...init, redirect: "follow", signal: controller.signal });
      } catch (primaryError) {
        // Only the real network path uses DNS-over-HTTPS fallback. Unit-test
        // fetch implementations remain fully deterministic and never escape to
        // the network. The fallback keeps the original hostname/TLS identity,
        // so this is DNS recovery rather than a content proxy.
        if (implementation !== globalThis.fetch || options.disablePublicDnsFallback) throw primaryError;
        try {
          response = await fetchViaPublicDns(url, init, {
            ...options,
            fetchTimeoutMs: timeoutMs,
            userAgent: options.userAgent || "VoxelMapper/0.12"
          });
        } catch (dnsFallbackError) {
          const error = new Error(
            `${primaryError?.message || "Primary fetch failed"}; public-DNS fallback failed: ${dnsFallbackError?.message || dnsFallbackError}`
          );
          error.cause = dnsFallbackError;
          throw error;
        }
      }
      if (!response?.ok) {
        const status = Number(response?.status || 0);
        const snippet = typeof response?.text === "function" ? (await response.text()).slice(0, 300) : "";
        const error = new Error(`HTTP ${response?.status ?? "?"} fetching ${new URL(url).host}${snippet ? `: ${snippet}` : ""}`);
        error.retryable = isRetryableHttpStatus(status);
        throw error;
      }
      return {
        response,
        retrieval: {
          mode: "live",
          originalUrl: url,
          capturedOriginalUrl: null,
          replayUrl: null,
          captureAt: null,
          captureTimestamp: null,
          digest: null
        }
      };
    } catch (error) {
      lastError = error;
      const retryable = error?.retryable !== false;
      if (attempt >= retries || !retryable) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
    } finally {
      clearTimeout(timer);
    }
  }

  const archiveEnabled = options.disableWebArchiveFallback !== true && (
    implementation === globalThis.fetch || typeof options.webArchiveFetchImpl === "function"
  );
  if (archiveEnabled) {
    try {
      return await fetchArchivedPublicUrl(url, init, {
        fetchImpl: options.webArchiveFetchImpl || globalThis.fetch,
        timeoutMs: options.webArchiveTimeoutMs ?? Math.min(timeoutMs, 30_000),
        captureLimit: options.webArchiveCaptureLimit ?? 5,
        userAgent: options.userAgent || "VoxelMapper/0.12",
        disablePublicDnsFallback: options.disablePublicDnsFallback
      });
    } catch (archiveError) {
      const combined = new Error(
        `${lastError?.message || "Live planning fetch failed"}; web-archive fallback failed: ${archiveError?.message || archiveError}`
      );
      combined.cause = archiveError;
      throw combined;
    }
  }
  throw lastError;
}

function isRetryableHttpStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function extensionForDocument(url, contentType) {
  const pathname = new URL(url).pathname;
  const ext = path.extname(pathname).toLowerCase();
  if (ext && ext.length <= 8 && /^[.][a-z0-9]+$/.test(ext)) return ext;
  const byType = {
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/tiff": ".tif",
    "application/zip": ".zip",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "text/csv": ".csv"
  };
  return byType[contentType] || ".bin";
}

function filenameFromDisposition(value) {
  const utf = String(value).match(/filename\*=UTF-8''([^;]+)/i);
  if (utf) {
    try { return decodeURIComponent(utf[1].trim()); } catch { return utf[1].trim(); }
  }
  const plain = String(value).match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1].trim() : null;
}

async function isFreshCache(filename, maxAgeHours) {
  if (!(await exists(filename))) return false;
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) return false;
  const details = await stat(filename);
  return Date.now() - details.mtimeMs <= maxAgeHours * 60 * 60 * 1000;
}

function restoreArchivedOriginalLinks(entries, retrieval) {
  if (retrieval?.mode !== "web-archive") return entries;
  return entries.map((entry) => {
    const original = originalUrlFromWaybackReplay(entry?.url);
    return original ? { ...entry, url: original } : entry;
  });
}

function mergeDiscoveredLinks(...groups) {
  const seen = new Set();
  const links = [];
  for (const entry of groups.flat()) {
    if (!entry?.url || !isSafePublicHttpUrl(entry.url)) continue;
    const key = String(entry.url);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(entry);
  }
  return links.sort((a, b) =>
    planningDocumentPriority(b.classification, b.direct ? "download" : "discover") -
    planningDocumentPriority(a.classification, a.direct ? "download" : "discover")
  );
}

function dedupeDiscovered(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const key = `${entry.application?.key || ""}\n${entry.url}\n${entry.action}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result.sort((a, b) => (b.priority || 0) - (a.priority || 0));
}

function withoutHtml(value) {
  if (!value) return value;
  const { html, ...rest } = value;
  return rest;
}

async function mapLimit(values, concurrency, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, values.length)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function clampInt(value, min, max) {
  const number = Math.floor(Number(value));
  return Math.max(min, Math.min(max, Number.isFinite(number) ? number : min));
}
