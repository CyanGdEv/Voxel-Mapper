import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { buildPlanningDocumentQueue } from "../src/lib/planning-documents.mjs";
import { processPlanningDocumentShard } from "../src/lib/planning-document-worker.mjs";

test("document worker discovers, downloads and content-addresses planning drawings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-planning-docs-"));
  try {
    const queue = buildPlanningDocumentQueue({ applications: [{
      entity: 101,
      reference: "26/001/FUL",
      "documentation-url": "https://planning.example.gov/application/101"
    }] }, { planningDocumentShards: 20 });
    const shard = queue.items[0].shard;
    const fetchImpl = async (url) => {
      if (String(url).includes("application/101")) {
        return new Response(`
          <html><body>
            <a href="/docs/proposed-site-plan.pdf">Proposed Site Plan</a>
            <a href="/contact">Contact</a>
          </body></html>
        `, { status: 200, headers: { "content-type": "text/html" } });
      }
      if (String(url).includes("proposed-site-plan.pdf")) {
        return new Response(Buffer.from("%PDF-mock-site-plan"), {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "content-disposition": "attachment; filename=Proposed-Site-Plan.pdf"
          }
        });
      }
      throw new Error(`unexpected URL ${url}`);
    };

    const result = await processPlanningDocumentShard(queue, {
      shardIndex: shard,
      cacheDir: root,
      fetchImpl,
      fetchRetries: 0
    });
    assert.equal(result.failures.length, 0);
    assert.equal(result.downloadedDocuments, 1);
    assert.equal(result.uniqueContentObjects, 1);
    assert.equal(result.discoveredLinks, 1);
    const document = result.results[0].documents[0];
    assert.equal(document.classification, "site-plan");
    assert.match(document.contentHash, /^[a-f0-9]{64}$/);
    const object = path.join(root, "planning-documents", document.objectPath);
    assert.ok((await stat(object)).size > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("document worker reuses fresh discovery and document caches without network", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-planning-cache-"));
  try {
    const queue = buildPlanningDocumentQueue({ applications: [{
      entity: 202,
      reference: "26/202/FUL",
      "documentation-url": "https://planning.example.gov/application/202"
    }] }, { planningDocumentShards: 20 });
    const shard = queue.items[0].shard;
    let calls = 0;
    const firstFetch = async (url) => {
      calls += 1;
      if (String(url).includes("application/202")) {
        return new Response('<a href="/docs/elevations.pdf">Elevations</a>', {
          status: 200, headers: { "content-type": "text/html" }
        });
      }
      return new Response(Buffer.from("%PDF-mock-elevations"), {
        status: 200, headers: { "content-type": "application/pdf" }
      });
    };
    const first = await processPlanningDocumentShard(queue, {
      shardIndex: shard, cacheDir: root, fetchImpl: firstFetch, fetchRetries: 0
    });
    assert.equal(first.downloadedDocuments, 1);
    assert.equal(calls, 2);

    const second = await processPlanningDocumentShard(queue, {
      shardIndex: shard,
      cacheDir: root,
      fetchImpl: async () => { throw new Error("network should not be used for fresh cache"); },
      fetchRetries: 0
    });
    assert.equal(second.failures.length, 0);
    assert.equal(second.downloadedDocuments, 1);
    assert.equal(second.results[0].discovery.cacheHit, true);
    assert.equal(second.results[0].documents[0].status, "cached");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker records per-document failure instead of aborting a shard by default", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-planning-failure-"));
  try {
    const queue = buildPlanningDocumentQueue({ applications: [{
      entity: 303,
      "document-urls": "https://planning.example.gov/docs/missing-site-plan.pdf"
    }] }, { planningDocumentShards: 20 });
    const shard = queue.items[0].shard;
    const result = await processPlanningDocumentShard(queue, {
      shardIndex: shard,
      cacheDir: root,
      fetchRetries: 0,
      fetchImpl: async () => new Response("missing", { status: 404 })
    });
    assert.equal(result.failures.length, 1);
    assert.equal(result.results[0].status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("permanent 4xx planning document errors fail fast while transient 5xx errors still retry", async () => {
  const permanentRoot = await mkdtemp(path.join(os.tmpdir(), "voxel-planning-permanent-http-"));
  const transientRoot = await mkdtemp(path.join(os.tmpdir(), "voxel-planning-transient-http-"));
  try {
    const permanentQueue = buildPlanningDocumentQueue({ applications: [{
      entity: 401,
      "document-urls": "https://planning.example.gov/docs/gone.pdf"
    }] }, { planningDocumentShards: 20 });
    let permanentCalls = 0;
    await processPlanningDocumentShard(permanentQueue, {
      shardIndex: permanentQueue.items[0].shard,
      cacheDir: permanentRoot,
      fetchRetries: 2,
      fetchImpl: async () => {
        permanentCalls += 1;
        return new Response("gone", { status: 404 });
      }
    });
    assert.equal(permanentCalls, 1, "404 is definitive and must not burn the retry budget");

    const transientQueue = buildPlanningDocumentQueue({ applications: [{
      entity: 402,
      "document-urls": "https://planning.example.gov/docs/temporary.pdf"
    }] }, { planningDocumentShards: 20 });
    let transientCalls = 0;
    await processPlanningDocumentShard(transientQueue, {
      shardIndex: transientQueue.items[0].shard,
      cacheDir: transientRoot,
      fetchRetries: 2,
      fetchImpl: async () => {
        transientCalls += 1;
        return new Response("temporary", { status: 503 });
      }
    });
    assert.equal(transientCalls, 3, "transient server failures retain the full retry budget");
  } finally {
    await rm(permanentRoot, { recursive: true, force: true });
    await rm(transientRoot, { recursive: true, force: true });
  }
});

test("worker recovers archived authority application HTML and archived PDF without replacing canonical source URLs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-planning-archive-"));
  try {
    const applicationUrl = "https://planning.example.gov/application/archive-1";
    const documentUrl = "https://planning.example.gov/docs/proposed-layout.pdf";
    const queue = buildPlanningDocumentQueue({ applications: [{
      entity: 501,
      reference: "26/501/FUL",
      "documentation-url": applicationUrl
    }] }, { planningDocumentShards: 20 });
    const shard = queue.items[0].shard;
    const archiveFetchImpl = async (urlValue) => {
      const url = new URL(String(urlValue));
      if (url.pathname === "/cdx/search/cdx") {
        const source = url.searchParams.get("url");
        if (source === applicationUrl) return new Response(JSON.stringify([
          ["timestamp", "original", "statuscode", "mimetype", "digest"],
          ["20240102030405", applicationUrl, "200", "text/html", "APPDIGEST"]
        ]), { status: 200, headers: { "content-type": "application/json" } });
        if (source === documentUrl) return new Response(JSON.stringify([
          ["timestamp", "original", "statuscode", "mimetype", "digest"],
          ["20240103040506", documentUrl, "200", "application/pdf", "PDFDIGEST"]
        ]), { status: 200, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify([["timestamp", "original", "statuscode", "mimetype", "digest"]]), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.pathname.startsWith("/web/20240102030405id_/")) {
        return new Response('<html><body><a href="/docs/proposed-layout.pdf">Proposed Site Plan</a></body></html>', {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      if (url.pathname.startsWith("/web/20240103040506id_/")) {
        return new Response(Buffer.from("%PDF-archived-proposed-layout"), {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "content-disposition": "attachment; filename=Proposed-Layout.pdf"
          }
        });
      }
      throw new Error(`unexpected archive URL ${url}`);
    };

    const result = await processPlanningDocumentShard(queue, {
      shardIndex: shard,
      cacheDir: root,
      fetchRetries: 0,
      fetchImpl: async () => { throw new Error("live authority portal unavailable"); },
      webArchiveFetchImpl: archiveFetchImpl,
      disablePublicDnsFallback: true
    });

    assert.equal(result.failures.length, 0);
    assert.equal(result.downloadedDocuments, 1);
    assert.equal(result.discoveredLinks, 1);
    const discovery = result.results[0].discovery;
    assert.equal(discovery.retrievalMode, "web-archive");
    assert.equal(discovery.finalUrl, applicationUrl);
    assert.equal(discovery.archiveCaptureAt, "2024-01-02T03:04:05.000Z");
    assert.match(discovery.retrievalUrl, /^https:\/\/web\.archive\.org\/web\//);

    const document = result.results[0].documents[0];
    assert.equal(document.retrievalMode, "web-archive");
    assert.equal(document.url, documentUrl);
    assert.equal(document.finalUrl, documentUrl);
    assert.equal(document.archiveCaptureAt, "2024-01-03T04:05:06.000Z");
    assert.equal(document.classification, "site-plan");
    assert.match(document.retrievalUrl, /^https:\/\/web\.archive\.org\/web\//);
    assert.match(document.contentHash, /^[a-f0-9]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
