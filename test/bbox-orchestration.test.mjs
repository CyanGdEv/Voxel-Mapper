import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  parseGenerateArgs,
  buildBboxWorldOptions
} from "../scripts/generate-bbox-world.mjs";

test("bbox-only orchestration does not require a park name or manual planning flag", async () => {
  const args = parseGenerateArgs(["--bbox", "51.1,-1.2,51.2,-1.0"]);
  const handoff = await buildBboxWorldOptions(args, async () => false);

  assert.equal(handoff.options.bbox, "51.1,-1.2,51.2,-1.0");
  assert.equal(handoff.options.parkName, undefined);
  assert.equal(handoff.options.planningAuthorityEvidence, undefined);
  assert.equal(handoff.options.noAddon, true);
  assert.equal(handoff.options.buildings, "shells");
  assert.equal(handoff.authority.mode, "lower-authority-fallback");
});

test("current authority artifact is automatically handed to world generation when present", async () => {
  const args = parseGenerateArgs([
    "--bbox", "51.1,-1.2,51.2,-1.0",
    "--authority", "planning-current-authority-evidence.json",
    "--out", "out/test-world"
  ]);
  const handoff = await buildBboxWorldOptions(args, async (filename) => filename.endsWith("planning-current-authority-evidence.json"));

  assert.equal(handoff.authority.available, true);
  assert.equal(handoff.authority.mode, "current-planning-authority");
  assert.equal(
    handoff.options.planningAuthorityEvidence,
    path.resolve("planning-current-authority-evidence.json")
  );
});

test("developer-only knobs are not part of the bbox player contract", () => {
  assert.throws(
    () => parseGenerateArgs(["--bbox", "51.1,-1.2,51.2,-1.0", "--planning-authority-min-match-score", "0.7"]),
    /Unknown option/
  );
});
