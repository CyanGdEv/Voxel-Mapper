import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  buildCommonCrawlIndexUrl,
  commonCrawlSourceCandidates,
  commonCrawlTimestampToIso,
  fetchCommonCrawlPublicUrl,
  parseCommonCrawlIndex,
  parseWarcHttpResponse
} from "../src/lib/public-common-crawl.mjs";

test("Common Crawl index query is exact, bounded and fixed to the public index host", () => {
  const original = "http://planning.example.gov/portal/servlets/ApplicationSearchServlet?PKID=42";
  const url = new URL(buildCommonCrawlIndexUrl("CC-MAIN-2026-25", original, { captureLimit: 3 }));
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "index.commoncrawl.org");
  assert.equal(url.pathname, "/CC-MAIN-2026-25-index");
  assert.equal(url.searchParams.get("url"), original);
  assert.equal(url.searchParams.get("output"), "json");
  assert.equal(url.searchParams.get("filter"), "status:200");
  assert.equal(url.searchParams.get("limit"), "3");
  assert.throws(() => buildCommonCrawlIndexUrl("bad", original), /Invalid Common Crawl collection id/);
});

test("Common Crawl source candidates add same-host HTTPS for stale HTTP authority links", () => {
  assert.deepEqual(
    commonCrawlSourceCandidates("http://planning.example.gov/app/1"),
    ["http://planning.example.gov/app/1", "https://planning.example.gov/app/1"]
  );
  assert.deepEqual(
    commonCrawlSourceCandidates("https://planning.example.gov/app/1"),
    ["https://planning.example.gov/app/1"]
  );
  assert.throws(() => commonCrawlSourceCandidates("http://127.0.0.1/app"), /Unsafe Common Crawl source URL/);
});

test("Common Crawl NDJSON parser keeps only safe successful WARC records newest first", () => {
  const parsed = parseCommonCrawlIndex([
    JSON.stringify({ status: "200", timestamp: "20260102030405", url: "https://planning.example.gov/app/1", filename: "crawl-data/CC-MAIN-2026-05/segments/a/warc/x.warc.gz", offset: "10", length: "20" }),
    JSON.stringify({ status: "404", timestamp: "20260202030405", url: "https://planning.example.gov/app/1", filename: "crawl-data/CC-MAIN-2026-05/segments/a/warc/y.warc.gz", offset: "30", length: "40" }),
    JSON.stringify({ status: "200", timestamp: "20260302030405", url: "https://planning.example.gov/app/1", filename: "crawl-data/CC-MAIN-2026-09/segments/a/warc/z.warc.gz", offset: "50", length: "60" }),
    JSON.stringify({ status: "200", timestamp: "20260402030405", url: "http://127.0.0.1/private", filename: "crawl-data/CC-MAIN-2026-09/segments/a/warc/p.warc.gz", offset: "70", length: "80" })
  ].join("\n"));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].timestamp, "20260302030405");
  assert.equal(parsed[1].timestamp, "20260102030405");
});

test("WARC parser bounds the archived HTTP entity to WARC and HTTP content lengths", () => {
  const body = Buffer.from("%PDF-test-vector-plan");
  const http = Buffer.concat([
    Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\nContent-Length: ${body.length}\r\n\r\n`, "latin1"),
    body
  ]);
  const warc = Buffer.concat([
    Buffer.from(`WARC/1.0\r\nWARC-Type: response\r\nWARC-Target-URI: https://planning.example.gov/docs/plan.pdf\r\nContent-Length: ${http.length}\r\n\r\n`, "latin1"),
    http,
    Buffer.from("\r\n\r\nWARC-SEPARATOR-MUST-NOT-ENTER-PDF", "latin1")
  ]);
  const parsed = parseWarcHttpResponse(warc);
  assert.equal(parsed.status, 200);
  assert.equal(parsed.targetUrl, "https://planning.example.gov/docs/plan.pdf");
  assert.equal(parsed.httpHeaders.get("content-type"), "application/pdf");
  assert.deepEqual(parsed.body, body);
});

test("WARC parser rejects records whose declared payload is truncated", () => {
  const http = Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc", "latin1");
  const warc = Buffer.concat([
    Buffer.from(`WARC/1.0\r\nWARC-Type: response\r\nWARC-Target-URI: https://planning.example.gov/docs/plan.pdf\r\nContent-Length: ${http.length + 10}\r\n\r\n`, "latin1"),
    http
  ]);
  assert.throws(() => parseWarcHttpResponse(warc), /Truncated WARC payload/);
});

test("Common Crawl recovery range-fetches a WARC record and returns the original archived bytes", async () => {
  const original = "https://planning.example.gov/docs/proposed-layout.pdf";
  const body = Buffer.from("%PDF-common-crawl-vector-plan");
  const http = Buffer.concat([
    Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=Proposed-Layout.pdf\r\nContent-Length: ${body.length}\r\n\r\n`, "latin1"),
    body
  ]);
  const warc = Buffer.concat([
    Buffer.from(`WARC/1.0\r\nWARC-Type: response\r\nWARC-Target-URI: ${original}\r\nContent-Length: ${http.length}\r\n\r\n`, "latin1"),
    http,
    Buffer.from("\r\n\r\n")
  ]);
  const compressed = gzipSync(warc);
  const record = {
    status: "200",
    timestamp: "20260615010203",
    url: original,
    mime: "application/pdf",
    digest: "EXAMPLE",
    filename: "crawl-data/CC-MAIN-2026-25/segments/1/warc/example.warc.gz",
    offset: "1234",
    length: String(compressed.length)
  };
  const calls = [];
  const fetchImpl = async (urlValue, init = {}) => {
    const url = new URL(String(urlValue));
    calls.push({ url: url.toString(), range: init.headers?.Range || null });
    if (url.hostname === "index.commoncrawl.org") {
      return new Response(`${JSON.stringify(record)}\n`, { status: 200, headers: { "content-type": "text/plain" } });
    }
    if (url.hostname === "data.commoncrawl.org") {
      assert.equal(init.headers?.Range, `bytes=1234-${1234 + compressed.length - 1}`);
      return new Response(compressed, { status: 206, headers: { "content-type": "application/octet-stream" } });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const recovered = await fetchCommonCrawlPublicUrl(original, {}, {
    fetchImpl,
    collections: [{ id: "CC-MAIN-2026-25" }],
    collectionLimit: 1,
    disablePublicDnsFallback: true
  });
  assert.equal(recovered.retrieval.mode, "common-crawl");
  assert.equal(recovered.retrieval.archived, true);
  assert.equal(recovered.retrieval.capturedOriginalUrl, original);
  assert.equal(recovered.retrieval.captureAt, "2026-06-15T01:02:03.000Z");
  assert.equal(recovered.retrieval.collection, "CC-MAIN-2026-25");
  assert.deepEqual(Buffer.from(await recovered.response.arrayBuffer()), body);
  assert.equal(recovered.response.headers.get("content-type"), "application/pdf");
  assert.ok(calls.some((entry) => entry.url.includes("CC-MAIN-2026-25-index")));
  assert.ok(calls.some((entry) => entry.url.startsWith("https://data.commoncrawl.org/")));
});

test("Common Crawl timestamp conversion is deterministic", () => {
  assert.equal(commonCrawlTimestampToIso("20260615010203"), "2026-06-15T01:02:03.000Z");
  assert.equal(commonCrawlTimestampToIso("invalid"), null);
});
