import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = [
  "scripts/planning-current-state-plan.mjs",
  "scripts/planning-current-state-proof-shard.mjs",
  "scripts/planning-current-state-proof-merge.mjs",
  "scripts/planning-current-state-promote-shard.mjs",
  "scripts/planning-current-state-merge.mjs",
  "scripts/planning-authority-compat-stream.mjs"
];

test("sharded current-state scripts parse under the production Node runtime", () => {
  for (const relative of scripts) {
    const result = spawnSync(process.execPath, ["--check", path.join(root, relative)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${relative} failed node --check:\n${result.stderr || result.stdout}`);
  }
});

test("global current-state stages are manifest-only and never parse page geometry", async () => {
  for (const relative of [
    "scripts/planning-current-state-plan.mjs",
    "scripts/planning-current-state-proof-merge.mjs",
    "scripts/planning-current-state-merge.mjs"
  ]) {
    const source = await readFile(path.join(root, relative), "utf8");
    assert.doesNotMatch(source, /readBundlePage\s*\(/, `${relative} must not materialize page evidence`);
  }
});

test("only shard-local proof and promotion stages materialize registered pages", async () => {
  for (const relative of [
    "scripts/planning-current-state-proof-shard.mjs",
    "scripts/planning-current-state-promote-shard.mjs"
  ]) {
    const source = await readFile(path.join(root, relative), "utf8");
    assert.match(source, /readBundlePage\s*\(/, `${relative} must process its local page stream`);
  }
});

test("authority compatibility output streams NDJSON instead of rebuilding implementation proof", async () => {
  const source = await readFile(path.join(root, "scripts/planning-authority-compat-stream.mjs"), "utf8");
  assert.match(source, /createReadStream/);
  assert.match(source, /for await \(const line of lines\)/);
  assert.doesNotMatch(source, /evaluateImplementedPlanningPage/);
  assert.doesNotMatch(source, /buildImplementedApplicationProof/);
});
