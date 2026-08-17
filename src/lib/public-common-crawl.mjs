import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { fetchViaPublicDns, httpsUpgradeCandidate } from "./public-dns-http.mjs";
import { isSafePublicHttpUrl } from "./planning-documents.mjs";

const COLLECTIONS_URL = "https://index.commoncrawl.org/collinfo.json";
const INDEX_ORIGIN = "https://index.commoncrawl.org";
const DATA_ORIGIN = "https://data.commoncrawl.org";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_COLLECTION_LIMIT = 8;
const DEFAULT_CAPTURE_LIMIT = 5;
const DEFAULT_MAX_WARC_RECORD_MB = 16;

let collectionMemo = null;

/**
 * Recover the original HTTP payload from Common Crawl. This is an evidence
 * transport fallback only; the canonical authority URL remains the captured
 * original URL and crawl age never grants current/as-built authority.
 */
export async function fetchCommonCrawlPublicUrl(urlValue, init = {}, options = {}) {
  const originalUrl = assertSafeOriginalUrl(urlValue);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("No fetch implementation is available for Common Crawl recovery");

  const collections = options.collections || await loadCommonCrawlCollections({ ...options, fetchImpl });
  const limit = clampInt(options.collectionLimit ?? DEFAULT_COLLECTION_LIMIT, 1, 24);
  const selected = collections.slice(0, limit);
  if (!selected.length) throw new Error("Common Crawl collection list is empty");

  const indexFailures = [];
  for (const collection of selected) {
    for (const sourceUrl of commonCrawlSourceCandidates(originalUrl)) {
      let records;
      try {
        records = await queryCommonCrawlIndex(collection, sourceUrl, { ...options, fetchImpl });
      } catch (error) {
        indexFailures.push(`${collection.id}:${sourceUrl}: ${error?.message || error}`);
        continue;
      }
      for (const record of records) {
        try {
          const replay = await fetchCommonCrawlRecord(record, { ...options, fetchImpl });
          return {
            response: replay.response,
            retrieval: {
              mode: "common-crawl",
              archived: true,
              originalUrl,
              capturedOriginalUrl: replay.targetUrl || record.url || sourceUrl,
              captureTimestamp: record.timestamp || null,
              captureAt: commonCrawlTimestampToIso(record.timestamp),
              replayUrl: replay.recordUrl,
              digest: record.digest || null,
              mimetype: record.mime || record["mime-detected"] || replay.contentType || null,
              collection: collection.id
            }
          };
        } catch (error) {
          indexFailures.push(`${collection.id}:${record.timestamp || "capture"}: ${error?.message || error}`);
        }
      }
    }
  }
  throw new Error(`No usable Common Crawl capture for ${originalUrl}${indexFailures.length ? ` (${indexFailures.slice(0, 8).join("; ")})` : ""}`);
}

export async function loadCommonCrawlCollections(options = {}) {
  if (Array.isArray(options.collections)) return normalizeCollections(options.collections);
  if (collectionMemo && !options.refreshCollections) return collectionMemo;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const response = await fetchPublic(COLLECTIONS_URL, {
    headers: { Accept: "application/json", "User-Agent": options.userAgent || "VoxelMapper/0.12" }
  }, { ...options, fetchImpl });
  if (!response?.ok) throw new Error(`Common Crawl collection list HTTP ${response?.status ?? "?"}`);
  const payload = await response.json();
  const normalized = normalizeCollections(payload);
  if (!normalized.length) throw new Error("Common Crawl collection list contained no usable indexes");
  if (fetchImpl === globalThis.fetch) collectionMemo = normalized;
  return normalized;
}

export function commonCrawlSourceCandidates(urlValue) {
  const original = assertSafeOriginalUrl(urlValue);
  const result = [original];
  const upgraded = httpsUpgradeCandidate(original);
  if (upgraded) {
    const value = assertSafeOriginalUrl(upgraded);
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

export function buildCommonCrawlIndexUrl(collectionId, urlValue, options = {}) {
  const id = validateCollectionId(collectionId);
  const originalUrl = assertSafeOriginalUrl(urlValue);
  const endpoint = new URL(`${INDEX_ORIGIN}/${id}-index`);
  endpoint.searchParams.set("url", originalUrl);
  endpoint.searchParams.set("output", "json");
  endpoint.searchParams.set("filter", "status:200");
  endpoint.searchParams.set("limit", String(clampInt(options.captureLimit ?? DEFAULT_CAPTURE_LIMIT, 1, 20)));
  return endpoint.toString();
}

export function parseCommonCrawlIndex(text) {
  const records = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (String(record?.status || "") !== "200") continue;
    if (!record?.filename || !/^crawl-data\//.test(String(record.filename))) continue;
    if (!/^\d+$/.test(String(record.offset || "")) || !/^\d+$/.test(String(record.length || ""))) continue;
    try { record.url = assertSafeOriginalUrl(record.url); } catch { continue; }
    records.push(record);
  }
  return records.sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
}

export async function queryCommonCrawlIndex(collection, urlValue, options = {}) {
  const id = validateCollectionId(collection?.id || collection);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const indexUrl = buildCommonCrawlIndexUrl(id, urlValue, options);
  const response = await fetchPublic(indexUrl, {
    headers: { Accept: "application/x-ndjson,text/plain;q=0.9,*/*;q=0.2", "User-Agent": options.userAgent || "VoxelMapper/0.12" }
  }, { ...options, fetchImpl });
  if (response?.status === 404) return [];
  if (!response?.ok) throw new Error(`Common Crawl index HTTP ${response?.status ?? "?"}`);
  return parseCommonCrawlIndex(await response.text());
}

export async function fetchCommonCrawlRecord(record, options = {}) {
  const filename = String(record?.filename || "");
  if (!/^crawl-data\/[A-Za-z0-9._/-]+\.warc\.gz$/.test(filename) || filename.includes("..")) {
    throw new Error("Unsafe Common Crawl WARC filename");
  }
  const offset = Number(record.offset);
  const length = Number(record.length);
  const maxBytes = clampInt(options.maxWarcRecordMb ?? DEFAULT_MAX_WARC_RECORD_MB, 1, 128) * 1024 * 1024;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0 || length > maxBytes) {
    throw new Error(`Invalid or oversized Common Crawl WARC range: offset=${record.offset} length=${record.length}`);
  }

  const recordUrl = `${DATA_ORIGIN}/${filename}`;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const response = await fetchPublic(recordUrl, {
    headers: {
      Range: `bytes=${offset}-${offset + length - 1}`,
      Accept: "application/warc,*/*;q=0.1",
      "User-Agent": options.userAgent || "VoxelMapper/0.12"
    }
  }, { ...options, fetchImpl });
  if (!response?.ok) throw new Error(`Common Crawl WARC HTTP ${response?.status ?? "?"}`);
  const compressed = Buffer.from(await response.arrayBuffer());
  if (compressed.length > maxBytes) throw new Error("Common Crawl WARC response exceeded bounded record size");

  let warc;
  try { warc = gunzipSync(compressed); } catch (error) {
    throw new Error(`Unable to decompress Common Crawl WARC record: ${error?.message || error}`);
  }
  const parsed = parseWarcHttpResponse(warc);
  if (parsed.warcHeaders.get("warc-truncated")) throw new Error("Common Crawl capture is truncated");
  if (parsed.status < 200 || parsed.status >= 300) throw new Error(`Archived HTTP status ${parsed.status}`);
  const body = decodeHttpEntity(parsed.body, parsed.httpHeaders);
  return {
    response: bufferedResponse(parsed.targetUrl || record.url, parsed.status, parsed.httpHeaders, body),
    targetUrl: parsed.targetUrl || record.url,
    recordUrl,
    contentType: parsed.httpHeaders.get("content-type") || null
  };
}

export function parseWarcHttpResponse(buffer) {
  const bytes = Buffer.from(buffer);
  const firstBoundary = findHeaderBoundary(bytes, 0);
  if (firstBoundary < 0) throw new Error("Malformed WARC headers");
  const warcHeaders = parseHeaderBlock(bytes.subarray(0, firstBoundary).toString("latin1"), true);
  const httpStart = firstBoundary + boundaryLength(bytes, firstBoundary);

  // WARC Content-Length describes the encapsulated application/http payload,
  // not the record separators which follow it. Respect that boundary so binary
  // planning documents are reproduced byte-for-byte rather than gaining a
  // trailing CRLF/WARC separator from the container record.
  const warcContentLength = parseBoundedLength(warcHeaders.get("content-length"));
  const payloadEnd = warcContentLength == null ? bytes.length : httpStart + warcContentLength;
  if (payloadEnd > bytes.length) throw new Error("Truncated WARC payload");
  if (payloadEnd <= httpStart) throw new Error("Empty WARC HTTP payload");

  const secondBoundary = findHeaderBoundary(bytes, httpStart);
  if (secondBoundary < 0 || secondBoundary >= payloadEnd) throw new Error("Malformed archived HTTP headers");
  const httpBlock = bytes.subarray(httpStart, secondBoundary).toString("latin1");
  const lines = httpBlock.split(/\r?\n/);
  const statusMatch = lines.shift()?.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i);
  if (!statusMatch) throw new Error("Archived WARC payload is not an HTTP response");
  const httpHeaders = parseHeaderLines(lines);
  const bodyStart = secondBoundary + boundaryLength(bytes, secondBoundary);
  if (bodyStart > payloadEnd) throw new Error("Archived HTTP headers exceed WARC payload boundary");

  let body = bytes.subarray(bodyStart, payloadEnd);
  const transfer = String(httpHeaders.get("transfer-encoding") || "").toLowerCase();
  if (!transfer.includes("chunked")) {
    const httpContentLength = parseBoundedLength(httpHeaders.get("content-length"));
    if (httpContentLength != null) {
      if (httpContentLength > body.length) throw new Error("Truncated archived HTTP entity");
      body = body.subarray(0, httpContentLength);
    }
  }

  return {
    warcHeaders,
    httpHeaders,
    status: Number(statusMatch[1]),
    targetUrl: warcHeaders.get("warc-target-uri") || null,
    body
  };
}

export function commonCrawlTimestampToIso(value) {
  const timestamp = String(value || "");
  if (!/^\d{14}$/.test(timestamp)) return null;
  const iso = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}.000Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

async function fetchPublic(url, init, options) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = clampInt(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000, 120_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    try {
      return await fetchImpl(url, { ...init, redirect: "follow", signal: controller.signal });
    } catch (primaryError) {
      if (fetchImpl !== globalThis.fetch || options.disablePublicDnsFallback) throw primaryError;
      try {
        return await fetchViaPublicDns(url, init, {
          ...options,
          fetchTimeoutMs: timeoutMs,
          userAgent: options.userAgent || "VoxelMapper/0.12"
        });
      } catch (fallbackError) {
        throw new Error(`${primaryError?.message || primaryError}; public-DNS fallback failed: ${fallbackError?.message || fallbackError}`);
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

function normalizeCollections(payload) {
  const values = Array.isArray(payload) ? payload : [];
  const seen = new Set();
  return values
    .map((entry) => ({ id: String(entry?.id || ""), name: entry?.name || null }))
    .filter((entry) => {
      if (!/^CC-MAIN-\d{4}-\d{2}$/.test(entry.id) || seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    })
    .sort((a, b) => b.id.localeCompare(a.id));
}

function validateCollectionId(value) {
  const id = String(value || "");
  if (!/^CC-MAIN-\d{4}-\d{2}$/.test(id)) throw new Error(`Invalid Common Crawl collection id: ${id}`);
  return id;
}

function assertSafeOriginalUrl(value) {
  const url = value instanceof URL ? new URL(value) : new URL(String(value));
  if (url.username || url.password) throw new Error("Credential-bearing Common Crawl source URLs are not allowed");
  if (!isSafePublicHttpUrl(url)) throw new Error(`Unsafe Common Crawl source URL: ${url}`);
  return url.toString();
}

function parseHeaderBlock(value, skipFirstLine = false) {
  const lines = String(value).split(/\r?\n/);
  if (skipFirstLine) lines.shift();
  return parseHeaderLines(lines);
}

function parseHeaderLines(lines) {
  const headers = new Map();
  let previous = null;
  for (const line of lines) {
    if (!line) continue;
    if (/^[ \t]/.test(line) && previous) {
      headers.set(previous, `${headers.get(previous)} ${line.trim()}`);
      continue;
    }
    const index = line.indexOf(":");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    headers.set(key, headers.has(key) ? `${headers.get(key)}, ${value}` : value);
    previous = key;
  }
  return headers;
}

function findHeaderBoundary(buffer, start) {
  const crlf = buffer.indexOf(Buffer.from("\r\n\r\n"), start);
  const lf = buffer.indexOf(Buffer.from("\n\n"), start);
  if (crlf < 0) return lf;
  if (lf < 0) return crlf;
  return Math.min(crlf, lf);
}

function boundaryLength(buffer, index) {
  return buffer.subarray(index, index + 4).equals(Buffer.from("\r\n\r\n")) ? 4 : 2;
}

function parseBoundedLength(value) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function decodeHttpEntity(bodyValue, headers) {
  let body = Buffer.from(bodyValue);
  const transfer = String(headers.get("transfer-encoding") || "").toLowerCase();
  if (transfer.includes("chunked")) body = decodeChunked(body);
  const encoding = String(headers.get("content-encoding") || "").toLowerCase();
  try {
    if (encoding.includes("gzip")) return gunzipSync(body);
    if (encoding.includes("br")) return brotliDecompressSync(body);
    if (encoding.includes("deflate")) return inflateSync(body);
  } catch (error) {
    throw new Error(`Unable to decode archived HTTP entity: ${error?.message || error}`);
  }
  return body;
}

function decodeChunked(buffer) {
  const chunks = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const end = buffer.indexOf(Buffer.from("\r\n"), cursor);
    if (end < 0) throw new Error("Malformed chunked archived response");
    const sizeText = buffer.subarray(cursor, end).toString("ascii").split(";", 1)[0].trim();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0) throw new Error("Malformed chunk size in archived response");
    cursor = end + 2;
    if (size === 0) break;
    const next = cursor + size;
    if (next > buffer.length) throw new Error("Truncated chunked archived response");
    chunks.push(buffer.subarray(cursor, next));
    cursor = next + 2;
  }
  return Buffer.concat(chunks);
}

function bufferedResponse(url, status, headerMap, body) {
  const headers = new Map(headerMap);
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  headers.set("content-length", String(body.length));
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (name) => headers.get(String(name).toLowerCase()) || null },
    text: async () => body.toString("utf8"),
    json: async () => JSON.parse(body.toString("utf8")),
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
  };
}

function clampInt(value, min, max) {
  const number = Math.floor(Number(value));
  return Math.max(min, Math.min(max, Number.isFinite(number) ? number : min));
}
