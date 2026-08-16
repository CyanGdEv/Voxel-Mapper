import http from "node:http";
import https from "node:https";
import net from "node:net";

const DEFAULT_DOH_ENDPOINT = "https://dns.google/resolve";
const MAX_REDIRECTS = 5;

/**
 * Resolve a public HTTP(S) hostname with DNS-over-HTTPS, then make the request
 * against that exact address while retaining the original hostname for Host
 * and TLS SNI/certificate verification. This is a bounded fallback for public
 * authority sites whose DNS cannot be resolved by a hosted runner's system
 * resolver; it never disables TLS validation or permits private/reserved IPs.
 */
export async function fetchViaPublicDns(urlValue, init = {}, options = {}) {
  const url = new URL(urlValue);
  assertPublicHttpUrl(url);
  return requestWithPublicDns(url, init, options, 0);
}

export async function resolvePublicIpv4(hostname, options = {}) {
  const resolver = options.resolvePublicIpv4Impl;
  if (typeof resolver === "function") {
    const supplied = await resolver(hostname);
    const values = Array.isArray(supplied) ? supplied : [supplied];
    const publicValues = values.map(String).filter(isPublicIpv4);
    if (!publicValues.length) throw new Error(`DNS fallback resolved no public IPv4 address for ${hostname}`);
    return publicValues;
  }

  const fetchImpl = options.dohFetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("No fetch implementation is available for DNS-over-HTTPS");
  const endpoint = new URL(options.dohEndpoint || DEFAULT_DOH_ENDPOINT);
  endpoint.searchParams.set("name", hostname);
  endpoint.searchParams.set("type", "A");
  endpoint.searchParams.set("do", "1");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(options.dohTimeoutMs || 10_000));
  try {
    const response = await fetchImpl(endpoint, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": options.userAgent || "VoxelMapper/0.12"
      }
    });
    if (!response?.ok) throw new Error(`HTTP ${response?.status ?? "?"} resolving ${hostname} with DNS-over-HTTPS`);
    const payload = await response.json();
    const addresses = publicIpv4Answers(payload);
    if (!addresses.length) {
      const status = payload?.Status == null ? "unknown" : payload.Status;
      throw new Error(`DNS-over-HTTPS returned no public IPv4 address for ${hostname} (status ${status})`);
    }
    return addresses;
  } finally {
    clearTimeout(timer);
  }
}

export function publicIpv4Answers(payload) {
  return [...new Set((Array.isArray(payload?.Answer) ? payload.Answer : [])
    .filter((entry) => Number(entry?.type) === 1)
    .map((entry) => String(entry?.data || "").trim())
    .filter(isPublicIpv4))];
}

export function isPublicIpv4(value) {
  if (net.isIP(value) !== 4) return false;
  const octets = String(value).split(".").map(Number);
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 192 && b === 0) return false;
  if (a === 192 && b === 0 && octets[2] === 2) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && octets[2] === 100) return false;
  if (a === 203 && b === 0 && octets[2] === 113) return false;
  if (a >= 224) return false;
  return true;
}

async function requestWithPublicDns(url, init, options, redirectDepth) {
  if (redirectDepth > MAX_REDIRECTS) throw new Error(`Too many redirects fetching ${url.hostname}`);
  assertPublicHttpUrl(url);
  const addresses = await resolvePublicIpv4(url.hostname, options);
  let lastError = null;

  for (const address of addresses) {
    try {
      const response = await requestResolvedAddress(url, address, init, options);
      if (isRedirect(response.status) && response.headers.get("location")) {
        const redirected = new URL(response.headers.get("location"), url);
        assertPublicHttpUrl(redirected);
        return requestWithPublicDns(redirected, init, options, redirectDepth + 1);
      }
      return response;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`DNS fallback request failed for ${url.hostname}`);
}

function requestResolvedAddress(url, address, init, options) {
  const transport = url.protocol === "https:" ? https : http;
  const timeoutMs = Math.max(1_000, Math.min(600_000, Number(options.fetchTimeoutMs || 120_000)));
  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: init.method || "GET",
      headers: {
        ...(init.headers || {}),
        Host: url.host
      },
      // Preserve hostname/TLS SNI while bypassing only the broken system DNS
      // lookup. Node's TLS layer still validates the authority certificate.
      lookup: (_hostname, _lookupOptions, callback) => callback(null, address, 4),
      timeout: timeoutMs
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve(bufferedResponse(url.toString(), response.statusCode || 0, response.headers, body));
      });
    });
    request.on("timeout", () => request.destroy(new Error(`Timeout fetching ${url.hostname} via DNS fallback`)));
    request.on("error", reject);
    request.end();
  });
}

function bufferedResponse(url, status, headersObject, body) {
  const headers = new Map();
  for (const [key, value] of Object.entries(headersObject || {})) {
    if (value == null) continue;
    headers.set(String(key).toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value));
  }
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

function assertPublicHttpUrl(url) {
  if (!(url instanceof URL)) throw new Error("Public DNS fetch requires a URL");
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Unsupported public URL protocol: ${url.protocol}`);
  if (!url.hostname || net.isIP(url.hostname)) throw new Error("DNS fallback requires a public hostname, not a literal IP address");
  if (url.username || url.password) throw new Error("Credential-bearing public URLs are not allowed");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error(`Private hostname is not allowed: ${host}`);
  }
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
