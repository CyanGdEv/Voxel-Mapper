#!/usr/bin/env node
import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  AUTHORITY_BUNDLE_FORMAT,
  iterateNdjson,
  loadBundleManifest
} from "../src/lib/planning-evidence-bundle.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.manifest) {
  console.error("Usage: validate-planning-authority-bundle.mjs --manifest planning-current-authority-pointer.json");
  process.exit(2);
}

const pointerPath = path.resolve(args.manifest);
const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
if (pointer.format !== AUTHORITY_BUNDLE_FORMAT) {
  throw new Error(`Expected ${AUTHORITY_BUNDLE_FORMAT}, found ${pointer.format || "unknown authority format"}`);
}

const bundleRoot = path.resolve(path.dirname(pointerPath), pointer.bundlePath || ".");
const bundle = await loadBundleManifest(bundleRoot, AUTHORITY_BUNDLE_FORMAT);
const manifest = bundle.manifest;
const targets = new Set();
let streamedGeometry = 0;
let unsafeRideAuthority = 0;
const unsafeSamples = [];

for (const page of manifest.pages || []) {
  if (!page?.geometryFile) continue;
  const filename = path.resolve(bundle.root, page.geometryFile);
  for await (const candidate of iterateNdjson(filename)) {
    streamedGeometry += 1;
    const implementation = candidate.implementationCorroboration || candidate.planningTemporal?.implementationCorroboration || {};
    const target = implementation.featureId || candidate.associationContract?.featureId || null;
    if (target) targets.add(String(target));
    if (implementation.featureKind !== "ride_track") continue;

    const classification = String(candidate.classification || implementation.planningClassification || "")
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    const semantic = String(candidate.semantic || implementation.planningSemantic || "");
    if (classification === "ride_layout" && /ride-centerline-or-edge/.test(semantic)) continue;

    unsafeRideAuthority += 1;
    if (unsafeSamples.length < 5) {
      unsafeSamples.push({
        id: candidate.id || null,
        classification: candidate.classification || null,
        semantic: candidate.semantic || null,
        target
      });
    }
  }
}

const geometry = Number(manifest.geometryCandidateCount || 0);
const materials = Number(manifest.materialObservationCount || 0);
const templates = Number(manifest.rideStructureTemplateCount || 0);
const summary = {
  worldGeometryAuthority: Boolean(manifest.worldGeometryAuthority),
  geometry,
  streamedGeometry,
  materials,
  templates,
  distinctCurrentTargets: targets.size,
  unsafeRideAuthority
};
console.log(JSON.stringify(summary, null, 2));

if (manifest.worldGeometryAuthority !== true) {
  throw new Error("Benchmark produced no verified planning world authority");
}
if (geometry <= 0) {
  throw new Error("Benchmark produced zero verified planning geometry candidates");
}
if (streamedGeometry !== geometry) {
  throw new Error(`Authority geometry count mismatch: manifest=${geometry}, streamed=${streamedGeometry}`);
}
if (unsafeRideAuthority > 0) {
  throw new Error(`Generic planning geometry incorrectly gained ride authority: ${JSON.stringify(unsafeSamples)}`);
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
