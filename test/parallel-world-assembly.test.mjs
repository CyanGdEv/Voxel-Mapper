import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openMcworld } from "@taku128/mcworld-browser";
import { buildBedrockWorld } from "../src/lib/mcworld.mjs";
import { writeJson, readJson } from "../src/lib/io.mjs";
import { createWorldShardBundle, planWorldShards } from "../src/lib/world-shards.mjs";
import { buildWorldShard } from "../scripts/build-world-shard.mjs";
import { assembleWorldShards } from "../scripts/assemble-world-shards.mjs";

function fixtureCompilation() {
  const chunks = [];
  for (let z = 0; z < 2; z += 1) {
    for (let x = 0; x < 2; x += 1) {
      chunks.push({
        x,
        z,
        o: [[1, x * 16 + 2, 1, z * 16 + 2, x * 16 + 3, 2, z * 16 + 3, 0]]
      });
    }
  }
  return {
    palette: ["minecraft:stone"],
    chunks,
    signs: [],
    stats: {},
    meta: {
      bounds: { minX: 0, minZ: 0, maxX: 31, maxZ: 31 },
      spawnLocal: { x: 8, y: 0, z: 8 },
      buildingMode: "shells",
      verticalStats: {},
      topology: null,
      explicitSemantics: null,
      sourceFusion: null
    }
  };
}

test("parallel shard assembly reproduces the monolithic logical LevelDB records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-parallel-world-"));
  try {
    const compilation = fixtureCompilation();
    const parkName = "Parallel Fixture";
    const slug = "parallel-fixture";
    const monolithicDir = path.join(root, "monolithic");
    const monolithic = await buildBedrockWorld({
      parkName,
      slug,
      compilation,
      outputDir: monolithicDir,
      options: { worldMargin: 0, maxWorldChunks: 16, baseY: 8, palette: "clean" }
    });

    const plan = planWorldShards(compilation, { maxShards: 2, worldMargin: 0 });
    const envelope = { schemaVersion: 1, parkName, slug, compilation };
    const shardsRoot = path.join(root, "shards");
    await mkdir(shardsRoot, { recursive: true });
    for (const shard of plan.shards) {
      const bundle = createWorldShardBundle(envelope, plan, shard.id, { baseY: 8, palette: "clean" });
      const input = path.join(root, `shard-${shard.id}.json`);
      const out = path.join(shardsRoot, `shard-${shard.id}`);
      await writeJson(input, bundle);
      await buildWorldShard({ input, out }, () => {});
    }

    const planPath = path.join(root, "world-shard-plan.json");
    const preparationPath = path.join(root, "world-preparation.json");
    const buildResultPath = path.join(root, "build-result.json");
    await writeJson(planPath, plan);
    await writeJson(preparationPath, {
      schemaVersion: 1,
      bbox: "0,0,1,1",
      authorityHandoff: { mode: "lower-authority-fallback" },
      parkName,
      slug,
      planHash: plan.planHash,
      confidence: 1,
      grade: "A",
      planningAuthorityMatchedFeatures: 0,
      planningAuthorityWinningAttributes: 0,
      planningAuthorityAppliedAttributes: 0
    });
    await writeJson(buildResultPath, { parkName, slug, paths: {}, stats: {} });

    const assembledOut = path.join(root, "assembled");
    const downloadDir = path.join(root, "download");
    const assembled = await assembleWorldShards({
      plan: planPath,
      shardsDir: shardsRoot,
      preparation: preparationPath,
      buildResult: buildResultPath,
      out: assembledOut,
      downloadDir
    }, () => {});

    assert.equal(assembled.validation.status, "passed");
    assert.equal(assembled.validation.chunksVerified, 4);
    assert.equal(assembled.manifest.parallelBuild.shards, 2);
    assert.equal(assembled.manifest.chunks, 4);

    const [monolithicEntries, assembledEntries] = await Promise.all([
      logicalEntries(monolithic.mcworldPath),
      logicalEntries(assembled.mcworldPath)
    ]);
    assert.deepEqual(assembledEntries, monolithicEntries);

    const patchedBuild = await readJson(buildResultPath);
    assert.equal(patchedBuild.stats.worldChunks, 4);
    assert.equal(patchedBuild.stats.worldValidation, "passed");
    assert.equal(patchedBuild.stats.worldBuildShards, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function logicalEntries(filename) {
  const bytes = await readFile(filename);
  const world = openMcworld(new Uint8Array(bytes));
  const entries = [];
  for (const entry of world.reader.iterate({ values: true })) {
    entries.push([
      Buffer.from(entry.key).toString("hex"),
      Buffer.from(entry.value).toString("hex")
    ]);
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return entries;
}
