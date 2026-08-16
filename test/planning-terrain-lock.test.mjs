import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// This contract test protects the non-negotiable terrain rule at the pipeline
// boundary. Even legacy callers requesting path terrain conformance must be
// reduced to evidence-only before raster compilation.
test("pipeline locks terrain elevation against legacy path conform mode", async () => {
  const source = await readFile(new URL("../src/lib/pipeline.mjs", import.meta.url), "utf8");
  assert.match(source, /pathTerrainMode:\s*options\.pathTerrainMode\s*===\s*"off"\s*\?\s*"off"\s*:\s*"evidence"/);
  assert.match(source, /planningDeformationAllowed:\s*false/);
  assert.match(source, /pathCutFillAllowed:\s*false/);
});
