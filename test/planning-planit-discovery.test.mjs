import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  buildPlanItSearchUrl,
  discoverPlanningApplicationsFromPlanIt,
  normalizePlanItRecord
} from "../src/lib/planning-planit-discovery.mjs";
import { augmentPlanningFromLocalPortals } from "../src/lib/planning-lpa-fallback.mjs";

const BBOX = "52.9820,-1.9000,52.9945,-1.8665";

function planItRecord() {
  return {
    address: "Alton Towers Resort, Farley Lane, Alton, Staffordshire ST10 4DB",
    app_state: "Permitted",
    area_id: 142,
    area_name: "Staffordshire Moorlands",
    decided_date: "2018-02-14",
    description: "Theme park ride and associated works",
    link: "https://www.planit.org.uk/planapplic/StaffordshireMoorlands/SMD/2017/0001/",
    location: { type: "Point", coordinates: [-1.885, 52.987] },
    name: "StaffordshireMoorlands/SMD/2017/0001",
    other_fields: {
      date_received: "2017-10-01",
      date_validated: "2017-10-05",
      decision: "Grant",
      status: "Final Decision",
      docs_url: "https://publicaccess.staffsmoorlands.gov.uk/portal/servlets/ApplicationSearchServlet?PKID=777"
    },
    reference: "SMD/2017/0001",
    uid: "SMD/2017/0001",
    url: "https://publicaccess.staffsmoorlands.gov.uk/portal/servlets/ApplicationSearchServlet?PKID=777"
  };
}

test("PlanIt bbox URL uses west,south,east,north and bounded page size", () => {
  const url = buildPlanItSearchUrl("https://www.planit.org.uk/api/applics/json", {
    bbox: BBOX,
    page: 2,
    pageSize: 2500
  });
  assert.equal(url.searchParams.get("bbox"), "-1.9,52.982,-1.8665,52.9945");
  assert.equal(url.searchParams.get("pg_sz"), "300");
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(url.searchParams.get("compress"), "on");
});

test("PlanIt record is navigation evidence only and strips temporal authority", () => {
  const application = normalizePlanItRecord(planItRecord());
  assert.equal(application.reference, "SMD/2017/0001");
  assert.equal(application.source, "planit-discovery-index");
  assert.equal(application.discoveryOnly, true);
  assert.match(application.documentationUrl, /publicaccess\.staffsmoorlands\.gov\.uk/);
  assert.equal(application.decision, undefined);
  assert.equal(application.status, undefined);
  assert.equal(application.decisionDate, undefined);
  assert.equal(application.startDate, undefined);
  assert.deepEqual(application.discoveryLocation, { latitude: 52.987, longitude: -1.885 });
});

test("PlanIt discovery performs one bounded bbox request and caches the page", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-planit-discovery-"));
  let requests = 0;
  try {
    const first = await discoverPlanningApplicationsFromPlanIt({
      bbox: BBOX,
      cacheDir: root,
      maxResults: 2500,
      fetchPlanItImpl: async (url) => {
        requests += 1;
        assert.equal(new URL(url).searchParams.get("pg_sz"), "300");
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ from: 0, to: 0, total: 1, records: [planItRecord()] })
        };
      }
    });
    assert.equal(first.applicationCount, 1);
    assert.equal(first.pagesFetched, 1);
    assert.equal(first.authoritativePlanningMetadata, false);

    const second = await discoverPlanningApplicationsFromPlanIt({
      bbox: BBOX,
      cacheDir: root,
      maxResults: 2500,
      fetchPlanItImpl: async () => { throw new Error("cache was not reused"); }
    });
    assert.equal(second.applicationCount, 1);
    assert.equal(requests, 1);
    assert.equal(second.pages[0].cacheHit, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed Staffordshire register falls back to PlanIt without granting PlanIt temporal authority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-planit-lpa-fallback-"));
  try {
    const planning = {
      providerId: "planning-data-england",
      status: "acquired",
      coverageStatus: "partial-or-unknown",
      applications: [],
      applicationCount: 0,
      jurisdictions: [{ entity: 999, name: "Staffordshire Moorlands LPA" }]
    };
    const osmData = {
      elements: [{ type: "way", id: 1, tags: { tourism: "theme_park", name: "Alton Towers Resort" } }]
    };
    const result = await augmentPlanningFromLocalPortals({
      bbox: BBOX,
      cacheDir: root,
      noCache: true,
      fetchPlanningPortalImpl: async () => { throw new Error("fixture council outage"); },
      fetchPlanItImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ from: 0, to: 0, total: 1, records: [planItRecord()] })
      })
    }, planning, osmData);

    assert.equal(result.applicationCount, 1);
    assert.equal(result.status, "acquired-with-discovery-index-fallback");
    assert.equal(result.coverageStatus, "national-plus-discovery-index");
    assert.equal(result.planningDiscoveryFailure, false);
    assert.equal(result.localPortalFallback.sourceFailure, true);
    assert.equal(result.discoveryIndexFallback.addedApplications, 1);
    assert.equal(result.applications[0].source, "planit-discovery-index");
    assert.equal(result.applications[0].decision, undefined);
    assert.equal(result.applications[0].decisionDate, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
