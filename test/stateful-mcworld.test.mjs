import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LevelDB } from "@8crafter/leveldb-zlib";
import { unzipSync } from "fflate";
import { entryContentTypeToFormatMap, generateChunkKeyFromIndices, offsetToChunkBlockIndex } from "mcbe-leveldb";
import { buildBedrockWorld } from "../src/lib/mcworld.mjs";

test("stateful Bedrock post-pass stores oriented stair states in the finished mcworld", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "voxel-stateful-world-"));
  const unpacked = await mkdtemp(path.join(os.tmpdir(), "voxel-stateful-unpack-"));
  try {
    const compilation = {
      meta: {
        bounds: { minX: 0, minZ: 0, maxX: 15, maxZ: 15 },
        spawnLocal: { x: 1, y: 2, z: 1 },
        statefulBlockReplacements: [{
          x: 1,
          y: 2,
          z: 1,
          name: "minecraft:deepslate_tile_stairs",
          states: {
            "minecraft:corner": "none",
            upside_down_bit: 0,
            weirdo_direction: 0
          },
          kind: "lidar-roof-stair"
        }]
      },
      palette: ["minecraft:deepslate_tiles"],
      chunks: [{ x: 0, z: 0, o: [[2, 1, 2, 1, 1, 2, 1, 0]] }],
      signs: []
    };

    const result = await buildBedrockWorld({
      parkName: "Stateful Fixture",
      slug: "stateful-fixture",
      compilation,
      outputDir,
      options: { baseY: 64, worldMargin: 0, palette: "clean" }
    });

    assert.equal(result.validation.statefulBuildingDetail.replaced, 1);
    const archive = unzipSync(new Uint8Array(await readFile(result.mcworldPath)));
    for (const [name, bytes] of Object.entries(archive)) {
      const target = path.join(unpacked, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }

    const database = new LevelDB(path.join(unpacked, "db"), { createIfMissing: false });
    await database.open();
    try {
      const worldY = 66;
      const subChunkIndex = Math.floor(worldY / 16);
      const raw = await database.get(generateChunkKeyFromIndices({
        x: 0,
        z: 0,
        subChunkIndex,
        dimension: "overworld"
      }, "SubChunkPrefix"));
      const parsed = await entryContentTypeToFormatMap.SubChunkPrefix.parse(raw);
      const layer = parsed.value.layers.value.value[0];
      const offset = offsetToChunkBlockIndex({ x: 1, y: worldY % 16, z: 1 });
      const paletteIndex = layer.block_indices.value.value[offset];
      const block = layer.palette.value[String(paletteIndex)].value;
      assert.equal(block.name.value, "minecraft:deepslate_tile_stairs");
      assert.equal(block.states.value["minecraft:corner"].value, "none");
      assert.equal(block.states.value.upside_down_bit.value, 0);
      assert.equal(block.states.value.weirdo_direction.value, 0);
    } finally {
      await database.close();
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
    await rm(unpacked, { recursive: true, force: true });
  }
});
