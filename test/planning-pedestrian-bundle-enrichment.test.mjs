import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { enrichPlanningPedestrianBundle } from "../src/lib/planning-pedestrian-bundle-enrichment.mjs";
import { readNdjson } from "../src/lib/planning-evidence-bundle.mjs";

test("production extraction bundle preserves a labelled ride entrance plaza as path-area evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-plaza-bundle-"));
  try {
    await mkdir(path.join(root, "pages"), { recursive: true });
    const geometryFile = "pages/wicker-p1.geometry.ndjson";
    const candidate = {
      id: "wicker:p1:v0",
      contentHash: "wicker",
      pageNumber: 1,
      classification: "site_plan",
      semantic: "site-feature-or-building-footprint",
      closed: true,
      boundsPt: { minX: 100, minY: 100, maxX: 220, maxY: 190 },
      confidence: 0.48,
      georegistrationRequired: true,
      worldGeometryAuthority: false
    };
    await writeFile(path.join(root, geometryFile), `${JSON.stringify(candidate)}\n`, "utf8");
    const manifest = {
      pages: [{
        contentHash: "wicker",
        pageNumber: 1,
        geometryFile,
        text: {
          items: [
            { text: "WICKER MAN ENTRANCE PLAZA", xPt: 155, yPt: 140 },
            { text: "BUFF RESIN BOUND PAVING", xPt: 155, yPt: 154 }
          ]
        }
      }]
    };

    const summary = await enrichPlanningPedestrianBundle(root, manifest);
    const [enriched] = await readNdjson(path.join(root, geometryFile));
    assert.equal(summary.counts.plaza, 1);
    assert.equal(summary.enrichedCandidates, 1);
    assert.equal(enriched.kind, "path");
    assert.equal(enriched.featureKind, "path");
    assert.equal(enriched.subtype, "pedestrian_plaza");
    assert.equal(enriched.pedestrianEvidence.worldGeometryAuthority, false);
    assert.equal(enriched.pedestrianEvidence.georegistrationRequired, true);
    assert.equal(enriched.pedestrianEvidence.terrainGeometryMutable, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
