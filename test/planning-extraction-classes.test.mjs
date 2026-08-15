import test from "node:test";
import assert from "node:assert/strict";
import { normalizeExtractorClass } from "../src/lib/planning-extraction-worker.mjs";

test("planning document classes map to extractor geometry semantics", () => {
  assert.equal(normalizeExtractorClass("site-plan"), "site_plan");
  assert.equal(normalizeExtractorClass("ride-layout"), "ride_layout");
  assert.equal(normalizeExtractorClass("landscape"), "landscape_plan");
  assert.equal(normalizeExtractorClass("demolition"), "demolition_plan");
  assert.equal(normalizeExtractorClass("elevation"), "elevation");
});
