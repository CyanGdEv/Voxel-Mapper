#!/usr/bin/env node
import path from "node:path";
import { access, copyFile, mkdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { buildPark } from "../src/lib/pipeline.mjs";
import { writeJson } from "../src/lib/io.mjs";

// The generic compiler defaults to 2.5M 1 m cells, which is appropriate for
// small/manual builds but too low for complete large theme-park bboxes. The
// bbox player workflow has 20-way downstream chunk sharding and a controlled
// hosted-runner environment, so allow a bounded 8M-cell preparation envelope.
// This is still an explicit safety ceiling: very large/accidental bboxes fail
// before allocating unbounded raster state.
export const BBOX_RASTER_SAFETY_LIMIT = 8_000_000;

export function parseGenerateArgs(argv) {
  const result = {
    out: "out/bbox-world",
    cache: ".tpmap-cache",
    authority: "planning-current-authority-evidence.json",
    downloadDir: "world-download"
  };
  const args = [...argv];
  while (args.length) {
    const token = args.shift();
    if (!["--bbox", "--out", "--cache", "--authority", "--download-dir"].includes(token)) {
      throw new Error(`Unknown option: ${token}`);
    }
    const value = args.shift();
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
    if (token === "--bbox") result.bbox = value;
    else if (token === "--out") result.out = value;
    else if (token === "--cache") result.cache = value;
    else if (token === "--authority") result.authority = value;
    else if (token === "--download-dir") result.downloadDir = value;
  }
  if (!result.bbox) throw new Error("--bbox is required");
  return result;
}

export async function buildBboxWorldOptions(args, exists = fileExists, materializeBoundary = true) {
  const authorityPath = path.resolve(args.authority);
  const hasAuthority = await exists(authorityPath);
  const boundaryOverridePath = path.resolve(args.cache, "bbox-world-boundary.geojson");
  if (materializeBoundary) await writeBboxBoundaryOverride(args.bbox, boundaryOverridePath);
  return {
    options: {
      bbox: args.bbox,
      out: path.resolve(args.out),
      cache: path.resolve(args.cache),
      // The player bbox is the world-generation envelope. OSM/planning park
      // boundaries remain evidence features inside this verified override and
      // are not allowed to silently shrink the requested chunk roster.
      override: [boundaryOverridePath],
      maxCells: BBOX_RASTER_SAFETY_LIMIT,
      noAddon: true,
      buildings: "shells",
      accuracyMode: "plausible",
      pathGeometryMode: "repair",
      pathEdgeMode: "evidence",
      pathTerrainMode: "conform",
      terrainDetailMode: "plausible",
      rideTerrainMode: "inferred",
      ...(hasAuthority ? { planningAuthorityEvidence: authorityPath } : {})
    },
    authority: {
      requestedPath: authorityPath,
      available: hasAuthority,
      mode: hasAuthority ? "current-planning-authority" : "lower-authority-fallback"
    },
    generationEnvelope: {
      mode: "bbox",
      path: boundaryOverridePath,
      bbox: args.bbox,
      rasterSafetyLimitCells: BBOX_RASTER_SAFETY_LIMIT
    }
  };
}

export async function writeBboxBoundaryOverride(bboxText, filename) {
  const bbox = parseBboxText(bboxText);
  await mkdir(path.dirname(filename), { recursive: true });
  return writeJson(filename, {
    type: "FeatureCollection",
    name: "Voxel Mapper generation bbox",
    features: [{
      type: "Feature",
      id: "bbox:world-generation-envelope",
      properties: {
        id: "bbox:world-generation-envelope",
        name: "World generation bbox",
        kind: "park_boundary",
        subtype: "generation_bbox",
        verified: true,
        source_name: "User supplied generation bbox",
        license: null
      },
      geometry: {
        type: "Polygon",
        coordinates: [[
          [bbox.west, bbox.south],
          [bbox.east, bbox.south],
          [bbox.east, bbox.north],
          [bbox.west, bbox.north],
          [bbox.west, bbox.south]
        ]]
      }
    }]
  });
}

export function parseBboxText(value) {
  const parts = String(value).split(",").map((entry) => Number(entry.trim()));
  if (parts.length !== 4 || parts.some((entry) => !Number.isFinite(entry))) {
    throw new Error("bbox must be south,west,north,east");
  }
  const [south, west, north, east] = parts;
  if (south < -90 || north > 90 || west < -180 || east > 180 || south >= north || west >= east) {
    throw new Error("bbox coordinates are invalid or reversed");
  }
  return { south, west, north, east };
}

export async function generateBboxWorld(args, progress = (message) => console.error(`• ${message}`)) {
  const handoff = await buildBboxWorldOptions(args);
  progress(handoff.authority.available
    ? "Using verified-current planning authority produced by the bbox planning pipeline"
    : "No current planning authority artifact is available; continuing with lower-authority public evidence");

  const result = await buildPark(handoff.options, progress);
  if (!result?.paths?.world) throw new Error("BBox generation completed without a .mcworld output");

  const downloadDir = path.resolve(args.downloadDir);
  await mkdir(downloadDir, { recursive: true });
  const downloadPath = path.join(downloadDir, path.basename(result.paths.world));
  await copyFile(result.paths.world, downloadPath);

  const summary = {
    schemaVersion: 1,
    bbox: args.bbox,
    generationEnvelope: handoff.generationEnvelope,
    authorityHandoff: handoff.authority,
    generatedWorld: downloadPath,
    worldChunks: result.stats?.worldChunks || 0,
    worldValidation: result.stats?.worldValidation || null,
    planningAuthorityMatchedFeatures: result.stats?.planningAuthorityMatchedFeatures || 0,
    planningAuthorityWinningAttributes: result.stats?.planningAuthorityWinningAttributes || 0,
    planningAuthorityAppliedAttributes: result.stats?.planningAuthorityAppliedAttributes || 0,
    confidence: result.confidence,
    grade: result.grade,
    outputDir: result.outputDir
  };
  await writeJson(path.join(downloadDir, "bbox-generation-result.json"), summary);
  console.log(JSON.stringify(summary, null, 2));
  return { result, summary };
}

async function fileExists(filename) {
  try {
    await access(filename, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generateBboxWorld(parseGenerateArgs(process.argv.slice(2))).catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
