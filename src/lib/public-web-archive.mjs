import { fetchViaPublicDns } from "./public-dns-http.mjs";

const CDX_ENDPOINT = "https://web.archive.org/cdx/search/cdx";
const REPLAY_ORIGIN = "https://web.archive.org";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CAPTURE_LIMIT = 5;

/**
 * Fetch an immutable public copy of a URL from the Internet Archive Wayback
 * Machine. This is transport recovery only: callers must retain the original
 * authority URL and must not infer current/as-built status from archive age.
 */
export async function fetchArchivedPublicUrl(urlValue, init = {}, options = {}) {
  const originalUrl = assertSafeOriginalUrl(urlValue);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("No fetch implementation is available for web-archive recovery");

  const cdxUrl = buildWaybackCdxUrl(originalUrl, options);
  const cdxResponse = await fetchArchiveResponse(cdxUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": options.userAgent || "VoxelMapper/0.12"
    }
  }, { ...options, fetchImpl });
  if (!cdxResponse?.ok) {
    throw new Error(`Wayback CDX HTTP ${cdxResponse?.status ?? "?"} for ${new URL(originalUrl).host}`);
  }

  let payload;
  try {
    payload = await cdxResponse.json();
  } catch (error) {
    throw new Error(`Wayback CDX returned invalid JSON for ${new URL(originalUrl).host}: ${error?.message || error}`);
  }
  const captures = parseWaybackCdx(payload)
    .filter((capture) => capture.statuscode === "200")
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  if (!captures.length) throw new Error(`No public Wayback capture for ${originalUrl}`);

  const replayFailures = [];
  for (const capture of captures) {
    const replayUrl = buildWaybackReplayUrl(capture);
    try {
      const response = await fetchArchiveResponse(replayUrl, {
        ...init,
        headers: {
          ...(init.headers || {}),
          "User-Agent": options.userAgent || "VoxelMapper/0.12"
        }
      }, { ...options, fetchImpl });
      if (!response?.ok) {
        replayFailures.push(`${capture.timestamp}: HTTP ${response?.status ?? "?"}`);
        continue;
      }
      return {
        response,
        retrieval: {
          mode: "web-archive",
          originalUrl,
          capturedOriginalUrl: capture.original,
          captureTimestamp: capture.timestamp,
          captureAt: waybackTimestampToIso(capture.timestamp),
          replayUrl,
          digest: capture.digest || null,
          mimetype: capture.mimetype || null
        }
      };
    } catch (error) {
      replayFailures.push(`${capture.timestamp}: ${error?.message || error}`);
    }
  }
  throw new Error(`Wayback replay failed for ${originalUrl}: ${replayFailures.join("; ") || "no usable capture"}`);
}

export function buildWaybackCdxUrl(urlValue, options = {}) {
  const originalUrl = assertSafeOriginalUrl(urlValue);
  const endpoint = new URL(options.cdxEndpoint || CDX_ENDPOINT);
  if (endpoint.protocol !== "https:" || endpoint.hostname !== "web.archive.org") {
    throw new Error("Wayback CDX endpoint must remain https://web.archive.org");
  }
  endpoint.searchParams.set("url", originalUrl);
  endpoint.searchParams.set("output", "json");
  endpoint.searchParams.set("fl", "timestamp,original,statuscode,mimetype,digest");
  endpoint.searchParams.append("filter", "statuscode:200");
  endpoint.searchParams.set("collapse", "digest");
  endpoint.searchParams.set("fastLatest", "true");
  endpoint.searchParams.set("limit", `-${clampInt(options.captureLimit ?? DEFAULT_CAPTURE_LIMIT, 1, 20)}`);
  return endpoint.toString();
}

export function parseWaybackCdx(payload) {
  if (!Array.isArray(payload) || payload.length < 2 || !Array.isArray(payload[0])) return [];
  const header = payload[0].map((field) => String(field));
  const rows = [];
  for (const raw of payload.slice(1)) {
    if (!Array.isArray(raw) || raw.length !== header.length) continue;
    const row = Object.fromEntries(header.map((field, index) => [field, String(raw[index] ?? "")]));
    if (!/^\d{14}$/.test(row.timestamp || "")) continue;
    try { assertSafeOriginalUrl(row.original); } catch { continue; }
    rows.push(row);
  }
  return rows;
}

export function buildWaybackReplayUrl(capture) {
  if (!capture || !/^\d{14}$/.test(String(capture.timestamp || ""))) throw new Error("Invalid Wayback capture timestamp");
  const originalUrl = assertSafeOriginalUrl(capture.original);
  // `id_` requests identity/raw replay so authority HTML keeps its original
  // links and binary documents are not wrapped in the Wayback UI.
  return `${REPLAY_ORIGIN}/web/${capture.timestamp}id_/${originalUrl}`;
}

export function originalUrlFromWaybackReplay(urlValue) {
  let url;
  try { url = new URL(String(urlValue)); } catch { return null; }
  if (url.hostname !== "web.archive.org") return null;
  const match = url.pathname.match(/^\/web\/\d{1,14}(?:[a-z_]+)?\/(https?:\/\/.*)$/i);
  if (!match) return null;
  const suffix = `${match[1]}${url.search || ""}${url.hash || ""}`;
  try { return assertSafeOriginalUrl(suffix); } catch { return null; }
}

export function waybackTimestampToIso(value) {
  const timestamp = String(value || "");
  if (!/^\d{14}$/.test(timestamp)) return null;
  const iso = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}.000Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

async function fetchArchiveResponse(url, init, options) {
  const fetchImpl = options.fetchImpl;
  const timeoutMs = clampInt(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000, 120_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    try {
      return await fetchImpl(url, { ...init, redirect: "follow", signal: controller.signal });
    } catch (primaryError) {
      // Custom test implementations are deterministic and must never escape to
      // the network. Real runs get the same bounded public-DNS recovery used by
      // first-party planning sources.
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

function assertSafeOriginalUrl(value) {
  const url = value instanceof URL ? new URL(value) : new URL(String(value));
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Unsupported archive source protocol: ${url.protocol}`);
  if (url.username || url.password) throw new Error("Credential-bearing archive source URLs are not allowed");
  if (!url.hostname || /^(localhost|127\.|10\.|192\.168\.|169\.254\.)/i.test(url.hostname) || url.hostname.endsWith(".local")) {
    throw new Error(`Private archive source hostname is not allowed: ${url.hostname}`);
  }
  return url.toString();
}

function clampInt(value, min, max) {
  const number = Math.floor(Number(value));
  return Math.max(min, Math.min(max, Number.isFinite(number) ? number : min));
}
