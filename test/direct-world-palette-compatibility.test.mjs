import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
const P = /["'](minecraft:[a-z0-9_]+)["']/g;
const blocks = (text) => new Set([...text.matchAll(P)].map((m) => m[1]));
test("direct-world module is valid JavaScript", () => {
  const file = fileURLToPath(new URL("../src/lib/mcworld.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
test("appearance palettes are accepted by the direct-world compiler", async () => {
  const [world, ...emitters] = await Promise.all([
    readFile(new URL("../src/lib/mcworld.mjs", import.meta.url), "utf8"),
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
  const unsupported = [...emitted].filter((b) => !allowed.has(b)).sort();
  assert.deepEqual(unsupported, []);
});
test("planning timber and ride structure identifiers stay Bedrock-compatible", async () => {
  const [world, materials, rides] = await Promise.all([
    readFile(new URL("../src/lib/mcworld.mjs", import.meta.url), "utf8"),
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
test("Java rooted_dirt alias is not emitted", async () => {
  const text = (await Promise.all([
    readFile(new URL("../src/lib/fidelity.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/aerial-appearance.mjs", import.meta.url), "utf8")
  ])).join("\n");
  assert.equal(text.includes("minecraft:rooted_dirt"), false);
});