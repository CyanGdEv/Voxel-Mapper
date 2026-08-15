import { planningDocumentPriority, shardForApplication } from "./planning-documents.mjs";

const EXTRACTABLE_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/tiff"
]);
const LOW_VALUE_CLASSES = new Set(["decision", "supporting", "unknown"]);

export function buildPlanningDocumentCatalog(manifests, options = {}) {
  const values = Array.isArray(manifests) ? manifests : [manifests].filter(Boolean);
  const extractionShards = Math.max(1, Math.min(100, Number(options.planningExtractionShards ?? 20)));
  const content = new Map();
  const applications = new Map();
  const failures = [];
  const pendingPortal = [];

  for (const manifest of values) {
    failures.push(...(manifest?.failures || []));
    for (const discovered of manifest?.discovered || []) {
      if (!discovered.direct) pendingPortal.push(discovered);
    }
    for (const result of manifest?.results || []) {
      const application = result.application || null;
      for (const document of result.documents || []) {
        if (!document?.contentHash || !["downloaded", "cached"].includes(document.status)) continue;
        addDocument(content, applications, application || document.application, document);
      }
    }
  }

  const documents = [...content.values()].map(finalizeContentRecord)
    .sort((a, b) => (b.extractionPriority || 0) - (a.extractionPriority || 0) || a.contentHash.localeCompare(b.contentHash));
  const extractionQueue = documents
    .filter((document) => isExtractablePlanningDocument(document, options))
    .map((document) => ({
      contentHash: document.contentHash,
      objectPath: document.objectPath,
      contentType: document.contentType,
      byteLength: document.byteLength,
      classification: document.classification,
      priority: document.extractionPriority,
      applicationKeys: document.applicationKeys,
      shard: extractionShardForContent(document.contentHash, extractionShards),
      status: "pending"
    }));

  const byApplication = Object.fromEntries([...applications.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, {
      ...value.application,
      documentHashes: [...value.documentHashes].sort(),
      classifications: countBy([...value.classifications])
    }]));

  return {
    schemaVersion: 1,
    inputShardManifests: values.length,
    uniqueDocuments: documents.length,
    applicationCount: applications.size,
    duplicateReferencesCollapsed: Math.max(0, countDocumentReferences(values) - documents.length),
    extractionShards,
    extractionQueueItems: extractionQueue.length,
    extractionShardCounts: countBy(extractionQueue.map((item) => String(item.shard))),
    classCounts: countBy(documents.map((item) => item.classification)),
    revisionChanges: documents.filter((item) => item.revisionChanged).length,
    pendingPortalLinks: dedupePendingPortal(pendingPortal),
    failures,
    applications: byApplication,
    documents,
    extractionQueue
  };
}

export function isExtractablePlanningDocument(document, options = {}) {
  if (!document?.contentHash || !document?.objectPath) return false;
  const type = String(document.contentType || "").toLowerCase();
  const supported = EXTRACTABLE_CONTENT_TYPES.has(type) || /\.(pdf|png|jpe?g|tiff?)$/i.test(document.objectPath);
  if (!supported) return false;
  if (options.includeLowValuePlanningDocuments) return true;
  return !LOW_VALUE_CLASSES.has(document.classification);
}

export function extractionShardForContent(contentHash, shardCount = 20) {
  // Reuse the stable SHA-based shard function. Content hashes, unlike application
  // references, ensure identical bytes are extracted only once.
  return shardForApplication(`content:${contentHash}`, shardCount);
}

function addDocument(content, applications, application, document) {
  const hash = document.contentHash;
  let record = content.get(hash);
  if (!record) {
    record = {
      contentHash: hash,
      objectPath: document.objectPath,
      contentType: document.contentType || null,
      byteLength: Number(document.byteLength || 0),
      classifications: [],
      urls: new Set(),
      applicationKeys: new Set(),
      labels: new Set(),
      revisionChanged: false,
      previousContentHashes: new Set()
    };
    content.set(hash, record);
  }
  if (document.url) record.urls.add(document.url);
  if (document.finalUrl) record.urls.add(document.finalUrl);
  if (document.label) record.labels.add(document.label);
  if (document.classification) record.classifications.push(document.classification);
  if (document.revisionChanged) record.revisionChanged = true;
  if (document.previousContentHash && document.previousContentHash !== hash) record.previousContentHashes.add(document.previousContentHash);

  const appKey = application?.key || document.application?.key || null;
  if (appKey) {
    record.applicationKeys.add(appKey);
    let app = applications.get(appKey);
    if (!app) {
      app = {
        application: application || document.application,
        documentHashes: new Set(),
        classifications: []
      };
      applications.set(appKey, app);
    }
    app.documentHashes.add(hash);
    if (document.classification) app.classifications.push(document.classification);
  }
}

function finalizeContentRecord(record) {
  const classification = chooseBestClassification(record.classifications);
  return {
    contentHash: record.contentHash,
    objectPath: record.objectPath,
    contentType: record.contentType,
    byteLength: record.byteLength,
    classification,
    extractionPriority: planningDocumentPriority(classification, "download"),
    classifications: countBy(record.classifications),
    urls: [...record.urls].sort(),
    labels: [...record.labels].sort(),
    applicationKeys: [...record.applicationKeys].sort(),
    revisionChanged: record.revisionChanged,
    previousContentHashes: [...record.previousContentHashes].sort()
  };
}

function chooseBestClassification(values) {
  const unique = [...new Set(values.filter(Boolean))];
  if (!unique.length) return "unknown";
  return unique.sort((a, b) => planningDocumentPriority(b, "download") - planningDocumentPriority(a, "download") || a.localeCompare(b))[0];
}

function countDocumentReferences(manifests) {
  let count = 0;
  for (const manifest of manifests) {
    for (const result of manifest?.results || []) {
      count += (result.documents || []).filter((document) => document?.contentHash && ["downloaded", "cached"].includes(document.status)).length;
    }
  }
  return count;
}

function countBy(values) {
  const result = {};
  for (const value of values) result[value] = (result[value] || 0) + 1;
  return result;
}

function dedupePendingPortal(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const key = `${entry.application?.key || ""}\n${entry.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result.sort((a, b) => (b.priority || 0) - (a.priority || 0));
}
