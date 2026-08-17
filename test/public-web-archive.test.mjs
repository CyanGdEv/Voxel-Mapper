import test from "node:test";
import assert from "node:assert/strict";
import {
  archiveSourceCandidates,
  buildWaybackCdxUrl,
  buildWaybackReplayUrl,
  fetchArchivedPublicUrl,
  originalUrlFromWaybackReplay,
  parseWaybackCdx,
  waybackTimestampToIso
} from "../src/lib/public-web-archive.mjs";

test("Wayback CDX requests stay on the fixed archive endpoint and request bounded latest successful captures", () => {
  const original = "http://planning.example.gov/portal/servlets/ApplicationSearchServlet?PKID=42";
  const cdx = new URL(buildWaybackCdxUrl(original, { captureLimit: 7 }));
  assert.equal(cdx.protocol, "https:");
  assert.equal(cdx.hostname, "web.archive.org");
  assert.equal(cdx.pathname, "/cdx/search/cdx");
  assert.equal(cdx.searchParams.get("url"), original);
  assert.equal(cdx.searchParams.get("output"), "json");
  assert.equal(cdx.searchParams.get("fl"), "timestamp,original,statuscode,mimetype,digest");
  assert.deepEqual(cdx.searchParams.getAll("filter"), ["statuscode:200"]);
  assert.equal(cdx.searchParams.get("collapse"), "digest");
  assert.equal(cdx.searchParams.get("fastLatest"), "true");
  assert.equal(cdx.searchParams.get("limit"), "-7");
  assert.throws(
    () => buildWaybackCdxUrl(original, { cdxEndpoint: "https://example.com/cdx" }),
    /must remain https:\/\/web\.archive\.org/
  );
});

test("archive source candidates preserve the original URL and add same-host HTTPS recovery for legacy HTTP indexes", () => {
  assert.deepEqual(
    archiveSourceCandidates("http://planning.example.gov/app/1?x=2"),
    ["http://planning.example.gov/app/1?x=2", "https://planning.example.gov/app/1?x=2"]
  );
  assert.deepEqual(
    archiveSourceCandidates("https://planning.example.gov/app/1"),
    ["https://planning.example.gov/app/1"]
  );
});

test("CDX parser rejects malformed and private-source captures", () => {
  const rows = parseWaybackCdx([
    ["timestamp", "original", "statuscode", "mimetype", "digest"],
    ["20240102030405", "https://planning.example.gov/app/1", "200", "text/html", "ABC"],
    ["bad", "https://planning.example.gov/app/2", "200", "text/html", "DEF"],
    ["20240102030406", "http://127.0.0.1/private", "200", "text/html", "GHI"],
    ["20240102030407", "file:///tmp/private", "200", "text/html", "JKL"]
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].timestamp, "20240102030405");
  assert.equal(rows[0].original, "https://planning.example.gov/app/1");
});

test("Wayback replay helpers preserve the canonical first-party source URL", () => {
  const capture = {
    timestamp: "20240102030405",
    original: "https://planning.example.gov/docs/site-plan.pdf"
  };
  const replay = buildWaybackReplayUrl(capture);
  assert.equal(replay, "https://web.archive.org/web/20240102030405id_/https://planning.example.gov/docs/site-plan.pdf");
  assert.equal(originalUrlFromWaybackReplay(replay), capture.original);
  assert.equal(originalUrlFromWaybackReplay("https://example.com/not-wayback"), null);
  assert.equal(waybackTimestampToIso(capture.timestamp), "2024-01-02T03:04:05.000Z");
  assert.equal(waybackTimestampToIso("bad"), null);
});

test("archive transport tries newer captures first and falls back to an older usable capture", async () => {
  const original = "http://planning.example.gov/app/42";
  const calls = [];
  const fetchImpl = async (urlValue) => {
    const url = new URL(String(urlValue));
    calls.push(url.toString());
    if (url.pathname === "/cdx/search/cdx") {
      const source = url.searchParams.get("url");
      if (source.startsWith("https://")) return new Response(JSON.stringify([
        ["timestamp", "original", "statuscode", "mimetype", "digest"],
        ["20240203040506", "https://planning.example.gov/app/42", "200", "text/html", "NEW"],
        ["20240102030405", "https://planning.example.gov/app/42", "200", "text/html", "OLD"]
      ]), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify([["timestamp", "original", "statuscode", "mimetype", "digest"]]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.pathname.startsWith("/web/20240203040506id_/")) return new Response("missing", { status: 404 });
    if (url.pathname.startsWith("/web/20240102030405id_/")) {
      return new Response("<html>archived planning page</html>", { status: 200, headers: { "content-type": "text/html" } });
    }
    throw new Error(`unexpected archive URL ${url}`);
  };

  const result = await fetchArchivedPublicUrl(original, {}, {
    fetchImpl,
    disablePublicDnsFallback: true,
    timeoutMs: 5_000
  });
  assert.equal(await result.response.text(), "<html>archived planning page</html>");
  assert.equal(result.retrieval.mode, "web-archive");
  assert.equal(result.retrieval.originalUrl, original);
  assert.equal(result.retrieval.capturedOriginalUrl, "https://planning.example.gov/app/42");
  assert.equal(result.retrieval.captureTimestamp, "20240102030405");
  assert.equal(result.retrieval.captureAt, "2024-01-02T03:04:05.000Z");
  assert.ok(calls.some((url) => url.includes("20240203040506id_")));
  assert.ok(calls.some((url) => url.includes("20240102030405id_")));
});

test("archive source validation rejects private and credential-bearing URLs", () => {
  assert.throws(() => archiveSourceCandidates("http://127.0.0.1/app"), /Unsafe archive source URL/);
  assert.throws(() => archiveSourceCandidates("https://user:secret@planning.example.gov/app"), /Credential-bearing/);
});
