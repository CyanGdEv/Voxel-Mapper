#!/usr/bin/env node
import path from "node:path";
import { readFile } from "node:fs/promises";
import { resolvePlanningRevisionAuthority } from "../src/lib/planning-revision-resolver.mjs";
import {
  REGISTERED_BUNDLE_FORMAT,
  findBundleManifests
} from "../src/lib/planning-evidence-bundle.mjs";
import { mergeApplicationSnapshots } from "../src/lib/planning-implemented-scheme-authority.mjs";
import { writeJson } from "../src/lib/io.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.manifests || !args.catalog || !args.out) {
  console.error("Usage: planning-current-state-plan.mjs --manifests DIR --catalog planning-document-catalog.json --out FILE [--queue planning-document-queue.json] [--reference-date ISO]");
  process.exit(2);
}

const located = await findBundleManifests(path.resolve(args.manifests), REGISTERED_BUNDLE_FORMAT);
if (!located.length) throw new Error("No registered planning shard manifests found");

const catalog = JSON.parse(await readFile(path.resolve(args.catalog), "utf8"));
if (args.queue) {
  const queue = JSON.parse(await readFile(path.resolve(args.queue), "utf8"));
  catalog.applications = mergeApplicationSnapshots(catalog.applications || {}, queue.planningApplicationSnapshot || {});
  catalog.planningApplicationSnapshotAt = queue.planningApplicationSnapshotAt || null;
  catalog.planningApplicationSnapshotProvider = queue.planningApplicationSnapshotProvider || null;
}

const mergedManifest = mergeRegisteredManifests(located);
const compactRegistered = compactRegisteredEvidence(mergedManifest);
const result = resolvePlanningRevisionAuthority(compactRegistered, catalog, {
  referenceDate: args.referenceDate,
  currentAuthorityConfidenceGate: number(args.currentAuthorityConfidenceGate, 0.85)
});
const pageDecisions = Object.fromEntries(result.pages.map((page) => [
  pageKey(page.contentHash, page.pageNumber),
  page.decision
]));

const plan = {
  schemaVersion: 1,
  format: "voxel-planning-current-state-plan-v1",
  evidenceStorage: "sharded-registered-page-ndjson",
  sourceShardCount: located.length,
  sourceShards: located.map((entry) => ({
    shard: shardId(entry),
    pageCount: Number(entry.manifest.pageCount || 0),
    evidencePageCount: Number(entry.manifest.evidencePageCount || entry.manifest.pages?.length || 0),
    geometryCandidateCount: Number(entry.manifest.geometryCandidateCount || 0),
    verticalObservationCount: Number(entry.manifest.verticalObservationCount || 0),
    materialObservationCount: Number(entry.manifest.materialObservationCount || 0),
    rideStructureTemplateCount: Number(entry.manifest.rideStructureTemplateCount || 0)
  })).sort((a, b) => a.shard - b.shard),
  applicationSnapshotAt: catalog.planningApplicationSnapshotAt || null,
  applicationSnapshotProvider: catalog.planningApplicationSnapshotProvider || null,
  registeredManifest: mergedManifest,
  revision: withoutResolvedEvidence(result),
  pageDecisions
};

await writeJson(path.resolve(args.out), plan);
console.log(JSON.stringify({
  status: result.status,
  sourceShards: located.length,
  pages: result.summary.pageCount,
  lineages: result.summary.lineageCount,
  authoritativeCurrentPages: result.summary.authoritativeCurrentPages,
  unresolvedPages: result.summary.unresolvedPages,
  geometryCandidates: mergedManifest.geometryCandidateCount,
  out: path.resolve(args.out)
}, null, 2));

function mergeRegisteredManifests(locatedManifests) {
  const pages = [];
  const unregisteredPages = [];
  const seenPages = new Set();
  let registeredPageCount = 0;
  let templateOnlyPageCount = 0;
  for (const entry of locatedManifests) {
    const manifest = entry.manifest || {};
    registeredPageCount += Number(manifest.registeredPageCount || 0);
    templateOnlyPageCount += Number(manifest.templateOnlyPageCount || 0);
    unregisteredPages.push(...(manifest.unregisteredPages || []));
    for (const page of manifest.pages || []) {
      const key = pageKey(page.contentHash, page.pageNumber);
      if (seenPages.has(key)) throw new Error(`Duplicate registered planning page across shards: ${key}`);
      seenPages.add(key);
      pages.push({
        ...page,
        sourceShard: shardId(entry),
        // Stream paths are shard-local and intentionally not consumed by this
        // metadata-only stage. Preserve them for audit without resolving them.
        geometryFile: page.geometryFile || null,
        verticalFile: page.verticalFile || null,
        materialFile: page.materialFile || null,
        templateFile: page.templateFile || null
      });
    }
  }
  pages.sort(pageSort);
  const geometryCandidateCount = sum(pages, "geometryCount");
  const verticalObservationCount = sum(pages, "verticalCount");
  const materialObservationCount = sum(pages, "materialCount");
  const rideStructureTemplateCount = sum(pages, "rideStructureTemplateCount");
  return {
    schemaVersion: 1,
    format: REGISTERED_BUNDLE_FORMAT,
    stage: "registered-shard-manifest-merge",
    coordinateSpace: "local-world-metres-plus-nonspatial-templates",
    georegistrationStatus: unregisteredPages.length ? (registeredPageCount ? "partially-registered" : "unregistered") : "registered",
    worldGeometryReady: geometryCandidateCount > 0,
    worldGeometryAuthority: false,
    spatialAuthorityEligible: true,
    temporalResolutionRequired: true,
    inputShardBundles: locatedManifests.length,
    pageCount: pages.length + unregisteredPages.length,
    evidencePageCount: pages.length,
    registeredPageCount,
    templateOnlyPageCount,
    unregisteredPageCount: unregisteredPages.length,
    geometryCandidateCount,
    verticalObservationCount,
    materialObservationCount,
    rideStructureTemplateCount,
    pages,
    unregisteredPages
  };
}

function compactRegisteredEvidence(manifest) {
  const drawingMetadata = [];
  const pageRefs = [];
  for (const page of manifest.pages || []) {
    drawingMetadata.push(...(page.drawingMetadata || []).map((entry) => ({
      ...entry,
      contentHash: entry.contentHash || page.contentHash,
      pageNumber: Number(entry.pageNumber || page.pageNumber || 1)
    })));
    if (Number(page.geometryCount || 0) + Number(page.verticalCount || 0) + Number(page.materialCount || 0) + Number(page.rideStructureTemplateCount || 0) > 0) {
      pageRefs.push({ contentHash: page.contentHash, pageNumber: page.pageNumber });
    }
  }
  return {
    schemaVersion: 3,
    coordinateSpace: "local-world-metres-plus-nonspatial-templates",
    worldGeometryReady: Number(manifest.geometryCandidateCount || 0) > 0,
    worldGeometryAuthority: false,
    temporalResolutionRequired: true,
    drawingMetadata,
    geometryCandidates: pageRefs,
    verticalObservations: [],
    materialObservations: [],
    rideStructureTemplates: []
  };
}

function shardId(located) {
  const explicit = Number(located?.manifest?.selectedShard);
  if (Number.isInteger(explicit) && explicit >= 0) return explicit;
  const match = String(located?.filename || located?.root || "").match(/(?:shard[-_])(\d+)/i);
  return match ? Number(match[1]) : -1;
}
function withoutResolvedEvidence(result) { const { resolvedEvidence, ...rest } = result; return rest; }
function pageKey(contentHash, pageNumber) { return `${contentHash || "unknown-document"}:p${Number(pageNumber || 1)}`; }
function pageSort(a, b) { return String(a.contentHash || "").localeCompare(String(b.contentHash || "")) || Number(a.pageNumber || 0) - Number(b.pageNumber || 0); }
function sum(values, key) { return (values || []).reduce((total, value) => total + Number(value?.[key] || 0), 0); }
function number(value, fallback) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
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
