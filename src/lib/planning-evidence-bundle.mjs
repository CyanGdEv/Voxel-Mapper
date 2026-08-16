import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { extractPlanningDocument } from "./planning-vector-extractor.mjs";
import { loadPlanningPdfJsRuntime } from "./planning-pdfjs-runtime.mjs";
import { enrichPlanningTextEvidence } from "./planning-text-evidence.mjs";
import { compactPlanningExtraction, normalizeExtractorClass } from "./planning-extraction-worker.mjs";

export const EXTRACTION_BUNDLE_FORMAT = "voxel-planning-extraction-bundle-v1";
export const REGISTERED_BUNDLE_FORMAT = "voxel-planning-registered-bundle-v1";
export const RESOLVED_BUNDLE_FORMAT = "voxel-planning-resolved-bundle-v1";
export const AUTHORITY_BUNDLE_FORMAT = "voxel-planning-authority-bundle-v1";

const DEFAULT_CONCURRENCY = 2;

export async function extractPlanningShardToBundle(catalog, options = {}) {
  const shardIndex = Number(options.shardIndex ?? 0);
  const outDir = path.resolve(options.outDir || `planning-extraction-shard-${shardIndex}`);
  const pagesDir = path.join(outDir, "pages");
  await mkdir(pagesDir, { recursive: true });
  const items = (catalog?.extractionQueue || []).filter((item) => Number(item.shard) === shardIndex);
  const concurrency = clampInt(options.concurrency ?? DEFAULT_CONCURRENCY, 1, 8);
  const needsPdf = items.some((item) => String(item.contentType || "").toLowerCase() === "application/pdf" || /\.pdf$/i.test(item.objectPath || ""));
  const pdfEngine = needsPdf ? (options.pdfEngine || await loadPlanningPdfJsRuntime()) : options.pdfEngine;
  const extractionOptions = { ...options, pdfEngine };

  const results = await mapLimit(items, concurrency, async (item) => {
    const extractionItem = { ...item, classification: normalizeExtractorClass(item.classification) };
    try {
      const extraction = await extractPlanningDocument(extractionItem, extractionOptions);
      enrichPlanningTextEvidence(extraction, extractionOptions);
      const compact = compactPlanningExtraction(extraction);
      const pageEntries = [];
      for (const page of compact.pages || []) {
        pageEntries.push(await writeExtractedPage(pagesDir, compact, page));
      }
      return {
        status: compact.status,
        contentHash: compact.contentHash,
        objectPath: compact.objectPath || item.objectPath || null,
        contentType: compact.contentType || item.contentType || null,
        classification: compact.classification || extractionItem.classification,
        applicationKeys: compact.applicationKeys || item.applicationKeys || [],
        acquisitionShard: compact.acquisitionShard ?? item.acquisitionShard ?? shardIndex,
        pageCount: compact.pageCount || pageEntries.length,
        vectorPageCount: compact.vectorPageCount || 0,
        textPageCount: compact.textPageCount || 0,
        rasterFallbackPageCount: compact.rasterFallbackPageCount || 0,
        pages: pageEntries,
        rasterFallbackQueue: compact.rasterFallbackQueue || [],
        warnings: compact.warnings || []
      };
    } catch (error) {
      if (options.strictPlanningExtraction) throw error;
      return {
        status: "failed",
        contentHash: item.contentHash || null,
        objectPath: item.objectPath || null,
        classification: extractionItem.classification,
        applicationKeys: item.applicationKeys || [],
        pages: [],
        rasterFallbackQueue: [],
        error: error?.message || String(error)
      };
    }
  });

  const pages = results.flatMap((result) => result.pages || []);
  const failures = results.filter((result) => result.status === "failed").map((result) => ({
    contentHash: result.contentHash,
    objectPath: result.objectPath,
    error: result.error
  }));
  const rasterFallbackQueue = dedupeFallback(results.flatMap((result) => result.rasterFallbackQueue || []));
  const manifest = {
    schemaVersion: 1,
    format: EXTRACTION_BUNDLE_FORMAT,
    stage: "extracted",
    coordinateSpace: "pdf-user-space-points",
    georegistrationStatus: "required",
    worldGeometryReady: false,
    selectedShard: shardIndex,
    inputItems: items.length,
    extractedDocuments: results.filter((result) => result.status === "extracted").length,
    rasterOnlyDocuments: results.filter((result) => result.status === "raster-fallback-required").length,
    failedDocuments: failures.length,
    documentCount: results.filter((result) => result.status !== "failed").length,
    pageCount: pages.length,
    geometryCandidateCount: sum(pages, "geometryCount"),
    verticalObservationCount: sum(pages, "verticalCount"),
    materialObservationCount: sum(pages, "materialCount"),
    rasterFallbackPages: rasterFallbackQueue.length,
    failures,
    rasterFallbackQueue,
    documents: results.map((result) => ({
      status: result.status,
      contentHash: result.contentHash,
      objectPath: result.objectPath,
      contentType: result.contentType || null,
      classification: result.classification || "unknown",
      applicationKeys: result.applicationKeys || [],
      acquisitionShard: result.acquisitionShard ?? null,
      pageCount: result.pageCount || 0,
      vectorPageCount: result.vectorPageCount || 0,
      textPageCount: result.textPageCount || 0,
      rasterFallbackPageCount: result.rasterFallbackPageCount || 0,
      warnings: result.warnings || [],
      error: result.error || null
    })),
    pages
  };
  await writeSmallJson(path.join(outDir, "manifest.json"), manifest);
  return { outDir, manifest };
}

async function writeExtractedPage(pagesDir, extraction, page) {
  const contentHash = extraction.contentHash || "unknown";
  const pageNumber = Number(page.pageNumber || 1);
  const stem = `${safeName(contentHash)}-p${pageNumber}`;
  const normalized = extraction.normalizedEvidence || {};
  const geometry = (normalized.geometryCandidates || []).filter((entry) => samePage(entry, contentHash, pageNumber));
  const vertical = (normalized.verticalObservations || []).filter((entry) => samePage(entry, contentHash, pageNumber));
  const material = (normalized.materialObservations || []).filter((entry) => samePage(entry, contentHash, pageNumber));
  const metadata = (normalized.drawingMetadata || []).filter((entry) => samePage(entry, contentHash, pageNumber, true))
    .map((entry) => ({ ...entry, contentHash: entry.contentHash || contentHash, pageNumber }));
  const geometryFile = geometry.length ? `pages/${stem}.geometry.ndjson` : null;
  const verticalFile = vertical.length ? `pages/${stem}.vertical.ndjson` : null;
  const materialFile = material.length ? `pages/${stem}.material.ndjson` : null;
  if (geometryFile) await writeNdjson(path.join(path.dirname(pagesDir), geometryFile), geometry);
  if (verticalFile) await writeNdjson(path.join(path.dirname(pagesDir), verticalFile), vertical);
  if (materialFile) await writeNdjson(path.join(path.dirname(pagesDir), materialFile), material);
  return {
    contentHash,
    pageNumber,
    classification: extraction.classification || "unknown",
    applicationKeys: extraction.applicationKeys || [],
    acquisitionShard: extraction.acquisitionShard ?? null,
    widthPt: page.widthPt ?? null,
    heightPt: page.heightPt ?? null,
    rotation: page.rotation ?? 0,
    text: page.text || null,
    vector: page.vector || null,
    drawingMetadata: metadata,
    rasterFallback: page.rasterFallback || null,
    geometryFile,
    verticalFile,
    materialFile,
    geometryCount: geometry.length,
    verticalCount: vertical.length,
    materialCount: material.length
  };
}

export async function mergeExtractionBundles(inputRoot, outDir) {
  const manifests = await findBundleManifests(inputRoot, EXTRACTION_BUNDLE_FORMAT);
  const target = path.resolve(outDir);
  await mkdir(path.join(target, "pages"), { recursive: true });
  const pages = [];
  const documents = [];
  const failures = [];
  const fallback = [];
  const seenPage = new Set();
  for (const located of manifests) {
    const manifest = located.manifest;
    failures.push(...(manifest.failures || []));
    fallback.push(...(manifest.rasterFallbackQueue || []));
    documents.push(...(manifest.documents || []));
    for (const pageEntry of manifest.pages || []) {
      const key = `${pageEntry.contentHash}:p${pageEntry.pageNumber}`;
      if (seenPage.has(key)) continue;
      seenPage.add(key);
      const copied = { ...pageEntry };
      for (const field of ["geometryFile", "verticalFile", "materialFile"]) {
        if (!pageEntry[field]) continue;
        const source = path.resolve(located.root, pageEntry[field]);
        const filename = path.basename(pageEntry[field]);
        const relative = `pages/${filename}`;
        await copyFile(source, path.join(target, relative));
        copied[field] = relative;
      }
      pages.push(copied);
    }
  }
  pages.sort(pageSort);
  const rasterFallbackQueue = dedupeFallback(fallback);
  const manifest = {
    schemaVersion: 1,
    format: EXTRACTION_BUNDLE_FORMAT,
    stage: "merged-extraction",
    coordinateSpace: "pdf-user-space-points",
    georegistrationStatus: "required",
    worldGeometryReady: false,
    inputShardBundles: manifests.length,
    documentCount: new Set(documents.filter((d) => d.contentHash).map((d) => d.contentHash)).size,
    pageCount: pages.length,
    geometryCandidateCount: sum(pages, "geometryCount"),
    verticalObservationCount: sum(pages, "verticalCount"),
    materialObservationCount: sum(pages, "materialCount"),
    rasterFallbackPages: rasterFallbackQueue.length,
    failures,
    rasterFallbackQueue,
    documents: dedupeDocuments(documents),
    pages
  };
  await writeSmallJson(path.join(target, "manifest.json"), manifest);
  return { outDir: target, manifest };
}

export async function readBundlePage(bundleRoot, pageEntry) {
  const root = path.resolve(bundleRoot);
  return {
    geometryCandidates: pageEntry.geometryFile ? await readNdjson(path.join(root, pageEntry.geometryFile)) : [],
    verticalObservations: pageEntry.verticalFile ? await readNdjson(path.join(root, pageEntry.verticalFile)) : [],
    materialObservations: pageEntry.materialFile ? await readNdjson(path.join(root, pageEntry.materialFile)) : [],
    drawingMetadata: (pageEntry.drawingMetadata || []).map((entry) => ({
      ...entry,
      contentHash: entry.contentHash || pageEntry.contentHash,
      pageNumber: Number(entry.pageNumber || pageEntry.pageNumber || 1)
    }))
  };
}

export async function writeEvidencePageStreams(bundleRoot, pageEntry, evidence, prefix = null) {
  const root = path.resolve(bundleRoot);
  await mkdir(path.join(root, "pages"), { recursive: true });
  const stem = prefix || `${safeName(pageEntry.contentHash)}-p${Number(pageEntry.pageNumber || 1)}`;
  const result = { ...pageEntry };
  const groups = [
    ["geometryCandidates", "geometryFile", "geometryCount", "geometry"],
    ["verticalObservations", "verticalFile", "verticalCount", "vertical"],
    ["materialObservations", "materialFile", "materialCount", "material"]
  ];
  for (const [arrayKey, fileKey, countKey, suffix] of groups) {
    const values = evidence?.[arrayKey] || [];
    result[countKey] = values.length;
    if (!values.length) {
      result[fileKey] = null;
      continue;
    }
    const relative = `pages/${stem}.${suffix}.ndjson`;
    await writeNdjson(path.join(root, relative), values);
    result[fileKey] = relative;
  }
  result.drawingMetadata = evidence?.drawingMetadata || pageEntry.drawingMetadata || [];
  return result;
}

export async function findBundleManifests(root, format = null) {
  const base = path.resolve(root);
  const files = await walk(base);
  const results = [];
  for (const filename of files.filter((file) => path.basename(file) === "manifest.json")) {
    let manifest;
    try { manifest = JSON.parse(await readFile(filename, "utf8")); } catch { continue; }
    if (format && manifest?.format !== format) continue;
    results.push({ root: path.dirname(filename), filename, manifest });
  }
  return results.sort((a, b) => a.filename.localeCompare(b.filename));
}

export async function loadBundleManifest(rootOrManifest, format = null) {
  const resolved = path.resolve(rootOrManifest);
  const details = await stat(resolved);
  const filename = details.isDirectory() ? path.join(resolved, "manifest.json") : resolved;
  const manifest = JSON.parse(await readFile(filename, "utf8"));
  if (format && manifest?.format !== format) throw new Error(`Expected ${format}, found ${manifest?.format || "unknown bundle format"}`);
  return { root: path.dirname(filename), filename, manifest };
}

export async function writeBundleManifest(root, manifest) {
  await mkdir(path.resolve(root), { recursive: true });
  await writeSmallJson(path.join(path.resolve(root), "manifest.json"), manifest);
  return path.join(path.resolve(root), "manifest.json");
}

export async function writeNdjson(filename, values) {
  await mkdir(path.dirname(filename), { recursive: true });
  const stream = createWriteStream(filename, { encoding: "utf8" });
  try {
    for (const value of values || []) {
      if (!stream.write(`${JSON.stringify(value)}\n`)) await onceDrain(stream);
    }
  } finally {
    await closeWriteStream(stream);
  }
  return filename;
}

export async function readNdjson(filename) {
  const values = [];
  if (!filename) return values;
  const input = createReadStream(filename, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    values.push(JSON.parse(line));
  }
  return values;
}

export async function* iterateNdjson(filename) {
  if (!filename) return;
  const input = createReadStream(filename, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    yield JSON.parse(line);
  }
}

export async function transformNdjson(inputFilename, outputFilename, transform) {
  await mkdir(path.dirname(outputFilename), { recursive: true });
  const stream = createWriteStream(outputFilename, { encoding: "utf8" });
  try {
    for await (const value of iterateNdjson(inputFilename)) {
      const transformed = await transform(value);
      if (transformed == null) continue;
      const values = Array.isArray(transformed) ? transformed : [transformed];
      for (const entry of values) {
        if (!stream.write(`${JSON.stringify(entry)}\n`)) await onceDrain(stream);
      }
    }
  } finally {
    await closeWriteStream(stream);
  }
}

function samePage(entry, contentHash, pageNumber, metadata = false) {
  if (entry?.contentHash && entry.contentHash !== contentHash) return false;
  const page = Number(entry?.pageNumber || 1);
  if (page !== pageNumber) return false;
  if (metadata) return true;
  return true;
}

function dedupeDocuments(values) {
  const map = new Map();
  for (const value of values || []) {
    const key = value?.contentHash || `${value?.objectPath || ""}:${value?.classification || ""}`;
    if (!map.has(key)) map.set(key, value);
  }
  return [...map.values()].sort((a, b) => String(a.contentHash || "").localeCompare(String(b.contentHash || "")));
}

function dedupeFallback(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const key = `${value.contentHash || ""}:p${value.pageNumber || 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result.sort((a, b) => (b.priority || 0) - (a.priority || 0) || String(a.contentHash || "").localeCompare(String(b.contentHash || "")) || Number(a.pageNumber || 0) - Number(b.pageNumber || 0));
}

function pageSort(a, b) {
  return String(a.contentHash || "").localeCompare(String(b.contentHash || "")) || Number(a.pageNumber || 0) - Number(b.pageNumber || 0);
}

function sum(values, key) { return (values || []).reduce((total, value) => total + Number(value?.[key] || 0), 0); }
function safeName(value) { return String(value || "unknown").replace(/[^a-zA-Z0-9._-]+/g, "_"); }
function clampInt(value, min, max) { const number = Math.floor(Number(value)); return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : min; }

async function walk(root) {
  const result = [];
  let entries = [];
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await walk(filename));
    else result.push(filename);
  }
  return result;
}

function onceDrain(stream) {
  return new Promise((resolve, reject) => {
    stream.once("drain", resolve);
    stream.once("error", reject);
  });
}

function closeWriteStream(stream) {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

async function writeSmallJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`);
  return filename;
}
