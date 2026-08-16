import path from "node:path";
import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import {
  EXTRACTION_BUNDLE_FORMAT,
  REGISTERED_BUNDLE_FORMAT,
  findBundleManifests,
  loadBundleManifest,
  writeBundleManifest
} from "./planning-evidence-bundle.mjs";
import { sha256 } from "./io.mjs";

const STREAM_FIELDS = Object.freeze(["geometryFile", "verticalFile", "materialFile", "templateFile"]);

export function buildPlanningGeoregistrationShardPlan(manifest, options = {}) {
  if (manifest?.format !== EXTRACTION_BUNDLE_FORMAT) {
    throw new Error(`Expected ${EXTRACTION_BUNDLE_FORMAT}, found ${manifest?.format || "unknown bundle format"}`);
  }
  const pages = [...(manifest.pages || [])].sort(pageSort);
  const requested = clampInt(options.shards ?? 20, 1, 100);
  const activeShardCount = pages.length ? Math.min(requested, pages.length) : 1;
  const bins = Array.from({ length: activeShardCount }, (_, shard) => ({ shard, weight: 0, pageKeys: [] }));
  const weightedPages = pages.map((page) => ({
    key: planningPageKey(page),
    weight: georegistrationPageWeight(page),
    page
  })).sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));

  for (const page of weightedPages) {
    bins.sort((a, b) => a.weight - b.weight || a.pageKeys.length - b.pageKeys.length || a.shard - b.shard);
    const target = bins[0];
    target.pageKeys.push(page.key);
    target.weight += page.weight;
  }
  bins.sort((a, b) => a.shard - b.shard);
  for (const bin of bins) bin.pageKeys.sort();

  const assignments = Object.fromEntries(bins.flatMap((bin) => bin.pageKeys.map((key) => [key, bin.shard])));
  const sourceFingerprint = extractionManifestFingerprint(manifest);
  return {
    schemaVersion: 1,
    format: "voxel-planning-georeg-shard-plan-v1",
    strategy: "weighted-longest-processing-time",
    sourceBundleFormat: manifest.format,
    sourceFingerprint,
    requestedShards: requested,
    activeShardCount,
    activeShards: bins.filter((bin) => bin.pageKeys.length > 0).map((bin) => bin.shard),
    pageCount: pages.length,
    totalWeight: bins.reduce((sum, bin) => sum + bin.weight, 0),
    maxShardWeight: Math.max(0, ...bins.map((bin) => bin.weight)),
    minShardWeight: Math.min(...bins.map((bin) => bin.weight)),
    shardWeights: Object.fromEntries(bins.map((bin) => [String(bin.shard), round(bin.weight)])),
    shardPageCounts: Object.fromEntries(bins.map((bin) => [String(bin.shard), bin.pageKeys.length])),
    assignments,
    shards: bins.map((bin) => ({
      shard: bin.shard,
      weight: round(bin.weight),
      pageCount: bin.pageKeys.length,
      pageKeys: bin.pageKeys
    }))
  };
}

export async function materializePlanningGeoregistrationInputShard(evidencePath, plan, shardIndex, outDir) {
  const bundle = await loadBundleManifest(evidencePath, EXTRACTION_BUNDLE_FORMAT);
  validatePlanAgainstManifest(plan, bundle.manifest);
  const shard = Number(shardIndex);
  if (!Number.isInteger(shard) || shard < 0 || shard >= Number(plan.activeShardCount || 0)) {
    throw new Error(`Planning georegistration shard index must be 0..${Math.max(0, Number(plan.activeShardCount || 1) - 1)}`);
  }
  const selectedKeys = new Set(plan.shards?.find((entry) => Number(entry.shard) === shard)?.pageKeys || []);
  const selectedPages = (bundle.manifest.pages || []).filter((page) => selectedKeys.has(planningPageKey(page))).sort(pageSort);
  const target = path.resolve(outDir);
  await mkdir(path.join(target, "pages"), { recursive: true });
  const pages = [];
  for (const page of selectedPages) {
    const copied = { ...page };
    for (const field of STREAM_FIELDS) {
      if (!page[field]) continue;
      const source = path.resolve(bundle.root, page[field]);
      const relative = `pages/${path.basename(page[field])}`;
      await copyFile(source, path.join(target, relative));
      copied[field] = relative;
    }
    pages.push(copied);
  }
  const contentHashes = new Set(pages.map((page) => page.contentHash).filter(Boolean));
  const manifest = {
    ...bundle.manifest,
    stage: "georegistration-input-shard",
    parallelGeoregistration: {
      planFormat: plan.format,
      sourceFingerprint: plan.sourceFingerprint,
      strategy: plan.strategy,
      selectedShard: shard,
      activeShardCount: plan.activeShardCount
    },
    selectedShard: shard,
    inputShardBundles: undefined,
    documentCount: contentHashes.size,
    pageCount: pages.length,
    geometryCandidateCount: sum(pages, "geometryCount"),
    verticalObservationCount: sum(pages, "verticalCount"),
    materialObservationCount: sum(pages, "materialCount"),
    rideStructureTemplateCount: sum(pages, "rideStructureTemplateCount"),
    documents: (bundle.manifest.documents || []).filter((document) => contentHashes.has(document.contentHash)),
    pages
  };
  await writeBundleManifest(target, manifest);
  return { outDir: target, manifest };
}

export async function mergePlanningGeoregistrationShards(inputRoot, outDir, options = {}) {
  const located = await findBundleManifests(inputRoot, REGISTERED_BUNDLE_FORMAT);
  if (!located.length) throw new Error("No registered planning georegistration shard bundles were found");
  const target = path.resolve(outDir);
  await mkdir(path.join(target, "pages"), { recursive: true });
  const pages = [];
  const unregisteredPages = [];
  const seenPages = new Set();
  const seenUnregistered = new Set();
  let registeredPageCount = 0;
  let templateOnlyPageCount = 0;
  let geometryCandidateCount = 0;
  let verticalObservationCount = 0;
  let materialObservationCount = 0;
  let rideStructureTemplateCount = 0;

  for (const bundle of located) {
    const manifest = bundle.manifest;
    registeredPageCount += Number(manifest.registeredPageCount || 0);
    templateOnlyPageCount += Number(manifest.templateOnlyPageCount || 0);
    geometryCandidateCount += Number(manifest.geometryCandidateCount || 0);
    verticalObservationCount += Number(manifest.verticalObservationCount || 0);
    materialObservationCount += Number(manifest.materialObservationCount || 0);
    rideStructureTemplateCount += Number(manifest.rideStructureTemplateCount || 0);
    for (const page of manifest.pages || []) {
      const key = planningPageKey(page);
      if (seenPages.has(key)) throw new Error(`Duplicate registered planning page across georegistration shards: ${key}`);
      seenPages.add(key);
      const copied = { ...page };
      for (const field of STREAM_FIELDS) {
        if (!page[field]) continue;
        const source = path.resolve(bundle.root, page[field]);
        const relative = `pages/${path.basename(page[field])}`;
        await copyFile(source, path.join(target, relative));
        copied[field] = relative;
      }
      pages.push(copied);
    }
    for (const page of manifest.unregisteredPages || []) {
      const key = planningPageKey(page);
      if (seenUnregistered.has(key)) continue;
      seenUnregistered.add(key);
      unregisteredPages.push(page);
    }
  }

  pages.sort(pageSort);
  unregisteredPages.sort(pageSort);
  const reports = await findGeoregistrationReports(inputRoot);
  const registrations = reports.flatMap((report) => report.registrations || []).sort(pageSort);
  const spatialRegistrations = registrations.filter((entry) => entry.status !== "template-only");
  const spatialFailed = spatialRegistrations.filter((entry) => entry.status !== "registered");
  const status = spatialRegistrations.length
    ? (spatialFailed.length === 0 ? "registered" : registeredPageCount > 0 ? "partially-registered" : "unregistered")
    : templateOnlyPageCount > 0 ? "template-only" : "unregistered";
  const manifest = {
    schemaVersion: 1,
    format: REGISTERED_BUNDLE_FORMAT,
    stage: "registered",
    coordinateSpace: "local-world-metres-plus-nonspatial-templates",
    georegistrationStatus: status,
    worldGeometryReady: geometryCandidateCount > 0,
    worldGeometryAuthority: false,
    spatialAuthorityEligible: true,
    temporalResolutionRequired: true,
    sourceBundleFormat: EXTRACTION_BUNDLE_FORMAT,
    parallelGeoregistration: {
      enabled: true,
      shardBundles: located.length,
      reportShards: reports.length,
      strategy: options.strategy || "weighted-longest-processing-time"
    },
    pageCount: registrations.length || registeredPageCount + templateOnlyPageCount + unregisteredPages.length,
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
  await writeBundleManifest(target, manifest);
  return {
    manifest,
    reports,
    report: {
      schemaVersion: 4,
      status,
      mode: "parallel-chunked-bundle",
      groupCount: registrations.length || manifest.pageCount,
      registeredGroupCount: registeredPageCount,
      templateOnlyGroupCount: templateOnlyPageCount,
      unregisteredGroupCount: unregisteredPages.length,
      registrations,
      unregisteredPages,
      bbox: options.reference?.bbox || reports.find((report) => report.bbox)?.bbox || null,
      referenceProvider: options.reference?.provider || reports.find((report) => report.referenceProvider)?.referenceProvider || null,
      referenceFeatureCount: options.reference?.featureCount ?? options.reference?.features?.length ?? reports.find((report) => report.referenceFeatureCount != null)?.referenceFeatureCount ?? 0,
      parallelGeoregistration: manifest.parallelGeoregistration,
      registeredEvidence: {
        format: REGISTERED_BUNDLE_FORMAT,
        coordinateSpace: manifest.coordinateSpace,
        worldGeometryReady: manifest.worldGeometryReady,
        worldGeometryAuthority: false,
        temporalResolutionRequired: true,
        registeredPageCount,
        templateOnlyPageCount,
        geometryCandidateCount,
        verticalObservationCount,
        materialObservationCount,
        rideStructureTemplateCount
      }
    }
  };
}

export function planningPageKey(page) {
  return `${page?.contentHash || "unknown"}:p${Number(page?.pageNumber || 1)}`;
}

export function georegistrationPageWeight(page) {
  const geometry = Number(page?.geometryCount || 0);
  const vertical = Number(page?.verticalCount || 0);
  const material = Number(page?.materialCount || 0);
  const templates = Number(page?.rideStructureTemplateCount || 0);
  const spatial = geometry + vertical + material;
  if (!spatial && templates > 0) return 0.25 + Math.min(2, templates * 0.02);
  return 1 + geometry * 8 + vertical * 2 + material * 2 + templates * 0.02;
}

function extractionManifestFingerprint(manifest) {
  return sha256({
    format: manifest?.format,
    pageCount: manifest?.pageCount,
    geometryCandidateCount: manifest?.geometryCandidateCount,
    verticalObservationCount: manifest?.verticalObservationCount,
    materialObservationCount: manifest?.materialObservationCount,
    rideStructureTemplateCount: manifest?.rideStructureTemplateCount,
    pages: (manifest?.pages || []).map((page) => ({
      key: planningPageKey(page),
      geometryCount: page.geometryCount || 0,
      verticalCount: page.verticalCount || 0,
      materialCount: page.materialCount || 0,
      rideStructureTemplateCount: page.rideStructureTemplateCount || 0
    }))
  });
}

function validatePlanAgainstManifest(plan, manifest) {
  if (plan?.format !== "voxel-planning-georeg-shard-plan-v1") throw new Error("Unsupported planning georegistration shard plan");
  const actual = extractionManifestFingerprint(manifest);
  if (plan.sourceFingerprint !== actual) {
    throw new Error("Planning georegistration shard plan does not match the extraction evidence bundle");
  }
}

async function findGeoregistrationReports(root) {
  const files = await walk(path.resolve(root));
  const reports = [];
  for (const filename of files.filter((entry) => /^planning-georegistration-shard-\d+\.json$/.test(path.basename(entry)))) {
    try {
      const report = JSON.parse(await readFile(filename, "utf8"));
      reports.push(report);
    } catch {}
  }
  return reports.sort((a, b) => firstRegistrationKey(a).localeCompare(firstRegistrationKey(b)));
}

async function walk(root) {
  const files = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walk(filename));
    else files.push(filename);
  }
  return files;
}

function firstRegistrationKey(report) {
  return planningPageKey(report?.registrations?.[0] || {});
}
function sum(pages, field) { return pages.reduce((total, page) => total + Number(page?.[field] || 0), 0); }
function pageSort(a, b) { return String(a?.contentHash || "").localeCompare(String(b?.contentHash || "")) || Number(a?.pageNumber || 0) - Number(b?.pageNumber || 0); }
function clampInt(value, min, max) {
  const number = Math.floor(Number(value));
  return Math.max(min, Math.min(max, Number.isFinite(number) ? number : min));
}
function round(value) { return Math.round(Number(value || 0) * 1000) / 1000; }
