import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { LevelDB } from "@8crafter/leveldb-zlib";
import { unzipSync, zipSync } from "fflate";
import { entryContentTypeToFormatMap, generateChunkKeyFromIndices, offsetToChunkBlockIndex } from "mcbe-leveldb";
import { invariant } from "./errors.mjs";
import { buildBedrockWorld as buildBaseBedrockWorld, WORLD_PALETTES } from "./mcworld-core.mjs";

export { WORLD_PALETTES };

/**
 * Preserve the proven direct-world writer, then replace explicitly tagged
 * structural fallback cubes with stateful vanilla Bedrock slabs/stairs.
 * This keeps terrain/chunk generation stable while allowing LiDAR-derived
 * building detail to retain orientation and half-block geometry.
 */
export async function buildBedrockWorld(args) {
  const result = await buildBaseBedrockWorld(args);
  const replacements = args.compilation?.meta?.statefulBlockReplacements || [];
  if (!replacements.length) return result;

  const manifest = JSON.parse(await readFile(result.worldManifestPath, "utf8"));
  const detail = await applyStatefulBlockReplacements({
    mcworldPath: result.mcworldPath,
    replacements,
    baseY: manifest.baseY,
    blockDataVersion: manifest.blockDataVersion
  });

  const archiveBytes = await readFile(result.mcworldPath);
  manifest.archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
  manifest.validation ||= {};
  manifest.validation.statefulBuildingDetail = detail;
  manifest.buildingOutput ||= {};
  manifest.buildingOutput.statefulDetailBlocks = detail.replaced;
  manifest.buildingOutput.statefulDetailVariants = detail.variants;
  await writeFile(result.worldManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  if (result.palettePath) {
    const palette = JSON.parse(await readFile(result.palettePath, "utf8"));
    const emitted = new Set(palette.emittedBlocks || []);
    for (const replacement of replacements) emitted.add(replacement.name);
    palette.emittedBlocks = [...emitted].sort();
    palette.statefulVariants = detail.variants;
    await writeFile(result.palettePath, `${JSON.stringify(palette, null, 2)}\n`);
  }

  result.validation = { ...result.validation, statefulBuildingDetail: detail };
  return result;
}

export async function applyStatefulBlockReplacements({ mcworldPath, replacements, baseY, blockDataVersion }) {
  invariant(Number.isInteger(baseY), "Stateful block replacement requires the Bedrock base Y");
  invariant(Number.isInteger(blockDataVersion), "Stateful block replacement requires a Bedrock block-data version");

  const archive = unzipSync(new Uint8Array(await readFile(mcworldPath)));
  const stage = await mkdtemp(path.join(path.dirname(mcworldPath), ".stateful-blocks-"));
  const databasePath = path.join(stage, "db");
  let database = null;

  try {
    for (const [name, bytes] of Object.entries(archive)) {
      const target = path.join(stage, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }

    database = new LevelDB(databasePath, { createIfMissing: false });
    await database.open();
    const groups = groupBySubchunk(replacements, baseY);
    let replaced = 0;
    const variants = new Map();

    for (const group of groups.values()) {
      const indices = {
        x: group.chunkX,
        z: group.chunkZ,
        subChunkIndex: group.subChunkIndex,
        dimension: "overworld"
      };
      const key = generateChunkKeyFromIndices(indices, "SubChunkPrefix");
      const raw = await database.get(key);
      invariant(raw?.length, `Stateful building detail targets a missing subchunk ${group.chunkX},${group.chunkZ},${group.subChunkIndex}`);
      const parsed = await entryContentTypeToFormatMap.SubChunkPrefix.parse(raw);
      const layer = parsed.value.layers.value.value[0];
      const palette = layer.palette.value;
      const blockIndices = layer.block_indices.value.value;
      const lookup = new Map();

      for (const [index, entry] of Object.entries(palette)) lookup.set(paletteEntryKey(entry), Number(index));

      for (const replacement of group.items) {
        const entry = blockNbt(replacement.name, replacement.states || {}, blockDataVersion);
        const variantKey = paletteEntryKey(entry);
        let paletteIndex = lookup.get(variantKey);
        if (paletteIndex === undefined) {
          paletteIndex = Object.keys(palette).length;
          palette[String(paletteIndex)] = entry;
          lookup.set(variantKey, paletteIndex);
        }
        const localX = floorMod(replacement.x, 16);
        const localY = floorMod(baseY + replacement.y, 16);
        const localZ = floorMod(replacement.z, 16);
        blockIndices[offsetToChunkBlockIndex({ x: localX, y: localY, z: localZ })] = paletteIndex;
        variants.set(variantKey, {
          name: replacement.name,
          states: replacement.states || {},
          kind: replacement.kind || "detail"
        });
        replaced += 1;
      }

      await database.batch([{ type: "put", key, value: entryContentTypeToFormatMap.SubChunkPrefix.serialize(parsed) }]);
    }

    await database.close();
    database = null;

    const rebuilt = {};
    await collectFiles(stage, "", rebuilt);
    const bytes = Buffer.from(zipSync(rebuilt, { level: 6 }));
    const temporary = `${mcworldPath}.stateful-${process.pid}`;
    await writeFile(temporary, bytes);
    await rm(mcworldPath, { force: true });
    await rename(temporary, mcworldPath);

    return {
      schemaVersion: 1,
      status: "passed",
      requested: replacements.length,
      replaced,
      subchunks: groups.size,
      variants: [...variants.values()]
    };
  } finally {
    if (database?.isOpen()) await database.close().catch(() => {});
    await rm(stage, { recursive: true, force: true });
  }
}

function groupBySubchunk(replacements, baseY) {
  const groups = new Map();
  for (const replacement of replacements) {
    invariant(Number.isInteger(replacement?.x) && Number.isInteger(replacement?.y) && Number.isInteger(replacement?.z),
      "Stateful block replacement coordinates must be integer world-grid coordinates");
    invariant(typeof replacement?.name === "string" && replacement.name.startsWith("minecraft:"),
      "Stateful block replacement requires a vanilla Bedrock block identifier");
    const worldY = baseY + replacement.y;
    const chunkX = floorDiv(replacement.x, 16);
    const chunkZ = floorDiv(replacement.z, 16);
    const subChunkIndex = floorDiv(worldY, 16);
    const key = `${chunkX},${chunkZ},${subChunkIndex}`;
    if (!groups.has(key)) groups.set(key, { chunkX, chunkZ, subChunkIndex, items: [] });
    groups.get(key).items.push(replacement);
  }
  return groups;
}

function blockNbt(name, states, blockDataVersion) {
  const typedStates = {};
  for (const [stateName, value] of Object.entries(states)) typedStates[stateName] = typedState(stateName, value);
  return {
    type: "compound",
    value: {
      name: { type: "string", value: name },
      states: { type: "compound", value: typedStates },
      version: { type: "int", value: blockDataVersion }
    }
  };
}

function typedState(name, value) {
  if (name === "upside_down_bit") return { type: "byte", value: value ? 1 : 0 };
  if (name === "weirdo_direction") return { type: "int", value: Number(value) };
  if (typeof value === "string") return { type: "string", value };
  if (Number.isInteger(value)) return { type: "int", value };
  throw new Error(`Unsupported Bedrock block-state value for ${name}`);
}

function paletteEntryKey(entry) {
  const value = entry?.value || {};
  const states = value.states?.value || {};
  const normalized = Object.fromEntries(Object.entries(states).sort(([a], [b]) => a.localeCompare(b)).map(([name, state]) => [name, state?.value]));
  return JSON.stringify([value.name?.value, normalized]);
}

async function collectFiles(directory, prefix, archive) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = path.join(directory, entry.name);
    const archivePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await collectFiles(fullPath, archivePath, archive);
    else archive[archivePath] = new Uint8Array(await readFile(fullPath));
  }
}

const floorDiv = (value, divisor) => Math.floor(value / divisor);
const floorMod = (value, divisor) => ((value % divisor) + divisor) % divisor;
