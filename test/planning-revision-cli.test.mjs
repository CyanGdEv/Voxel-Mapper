import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function runNode(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`exit ${code}: ${stderr || stdout}`)));
  });
}

test("planning revision CLI consumes immutable application snapshot and emits authority-scoped evidence", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "voxel-planning-revision-"));
  const registeredFile = path.join(dir, "registered.json");
  const catalogFile = path.join(dir, "catalog.json");
  const queueFile = path.join(dir, "queue.json");
  const reportFile = path.join(dir, "report.json");
  const resolvedFile = path.join(dir, "resolved.json");
  const authorityFile = path.join(dir, "authority.json");

  await writeFile(registeredFile, JSON.stringify({
    worldGeometryReady: true,
    worldGeometryAuthority: false,
    drawingMetadata: [{ contentHash: "doc", pageNumber: 1, drawingNumber: "D-01", revision: "C", status: "as-built" }],
    geometryCandidates: [{ id: "g", contentHash: "doc", pageNumber: 1, coordinateSpace: "local-world-metres", localGeometry: { type: "Polygon", coordinates: [[[0,0],[1,0],[1,1],[0,1],[0,0]]] } }],
    verticalObservations: [], materialObservations: []
  }));
  await writeFile(catalogFile, JSON.stringify({
    applications: { "entity:7": { key: "entity:7", reference: "APP/7" } },
    documents: [{ contentHash: "doc", classification: "site-plan", labels: ["Site plan"], applicationKeys: ["entity:7"], previousContentHashes: [] }]
  }));
  await writeFile(queueFile, JSON.stringify({
    planningApplicationSnapshotAt: "2026-08-15T09:00:00.000Z",
    planningApplicationSnapshotProvider: "planning-data-england",
    planningApplicationSnapshot: {
      "entity:7": { key: "entity:7", reference: "APP/7", temporal: { statusEvidence: ["approved"], dateEvidence: [] } }
    }
  }));

  await runNode([
    path.resolve("scripts/planning-resolve-revisions.mjs"),
    "--registered", registeredFile,
    "--catalog", catalogFile,
    "--queue", queueFile,
    "--out", reportFile,
    "--resolved-out", resolvedFile,
    "--authority-out", authorityFile,
    "--reference-date", "2026-08-15T00:00:00Z"
  ], process.cwd());

  const report = JSON.parse(await readFile(reportFile, "utf8"));
  const resolved = JSON.parse(await readFile(resolvedFile, "utf8"));
  const authority = JSON.parse(await readFile(authorityFile, "utf8"));
  assert.equal(report.status, "resolved");
  assert.equal(report.applicationSnapshotProvider, "planning-data-england");
  assert.equal(report.summary.authoritativeCurrentPages, 1);
  assert.equal(resolved.geometryCandidates[0].worldGeometryAuthority, true);
  assert.equal(resolved.geometryCandidates[0].planningTemporal.state, "current");
  assert.equal(authority.authorityScope, "planning-current-state-only");
  assert.equal(authority.counts.geometryCandidates, 1);
  assert.equal(authority.geometryCandidates[0].id, "g");
  assert.equal(authority.temporalResolutionRequired, false);
});
