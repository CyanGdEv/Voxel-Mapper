#!/usr/bin/env node
import path from "node:path";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { openMcworld } from "@taku128/mcworld-browser";
import { createProjector } from "../src/lib/geo.mjs";

export function parseBedrockContentArgs(argv) {
  const result = { root: "acceptance-download", report: "bedrock-content-qa.json", markdown: "BEDROCK_CONTENT_QA.md" };
  const args = [...argv];
  while (args.length) {
    const token = args.shift();
    if (!["--root", "--report", "--markdown"].includes(token)) throw new Error(`Unknown option: ${token}`);
    const value = args.shift();
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
    if (token === "--root") result.root = value;
    else if (token === "--report") result.report = value;
    else result.markdown = value;
  }
  return result;
}

export async function validateBedrockContent(options = {}) {
  const root = path.resolve(options.root || "acceptance-download");
  const files = await walk(root);
  const failures = [];
  const warnings = [];
  const worldPath = files.find((filename) => filename.endsWith(".mcworld"));
  const evidencePath = selectNamed(files, "evidence.json");
  const mapPath = await selectFinalMap(files);
  if (!worldPath) failures.push("No .mcworld file is available for decoded content QA");
  if (!evidencePath) failures.push("No evidence.json is available for decoded content QA");
  if (!mapPath) failures.push("No final fused GeoJSON map is available for decoded content QA");

  if (failures.length) return finishReport(options, { schemaVersion: 1, status: "failed", failures, warnings });

  const [worldBytes, evidence, finalMap] = await Promise.all([
    readFile(worldPath),
    readJson(evidencePath),
    readJson(mapPath)
  ]);
  const compilation = evidence.compilation?.meta || {};
  const bounds = compilation.bounds || {};
  const baseY = Number(compilation.baseY ?? 64);
  const elevation = evidence.source?.elevation || {};
  const sourceReliefM = finiteRange(elevation.minM, elevation.maxM);
  const maxScanY = Math.min(319, Math.max(baseY + 32, baseY + Math.ceil(sourceReliefM || 0) + 32));

  for (const key of ["minX", "maxX", "minZ", "maxZ"]) {
    if (!Number.isFinite(Number(bounds[key]))) failures.push(`Compilation bounds are missing ${key}`);
  }
  if (failures.length) return finishReport(options, { schemaVersion: 1, status: "failed", failures, warnings });

  const world = openMcworld(new Uint8Array(worldBytes));
  const blockNameCache = new Map();
  const readBlockName = (x, y, z) => {
    const key = `${x},${y},${z}`;
    if (blockNameCache.has(key)) return blockNameCache.get(key);
    const decoded = world.readBlocks({ minX: x, maxX: x, minY: y, maxY: y, minZ: z, maxZ: z });
    const entry = decoded.blocks?.[0];
    const name = entry ? decoded.palette?.[entry.state]?.Name || "minecraft:air" : "minecraft:air";
    blockNameCache.set(key, name);
    return name;
  };
  const terrainSurfaceY = (x, z) => {
    if (isAir(readBlockName(x, baseY, z))) return null;
    let top = baseY;
    for (let y = baseY + 1; y <= maxScanY; y += 1) {
      if (isAir(readBlockName(x, y, z))) break;
      top = y;
    }
    return top;
  };

  const grid = gridPoints(bounds, 7);
  const terrainSamples = grid.map(({ x, z }) => ({ x, z, y: terrainSurfaceY(x, z) }))
    .filter((sample) => Number.isFinite(sample.y));
  const heights = terrainSamples.map((sample) => sample.y);
  const decodedReliefBlocks = heights.length ? Math.max(...heights) - Math.min(...heights) : 0;
  const distinctSurfaceHeights = new Set(heights).size;
  const baseYFraction = heights.length ? heights.filter((height) => height === baseY).length / heights.length : 1;
  const minimumExpectedRelief = sourceReliefM >= 20 ? 5 : sourceReliefM >= 5 ? 2 : 0;

  if (terrainSamples.length < Math.max(9, Math.floor(grid.length * 0.5))) {
    failures.push(`Too few decoded terrain columns were found (${terrainSamples.length}/${grid.length})`);
  }
  if (minimumExpectedRelief > 0 && decodedReliefBlocks < minimumExpectedRelief) {
    failures.push(
      `Decoded world is effectively flat: ${decodedReliefBlocks} blocks of sampled relief despite ${sourceReliefM.toFixed(1)} m source-elevation relief`
    );
  }
  if (minimumExpectedRelief > 0 && distinctSurfaceHeights < 3) {
    failures.push(`Decoded terrain has only ${distinctSurfaceHeights} distinct sampled surface heights`);
  }
  if (sourceReliefM >= 20 && baseYFraction > 0.9) {
    failures.push(`${(baseYFraction * 100).toFixed(1)}% of decoded terrain samples stop at the flat foundation Y=${baseY}`);
  }

  const spawnRelativeY = Number(compilation.spawnLocal?.y);
  if (sourceReliefM >= 5 && Number.isFinite(spawnRelativeY) && spawnRelativeY < -2) {
    failures.push(
      `Mapped spawn/path surface is ${spawnRelativeY} blocks below the elevation datum; terrain/features are likely buried beneath the foundation`
    );
  }

  const pathResult = validateMappedPathSurfaces({
    finalMap,
    compilation,
    terrainSurfaceY,
    readBlockName,
    bounds
  });
  if (pathResult.eligibleFeatures >= 5) {
    if (pathResult.matchedFeatures < Math.min(5, Math.ceil(pathResult.eligibleFeatures * 0.2))) {
      failures.push(
        `Only ${pathResult.matchedFeatures}/${pathResult.eligibleFeatures} sampled mapped paths/roads expose their expected Minecraft surface palette`
      );
    }
  } else {
    warnings.push(`Only ${pathResult.eligibleFeatures} simple mapped path/road features were eligible for decoded palette QA`);
  }

  const report = {
    schemaVersion: 1,
    status: failures.length ? "failed" : "passed",
    world: {
      file: path.relative(root, worldPath),
      bytes: (await stat(worldPath)).size,
      baseY,
      maxScanY
    },
    terrain: {
      provider: elevation.provider || elevation.sourceKind || null,
      sourceMinM: finiteOrNull(elevation.minM),
      sourceMaxM: finiteOrNull(elevation.maxM),
      sourceReliefM: round(sourceReliefM),
      sampledColumns: terrainSamples.length,
      decodedMinSurfaceY: heights.length ? Math.min(...heights) : null,
      decodedMaxSurfaceY: heights.length ? Math.max(...heights) : null,
      decodedReliefBlocks,
      distinctSurfaceHeights,
      foundationSurfaceFraction: round(baseYFraction),
      spawnRelativeY: Number.isFinite(spawnRelativeY) ? spawnRelativeY : null,
      samples: terrainSamples
    },
    mappedSurfaceQa: pathResult,
    failures,
    warnings
  };
  return finishReport(options, report);
}

function validateMappedPathSurfaces({ finalMap, compilation, terrainSurfaceY, readBlockName, bounds }) {
  const center = compilation.projectionCenter || {};
  if (!Number.isFinite(center.lon) || !Number.isFinite(center.lat)) {
    return { eligibleFeatures: 0, matchedFeatures: 0, matchRatio: 0, samples: [], reason: "projection-center-missing" };
  }
  const projector = createProjector({ lon: center.lon, lat: center.lat });
  const candidates = (finalMap.features || []).filter((feature) => {
    const props = feature.properties || {};
    const fidelity = props._fidelity?.path;
    return ["path", "road"].includes(props.kind) &&
      feature.geometry?.type === "LineString" &&
      Array.isArray(feature.geometry.coordinates) && feature.geometry.coordinates.length >= 2 &&
      fidelity && !fidelity.bridge && !fidelity.tunnel && Number(props.layer || 0) === 0;
  });
  const samples = [];
  for (const feature of evenlySelect(candidates, 24)) {
    const coords = feature.geometry.coordinates;
    const coordinate = coords[Math.floor(coords.length / 2)];
    if (!Array.isArray(coordinate) || coordinate.length < 2) continue;
    const [localX, localZ] = projector.forward([Number(coordinate[0]), Number(coordinate[1])]);
    const centerX = Math.round(localX);
    const centerZ = Math.round(localZ);
    if (!insideBounds(centerX, centerZ, bounds)) continue;
    const expected = expectedPathBlocks(feature.properties?._fidelity?.path?.surfaceStyle);
    if (!expected.size) continue;
    let matched = false;
    let observed = null;
    let observedAt = null;
    for (let dx = -2; dx <= 2 && !matched; dx += 1) {
      for (let dz = -2; dz <= 2 && !matched; dz += 1) {
        const x = centerX + dx;
        const z = centerZ + dz;
        if (!insideBounds(x, z, bounds)) continue;
        const y = terrainSurfaceY(x, z);
        if (!Number.isFinite(y)) continue;
        const name = readBlockName(x, y, z);
        observed ||= name;
        observedAt ||= { x, y, z };
        if (expected.has(name)) {
          matched = true;
          observed = name;
          observedAt = { x, y, z };
        }
      }
    }
    samples.push({
      featureId: feature.properties?.id || feature.id || null,
      kind: feature.properties?.kind || null,
      expected: [...expected],
      observed,
      observedAt,
      matched
    });
  }
  const matchedFeatures = samples.filter((sample) => sample.matched).length;
  return {
    eligibleFeatures: samples.length,
    matchedFeatures,
    matchRatio: samples.length ? round(matchedFeatures / samples.length) : 0,
    samples
  };
}

function expectedPathBlocks(style) {
  const values = [style?.primaryBlock, style?.secondaryBlock, style?.tertiaryBlock, ...(style?.paletteBlocks || [])];
  return new Set(values.map(normalizeBlockName).filter(Boolean));
}

function normalizeBlockName(value) {
  if (!value) return null;
  const text = String(value);
  return text.includes(":") ? text : `minecraft:${text}`;
}

function gridPoints(bounds, size) {
  const marginX = Math.min(16, Math.max(0, Math.floor((Number(bounds.maxX) - Number(bounds.minX)) / 10)));
  const marginZ = Math.min(16, Math.max(0, Math.floor((Number(bounds.maxZ) - Number(bounds.minZ)) / 10)));
  const minX = Math.ceil(Number(bounds.minX)) + marginX;
  const maxX = Math.floor(Number(bounds.maxX)) - marginX;
  const minZ = Math.ceil(Number(bounds.minZ)) + marginZ;
  const maxZ = Math.floor(Number(bounds.maxZ)) - marginZ;
  const result = [];
  for (let ix = 0; ix < size; ix += 1) {
    for (let iz = 0; iz < size; iz += 1) {
      const x = Math.round(minX + (ix / Math.max(1, size - 1)) * (maxX - minX));
      const z = Math.round(minZ + (iz / Math.max(1, size - 1)) * (maxZ - minZ));
      result.push({ x, z });
    }
  }
  return result;
}

function evenlySelect(values, limit) {
  if (values.length <= limit) return values;
  return Array.from({ length: limit }, (_, index) => values[Math.floor((index / limit) * values.length)]);
}

function insideBounds(x, z, bounds) {
  return x >= Number(bounds.minX) && x <= Number(bounds.maxX) && z >= Number(bounds.minZ) && z <= Number(bounds.maxZ);
}

function isAir(name) {
  return !name || name === "minecraft:air" || name === "air";
}

function finiteRange(min, max) {
  const a = Number(min);
  const b = Number(max);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : 0;
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value) {
  return Math.round(Number(value) * 10_000) / 10_000;
}

async function selectFinalMap(files) {
  const candidates = files.filter((filename) => filename.endsWith(".geojson") && !/qa\.geojson$/i.test(filename));
  let best = null;
  let bestCount = -1;
  for (const filename of candidates) {
    try {
      const data = await readJson(filename);
      const count = Array.isArray(data.features) ? data.features.length : -1;
      if (count > bestCount) {
        best = filename;
        bestCount = count;
      }
    } catch {}
  }
  return best;
}

function selectNamed(files, basename) {
  const matches = files.filter((filename) => path.basename(filename) === basename);
  return matches.sort((a, b) => a.length - b.length)[0] || null;
}

async function walk(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) result.push(filename);
    }
  }
  await visit(root);
  return result;
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

async function finishReport(options, report) {
  const reportPath = path.resolve(options.report || "bedrock-content-qa.json");
  const markdownPath = path.resolve(options.markdown || "BEDROCK_CONTENT_QA.md");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const lines = [
    `# Decoded Bedrock content QA: ${String(report.status || "failed").toUpperCase()}`,
    "",
    report.terrain ? `- Source elevation relief: **${report.terrain.sourceReliefM} m**` : null,
    report.terrain ? `- Decoded sampled relief: **${report.terrain.decodedReliefBlocks} blocks** across ${report.terrain.sampledColumns} columns` : null,
    report.terrain ? `- Flat-foundation sample fraction: **${(report.terrain.foundationSurfaceFraction * 100).toFixed(1)}%**` : null,
    report.mappedSurfaceQa ? `- Mapped path/road palette matches: **${report.mappedSurfaceQa.matchedFeatures}/${report.mappedSurfaceQa.eligibleFeatures}**` : null,
    ""
  ].filter((line) => line != null);
  if (report.failures?.length) lines.push("## Failures", "", ...report.failures.map((value) => `- ${value}`), "");
  if (report.warnings?.length) lines.push("## Warnings", "", ...report.warnings.map((value) => `- ${value}`), "");
  await writeFile(markdownPath, `${lines.join("\n")}\n`);
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseBedrockContentArgs(process.argv.slice(2));
  validateBedrockContent(args).then((report) => {
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "passed") process.exitCode = 1;
  }).catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
