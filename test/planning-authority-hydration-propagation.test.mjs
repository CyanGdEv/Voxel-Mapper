import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hydratePlanningAuthorityData } from "../src/lib/planning-authority-fusion.mjs";

test("file-based planning authority is retained on mutable production options for downstream 3D consumers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "planning-authority-hydration-"));
  try {
    const authorityPath = path.join(dir, "authority.json");
    const evidence = {
      schemaVersion: 1,
      verticalObservations: [{ id: "level-1", valueM: 42 }],
      rideStructureTemplates: [{ id: "support-template-1", supportCode: "S1" }]
    };
    await writeFile(authorityPath, JSON.stringify(evidence));
    const options = { planningAuthorityEvidence: authorityPath };

    const hydrated = await hydratePlanningAuthorityData(options);

    assert.equal(hydrated, options);
    assert.deepEqual(options.planningAuthorityEvidenceData, evidence);
    assert.equal(options.planningAuthorityEvidenceData.rideStructureTemplates.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("frozen caller options still receive a hydrated clone", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "planning-authority-hydration-frozen-"));
  try {
    const authorityPath = path.join(dir, "authority.json");
    const evidence = { schemaVersion: 1, rideStructureTemplates: [{ id: "support-template-1" }] };
    await writeFile(authorityPath, JSON.stringify(evidence));
    const options = Object.freeze({ planningAuthorityEvidence: authorityPath });

    const hydrated = await hydratePlanningAuthorityData(options);

    assert.notEqual(hydrated, options);
    assert.deepEqual(hydrated.planningAuthorityEvidenceData, evidence);
    assert.equal(options.planningAuthorityEvidenceData, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
