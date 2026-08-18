import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
const P = /["'](minecraft:[a-z0-9_]+)["']/g;
const blocks = (text) => new Set([...text.matchAll(P)].map((m) => m[1]));
const directWorldCore = () => readFile(new URL("../src/lib/mcworld-core.mjs", import.meta.url), "utf8");
test("direct-world module is valid JavaScript", () => {
  for (const relative of ["../src/lib/mcworld.mjs", "../src/lib/mcworld-core.mjs"]) {
    const file = fileURLToPath(new URL(relative, import.meta.url));
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
});
test("appearance palettes are accepted by the direct-world compiler", async () => {
  const [world, ...emitters] = await Promise.all([
    directWorldCore(),
    readFile(new URL("../src/lib/fidelity.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/aerial-appearance.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/raster.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/material-palettes.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/planning-object-renderer.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/ride-structure-renderer.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/natural-tree-geometry.mjs", import.meta.url), "utf8")
  ]);
  const section = world.slice(world.indexOf("const BEDROCK_BLOCKS"), world.indexOf("export const WORLD_PALETTES"));
  const allowed = blocks(section);
  const emitted = new Set(emitters.flatMap((text) => [...blocks(text)]));
  emitted.delete("minecraft:overworld");
  // Stateful slab/stair identifiers are deliberately handled by the post-pass,
  // not the core full-block allowlist. State names are metadata, not block IDs.
  for (const value of [
    "minecraft:corner", "minecraft:vertical_half",
    "minecraft:deepslate_tile_slab", "minecraft:deepslate_tile_stairs",
    "minecraft:deepslate_brick_slab", "minecraft:deepslate_brick_stairs",
    "minecraft:polished_deepslate_slab", "minecraft:polished_deepslate_stairs",
    "minecraft:brick_slab", "minecraft:brick_stairs",
    "minecraft:stone_brick_slab", "minecraft:stone_brick_stairs",
    "minecraft:spruce_slab", "minecraft:spruce_stairs",
    "minecraft:oak_slab", "minecraft:oak_stairs",
    "minecraft:sandstone_slab", "minecraft:sandstone_stairs",
    "minecraft:smooth_sandstone_slab", "minecraft:smooth_sandstone_stairs"
  ]) emitted.delete(value);
  const unsupported = [...emitted].filter((b) => !allowed.has(b)).sort();
  assert.deepEqual(unsupported, []);
});
test("planning timber and ride structure identifiers stay Bedrock-compatible", async () => {
  const [world, materials, rides] = await Promise.all([
    directWorldCore(),
    readFile(new URL("../src/lib/material-palettes.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/ride-structure-renderer.mjs", import.meta.url), "utf8")
  ]);
  const section = world.slice(world.indexOf("const BEDROCK_BLOCKS"), world.indexOf("export const WORLD_PALETTES"));
  const allowed = blocks(section);
  assert.equal(materials.includes("minecraft:stripped_spruce_wood"), true);
  assert.equal(allowed.has("minecraft:stripped_spruce_wood"), true);
  assert.equal(allowed.has("minecraft:stripped_spruce_log"), true);
  assert.equal(allowed.has("minecraft:iron_trapdoor"), true);
  assert.equal(rides.includes("minecraft:bricks"), false);
  assert.equal(rides.includes("minecraft:brick_block"), true);
});
test("stateful building detail remains isolated from the core full-block palette", async () => {
  const wrapper = await readFile(new URL("../src/lib/mcworld.mjs", import.meta.url), "utf8");
  assert.equal(wrapper.includes('from "./mcworld-core.mjs"'), true);
  assert.equal(wrapper.includes("applyStatefulBlockReplacements"), true);
  assert.equal(wrapper.includes("blockDataVersion"), true);
});
test("Java rooted_dirt alias is not emitted", async () => {
  const text = (await Promise.all([
    readFile(new URL("../src/lib/fidelity.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/aerial-appearance.mjs", import.meta.url), "utf8")
  ])).join("\n");
  assert.equal(text.includes("minecraft:rooted_dirt"), false);
});