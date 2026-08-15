const BUILTIN = Object.freeze({
  weathered_asphalt: palette("weathered_asphalt", "Weathered asphalt", "speckled", [
    ["minecraft:gray_wool", 0.45], ["minecraft:gray_concrete", 0.30],
    ["minecraft:light_gray_concrete", 0.15], ["minecraft:andesite", 0.10]
  ]),
  fresh_black_asphalt: palette("fresh_black_asphalt", "Fresh black asphalt", "speckled", [
    ["minecraft:black_concrete", 0.55], ["minecraft:black_wool", 0.25],
    ["minecraft:gray_concrete", 0.15], ["minecraft:smooth_basalt", 0.05]
  ]),
  light_asphalt: palette("light_asphalt", "Light asphalt", "speckled", [
    ["minecraft:light_gray_concrete", 0.45], ["minecraft:gray_wool", 0.30],
    ["minecraft:andesite", 0.15], ["minecraft:stone", 0.10]
  ]),
  red_tarmac: palette("red_tarmac", "Red tarmac", "speckled", [
    ["minecraft:red_concrete", 0.55], ["minecraft:red_terracotta", 0.25],
    ["minecraft:brick_block", 0.10], ["minecraft:brown_terracotta", 0.10]
  ]),
  resin_bound_beige: palette("resin_bound_beige", "Resin-bound beige", "speckled", [
    ["minecraft:smooth_sandstone", 0.40], ["minecraft:sandstone", 0.25],
    ["minecraft:calcite", 0.15], ["minecraft:birch_planks", 0.10],
    ["minecraft:packed_mud", 0.10]
  ]),
  resin_bound_grey: palette("resin_bound_grey", "Resin-bound grey", "speckled", [
    ["minecraft:andesite", 0.35], ["minecraft:light_gray_concrete", 0.30],
    ["minecraft:stone", 0.20], ["minecraft:polished_andesite", 0.10],
    ["minecraft:gray_concrete", 0.05]
  ]),
  concrete: palette("concrete", "Concrete", "mixed", [
    ["minecraft:light_gray_concrete", 0.50], ["minecraft:smooth_stone", 0.25],
    ["minecraft:stone", 0.15], ["minecraft:andesite", 0.10]
  ]),
  old_concrete: palette("old_concrete", "Old concrete", "mixed", [
    ["minecraft:smooth_stone", 0.40], ["minecraft:stone", 0.25],
    ["minecraft:andesite", 0.20], ["minecraft:light_gray_concrete", 0.15]
  ]),
  brick: palette("brick", "Brick", "running_bond", [
    ["minecraft:brick_block", 0.70], ["minecraft:red_terracotta", 0.20],
    ["minecraft:brown_terracotta", 0.10]
  ]),
  stone: palette("stone", "Stone", "mixed", [
    ["minecraft:stone_bricks", 0.45], ["minecraft:andesite", 0.25],
    ["minecraft:tuff", 0.15], ["minecraft:cobblestone", 0.15]
  ]),
  timber: palette("timber", "Timber", "mixed", [
    ["minecraft:spruce_planks", 0.50], ["minecraft:oak_planks", 0.25],
    ["minecraft:dark_oak_planks", 0.15], ["minecraft:stripped_spruce_wood", 0.10]
  ]),
  gravel: palette("gravel", "Gravel", "speckled", [
    ["minecraft:gravel", 0.55], ["minecraft:andesite", 0.20],
    ["minecraft:gray_concrete_powder", 0.15], ["minecraft:tuff", 0.10]
  ]),
  slate_roof: palette("slate_roof", "Slate roof", "mixed", [
    ["minecraft:deepslate_tiles", 0.55], ["minecraft:deepslate_bricks", 0.25],
    ["minecraft:polished_deepslate", 0.20]
  ]),
  clay_tile_roof: palette("clay_tile_roof", "Clay tile roof", "mixed", [
    ["minecraft:brick_block", 0.45], ["minecraft:red_terracotta", 0.35],
    ["minecraft:orange_terracotta", 0.20]
  ]),
  metal_roof: palette("metal_roof", "Metal roof", "stripes", [
    ["minecraft:iron_block", 0.45], ["minecraft:light_gray_concrete", 0.35],
    ["minecraft:smooth_stone", 0.20]
  ]),
  glass: palette("glass", "Glass", "solid", [["minecraft:glass", 1]]),
  grass: palette("grass", "Grass", "organic", [
    ["minecraft:grass_block", 0.70], ["minecraft:moss_block", 0.20],
    ["minecraft:coarse_dirt", 0.10]
  ]),
  earth: palette("earth", "Earth", "organic", [
    ["minecraft:dirt", 0.45], ["minecraft:coarse_dirt", 0.30],
    ["minecraft:packed_mud", 0.15], ["minecraft:dirt_with_roots", 0.10]
  ])
});

const ALIASES = Object.freeze({
  asphalt: "weathered_asphalt", tarmac: "weathered_asphalt", bitmac: "weathered_asphalt",
  "black asphalt": "fresh_black_asphalt", "fresh asphalt": "fresh_black_asphalt",
  "red asphalt": "red_tarmac", "red tarmac": "red_tarmac",
  "resin bound beige": "resin_bound_beige", "resin-bound beige": "resin_bound_beige",
  "resin bound grey": "resin_bound_grey", "resin-bound grey": "resin_bound_grey",
  cement: "concrete", concrete: "concrete", "old concrete": "old_concrete",
  brick: "brick", brickwork: "brick", masonry: "stone", stone: "stone",
  timber: "timber", wood: "timber", wooden: "timber", gravel: "gravel",
  slate: "slate_roof", "slate tile": "slate_roof", "slate tiles": "slate_roof",
  "clay tile": "clay_tile_roof", "clay tiles": "clay_tile_roof", tile: "clay_tile_roof",
  "metal roof": "metal_roof", metal: "metal_roof", steel: "metal_roof",
  glass: "glass", glazing: "glass", grass: "grass", earth: "earth", soil: "earth"
});

export function createMaterialRegistry(records = []) {
  const palettes = new Map(Object.entries(BUILTIN).map(([key, value]) => [key, structuredClone(value)]));
  const aliases = new Map(Object.entries(ALIASES));
  const custom = [];
  for (const record of records || []) {
    if (!record || typeof record !== "object") continue;
    const code = clean(record.code || record.id || record.key);
    if (!code) continue;
    const builtin = resolveBuiltin(record.palette || record.name || record.material || code, palettes, aliases);
    const blocks = normalizeBlocks(record.blocks || record.palette_blocks || record.minecraft_blocks);
    const value = blocks.length
      ? palette(code, record.name || record.description || code, normalizePattern(record.pattern), blocks)
      : builtin ? { ...structuredClone(builtin), key: code, name: record.name || builtin.name }
      : palette(code, record.name || record.description || code, "mixed", [["minecraft:stone", 1]]);
    value.source = "planning-material-schedule";
    value.description = record.description || null;
    value.role = normalizeRole(record.role || record.applies_to || "surface");
    palettes.set(code, value);
    aliases.set(code, code);
    if (record.name) aliases.set(clean(record.name), code);
    if (record.description) aliases.set(clean(record.description), code);
    custom.push(value);
  }
  return { palettes, aliases, custom };
}

export function resolveFeatureMaterialPalettes(feature, registry) {
  if (!registry) return null;
  const tags = feature.tags || {};
  const roles = {};
  const candidates = {
    surface: [tags.surface_material_code, tags.material_code, tags.surface, tags.material],
    wall: [tags.wall_material_code, tags.building_material_code, tags["building:material"], tags.material_code, tags.material],
    roof: [tags.roof_material_code, tags["roof:material"], tags.material_code],
    floor: [tags.floor_material_code, tags.floor_material, tags.material_code],
    barrier: [tags.barrier_material_code, tags.barrier_material, tags.material_code]
  };
  for (const [role, values] of Object.entries(candidates)) {
    const found = values.map((value) => resolveMaterial(value, registry))
      .find((entry) => entry && (!entry.source || entry.role === role));
    if (found) roles[role] = { ...structuredClone(found), role };
  }
  return Object.keys(roles).length ? roles : null;
}

export function primaryMaterialBlock(feature, role, fallback) {
  return feature?.materialPalette?.[role]?.blocks?.[0]?.block || fallback;
}

export function paletteSummary(registry) {
  return {
    schemaVersion: 1,
    builtins: Object.keys(BUILTIN).length,
    custom: registry?.custom?.length || 0,
    customPalettes: (registry?.custom || []).map((entry) => ({
      key: entry.key, name: entry.name, role: entry.role, pattern: entry.pattern, blocks: entry.blocks
    }))
  };
}

function resolveMaterial(value, registry) {
  if (value === null || value === undefined || value === "") return null;
  const key = clean(value);
  const direct = registry.palettes.get(key);
  if (direct) return direct;
  const alias = registry.aliases.get(key);
  if (alias && registry.palettes.has(alias)) return registry.palettes.get(alias);
  for (const [candidate, paletteValue] of registry.palettes.entries()) {
    if (key.includes(candidate.replaceAll("_", " "))) return paletteValue;
  }
  return null;
}

function resolveBuiltin(value, palettes, aliases) {
  const key = clean(value);
  if (palettes.has(key)) return palettes.get(key);
  const alias = aliases.get(key);
  return alias ? palettes.get(alias) : null;
}

function palette(key, name, pattern, pairs) {
  const normalized = normalizeBlocks(pairs);
  return { key, name, pattern: normalizePattern(pattern), blocks: normalized };
}

function normalizeBlocks(value) {
  const raw = Array.isArray(value) ? value : [];
  const result = raw.map((entry) => Array.isArray(entry)
    ? { block: String(entry[0]), weight: Number(entry[1] ?? 1) }
    : { block: String(entry.block || entry.id || ""), weight: Number(entry.weight ?? 1) }
  ).filter((entry) => entry.block.startsWith("minecraft:") && Number.isFinite(entry.weight) && entry.weight > 0);
  const total = result.reduce((sum, entry) => sum + entry.weight, 0) || 1;
  return result.map((entry) => ({ block: entry.block, weight: Math.round(entry.weight / total * 10000) / 10000 }));
}

function normalizePattern(value) {
  const key = clean(value || "mixed").replaceAll(" ", "_");
  if (["solid", "checker", "herringbone", "running_bond", "grid", "slabs", "stripes", "mosaic", "mixed", "speckled", "organic"].includes(key)) return key;
  if (["fine_noise", "noise", "fine-noise"].includes(key)) return "speckled";
  if (["large_subtle_patches", "patches", "large_patches"].includes(key)) return "mixed";
  return "mixed";
}

function normalizeRole(value) {
  const key = clean(value).replaceAll(" ", "_");
  if (["surface", "wall", "roof", "floor", "barrier"].includes(key)) return key;
  return "surface";
}

function clean(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
