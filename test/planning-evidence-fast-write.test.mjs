import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { writeEvidencePageStreams } from "../src/lib/planning-evidence-bundle.mjs";
import { writeEvidencePageStreamsFast } from "../src/lib/planning-evidence-fast-write.mjs";

const page = {
  contentHash: "fixture-hash",
  pageNumber: 7,
  classification: "site-plan",
  applicationKeys: ["fixture-app"],
  geometryFile: null,
  verticalFile: null,
  materialFile: null,
  templateFile: null,
  drawingMetadata: []
};

const evidence = {
  geometryCandidates: [
    { id: "g1", semantic: "building-footprint-or-room", localGeometry: { type: "Polygon", coordinates: [[[0, 0], [4, 0], [4, 3], [0, 3], [0, 0]]] } },
    { id: "g2", semantic: "site-edge-or-route", localGeometry: { type: "LineString", coordinates: [[0, 0], [8, 1]] } }
  ],
  verticalObservations: [{ id: "v1", value: 12.4, unit: "m" }],
  materialObservations: [{ id: "m1", canonicalMaterial: "red_tarmac" }],
  rideStructureTemplates: [{ id: "t1", supportCode: "SUP-12", members: [[0, 0], [2, 4]] }],
  drawingMetadata: [{ id: "d1", issueDate: "2026-08-01", contentHash: "fixture-hash", pageNumber: 7 }]
};

test("fast planning evidence writer is byte-for-byte equivalent to the canonical page-stream writer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-fast-evidence-write-"));
  try {
    const canonicalRoot = path.join(root, "canonical");
    const fastRoot = path.join(root, "fast");
    const canonical = await writeEvidencePageStreams(canonicalRoot, page, evidence);
    const fast = await writeEvidencePageStreamsFast(fastRoot, page, evidence);
    assert.deepEqual(fast, canonical);

    for (const field of ["geometryFile", "verticalFile", "materialFile", "templateFile"]) {
      assert.ok(canonical[field]);
      const canonicalBytes = await readFile(path.join(canonicalRoot, canonical[field]));
      const fastBytes = await readFile(path.join(fastRoot, fast[field]));
      assert.deepEqual(fastBytes, canonicalBytes, `${field} bytes differ`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fast writer preserves empty stream fields and drawing metadata exactly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-fast-evidence-empty-"));
  try {
    const emptyEvidence = {
      geometryCandidates: [],
      verticalObservations: [],
      materialObservations: [],
      rideStructureTemplates: [],
      drawingMetadata: evidence.drawingMetadata
    };
    const canonical = await writeEvidencePageStreams(path.join(root, "canonical"), page, emptyEvidence);
    const fast = await writeEvidencePageStreamsFast(path.join(root, "fast"), page, emptyEvidence);
    assert.deepEqual(fast, canonical);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fast writer preserves record order and bytes across forced bounded batches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-fast-evidence-batches-"));
  try {
    const manyGeometryCandidates = Array.from({ length: 500 }, (_, index) => ({
      id: `g-${index}`,
      semantic: "site-edge-or-route",
      localGeometry: { type: "LineString", coordinates: [[index, index + 0.25], [index + 1, index + 1.25]] },
      payload: "x".repeat(256)
    }));
    const largeEvidence = { ...evidence, geometryCandidates: manyGeometryCandidates };
    const canonicalRoot = path.join(root, "canonical");
    const fastRoot = path.join(root, "fast");
    const canonical = await writeEvidencePageStreams(canonicalRoot, page, largeEvidence);
    const fast = await writeEvidencePageStreamsFast(fastRoot, page, largeEvidence, null, { maxBatchBytes: 16 * 1024 });

    assert.deepEqual(fast, canonical);
    const canonicalBytes = await readFile(path.join(canonicalRoot, canonical.geometryFile));
    const fastBytes = await readFile(path.join(fastRoot, fast.geometryFile));
    assert.deepEqual(fastBytes, canonicalBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fast writer writes a single record larger than its preferred batch without aggregating it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-fast-evidence-large-record-"));
  try {
    const largeRecordEvidence = {
      geometryCandidates: [{ id: "large", payload: "z".repeat(64 * 1024) }],
      verticalObservations: [],
      materialObservations: [],
      rideStructureTemplates: [],
      drawingMetadata: []
    };
    const canonicalRoot = path.join(root, "canonical");
    const fastRoot = path.join(root, "fast");
    const canonical = await writeEvidencePageStreams(canonicalRoot, page, largeRecordEvidence);
    const fast = await writeEvidencePageStreamsFast(fastRoot, page, largeRecordEvidence, null, { maxBatchBytes: 16 * 1024 });

    assert.deepEqual(fast, canonical);
    const canonicalBytes = await readFile(path.join(canonicalRoot, canonical.geometryFile));
    const fastBytes = await readFile(path.join(fastRoot, fast.geometryFile));
    assert.deepEqual(fastBytes, canonicalBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
