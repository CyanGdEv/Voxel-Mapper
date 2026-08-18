import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("real park acceptance enforces the ride and plaza production gate", async () => {
  const workflow = await readFile(".github/workflows/park-generation-acceptance.yml", "utf8");
  assert.match(workflow, /validate-ride-plaza-production\.mjs/);
  assert.match(workflow, /RIDE_PLAZA_PRODUCTION\.md/);
  assert.match(workflow, /ride-plaza-production-report\.json/);
  assert.match(workflow, /Require complete 3D rides and planning-derived access surfaces/);
});
