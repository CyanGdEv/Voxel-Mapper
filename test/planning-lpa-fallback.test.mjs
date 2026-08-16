import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { acquireSources } from "../src/lib/sources.mjs";
import {
  extractOsmPlanningHints,
  parsePublicAccessMajorApplications
} from "../src/lib/planning-lpa-fallback.mjs";

const BBOX = "52.9820,-1.9000,52.9945,-1.8665";
const listingUrl = "https://publicaccess.example.gov/portal/servlets/MajorContentiousDevelopmentservlet";

function portalHtml() {
  return `
    <table>
      <tr>
        <td><a href="ApplicationSearchServlet?PKID=101">SMD/2026/0101</a></td>
        <td>17/05/2026</td><td>19/05/2026</td>
        <td>Fixture Park, Example Road, ST10 1AA</td>
        <td>Replacement ride, guest paths and landscaping</td>
        <td>Planning Permission - Approved</td><td>31/08/2026</td>
      </tr>
      <tr>
        <td><a href="ApplicationSearchServlet?PKID=102">SMD/2026/0102</a></td>
        <td>01/06/2026</td><td>03/06/2026</td>
        <td>Unrelated Industrial Estate</td><td>Warehouse extension</td>
        <td>Planning Permission - Approved</td><td>01/09/2026</td>
      </tr>
    </table>`;
}

test("local planning register parser uses a generic OSM park hint instead of hardcoded application IDs", () => {
  const applications = parsePublicAccessMajorApplications(portalHtml(), listingUrl, ["Fixture Park"]);
  assert.equal(applications.length, 1);
  assert.equal(applications[0].reference, "SMD/2026/0101");
  assert.match(applications[0].documentationUrl, /ApplicationSearchServlet\?PKID=101$/);
  assert.equal(applications[0].source, "local-planning-authority-public-register");
  assert.equal(applications[0].description, "Replacement ride, guest paths and landscaping");
  assert.equal(applications[0].decision, "Planning Permission - Approved");
  assert.equal(applications[0]["received-date"], "17/05/2026");
  assert.equal(applications[0]["valid-date"], "19/05/2026");
  assert.equal(applications[0]["decision-date"], "31/08/2026");
});

test("OSM planning hints include park identity, named rides and named park areas", () => {
  const hints = extractOsmPlanningHints({
    elements: [
      { type: "way", id: 1, tags: { tourism: "theme_park", name: "Fixture Park", "addr:postcode": "ST10 1AA" } },
      { type: "way", id: 2, tags: { roller_coaster: "track", name: "Fixture Fury" } },
      { type: "relation", id: 3, tags: { leisure: "park", name: "Adventure Valley", type: "multipolygon" } },
      { type: "node", id: 4, tags: { tourism: "attraction", name: "Do not use unrelated point attraction" } }
    ]
  });
  assert.deepEqual(hints, ["Fixture Park", "ST10 1AA", "Fixture Fury", "Adventure Valley"]);
});

test("bbox acquisition supplements a zero-result national planning feed from the discovered LPA portal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-planning-lpa-fallback-"));
  const osmPath = path.join(root, "osm.json");
  await writeFile(osmPath, JSON.stringify({
    version: 0.6,
    elements: [{
      type: "way",
      id: 1,
      tags: { tourism: "theme_park", name: "Fixture Park" },
      geometry: [
        { lat: 52.983, lon: -1.899 },
        { lat: 52.983, lon: -1.867 },
        { lat: 52.994, lon: -1.867 },
        { lat: 52.994, lon: -1.899 },
        { lat: 52.983, lon: -1.899 }
      ]
    }]
  }));

  let portalRequests = 0;
  try {
    const sources = await acquireSources({
      bbox: BBOX,
      osm: osmPath,
      elevation: "none",
      cache: path.join(root, "cache"),
      noCache: true,
      planningAcquirerImpl: async () => ({
        provider: "Planning Data / MHCLG (England)",
        providerId: "planning-data-england",
        status: "acquired",
        applicationCount: 0,
        jurisdictionCount: 1,
        applications: [],
        jurisdictions: [{ entity: 999, reference: "E07000198", name: "Staffordshire Moorlands District Council" }]
      }),
      fetchPlanningPortalImpl: async () => {
        portalRequests += 1;
        return {
          ok: true,
          status: 200,
          text: async () => portalHtml()
        };
      }
    });

    assert.equal(portalRequests, 1);
    assert.equal(sources.planning.applicationCount, 1);
    assert.equal(sources.planning.applications[0].reference, "SMD/2026/0101");
    assert.equal(sources.planning.status, "acquired-with-local-portal-fallback");
    assert.equal(sources.planning.coverageStatus, "national-plus-local-portal");
    assert.equal(sources.planning.localPortalFallback.addedApplications, 1);
    assert.equal(sources.planning.applications[0].organisationEntity, 999);
    assert.equal(sources.planning.applications[0].decision, "Planning Permission - Approved");
    assert.ok(sources.planning.osmPlanningDiscovery.anchorCount >= 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
