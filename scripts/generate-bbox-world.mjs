#!/usr/bin/env node
import path from "node:path";
import { access, copyFile, mkdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { buildPark } from "../src/lib/pipeline.mjs";
import { writeJson } from "../src/lib/io.mjs";

// The generic compiler defaults to 2.5M 1 m cells, which is appropriate for
// small/manual builds but too low for complete large theme-park bboxes. The
// bbox player workflow has bounded downstream chunk handling, so allow an 8M
// cell preparation envelope while still rejecting accidental huge selections.
export const BBOX_RASTER_SAFETY_LIMIT = 8_000_000;

export function parseGenerateArgs(argv) {
  const result = {
    out: "out/bbox-world",
    cache: ".tpmap-cache",
    authority: "planning-current-authority-evidence.json",
    downloadDir: "world-download",
    buildings: undefined,
    stable: false
  };
  const args = [...argv];
  while (args.length) {
    const token = args.shift();
    if (token === "--stable") {
      result.stable = true;
      continue;
    }
    if (!["--bbox", "--out", "--cache", "--authority", "--download-dir", "--buildings"].includes(token)) {
      throw new Error(`Unknown option: ${token}`);
    }
    const value = args.shift();
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
    if (token === "--bbox") result.bbox = value;
    else if (token === "--out") result.out = value;
    else if (token === "--cache") result.cache = value;
    else if (token === "--authority") result.authority = value;
    else if (token === "--download-dir") result.downloadDir = value;
    else if (token === "--buildings") result.buildings = value;
  }
  if (!result.bbox) throw new Error("--bbox is required");
  if (result.buildings != null && !["markers", "shells"].includes(result.buildings)) throw new Error("--buildings must be markers or shells");
  return result;
}

export async function buildBboxWorldOptions(args, exists = fileExists, materializeBoundary = true) {
  const stable = args.stable === true;
  // Preserve the established research/generation default of 3D shells. Stable
  // app generation deliberately starts with markers unless the user enables the
  // 3D-building toggle.
  const buildings = args.buildings || (stable ? "markers" : "shells");
  if (!["markers", "shells"].includes(buildings)) throw new Error("buildings must be markers or shells");
  const authorityPath = path.resolve(args.authority || "planning-current-authority-evidence.json");
  const hasAuthority = !stable && await exists(authorityPath);
  const boundaryOverridePath = path.resolve(args.cache, "bbox-world-boundary.geojson");
  if (materializeBoundary) await writeBboxBoundaryOverride(args.bbox, boundaryOverridePath);

  const planningDisabled = async () => ({
    provider: "disabled",
    providerId: null,
    status: "disabled-stable-profile",
    applicationCount: 0,
    jurisdictionCount: 0,
    applications: [],
    jurisdictions: [],
    acquisitionAttempts: []
  });

  return {
    options: {
      bbox: args.bbox,
      out: path.resolve(args.out),
      cache: path.resolve(args.cache),
      // The player bbox is the world-generation envelope. OSM park boundaries
      // remain evidence features inside this verified override and cannot shrink
      // the requested chunk roster.
      override: [boundaryOverridePath],
      maxCells: BBOX_RASTER_SAFETY_LIMIT,
      noAddon: true,
      buildings,
      accuracyMode: "plausible",
      pathGeometryMode: "repair",
      pathEdgeMode: "evidence",
      pathTerrainMode: "conform",
      terrainDetailMode: "plausible",
      rideTerrainMode: "inferred",
      stableMode: stable,
      planningMode: stable ? "off" : "auto",
      ...(stable ? {
        planning: [],
        planningAcquirerImpl: planningDisabled,
        disablePlanItDiscovery: true,
        planningAuthorityEvidence: undefined,
        planningAuthorityEvidenceData: undefined
      } : hasAuthority ? { planningAuthorityEvidence: authorityPath } : {})
    },
    authority: {
      requestedPath: authorityPath,
      available: hasAuthority,
      mode: stable
        ? "disabled-stable-profile"
        : hasAuthority ? "current-planning-authority" : "lower-authority-fallback"
    },
    featureProfile: {
      stable,
      planning: stable ? "disabled" : "automatic",
      buildings3d: buildings === "shells",
      buildingMode: buildings
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
  if (handoff.featureProfile.stable) {
    progress(`Stable profile: planning disabled; 3D buildings ${handoff.featureProfile.buildings3d ? "enabled" : "disabled"}`);
  } else {
    progress(handoff.authority.available
      ? "Using verified-current planning authority produced by the bbox planning pipeline"
      : "No current planning authority artifact is available; continuing with lower-authority public evidence");
  }

  const result = await buildPark(handoff.options, progress);
  if (!result?.paths?.world) throw new Error("BBox generation completed without a .mcworld output");

  const downloadDir = path.resolve(args.downloadDir);
  await mkdir(downloadDir, { recursive: true });
  const downloadPath = path.join(downloadDir, path.basename(result.paths.world));
  await copyFile(result.paths.world, downloadPath);

  const summary = {
    schemaVersion: 2,
    bbox: args.bbox,
    featureProfile: handoff.featureProfile,
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
