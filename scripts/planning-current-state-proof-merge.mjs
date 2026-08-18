#!/usr/bin/env node
import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import {
  buildImplementedApplicationProof,
  mergeApplicationSnapshots
} from "../src/lib/planning-implemented-scheme-authority.mjs";
import { writeJson } from "../src/lib/io.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.proofs || !args.catalog || !args.out) {
  console.error("Usage: planning-current-state-proof-merge.mjs --proofs DIR --catalog FILE --out FILE [--queue FILE]");
  process.exit(2);
}

const catalog = await readJson(args.catalog);
if (args.queue) {
  const queue = await readJson(args.queue);
  catalog.applications = mergeApplicationSnapshots(catalog.applications || {}, queue.planningApplicationSnapshot || {});
}
const proofFiles = await findProofFiles(path.resolve(args.proofs));
if (!proofFiles.length) throw new Error("No current-state proof shard files found");

const contextsByApplication = new Map();
const seenPages = new Set();
const shardSummaries = [];
let evaluatedPages = 0;
let certifiedSpatialPages = 0;
let certifiedContextPages = 0;
let rejectedPages = 0;
let registrationAnchorCount = 0;
let candidateProofChecks = 0;
const rejected = {};

for (const filename of proofFiles) {
  const proofShard = await readJson(filename);
  if (proofShard.format !== "voxel-planning-current-state-proof-shard-v1") continue;
  shardSummaries.push({ shard: Number(proofShard.shard), ...(proofShard.summary || {}) });
  const summary = proofShard.summary || {};
  evaluatedPages += Number(summary.evaluatedPages || 0);
  certifiedSpatialPages += Number(summary.certifiedSpatialPages || 0);
  certifiedContextPages += Number(summary.certifiedContextPages || 0);
  rejectedPages += Number(summary.rejectedPages || 0);
  registrationAnchorCount += Number(summary.registrationAnchorCount || 0);
  candidateProofChecks += Number(summary.candidateProofChecks || 0);
  mergeCounts(rejected, summary.rejected);
  for (const record of proofShard.pages || []) {
    const key = record.key || pageKey(record.page?.contentHash, record.page?.pageNumber);
    if (seenPages.has(key)) throw new Error(`Duplicate current-state page proof across shards: ${key}`);
    seenPages.add(key);
    for (const applicationKey of record.applicationKeys || record.page?.applicationKeys || []) {
      if (!contextsByApplication.has(applicationKey)) contextsByApplication.set(applicationKey, []);
      contextsByApplication.get(applicationKey).push({ page: record.page, evaluation: record.evaluation });
    }
  }
}

const proofs = {};
let accepted = 0;
let rejectedApplications = 0;
for (const [applicationKey, contexts] of [...contextsByApplication.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)))) {
  const temporal = catalog.applications?.[applicationKey]?.temporal;
  const proof = buildImplementedApplicationProof(applicationKey, contexts, temporal ? [temporal] : []);
  proofs[applicationKey] = proof;
  if (proof.accepted) accepted += 1;
  else rejectedApplications += 1;
}

const output = {
  schemaVersion: 1,
  format: "voxel-planning-current-state-application-proofs-v1",
  proofShardCount: shardSummaries.length,
  pageCount: seenPages.size,
  summary: {
    evaluatedPages,
    certifiedSpatialPages,
    certifiedContextPages,
    rejectedPages,
    registrationAnchorCount,
    candidateProofChecks,
    applicationProofsAccepted: accepted,
    applicationProofsRejected: rejectedApplications,
    rejected
  },
  shards: shardSummaries.sort((a, b) => Number(a.shard) - Number(b.shard)),
  proofs
};
await writeJson(path.resolve(args.out), output);
console.log(JSON.stringify({
  proofShards: shardSummaries.length,
  pages: seenPages.size,
  applications: Object.keys(proofs).length,
  acceptedApplications: accepted,
  rejectedApplications,
  certifiedSpatialPages,
  out: path.resolve(args.out)
}, null, 2));

async function findProofFiles(root) {
  const details = await stat(root);
  if (details.isFile()) return [root];
  const result = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const filename = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        try {
          const value = JSON.parse(await readFile(filename, "utf8"));
          if (value?.format === "voxel-planning-current-state-proof-shard-v1") result.push(filename);
        } catch {}
      }
    }
  }
  await walk(root);
  return result.sort();
}
function pageKey(contentHash, pageNumber) { return `${contentHash || "unknown-document"}:p${Number(pageNumber || 1)}`; }
function mergeCounts(target, source) { for (const [key, value] of Object.entries(source || {})) target[key] = (target[key] || 0) + Number(value || 0); }
async function readJson(filename) { return JSON.parse(await readFile(path.resolve(filename), "utf8")); }
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
