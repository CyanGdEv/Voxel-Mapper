import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/lib/args.mjs";

test("planning authority evidence path and conservative match gates parse as developer options", () => {
  const { command, options } = parseArgs([
    "build",
    "--planning-authority-evidence", "planning-current-authority-evidence.json",
    "--planning-authority-min-match-score", "0.7",
    "--planning-authority-ambiguity-gap", "0.09",
    "--planning-authority-point-tolerance-m", "10",
    "--planning-authority-point-ambiguity-m", "1.25"
  ]);
  assert.equal(command, "build");
  assert.equal(options.planningAuthorityEvidence, "planning-current-authority-evidence.json");
  assert.equal(options.planningAuthorityMinMatchScore, 0.7);
  assert.equal(options.planningAuthorityAmbiguityGap, 0.09);
  assert.equal(options.planningAuthorityPointToleranceM, 10);
  assert.equal(options.planningAuthorityPointAmbiguityM, 1.25);
});

test("planning authority score gates reject unsafe values", () => {
  assert.throws(
    () => parseArgs(["build", "--planning-authority-min-match-score", "0.2"]),
    /planning-authority-min-match-score must be between 0.4 and 1/
  );
  assert.throws(
    () => parseArgs(["build", "--planning-authority-ambiguity-gap", "0.8"]),
    /planning-authority-ambiguity-gap must be between 0 and 0.5/
  );
});
