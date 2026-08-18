#!/usr/bin/env node
import path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import readline from "node:readline";
import { createGzip } from "node:zlib";
import {
  AUTHORITY_BUNDLE_FORMAT,
  loadBundleManifest
} from "../src/lib/planning-evidence-bundle.mjs";

const CHUNKED_JSON_FORMAT = "voxel-chunked-json-gzip-v1";

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

const drawingMetadata = (manifest.pages || []).flatMap((page) => page.drawingMetadata || []);
const metadata = {
  schemaVersion: 4,
  coordinateSpace: "local-world-metres-plus-nonspatial-templates",
  authorityScope: "planning-current-state-plus-independently-corroborated-implemented-schemes",
  sourceStorage: "chunked-page-ndjson",
  sourceBundle: pointer.bundlePath || null,
  worldGeometryReady: Number(manifest.geometryCandidateCount || 0) > 0,
  worldGeometryAuthority: Boolean(manifest.worldGeometryAuthority),
  temporalResolutionRequired: false,
  counts: {
    geometryCandidates: Number(manifest.geometryCandidateCount || 0),
    verticalObservations: Number(manifest.verticalObservationCount || 0),
    materialObservations: Number(manifest.materialObservationCount || 0),
    rideStructureTemplates: Number(manifest.rideStructureTemplateCount || 0),
    drawingMetadata: drawingMetadata.length
  },
  implementedSchemeAuthority: {
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
  },
  templatePolicy: {
    spatialAuthority: false,
    worldGeometryAuthority: false,
    exactAuthoritativePlanAnchorLinkRequired: true,
    terrainGeometryMutable: false
  },
  terrainPolicy: {
    geometryAuthority: false,
    elevationAuthority: false,
    planningMayRepaintExistingTopSurfaceOnly: true
  },
  corroboration: pointer.corroboration || manifest.corroboration || null
};

// Keep the compatibility contract identical after readJson(), but never create
// a >500 MB JavaScript string. io.mjs already supports this line-oriented gzip
// container and rehydrates each top-level array record-by-record. The world and
// benchmark consumers therefore see the same object while storage, transfer and
// parsing remain below V8's hard maximum string length.
const arrays = {
  geometryCandidates: Number(manifest.geometryCandidateCount || 0),
  verticalObservations: Number(manifest.verticalObservationCount || 0),
  materialObservations: Number(manifest.materialObservationCount || 0),
  rideStructureTemplates: Number(manifest.rideStructureTemplateCount || 0),
  drawingMetadata: drawingMetadata.length
};
const header = JSON.stringify({
  __chunkedJson: {
    format: CHUNKED_JSON_FORMAT,
    schemaVersion: 1,
    arrays
  },
  metadata
});

const output = createWriteStream(outPath);
const gzip = createGzip({ level: 3 });
gzip.pipe(output);
const completion = once(output, "finish");
const failure = Promise.race([
  once(gzip, "error").then(([error]) => { throw error; }),
  once(output, "error").then(([error]) => { throw error; })
]);

try {
  await writeGzipLine(gzip, header);
  await writeCollection(gzip, bundle.root, manifest.pages || [], "geometryFile", "geometryCandidates");
  await writeCollection(gzip, bundle.root, manifest.pages || [], "verticalFile", "verticalObservations");
  await writeCollection(gzip, bundle.root, manifest.pages || [], "materialFile", "materialObservations");
  await writeCollection(gzip, bundle.root, manifest.pages || [], "templateFile", "rideStructureTemplates");
  for (const value of drawingMetadata) await writeGzipLine(gzip, JSON.stringify(["drawingMetadata", value]));
  gzip.end();
  await Promise.race([completion, failure]);
} catch (error) {
  output.destroy();
  gzip.destroy();
  throw error;
}

console.log(JSON.stringify({
  out: outPath,
  counts: metadata.counts,
  worldGeometryAuthority: Boolean(manifest.worldGeometryAuthority),
  mode: "streamed-chunked-gzip-from-authority-bundle"
}, null, 2));

async function writeCollection(stream, root, pages, field, property) {
  for (const page of pages) {
    if (!page?.[field]) continue;
    const filename = path.resolve(root, page[field]);
    const input = createReadStream(filename, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      const value = line.trim();
      if (!value) continue;
      // The NDJSON value has already been validated/written by the authority
      // bundle producer. Wrap its raw JSON text directly rather than parsing and
      // serializing a second geometry object in this compatibility stage.
      await writeGzipLine(stream, `[${JSON.stringify(property)},${value}]`);
    }
  }
}

async function writeGzipLine(stream, line) {
  if (!stream.write(`${line}\n`)) await once(stream, "drain");
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
