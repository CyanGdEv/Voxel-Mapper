import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  buildPreparationCacheIdentity,
  createStageProfiler
} from "../scripts/prepare-bbox-world-shards.mjs";
import { replayWorldPreparation, validatePreparation } from "../scripts/replay-world-preparation.mjs";
import { planWorldShards } from "../src/lib/world-shards.mjs";
import { writeJson } from "../src/lib/io.mjs";

const compilation = {
  meta: {
    bounds: { minX: 0, minZ: 0, maxX: 63, maxZ: 31 },
    spawnLocal: { x: 8, y: 0, z: 8 }
  },
  palette: ["minecraft:grass_block"],
  chunks: [{ x: 0, z: 0, o: [] }],
  signs: []
};

test("preparation profiler records named build stages without changing progress messages", async () => {
  const messages = [];
  const profiler = createStageProfiler((message) => messages.push(message));
  profiler.progress("Resolving bounded public sources");
  await new Promise((resolve) => setTimeout(resolve, 2));
  profiler.progress("Normalizing map geometry and provenance");
  await new Promise((resolve) => setTimeout(resolve, 2));
  profiler.progress("Build complete");
  const stages = profiler.finish();
  assert.deepEqual(messages, [
    "Resolving bounded public sources",
    "Normalizing map geometry and provenance",
    "Build complete"
  ]);
  assert.deepEqual(stages.map((entry) => entry.stage), [
    "Resolving bounded public sources",
    "Normalizing map geometry and provenance"
  ]);
  assert.ok(stages.every((entry) => Number.isInteger(entry.durationMs) && entry.durationMs >= 0));
});

test("preparation cache identity changes when current-authority bytes change", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-prep-key-"));
  const authority = path.join(root, "authority.json");
  const priorSha = process.env.GITHUB_SHA;
  process.env.GITHUB_SHA = "abc123";
  try {
    await writeFile(authority, "{\"state\":1}\n");
    const args = { bbox: "52.98,-1.90,52.99,-1.88", shards: 20 };
    const handoff = { authority: { available: true, requestedPath: authority } };
    const buildOptions = {
      buildings: "shells",
      accuracyMode: "plausible",
      pathGeometryMode: "repair",
      pathEdgeMode: "evidence",
      pathTerrainMode: "conform",
      terrainDetailMode: "plausible",
      rideTerrainMode: "inferred"
    };
    const first = await buildPreparationCacheIdentity(args, handoff, buildOptions);
    await writeFile(authority, "{\"state\":2}\n");
    const second = await buildPreparationCacheIdentity(args, handoff, buildOptions);
    assert.notEqual(first, second);
  } finally {
    if (priorSha === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = priorSha;
    await rm(root, { recursive: true, force: true });
  }
});

test("cached preparation replay validates the exact shard plan before emitting outputs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-prep-replay-"));
  const summaryPath = path.join(root, "world-preparation.json");
  const planPath = path.join(root, "world-shard-plan.json");
  const githubOutput = path.join(root, "github-output.txt");
  const plan = planWorldShards(compilation, { maxShards: 2, worldMargin: 0 });
  const summary = {
    schemaVersion: 1,
    planHash: plan.planHash,
    worldChunks: plan.chunkCount,
    shardCount: plan.shards.length,
    activeShardIds: plan.activeShardIds
  };
  const previousOutput = process.env.GITHUB_OUTPUT;
  try {
    await writeJson(summaryPath, summary);
    await writeJson(planPath, plan);
    process.env.GITHUB_OUTPUT = githubOutput;
    assert.equal(validatePreparation(summary, plan), true);
    const replay = await replayWorldPreparation({ summary: summaryPath, plan: planPath });
    assert.equal(replay.status, "reused");
    assert.equal(replay.planHash, plan.planHash);
    const outputs = await readFile(githubOutput, "utf8");
    assert.match(outputs, /preparation_reused=true/);
    assert.match(outputs, new RegExp(`plan_hash=${plan.planHash}`));

    const tampered = { ...plan, chunkCount: plan.chunkCount + 1 };
    assert.throws(() => validatePreparation(summary, tampered), /plan hash does not match|chunk count/i);
  } finally {
    if (previousOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = previousOutput;
    await rm(root, { recursive: true, force: true });
  }
});
