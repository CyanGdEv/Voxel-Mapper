import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_GITHUB_PLANNING_RUNNER_SHARDS,
  clampGithubPlanningRunnerShards
} from "../src/lib/github-actions-planning-fanout.mjs";

test("GitHub planning runner fanout is capped at four even for stale 256-shard callers", () => {
  assert.equal(MAX_GITHUB_PLANNING_RUNNER_SHARDS, 4);
  assert.equal(clampGithubPlanningRunnerShards(256), 4);
  assert.equal(clampGithubPlanningRunnerShards("256"), 4);
});

test("GitHub planning runner fanout preserves smaller requested shard counts", () => {
  assert.equal(clampGithubPlanningRunnerShards(1), 1);
  assert.equal(clampGithubPlanningRunnerShards(3), 3);
  assert.equal(clampGithubPlanningRunnerShards(4), 4);
});

test("GitHub planning runner fanout clamps larger valid requests to the aggregate-safe cap", () => {
  assert.equal(clampGithubPlanningRunnerShards(5), 4);
  assert.equal(clampGithubPlanningRunnerShards(8), 4);
  assert.equal(clampGithubPlanningRunnerShards(20), 4);
});

test("GitHub planning runner fanout fails safe to the bounded default for invalid values", () => {
  assert.equal(clampGithubPlanningRunnerShards(0), 4);
  assert.equal(clampGithubPlanningRunnerShards(-4), 4);
  assert.equal(clampGithubPlanningRunnerShards("not-a-number"), 4);
});
