import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { enrichPlanningPedestrianBundle } from "../src/lib/planning-pedestrian-bundle-enrichment.mjs";
import { readNdjson } from "../src/lib/planning-evidence-bundle.mjs";

test("closed explicit Wicker Man plaza on a ride-layout sheet is preserved without retyping track evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-ride-plaza-"));
  try {
    await mkdir(path.join(root, "pages"), { recursive: true });
    const geometryFile = "pages/sw8-p1.geometry.ndjson";
    const plaza = {
      id: "sw8:plaza",
      contentHash: "sw8",
      pageNumber: 1,
      classification: "ride_layout",
      semantic: "ride-centerline-or-edge",
      closed: true,
      boundsPt: { minX: 100, minY: 100, maxX: 210, maxY: 180 },
      confidence: 0.45,
      georegistrationRequired: true,
      worldGeometryAuthority: false
    };
    const track = {
      id: "sw8:track",
      contentHash: "sw8",
      pageNumber: 1,
      classification: "ride_layout",
      semantic: "ride-track-centerline",
      closed: true,
      boundsPt: { minX: 250, minY: 100, maxX: 420, maxY: 280 },
      kind: "ride_track",
      featureKind: "ride_track",
      rideStructureEvidence: { role: "track", subtype: "ride_track_centerline" },
      georegistrationRequired: true,
      worldGeometryAuthority: false
    };
    await writeFile(path.join(root, geometryFile), `${JSON.stringify(plaza)}\n${JSON.stringify(track)}\n`, "utf8");
    const manifest = {
      pages: [{
        contentHash: "sw8",
        pageNumber: 1,
        geometryFile,
        text: { items: [{ text: "WICKER MAN ENTRANCE PLAZA", xPt: 155, yPt: 140 }] }
      }]
    };

    const summary = await enrichPlanningPedestrianBundle(root, manifest);
    const enriched = await readNdjson(path.join(root, geometryFile));
    const enrichedPlaza = enriched.find((entry) => entry.id === "sw8:plaza");
    const enrichedTrack = enriched.find((entry) => entry.id === "sw8:track");
    assert.equal(summary.counts.plaza, 1);
    assert.equal(enrichedPlaza.kind, "path");
    assert.equal(enrichedPlaza.subtype, "pedestrian_plaza");
    assert.equal(enrichedPlaza.tags["area:highway"], "pedestrian");
    assert.equal(enrichedPlaza.pedestrianEvidence.worldGeometryAuthority, false);
    assert.equal(enrichedTrack.kind, "ride_track");
    assert.equal(enrichedTrack.rideStructureEvidence.role, "track");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
