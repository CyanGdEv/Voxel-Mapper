#!/usr/bin/env node
import path from "node:path";
import { readFile } from "node:fs/promises";
import { readBundlePage, loadBundleManifest, AUTHORITY_BUNDLE_FORMAT } from "../src/lib/planning-evidence-bundle.mjs";
import { writeJson } from "../src/lib/io.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.manifest || !args.out) {
  console.error("Usage: planning-authority-compat.mjs --manifest planning-current-authority-evidence.json --out FILE");
  process.exit(2);
}

const pointerPath = path.resolve(args.manifest);
const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
if (pointer.format !== AUTHORITY_BUNDLE_FORMAT) throw new Error(`Unsupported authority manifest format: ${pointer.format || "unknown"}`);
const bundleRoot = path.resolve(path.dirname(pointerPath), pointer.bundlePath || ".");
const bundle = await loadBundleManifest(bundleRoot, AUTHORITY_BUNDLE_FORMAT);
const geometryCandidates = [];
const verticalObservations = [];
const materialObservations = [];
const drawingMetadata = [];
for (const page of bundle.manifest.pages || []) {
  const evidence = await readBundlePage(bundle.root, page);
  geometryCandidates.push(...(evidence.geometryCandidates || []).filter(isAuthorityEntry));
  verticalObservations.push(...(evidence.verticalObservations || []).filter(isAuthorityEntry));
  materialObservations.push(...(evidence.materialObservations || []).filter(isAuthorityEntry));
  drawingMetadata.push(...(evidence.drawingMetadata || []).filter(isAuthorityEntry));
}
const hasAuthority = geometryCandidates.length || verticalObservations.length || materialObservations.length || drawingMetadata.length;
const output = {
  schemaVersion: 2,
  coordinateSpace: "local-world-metres",
  authorityScope: "planning-current-state-only",
  sourceStorage: "chunked-page-ndjson",
  sourceBundle: pointer.bundlePath || null,
  worldGeometryReady: geometryCandidates.length > 0,
  worldGeometryAuthority: Boolean(hasAuthority),
  temporalResolutionRequired: false,
  geometryCandidates,
  verticalObservations,
  materialObservations,
  drawingMetadata,
  counts: {
    geometryCandidates: geometryCandidates.length,
    verticalObservations: verticalObservations.length,
    materialObservations: materialObservations.length,
    drawingMetadata: drawingMetadata.length
  },
  corroboration: pointer.corroboration || null
};
await writeJson(path.resolve(args.out), output);
console.log(JSON.stringify({ out: path.resolve(args.out), counts: output.counts, worldGeometryAuthority: output.worldGeometryAuthority }, null, 2));

function isAuthorityEntry(entry) { return entry?.worldGeometryAuthority === true && entry?.planningTemporal?.state === "current"; }
function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = values[++index];
    if (value == null || value.startsWith("--")) throw new Error(`${token} requires a value`);
    result[key] = value;
  }
  return result;
}
