#!/usr/bin/env node
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolvePlanningRevisionAuthority } from "../src/lib/planning-revision-resolver.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.registered || !args.catalog || !args.out) {
  console.error("Usage: planning-resolve-revisions.mjs --registered planning-registered-evidence.json --catalog planning-document-catalog.json --out FILE [--queue planning-document-queue.json] [--resolved-out FILE] [--reference-date ISO] [--strict]");
  process.exit(2);
}

const registered = await readJson(args.registered);
const catalog = await readJson(args.catalog);
if (args.queue) {
  const queue = await readJson(args.queue);
  catalog.applications = mergeApplicationSnapshots(catalog.applications || {}, queue.planningApplicationSnapshot || {});
  catalog.planningApplicationSnapshotAt = queue.planningApplicationSnapshotAt || null;
  catalog.planningApplicationSnapshotProvider = queue.planningApplicationSnapshotProvider || null;
}

const result = resolvePlanningRevisionAuthority(registered, catalog, {
  referenceDate: args.referenceDate,
  currentAuthorityConfidenceGate: number(args.currentAuthorityConfidenceGate, 0.85)
});

await writeJson(args.out, {
  ...result,
  applicationSnapshotAt: catalog.planningApplicationSnapshotAt || null,
  applicationSnapshotProvider: catalog.planningApplicationSnapshotProvider || null
});
if (args.resolvedOut) await writeJson(args.resolvedOut, result.resolvedEvidence);

console.log(JSON.stringify({
  status: result.status,
  pages: result.summary.pageCount,
  lineages: result.summary.lineageCount,
  authoritativeCurrentPages: result.summary.authoritativeCurrentPages,
  unresolvedPages: result.summary.unresolvedPages,
  conflicts: result.summary.conflicts,
  authoritativeGeometryCandidates: result.summary.authoritativeGeometryCandidates,
  out: path.resolve(args.out),
  resolvedOut: args.resolvedOut ? path.resolve(args.resolvedOut) : null
}, null, 2));

if (args.strict && result.summary.unresolvedPages > 0) process.exitCode = 1;

function mergeApplicationSnapshots(existing, snapshot) {
  const keys = new Set([...Object.keys(existing || {}), ...Object.keys(snapshot || {})]);
  return Object.fromEntries([...keys].sort().map((key) => [key, {
    ...(existing[key] || {}),
    ...(snapshot[key] || {}),
    temporal: snapshot[key]?.temporal || existing[key]?.temporal || null
  }]));
}
async function readJson(filename) { return JSON.parse(await readFile(path.resolve(filename), "utf8")); }
async function writeJson(filename, value) {
  const resolved = path.resolve(filename);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, JSON.stringify(value, null, 2) + "\n");
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
