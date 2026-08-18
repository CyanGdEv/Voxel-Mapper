#!/usr/bin/env node
import path from "node:path";
import { createReadStream } from "node:fs";
import { open, readFile } from "node:fs/promises";
import readline from "node:readline";
import {
  AUTHORITY_BUNDLE_FORMAT,
  loadBundleManifest
} from "../src/lib/planning-evidence-bundle.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.manifest || !args.out) {
  console.error("Usage: planning-authority-compat-stream.mjs --manifest planning-current-authority-pointer.json --out FILE");
  process.exit(2);
}

const pointerPath = path.resolve(args.manifest);
const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
if (pointer.format !== AUTHORITY_BUNDLE_FORMAT) throw new Error(`Unsupported authority manifest format: ${pointer.format || "unknown"}`);
const bundleRoot = path.resolve(path.dirname(pointerPath), pointer.bundlePath || ".");
const bundle = await loadBundleManifest(bundleRoot, AUTHORITY_BUNDLE_FORMAT);
const manifest = bundle.manifest;
const outPath = path.resolve(args.out);
const handle = await open(outPath, "w");

try {
  const prefix = {
    schemaVersion: 4,
    coordinateSpace: "local-world-metres-plus-nonspatial-templates",
    authorityScope: "planning-current-state-plus-independently-corroborated-implemented-schemes",
    sourceStorage: "chunked-page-ndjson",
    sourceBundle: pointer.bundlePath || null,
    worldGeometryReady: Number(manifest.geometryCandidateCount || 0) > 0,
    worldGeometryAuthority: Boolean(manifest.worldGeometryAuthority),
    temporalResolutionRequired: false
  };
  await handle.write(`${JSON.stringify(prefix).slice(0, -1)},`);
  await writeCollection(handle, bundle.root, manifest.pages || [], "geometryFile", "geometryCandidates");
  await handle.write(",");
  await writeCollection(handle, bundle.root, manifest.pages || [], "verticalFile", "verticalObservations");
  await handle.write(",");
  await writeCollection(handle, bundle.root, manifest.pages || [], "materialFile", "materialObservations");
  await handle.write(",");
  await writeCollection(handle, bundle.root, manifest.pages || [], "templateFile", "rideStructureTemplates");
  await handle.write(",");
  const drawingMetadata = (manifest.pages || []).flatMap((page) => page.drawingMetadata || []);
  await handle.write(`"drawingMetadata":${JSON.stringify(drawingMetadata)},`);
  await handle.write(`"counts":${JSON.stringify({
    geometryCandidates: Number(manifest.geometryCandidateCount || 0),
    verticalObservations: Number(manifest.verticalObservationCount || 0),
    materialObservations: Number(manifest.materialObservationCount || 0),
    rideStructureTemplates: Number(manifest.rideStructureTemplateCount || 0),
    drawingMetadata: drawingMetadata.length
  })},`);
  await handle.write(`"implementedSchemeAuthority":${JSON.stringify({
    status: Number(manifest.implementedScheme?.certifiedSpatialPages || 0) > 0 ? "applied" : "no-implemented-scheme-proof",
    evaluatedPages: Number(manifest.implementedScheme?.evaluatedPages || 0),
    certifiedSpatialPages: Number(manifest.implementedScheme?.certifiedSpatialPages || 0),
    certifiedContextPages: Number(manifest.implementedScheme?.certifiedContextPages || 0),
    implementedApplications: Number(manifest.implementedScheme?.applicationProofsAccepted || 0),
    promotedGeometryCandidates: Number(manifest.implementedScheme?.promotedGeometryCandidates || 0),
    promotedVerticalObservations: 0,
    promotedMaterialObservations: Number(manifest.implementedScheme?.promotedAttributeObservations || 0),
    promotedRideStructureTemplates: 0,
    supportingEvidencePages: 0,
    pageProofs: []
  })},`);
  await handle.write(`"templatePolicy":${JSON.stringify({
    spatialAuthority: false,
    worldGeometryAuthority: false,
    exactAuthoritativePlanAnchorLinkRequired: true,
    terrainGeometryMutable: false
  })},`);
  await handle.write(`"terrainPolicy":${JSON.stringify({
    geometryAuthority: false,
    elevationAuthority: false,
    planningMayRepaintExistingTopSurfaceOnly: true
  })},`);
  await handle.write(`"corroboration":${JSON.stringify(pointer.corroboration || manifest.corroboration || null)}}\n`);
} finally {
  await handle.close();
}

console.log(JSON.stringify({
  out: outPath,
  counts: {
    geometryCandidates: Number(manifest.geometryCandidateCount || 0),
    verticalObservations: Number(manifest.verticalObservationCount || 0),
    materialObservations: Number(manifest.materialObservationCount || 0),
    rideStructureTemplates: Number(manifest.rideStructureTemplateCount || 0)
  },
  worldGeometryAuthority: Boolean(manifest.worldGeometryAuthority),
  mode: "streamed-from-authority-bundle"
}, null, 2));

async function writeCollection(handle, root, pages, field, property) {
  await handle.write(`${JSON.stringify(property)}:[`);
  let first = true;
  for (const page of pages) {
    if (!page?.[field]) continue;
    const filename = path.resolve(root, page[field]);
    const input = createReadStream(filename, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      const value = line.trim();
      if (!value) continue;
      if (!first) await handle.write(",");
      await handle.write(value);
      first = false;
    }
  }
  await handle.write("]");
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
