import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

function candidate() {
  return {
    id: "doc:p1:v0", contentHash: "doc", pageNumber: 1,
    semantic: "building-footprint-or-room", closed: true,
    coordinateSpace: "pdf-user-space-points", georegistrationRequired: true,
    commands: [
      { op: "M", x: 0, y: 0 }, { op: "L", x: 100, y: 0 },
      { op: "L", x: 100, y: 50 }, { op: "L", x: 0, y: 50 }, { op: "Z" }
    ]
  };
}

test("planning georegistration CLI writes QA and spatially registered evidence artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-georeg-cli-"));
  try {
    const evidence = path.join(root, "evidence.json");
    const reference = path.join(root, "reference.json");
    const controls = path.join(root, "controls.json");
    const report = path.join(root, "report.json");
    const registered = path.join(root, "registered.json");
    await writeFile(evidence, JSON.stringify({
      normalizedEvidence: {
        geometryCandidates: [candidate()],
        verticalObservations: [], materialObservations: [], drawingMetadata: []
      }
    }));
    await writeFile(reference, JSON.stringify({ provider: "synthetic", featureCount: 0, features: [] }));
    const points = [[0, 0], [100, 0], [100, 50], [0, 50]];
    await writeFile(controls, JSON.stringify({ controlPoints: points.map(([x, y]) => ({
      contentHash: "doc", pageNumber: 1,
      source: [x, y], target: [20 + x * 0.04, 30 + y * 0.04]
    })) }));
    const result = await runNode([
      "scripts/planning-georegister.mjs",
      "--evidence", evidence,
      "--reference", reference,
      "--control-points", controls,
      "--out", report,
      "--registered-out", registered,
      "--min-inliers", "4",
      "--max-rmse-m", "0.01",
      "--max-residual-m", "0.01"
    ]);
    assert.equal(result.code, 0, result.stderr);
    const qa = JSON.parse(await readFile(report, "utf8"));
    const spatial = JSON.parse(await readFile(registered, "utf8"));
    assert.equal(qa.status, "registered");
    assert.equal(qa.registeredGroupCount, 1);
    assert.equal(spatial.worldGeometryReady, true);
    assert.equal(spatial.worldGeometryAuthority, false);
    assert.equal(spatial.geometryCandidates[0].coordinateSpace, "local-world-metres");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
