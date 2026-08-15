#!/usr/bin/env node
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function parseAcceptanceArgs(argv) {
  const result = {
    root: "acceptance-download",
    report: "park-acceptance-report.json",
    markdown: "PARK_ACCEPTANCE.md"
  };
  const args = [...argv];
  while (args.length) {
    const token = args.shift();
    if (!["--root", "--bbox", "--report", "--markdown"].includes(token)) {
      throw new Error(`Unknown option: ${token}`);
    }
    const value = args.shift();
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
    if (token === "--root") result.root = value;
    else if (token === "--bbox") result.bbox = value;
    else if (token === "--report") result.report = value;
    else if (token === "--markdown") result.markdown = value;
  }
  if (!result.bbox) throw new Error("--bbox is required");
  return result;
}

export async function validateParkGeneration(options) {
  const root = path.resolve(options.root);
  const bbox = parseBbox(options.bbox);
  const files = await walk(root);
  const failures = [];
  const warnings = [];
  const pass = (condition, message) => {
    if (!condition) failures.push(message);
  };
  const warn = (condition, message) => {
    if (!condition) warnings.push(message);
  };

  const generationResultPath = requireNamed(files, "bbox-generation-result.json", failures);
  const buildResultPath = requireNamed(files, "build-result.json", failures);
  const evidencePath = requireNamed(files, "evidence.json", failures);
  const manifestPath = requireNamed(files, "world-manifest.json", failures);
  const planPath = requireNamed(files, "world-shard-plan.json", failures);
  const previewPath = requireNamed(files, "preview.svg", failures);
  const worldPath = files.find((filename) => filename.endsWith(".mcworld")) || null;
  if (!worldPath) failures.push("No .mcworld file was downloaded from the generation run");

  const generation = generationResultPath ? await readJson(generationResultPath) : {};
  const build = buildResultPath ? await readJson(buildResultPath) : {};
  const evidence = evidencePath ? await readJson(evidencePath) : {};
  const manifest = manifestPath ? await readJson(manifestPath) : {};
  const plan = planPath ? await readJson(planPath) : {};
  const finalMapPath = await selectFinalMap(files);
  const finalMap = finalMapPath ? await readJson(finalMapPath) : { features: [] };
  if (!finalMapPath) failures.push("No final fused GeoJSON map was found");

  const features = Array.isArray(finalMap.features) ? finalMap.features : [];
  const kindCounts = countKinds(features);
  const routeLengthM = features
    .filter((feature) => ["path", "road"].includes(feature.properties?.kind))
    .reduce((sum, feature) => sum + geometryLengthM(feature.geometry), 0);
  const rideLengthM = features
    .filter((feature) => feature.properties?.kind === "ride_track")
    .reduce((sum, feature) => sum + geometryLengthM(feature.geometry), 0);
  const buildingCount = (kindCounts.building || 0) + (kindCounts.structure || 0);
  const accessFeatureCount = (kindCounts.path || 0) + (kindCounts.road || 0);
  const rideFeatureCount = kindCounts.ride_track || 0;
  const vegetationCount = kindCounts.vegetation || 0;

  const expectedChunks = approximateBboxChunkCount(bbox);
  const actualChunks = Number(generation.worldChunks || build.stats?.worldChunks || plan.chunkCount || 0);
  const chunkRatio = expectedChunks ? actualChunks / expectedChunks : 0;
  pass(actualChunks > 0, "World generation reported zero chunks");
  pass(chunkRatio >= 0.9,
    `Chunk roster is too small for the requested bbox: ${actualChunks} vs ~${expectedChunks} expected (${chunkRatio.toFixed(3)}x)`);
  pass(chunkRatio <= 1.35,
    `Chunk roster is unexpectedly large for the requested bbox: ${actualChunks} vs ~${expectedChunks} expected (${chunkRatio.toFixed(3)}x)`);
  pass(Number(plan.chunkCount || 0) === actualChunks,
    "World shard plan chunk count does not match generated world chunk count");
  pass(Number(manifest.chunks || 0) === actualChunks,
    "World manifest chunk count does not match generated world chunk count");
  pass(generation.worldValidation === "passed",
    `World validation is ${generation.worldValidation || "missing"}, not passed`);
  pass(manifest.validation?.status === "passed",
    "Assembled world manifest validation did not pass");
  pass(Number(manifest.validation?.chunksVerified || 0) === actualChunks,
    "Merged LevelDB did not verify every planned chunk");

  pass(features.length >= 100, `Final fused park map is suspiciously sparse (${features.length} features)`);
  pass(accessFeatureCount >= 20, `Final map has too few paths/roads (${accessFeatureCount})`);
  pass(buildingCount >= 10, `Final map has too few buildings/structures (${buildingCount})`);
  pass(rideFeatureCount >= 1, "Final map contains no ride_track features");
  pass(routeLengthM >= 1_000, `Mapped access network is too short (${Math.round(routeLengthM)} m)`);
  pass(rideLengthM >= 100, `Mapped ride layout is too short (${Math.round(rideLengthM)} m)`);
  warn(vegetationCount > 0, "No explicit vegetation features were present in the final GeoJSON");
  warn((kindCounts.water || 0) > 0, "No explicit water features were present in the final GeoJSON");

  const generationBoundary = features.find((feature) =>
    feature.properties?.kind === "park_boundary" && feature.properties?.subtype === "generation_bbox");
  pass(Boolean(generationBoundary),
    "Final fused map does not contain the verified bbox generation envelope");

  // Overpass returns complete geometries for ways that intersect the bbox.
  // The world raster clips them through the verified generation envelope, so
  // outside vertices are diagnostic; wholly unrelated features are failures.
  const spatial = summarizeBboxIntersection(features, bbox);
  pass(spatial.entirelyOutsideFeatures === 0,
    `${spatial.entirelyOutsideFeatures} final map features do not intersect the requested bbox at all`);
  warn(spatial.coordinateOutsideRatio <= 0.5,
    `${(spatial.coordinateOutsideRatio * 100).toFixed(2)}% of source-geometry vertices lie outside the bbox because intersecting ways are retained whole`);

  let previewBytes = 0;
  let previewElements = 0;
  let previewCoverage = 0;
  if (previewPath) {
    const svg = await readFile(previewPath, "utf8");
    previewBytes = Buffer.byteLength(svg);
    previewElements = (svg.match(/<(?:path|circle)\b/g) || []).length;
    const renderableFeatures = features.filter((feature) => isRenderableGeometry(feature.geometry)).length;
    previewCoverage = renderableFeatures ? previewElements / renderableFeatures : 0;
    pass(previewBytes > 2_000, `Top-down preview SVG is unexpectedly small (${previewBytes} bytes)`);
    pass(previewElements > 0, "Top-down preview SVG contains no rendered geometry");
    pass(previewCoverage >= 0.95,
      `Top-down preview renders only ${(previewCoverage * 100).toFixed(1)}% of final map features`);
  }

  const qa = {
    pathGeometry: await loadQaLayer(files, "path-geometry-qa.geojson"),
    pathTopology: await loadQaLayer(files, "path-topology-qa.geojson"),
    orthophoto: await loadQaLayer(files, "orthophoto-qa.geojson")
  };
  pass(qa.pathGeometry.available, "Path geometry QA GeoJSON is missing");
  pass(qa.pathTopology.available, "Path topology QA GeoJSON is missing");
  warn(qa.orthophoto.available,
    "Orthophoto QA GeoJSON is missing; imagery-assisted checks were unavailable");

  if (qa.pathGeometry.available) {
    warn(isEvidenceActive(qa.pathGeometry),
      `Path geometry QA is ${qa.pathGeometry.status}${qa.pathGeometry.mode ? ` (mode ${qa.pathGeometry.mode})` : ""}; geometry-level path recovery was not active`);
  }
  if (qa.pathTopology.available) {
    warn(isEvidenceActive(qa.pathTopology),
      `Path topology QA is ${qa.pathTopology.status}${qa.pathTopology.mode ? ` (mode ${qa.pathTopology.mode})` : ""}; topology corroboration was unavailable`);
  }
  if (qa.orthophoto.available) {
    warn(isEvidenceActive(qa.orthophoto),
      `Orthophoto QA is ${qa.orthophoto.status}${qa.orthophoto.mode ? ` (mode ${qa.orthophoto.mode})` : ""}; imagery-assisted path/material checks were unavailable`);
  }

  const elevationProvider = evidence.source?.elevation?.provider || evidence.source?.elevation?.sourceKind || null;
  pass(Boolean(elevationProvider) && elevationProvider !== "none",
    "No elevation/LiDAR provider contributed to the generated park");
  pass(Boolean(evidence.source?.osm), "OSM acquisition evidence is missing");

  const planningSource = evidence.source?.planning || null;
  const planningApplications = firstFinite(
    planningSource?.applicationCount,
    build.stats?.planningApplications,
    0
  );
  const planningAppliedAttributes = Number(
    generation.planningAuthorityAppliedAttributes || build.stats?.planningAuthorityAppliedAttributes || 0
  );
  warn(Boolean(planningSource), "Planning acquisition evidence is missing");
  if (planningSource) {
    warn(planningApplications > 0,
      "Planning discovery returned zero applications; this run has no planning-derived geometry/material authority");
    if (planningApplications > 0) {
      warn(planningAppliedAttributes > 0,
        "Planning applications were discovered but no verified-current planning attributes were applied to the final reconstruction");
    }
  }

  let worldBytes = 0;
  if (worldPath) {
    worldBytes = (await stat(worldPath)).size;
    pass(worldBytes > 10_000, `Generated .mcworld is unexpectedly small (${worldBytes} bytes)`);
  }

  const report = {
    schemaVersion: 2,
    status: failures.length ? "failed" : "passed",
    bbox: options.bbox,
    generatedAt: new Date().toISOString(),
    world: {
      file: worldPath ? path.relative(root, worldPath) : null,
      bytes: worldBytes,
      validation: generation.worldValidation || null,
      chunks: actualChunks,
      approximateBboxChunks: expectedChunks,
      chunkRatio: round(chunkRatio),
      shards: Number(generation.parallelWorldBuild?.shards || manifest.parallelBuild?.shards || 0),
      levelDbEntriesMerged: Number(generation.parallelWorldBuild?.copiedLevelDbEntries || manifest.parallelBuild?.copiedLevelDbEntries || 0)
    },
    dataMap: {
      file: finalMapPath ? path.relative(root, finalMapPath) : null,
      featureCount: features.length,
      kindCounts,
      accessFeatureCount,
      routeLengthM: Math.round(routeLengthM),
      rideFeatureCount,
      rideLengthM: Math.round(rideLengthM),
      buildingCount,
      vegetationCount,
      bboxGenerationEnvelopePresent: Boolean(generationBoundary),
      featuresEntirelyOutsideBbox: spatial.entirelyOutsideFeatures,
      coordinatesOutsideBbox: spatial.outsideCoordinates,
      coordinateCount: spatial.totalCoordinates,
      coordinateOutsideRatio: round(spatial.coordinateOutsideRatio)
    },
    topDownPreview: {
      file: previewPath ? path.relative(root, previewPath) : null,
      bytes: previewBytes,
      renderedFeatureElements: previewElements,
      finalFeatureCoverage: round(previewCoverage)
    },
    qaLayers: qa,
    sources: {
      elevationProvider,
      planning: planningSource ? {
        available: true,
        provider: planningSource.provider || planningSource.sourceKind || null,
        status: planningSource.status || planningSource.acquisitionStatus || "available",
        applications: planningApplications,
        authorityAppliedAttributes: planningAppliedAttributes
      } : {
        available: false,
        provider: null,
        status: "missing",
        applications: 0,
        authorityAppliedAttributes: 0
      },
      confidence: generation.confidence ?? build.confidence ?? null,
      grade: generation.grade ?? build.grade ?? null
    },
    failures,
    warnings
  };

  await writeFile(path.resolve(options.report), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.resolve(options.markdown), buildMarkdown(report));
  return report;
}

function buildMarkdown(report) {
  const lines = [
    `# Park generation acceptance: ${report.status.toUpperCase()}`,
    "",
    `- BBox: \`${report.bbox}\``,
    `- World chunks: **${report.world.chunks.toLocaleString()}** (~${report.world.approximateBboxChunks.toLocaleString()} bbox chunks; ${report.world.chunkRatio}x)`,
    `- World validation: **${report.world.validation || "missing"}**`,
    `- Final map features: **${report.dataMap.featureCount.toLocaleString()}**`,
    `- Paths/roads: **${report.dataMap.accessFeatureCount}** (${report.dataMap.routeLengthM.toLocaleString()} m)`,
    `- Ride track features: **${report.dataMap.rideFeatureCount}** (${report.dataMap.rideLengthM.toLocaleString()} m)`,
    `- Buildings/structures: **${report.dataMap.buildingCount}**`,
    `- Features entirely outside bbox: **${report.dataMap.featuresEntirelyOutsideBbox}**`,
    `- Preview feature coverage: **${(report.topDownPreview.finalFeatureCoverage * 100).toFixed(1)}%**`,
    `- Elevation source: **${report.sources.elevationProvider || "missing"}**`,
    `- Planning applications: **${report.sources.planning.applications}**`,
    `- Planning authority attributes applied: **${report.sources.planning.authorityAppliedAttributes}**`,
    `- Accuracy: **${report.sources.grade || "?"} (${report.sources.confidence ?? "?"})**`,
    "",
    "## QA evidence status",
    "",
    `- Path geometry: **${qaText(report.qaLayers.pathGeometry)}**`,
    `- Path topology: **${qaText(report.qaLayers.pathTopology)}**`,
    `- Orthophoto: **${qaText(report.qaLayers.orthophoto)}**`,
    "",
    "## Layer counts",
    "",
    "```json",
    JSON.stringify(report.dataMap.kindCounts, null, 2),
    "```",
    ""
  ];
  if (report.failures.length) {
    lines.push("## Failures", "", ...report.failures.map((message) => `- ${message}`), "");
  }
  if (report.warnings.length) {
    lines.push("## Fidelity limitations", "", ...report.warnings.map((message) => `- ${message}`), "");
  }
  return `${lines.join("\n")}\n`;
}

function qaText(layer) {
  if (!layer?.available) return "missing";
  return [layer.status, layer.mode ? `mode=${layer.mode}` : null, `${layer.featureCount} features`]
    .filter(Boolean).join(", ");
}

async function loadQaLayer(files, basename) {
  const filename = files.find((candidate) => path.basename(candidate) === basename);
  if (!filename) {
    return { available: false, status: "missing", mode: null, featureCount: 0, file: null };
  }
  try {
    const data = await readJson(filename);
    return {
      available: true,
      status: String(data.status || "supplied"),
      mode: data.mode == null ? null : String(data.mode),
      featureCount: Array.isArray(data.features) ? data.features.length : 0,
      file: filename
    };
  } catch {
    return { available: true, status: "unreadable", mode: null, featureCount: 0, file: filename };
  }
}

function isEvidenceActive(layer) {
  if (!layer?.available) return false;
  const status = String(layer.status || "").toLowerCase();
  const mode = String(layer.mode || "").toLowerCase();
  return !new Set(["missing", "not-supplied", "unavailable", "unreadable", "off", "disabled"])
    .has(status) && !new Set(["off", "disabled", "none"]).has(mode);
}

async function selectFinalMap(files) {
  const candidates = files.filter((filename) =>
    filename.endsWith(".geojson") && !path.basename(filename).includes("-qa"));
  let selected = null;
  let score = -1;
  for (const filename of candidates) {
    try {
      const data = await readJson(filename);
      if (data.type !== "FeatureCollection" || !Array.isArray(data.features)) continue;
      const kinds = countKinds(data.features);
      const candidateScore = data.features.length + ((kinds.park_boundary || 0) ? 10_000 : 0);
      if (candidateScore > score) {
        selected = filename;
        score = candidateScore;
      }
    } catch {
      // Required artifacts are checked separately.
    }
  }
  return selected;
}

function countKinds(features) {
  const result = {};
  for (const feature of features) {
    const kind = feature.properties?.kind || "unknown";
    result[kind] = (result[kind] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

function approximateBboxChunkCount(bbox) {
  const midpoint = (bbox.south + bbox.north) / 2 * Math.PI / 180;
  const heightM = (bbox.north - bbox.south) * 111_320;
  const widthM = (bbox.east - bbox.west) * 111_320 * Math.cos(midpoint);
  return Math.ceil(widthM / 16) * Math.ceil(heightM / 16);
}

function parseBbox(text) {
  const values = String(text).split(",").map(Number);
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
    throw new Error("bbox must be south,west,north,east");
  }
  const [south, west, north, east] = values;
  if (south >= north || west >= east) throw new Error("bbox is reversed");
  return { south, west, north, east };
}

function geometryLengthM(geometry) {
  if (!geometry) return 0;
  if (geometry.type === "LineString") return lineLengthM(geometry.coordinates);
  if (geometry.type === "MultiLineString") {
    return geometry.coordinates.reduce((sum, line) => sum + lineLengthM(line), 0);
  }
  if (geometry.type === "Polygon") {
    return geometry.coordinates.reduce((sum, ring) => sum + lineLengthM(ring), 0);
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.flat().reduce((sum, ring) => sum + lineLengthM(ring), 0);
  }
  return 0;
}

function lineLengthM(line) {
  let total = 0;
  for (let index = 1; index < (line || []).length; index += 1) {
    total += haversineM(line[index - 1], line[index]);
  }
  return total;
}

function haversineM([lon1, lat1], [lon2, lat2]) {
  const radians = Math.PI / 180;
  const p1 = lat1 * radians;
  const p2 = lat2 * radians;
  const dp = (lat2 - lat1) * radians;
  const dl = (lon2 - lon1) * radians;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 6_371_008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function summarizeBboxIntersection(features, bbox) {
  let totalCoordinates = 0;
  let outsideCoordinates = 0;
  let entirelyOutsideFeatures = 0;
  for (const feature of features) {
    const coordinates = flattenCoordinates(feature.geometry?.coordinates);
    if (!coordinates.length) continue;
    totalCoordinates += coordinates.length;
    outsideCoordinates += coordinates.filter(([lon, lat]) =>
      lon < bbox.west || lon > bbox.east || lat < bbox.south || lat > bbox.north).length;
    const west = Math.min(...coordinates.map(([lon]) => lon));
    const east = Math.max(...coordinates.map(([lon]) => lon));
    const south = Math.min(...coordinates.map(([, lat]) => lat));
    const north = Math.max(...coordinates.map(([, lat]) => lat));
    if (east < bbox.west || west > bbox.east || north < bbox.south || south > bbox.north) {
      entirelyOutsideFeatures += 1;
    }
  }
  return {
    totalCoordinates,
    outsideCoordinates,
    coordinateOutsideRatio: totalCoordinates ? outsideCoordinates / totalCoordinates : 0,
    entirelyOutsideFeatures
  };
}

function flattenCoordinates(value, result = []) {
  if (!Array.isArray(value)) return result;
  if (value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
    result.push([value[0], value[1]]);
    return result;
  }
  for (const child of value) flattenCoordinates(child, result);
  return result;
}

function isRenderableGeometry(geometry) {
  return Boolean(geometry && ["Point", "LineString", "Polygon", "MultiLineString", "MultiPolygon"]
    .includes(geometry.type));
}

async function walk(root) {
  const result = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else result.push(filename);
    }
  };
  await visit(root);
  return result;
}

function requireNamed(files, basename, failures) {
  const matches = files.filter((filename) => path.basename(filename) === basename);
  if (!matches.length) {
    failures.push(`Required generation artifact is missing: ${basename}`);
    return null;
  }
  return matches.sort((a, b) => a.length - b.length)[0];
}

function firstFinite(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

const readJson = async (filename) => JSON.parse(await readFile(filename, "utf8"));
const round = (value) => Math.round(Number(value || 0) * 10_000) / 10_000;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseAcceptanceArgs(process.argv.slice(2));
  validateParkGeneration(options).then((report) => {
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "passed") process.exitCode = 1;
  }).catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
