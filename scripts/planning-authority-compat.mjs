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
const rideStructureTemplates = [];
const drawingMetadata = [];
for (const page of bundle.manifest.pages || []) {
  const evidence = await readBundlePage(bundle.root, page);
  geometryCandidates.push(...(evidence.geometryCandidates || []).filter(isAuthorityEntry));
  verticalObservations.push(...(evidence.verticalObservations || []).filter(isAuthorityEntry));
  materialObservations.push(...(evidence.materialObservations || []).filter(isAuthorityEntry));
  // Structural section/elevation templates are intentionally never world
  // geometry authority. They may enter the compact handoff only when the
  // revision resolver marked the page current and explicitly allowed the
  // template for later exact support-code linkage.
  rideStructureTemplates.push(...(evidence.rideStructureTemplates || []).filter(isCurrentTemplate));
  drawingMetadata.push(...(evidence.drawingMetadata || []).filter(isAuthorityEntry));
}
const hasAuthority = geometryCandidates.length || verticalObservations.length || materialObservations.length || drawingMetadata.length;
const output = {
  schemaVersion: 3,
  coordinateSpace: "local-world-metres-plus-nonspatial-templates",
  authorityScope: "planning-current-state-only",
  sourceStorage: "chunked-page-ndjson",
  sourceBundle: pointer.bundlePath || null,
  worldGeometryReady: geometryCandidates.length > 0,
  worldGeometryAuthority: Boolean(hasAuthority),
  temporalResolutionRequired: false,
  geometryCandidates,
  verticalObservations,
  materialObservations,
  rideStructureTemplates: dedupeTemplates(rideStructureTemplates),
  drawingMetadata,
  counts: {
    geometryCandidates: geometryCandidates.length,
    verticalObservations: verticalObservations.length,
    materialObservations: materialObservations.length,
    rideStructureTemplates: dedupeTemplates(rideStructureTemplates).length,
    drawingMetadata: drawingMetadata.length
  },
  templatePolicy: {
    spatialAuthority: false,
    worldGeometryAuthority: false,
    exactAuthoritativePlanAnchorLinkRequired: true,
    terrainGeometryMutable: false
  },
  corroboration: pointer.corroboration || null
};
await writeJson(path.resolve(args.out), output);
console.log(JSON.stringify({ out: path.resolve(args.out), counts: output.counts, worldGeometryAuthority: output.worldGeometryAuthority }, null, 2));

function isAuthorityEntry(entry) { return entry?.worldGeometryAuthority === true && entry?.planningTemporal?.state === "current"; }
function isCurrentTemplate(entry) {
  return entry?.templateAuthorityEligible === true && entry?.planningTemporal?.state === "current" && entry?.worldGeometryAuthority !== true;
}
function dedupeTemplates(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const key = value?.id || `${value?.contentHash || ""}:p${value?.pageNumber || 0}:${value?.supportCode || ""}:${value?.component || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result.sort((a, b) => String(a.contentHash || "").localeCompare(String(b.contentHash || "")) || Number(a.pageNumber || 0) - Number(b.pageNumber || 0) || String(a.id || "").localeCompare(String(b.id || "")));
}
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
