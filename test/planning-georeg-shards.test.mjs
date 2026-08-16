import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  EXTRACTION_BUNDLE_FORMAT,
  REGISTERED_BUNDLE_FORMAT,
  loadBundleManifest,
  writeBundleManifest,
  writeEvidencePageStreams
} from "../src/lib/planning-evidence-bundle.mjs";
import {
  buildPlanningGeoregistrationShardPlan,
  materializePlanningGeoregistrationInputShard,
  mergePlanningGeoregistrationShards,
  planningPageKey
} from "../src/lib/planning-georeg-shards.mjs";

function extractionManifest(pages) {
  return {
    schemaVersion: 1,
    format: EXTRACTION_BUNDLE_FORMAT,
    stage: "merged-extraction",
    coordinateSpace: "pdf-user-space-points",
    georegistrationStatus: "required",
    worldGeometryReady: false,
    documentCount: new Set(pages.map((page) => page.contentHash)).size,
    pageCount: pages.length,
    geometryCandidateCount: pages.reduce((sum, page) => sum + Number(page.geometryCount || 0), 0),
    verticalObservationCount: pages.reduce((sum, page) => sum + Number(page.verticalCount || 0), 0),
    materialObservationCount: pages.reduce((sum, page) => sum + Number(page.materialCount || 0), 0),
    rideStructureTemplateCount: pages.reduce((sum, page) => sum + Number(page.rideStructureTemplateCount || 0), 0),
    documents: [...new Set(pages.map((page) => page.contentHash))].map((contentHash) => ({ contentHash })),
    pages
  };
}

function page(contentHash, pageNumber, geometryCount, verticalCount = 0, materialCount = 0, rideStructureTemplateCount = 0) {
  return {
    contentHash,
    pageNumber,
    classification: "site-plan",
    geometryFile: geometryCount ? `pages/${contentHash}-p${pageNumber}.geometry.ndjson` : null,
    verticalFile: verticalCount ? `pages/${contentHash}-p${pageNumber}.vertical.ndjson` : null,
    materialFile: materialCount ? `pages/${contentHash}-p${pageNumber}.material.ndjson` : null,
    templateFile: rideStructureTemplateCount ? `pages/${contentHash}-p${pageNumber}.ride-structure-template.ndjson` : null,
    geometryCount,
    verticalCount,
    materialCount,
    rideStructureTemplateCount,
    drawingMetadata: []
  };
}

test("georegistration planner deterministically balances expensive pages across the requested runners", () => {
  const pages = [
    page("a", 1, 100),
    page("b", 1, 80),
    page("c", 1, 60),
    page("d", 1, 25),
    page("e", 1, 20),
    page("f", 1, 10),
    page("g", 1, 0, 0, 0, 5)
  ];
  const manifest = extractionManifest(pages);
  const first = buildPlanningGeoregistrationShardPlan(manifest, { shards: 3 });
  const second = buildPlanningGeoregistrationShardPlan(manifest, { shards: 3 });
  assert.deepEqual(first, second);
  assert.deepEqual(first.activeShards, [0, 1, 2]);
  assert.equal(Object.keys(first.assignments).length, pages.length);
  const allKeys = first.shards.flatMap((shard) => shard.pageKeys);
  assert.equal(new Set(allKeys).size, pages.length);
  assert.deepEqual([...allKeys].sort(), pages.map(planningPageKey).sort());
  assert.ok(first.maxShardWeight < first.totalWeight, "no single runner receives the whole georegistration workload");
});

test("georegistration input materialization copies only the pages assigned to that shard", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-georeg-shard-input-"));
  try {
    const evidenceRoot = path.join(root, "evidence");
    await mkdir(path.join(evidenceRoot, "pages"), { recursive: true });
    const pages = [page("a", 1, 5), page("b", 1, 4), page("c", 1, 3), page("d", 1, 2)];
    for (const entry of pages) {
      await writeFile(path.join(evidenceRoot, entry.geometryFile), `${JSON.stringify({ id: planningPageKey(entry) })}\n`);
    }
    await writeBundleManifest(evidenceRoot, extractionManifest(pages));
    const plan = buildPlanningGeoregistrationShardPlan(extractionManifest(pages), { shards: 2 });
    const result = await materializePlanningGeoregistrationInputShard(evidenceRoot, plan, 0, path.join(root, "shard-0"));
    const expected = new Set(plan.shards[0].pageKeys);
    assert.equal(result.manifest.pageCount, expected.size);
    assert.ok(result.manifest.pages.every((entry) => expected.has(planningPageKey(entry))));
    for (const entry of result.manifest.pages) {
      const text = await readFile(path.join(result.outDir, entry.geometryFile), "utf8");
      assert.match(text, /"id"/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parallel registered bundles merge back into one deterministic downstream authority input", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-georeg-shard-merge-"));
  try {
    const shardsRoot = path.join(root, "shards");
    const shard0 = path.join(shardsRoot, "artifact-0", "planning-registered-evidence-shard-0");
    const shard1 = path.join(shardsRoot, "artifact-1", "planning-registered-evidence-shard-1");
    await mkdir(shard0, { recursive: true });
    await mkdir(shard1, { recursive: true });

    const p1 = await writeEvidencePageStreams(shard0, page("a", 1, 1), {
      geometryCandidates: [{ id: "g-a" }], verticalObservations: [], materialObservations: [], rideStructureTemplates: [], drawingMetadata: []
    });
    p1.georegistrationStatus = "registered";
    const p2 = await writeEvidencePageStreams(shard0, page("b", 1, 0, 0, 0, 1), {
      geometryCandidates: [], verticalObservations: [], materialObservations: [], rideStructureTemplates: [{ id: "t-b" }], drawingMetadata: []
    });
    p2.georegistrationStatus = "template-only";
    const p4 = await writeEvidencePageStreams(shard1, page("d", 1, 1), {
      geometryCandidates: [{ id: "g-d" }], verticalObservations: [], materialObservations: [], rideStructureTemplates: [], drawingMetadata: []
    });
    p4.georegistrationStatus = "registered";

    await writeBundleManifest(shard0, {
      schemaVersion: 1,
      format: REGISTERED_BUNDLE_FORMAT,
      stage: "registered",
      coordinateSpace: "local-world-metres-plus-nonspatial-templates",
      georegistrationStatus: "partially-registered",
      registeredPageCount: 1,
      templateOnlyPageCount: 1,
      unregisteredPageCount: 1,
      geometryCandidateCount: 1,
      verticalObservationCount: 0,
      materialObservationCount: 0,
      rideStructureTemplateCount: 1,
      pages: [p1, p2],
      unregisteredPages: [{ contentHash: "c", pageNumber: 1, classification: "site-plan", rejectionReasons: ["registration-failed"] }]
    });
    await writeBundleManifest(shard1, {
      schemaVersion: 1,
      format: REGISTERED_BUNDLE_FORMAT,
      stage: "registered",
      coordinateSpace: "local-world-metres-plus-nonspatial-templates",
      georegistrationStatus: "registered",
      registeredPageCount: 1,
      templateOnlyPageCount: 0,
      unregisteredPageCount: 0,
      geometryCandidateCount: 1,
      verticalObservationCount: 0,
      materialObservationCount: 0,
      rideStructureTemplateCount: 0,
      pages: [p4],
      unregisteredPages: []
    });

    await writeFile(path.join(shardsRoot, "artifact-0", "planning-georegistration-shard-0.json"), JSON.stringify({
      registrations: [
        { contentHash: "a", pageNumber: 1, status: "registered" },
        { contentHash: "b", pageNumber: 1, status: "template-only" },
        { contentHash: "c", pageNumber: 1, status: "unregistered" }
      ]
    }));
    await writeFile(path.join(shardsRoot, "artifact-1", "planning-georegistration-shard-1.json"), JSON.stringify({
      registrations: [{ contentHash: "d", pageNumber: 1, status: "registered" }]
    }));

    const merged = await mergePlanningGeoregistrationShards(shardsRoot, path.join(root, "merged"));
    assert.equal(merged.report.status, "partially-registered");
    assert.equal(merged.manifest.registeredPageCount, 2);
    assert.equal(merged.manifest.templateOnlyPageCount, 1);
    assert.equal(merged.manifest.unregisteredPageCount, 1);
    assert.equal(merged.manifest.geometryCandidateCount, 2);
    assert.equal(merged.manifest.pages.length, 3);
    assert.equal(merged.report.registrations.length, 4);
    const reloaded = await loadBundleManifest(path.join(root, "merged"), REGISTERED_BUNDLE_FORMAT);
    assert.equal(reloaded.manifest.parallelGeoregistration.enabled, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
