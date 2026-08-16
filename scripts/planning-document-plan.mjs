#!/usr/bin/env node
import path from "node:path";
import { appendFile } from "node:fs/promises";
import { ensureDir, sha256, writeJson } from "../src/lib/io.mjs";
import { acquireSources } from "../src/lib/sources.mjs";
import { buildPlanningDocumentQueue } from "../src/lib/planning-documents.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const MAX_APPLICATIONS = 2_500;
const DEFAULT_SHARDS = 256;

if (args.includes("--help") || !value("--bbox")) {
  console.log(`Voxel Mapper planning document plan\n\nUsage:\n  node scripts/planning-document-plan.mjs --bbox south,west,north,east [options]\n\nOptions:\n  --out FILE               Queue output (default planning-document-queue.json)\n  --cache DIR              Discovery cache (default .tpmap-cache)\n  --max-applications N     Maximum intersecting planning applications (max 2500)\n  --shards N               Queue shard count (default 256, max 256)\n  --refresh                Refresh Planning Data/API and local-register discovery\n`);
  process.exit(args.includes("--help") ? 0 : 2);
}

const bbox = value("--bbox");
const cacheDir = path.resolve(value("--cache") || ".tpmap-cache");
await ensureDir(cacheDir);

const sources = await acquireSources({
  bbox,
  elevation: "none",
  cache: cacheDir,
  noCache: args.includes("--refresh"),
  maxPlanningApplications: Number(value("--max-applications") || MAX_APPLICATIONS),
  contact: process.env.TPMAP_CONTACT || undefined
});
const planning = sources.planning;

// A genuine successful zero-result planning search is valid. A zero-result
// caused by all usable discovery sources failing is not: silently proceeding
// here creates an apparently successful but effectively OSM-only world.
if (!(planning.applicationCount > 0) && (
  planning.planningDiscoveryFailure ||
  planning.status === "failed" ||
  planning.status === "local-portal-source-failed" ||
  planning.status === "planning-discovery-source-failed"
)) {
  throw new Error(
    `Planning application discovery failed for ${bbox}; refusing to generate an OSM-only world while required planning discovery sources are unavailable`
  );
}

const queue = buildPlanningDocumentQueue(planning, {
  planningDocumentShards: Number(value("--shards") || DEFAULT_SHARDS)
});

// Keep a compact, immutable lifecycle snapshot next to the queue. Discovery-
// only indexes deliberately contribute no temporal authority; their role is to
// locate the official application/document page for subsequent extraction.
queue.planningApplicationSnapshot = Object.fromEntries((planning.applications || []).map((application) => {
  const key = applicationKey(application);
  return [key, compactPlanningApplication(application, key)];
}));
queue.planningApplicationSnapshotAt = new Date().toISOString();
queue.planningApplicationSnapshotProvider = planning.providerId || planning.provider || null;
queue.planningCoverageStatus = planning.coverageStatus || null;
queue.localPortalFallback = planning.localPortalFallback || null;
queue.discoveryIndexFallback = planning.discoveryIndexFallback || null;
queue.osmPlanningHints = planning.localPortalFallback?.hints || planning.osmPlanningDiscovery?.searchTerms || [];

const out = path.resolve(value("--out") || "planning-document-queue.json");
await writeJson(out, queue);
const activeShards = Object.entries(queue.shardCounts || {})
  .filter(([, count]) => Number(count) > 0)
  .map(([index]) => Number(index))
  .sort((a, b) => a - b);

console.log(`Planning provider: ${planning.providerId || planning.provider || "none"}`);
console.log(`Planning coverage: ${planning.coverageStatus || planning.status || "unknown"}`);
console.log(`Local portal applications added: ${planning.localPortalFallback?.addedApplications || 0}`);
console.log(`Discovery-index applications added: ${planning.discoveryIndexFallback?.addedApplications || 0}`);
console.log(`Applications: ${planning.applicationCount || 0}`);
console.log(`Queue items: ${queue.itemCount}`);
console.log(`Active shards: ${activeShards.join(",") || "none"}`);
console.log(`Queue: ${out}`);

if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `active_shards=${JSON.stringify(activeShards.length ? activeShards : [0])}\n`);
  await appendFile(process.env.GITHUB_OUTPUT, `queue_items=${queue.itemCount}\n`);
  await appendFile(process.env.GITHUB_OUTPUT, `applications=${planning.applicationCount || 0}\n`);
}

function compactPlanningApplication(application, key) {
  const discoveryOnly = application.discoveryOnly === true || application.source === "planit-discovery-index";
  return {
    key,
    entity: application.entity ?? application.id ?? null,
    reference: application.reference ?? null,
    description: application.description ?? application.name ?? null,
    organisationEntity: application["organisation-entity"] ?? application.organisationEntity ?? null,
    documentationUrl: firstValue(application["documentation-url"] ?? application.documentationUrl),
    source: application.source ?? null,
    dataset: application.dataset ?? null,
    discoveryOnly,
    temporal: discoveryOnly ? { statusEvidence: [], dateEvidence: [] } : {
      statusEvidence: unique([
        application["planning-status"],
        application.planningStatus,
        application["application-status"],
        application.applicationStatus,
        application["decision-status"],
        application.decisionStatus,
        application.decision,
        application.status
      ].flatMap(values)),
      dateEvidence: collectDates(application)
    }
  };
}

function collectDates(application) {
  const fields = [
    ["decision-date", application["decision-date"] ?? application.decisionDate],
    ["application-date", application["application-date"] ?? application.applicationDate],
    ["received-date", application["received-date"] ?? application.receivedDate],
    ["valid-date", application["valid-date"] ?? application.validDate],
    ["start-date", application["start-date"] ?? application.startDate],
    ["end-date", application["end-date"] ?? application.endDate],
    ["entry-date", application["entry-date"] ?? application.entryDate],
    ["last-updated", application["last-updated"] ?? application.lastUpdated]
  ];
  return fields.flatMap(([kind, fieldValue]) => values(fieldValue).map((entry) => ({ kind, value: String(entry) })))
    .filter((entry) => entry.value.trim());
}

function applicationKey(application) {
  const entity = application.entity ?? application.id ?? null;
  if (entity != null) return `entity:${entity}`;
  if (application.reference) return `reference:${application.reference}`;
  return `hash:${sha256(application).slice(0, 20)}`;
}
function values(input) {
  if (input == null) return [];
  if (Array.isArray(input)) return input.flatMap(values);
  if (typeof input === "object") return Object.values(input).flatMap(values);
  return String(input).split(/[;\n|]+/).map((entry) => entry.trim()).filter(Boolean);
}
function firstValue(input) { return values(input)[0] || null; }
function unique(valuesList) { return [...new Set(valuesList.map((entry) => String(entry).trim()).filter(Boolean))]; }
