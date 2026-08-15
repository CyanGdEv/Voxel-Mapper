#!/usr/bin/env node
import path from "node:path";
import { access, copyFile, mkdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { buildPark } from "../src/lib/pipeline.mjs";
import { writeJson } from "../src/lib/io.mjs";

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

export async function buildBboxWorldOptions(args, exists = fileExists) {
  const authorityPath = path.resolve(args.authority);
  const hasAuthority = await exists(authorityPath);
  return {
    options: {
      bbox: args.bbox,
      out: path.resolve(args.out),
      cache: path.resolve(args.cache),
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
    }
  };
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
