#!/usr/bin/env node
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { georegisterPlanningEvidenceBatch } from "../src/lib/planning-georegistration-batch.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.evidence || !args.reference || !args.out) {
  console.error("Usage: planning-georegister.mjs --evidence planning-vector-evidence.json --reference planning-georeg-reference.json --out FILE [--registered-out FILE] [--control-points FILE] [--strict]");
  process.exit(2);
}

const extraction = await readJson(args.evidence);
const reference = await readJson(args.reference);
const controlPoints = args.controlPoints ? normalizeControlPointFile(await readJson(args.controlPoints)) : [];
const result = georegisterPlanningEvidenceBatch(extraction, reference.features || [], {
  controlPoints,
  model: args.model || "similarity",
  inlierThresholdM: number(args.inlierThresholdM, 1.5),
  maxRmseM: number(args.maxRmseM, 1.25),
  maxResidualM: number(args.maxResidualM, 3.5),
  minInliers: number(args.minInliers, 3),
  maxScaleRelativeError: number(args.maxScaleRelativeError, 0.22),
  maxAutoScaleRelativeError: number(args.maxAutoScaleRelativeError, 0.28),
  maxAutoShapeRmseM: number(args.maxAutoShapeRmseM, 1.8)
});

await writeJson(args.out, {
  ...result,
  bbox: reference.bbox || null,
  referenceProvider: reference.provider || null,
  referenceFeatureCount: reference.featureCount ?? reference.features?.length ?? 0
});
if (args.registeredOut) await writeJson(args.registeredOut, result.registeredEvidence);

console.log(JSON.stringify({
  status: result.status,
  groups: result.groupCount,
  registeredGroups: result.registeredGroupCount,
  unregisteredGroups: result.unregisteredGroupCount,
  registeredGeometryCandidates: result.registeredEvidence?.geometryCandidates?.length || 0,
  registeredVerticalObservations: result.registeredEvidence?.verticalObservations?.length || 0,
  registeredMaterialObservations: result.registeredEvidence?.materialObservations?.length || 0,
  out: path.resolve(args.out),
  registeredOut: args.registeredOut ? path.resolve(args.registeredOut) : null
}, null, 2));

if (args.strict && result.status !== "registered") process.exitCode = 1;

async function readJson(filename) { return JSON.parse(await readFile(path.resolve(filename), "utf8")); }
async function writeJson(filename, value) {
  const resolved = path.resolve(filename);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, JSON.stringify(value, null, 2) + "\n");
}
function normalizeControlPointFile(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.controlPoints)) return value.controlPoints;
  throw new Error("Control-point file must be an array or an object with controlPoints[]");
}
function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (token === "--strict") { result.strict = true; continue; }
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = values[++index];
    if (value == null || value.startsWith("--")) throw new Error(`${token} requires a value`);
    result[key] = value;
  }
  return result;
}
function number(value, fallback) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
