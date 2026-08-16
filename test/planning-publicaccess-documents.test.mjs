import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { extractPortalPlanningDocumentLinks } from "../src/lib/planning-portal-documents.mjs";
import { discoverPlanningPage, processPlanningDocumentShard } from "../src/lib/planning-document-worker.mjs";

const pageUrl = "http://publicaccess.example.gov/portal/servlets/ApplicationSearchServlet?PKID=42";
const html = `<!doctype html>
<html><head><script>
function AppBlobImage(s_ImageName) {
  URL = "http://publicaccess.example.gov/portal/servlets/AttachmentShowServlet?ImageName=" + escape(s_ImageName);
  window.open(URL, 'ImageWindow');
}
</script></head><body>
<table>
<tr><td><a href="javascript:AppBlobImage('160144');">Proposed Site Plan</a></td></tr>
<tr><td><a href="javascript:AppBlobImage('160145');">Landscape Site Plan</a></td></tr>
<tr><td><a href="javascript:void(0)">Not a planning document</a></td></tr>
</table>
</body></html>`;

function response(body, { contentType = "text/html", url = pageUrl, filename = null } = {}) {
  const bytes = typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
  const headers = new Headers({
    "content-type": contentType,
    "content-length": String(bytes.length)
  });
  if (filename) headers.set("content-disposition", `inline; filename=${filename}`);
  return {
    ok: true,
    status: 200,
    url,
    headers,
    text: async () => bytes.toString("utf8"),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  };
}

test("legacy PublicAccess AppBlobImage anchors become direct classified attachment URLs", () => {
  const links = extractPortalPlanningDocumentLinks(html, pageUrl);
  assert.equal(links.length, 2);
  assert.deepEqual(links.map((link) => [link.attachmentId, link.label, link.direct]), [
    ["160144", "Proposed Site Plan", true],
    ["160145", "Landscape Site Plan", true]
  ]);
  assert.equal(links[0].url,
    "http://publicaccess.example.gov/portal/servlets/AttachmentShowServlet?ImageName=160144");
  assert.equal(links[1].source, "legacy-publicaccess-attachment");
});

test("planning page discovery classifies legacy blob attachments as site/landscape documents", async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "voxel-publicaccess-discovery-"));
  try {
    const item = {
      id: "app-page",
      url: pageUrl,
      application: { key: "reference:TEST/42" },
      action: "discover",
      shard: 0
    };
    const discovery = await discoverPlanningPage(item, {
      cacheDir,
      refreshPlanningDocuments: true,
      fetchImpl: async (url) => {
        assert.equal(String(url), pageUrl);
        return response(html);
      }
    });
    const attachments = discovery.links.filter((link) => link.source === "legacy-publicaccess-attachment");
    assert.equal(attachments.length, 2);
    assert.equal(attachments[0].classification, "site-plan");
    assert.equal(attachments[1].classification, "landscape");
    assert.ok(attachments.every((link) => link.direct));
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("planning worker downloads and content-addresses legacy PublicAccess PDFs", async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "voxel-publicaccess-worker-"));
  try {
    const queue = {
      schemaVersion: 1,
      shardCount: 1,
      items: [{
        id: "app-page",
        url: pageUrl,
        label: "Fixture planning application",
        source: "documentation-url",
        action: "discover",
        direct: false,
        classification: "unknown",
        priority: 20,
        shard: 0,
        status: "pending",
        application: { key: "reference:TEST/42", reference: "TEST/42" }
      }]
    };
    const pdf = Buffer.from("%PDF-1.7\n% Voxel Mapper PublicAccess fixture\n%%EOF\n");
    const manifest = await processPlanningDocumentShard(queue, {
      shardIndex: 0,
      cacheDir,
      refreshPlanningDocuments: true,
      fetchImpl: async (url) => {
        const value = String(url);
        if (value === pageUrl) return response(html);
        const parsed = new URL(value);
        const imageId = parsed.searchParams.get("ImageName");
        if (["160144", "160145"].includes(imageId)) {
          return response(pdf, {
            contentType: "application/pdf",
            url: value,
            filename: `${imageId}.pdf`
          });
        }
        throw new Error(`Unexpected URL: ${value}`);
      }
    });

    assert.equal(manifest.failures.length, 0);
    assert.equal(manifest.downloadedDocuments, 2);
    assert.equal(manifest.uniqueContentObjects, 1, "identical fixture PDFs should deduplicate by content hash");
    const result = manifest.results[0];
    assert.equal(result.documents.length, 2);
    assert.deepEqual(result.documents.map((document) => document.classification), ["site-plan", "landscape"]);
    assert.ok(result.documents.every((document) => document.contentType === "application/pdf"));
    assert.ok(result.documents.every((document) => document.status === "downloaded"));
    assert.ok(result.discovered.every((entry) => entry.source === "legacy-publicaccess-attachment"));
    for (const document of result.documents) {
      const objectFile = path.join(cacheDir, "planning-documents", document.objectPath);
      assert.ok((await stat(objectFile)).size > 0);
    }
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});
