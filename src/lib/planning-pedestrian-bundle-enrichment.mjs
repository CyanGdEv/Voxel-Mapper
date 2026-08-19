import path from "node:path";
import { enrichPlanningPedestrianEvidence } from "./planning-pedestrian-enrichment.mjs";
import { readNdjson, writeNdjson } from "./planning-evidence-bundle.mjs";

const RIDE_LAYOUT_PLAZA = /\b(plaza|forecourt|concourse|courtyard|public\s+realm|pedestrian\s+(?:area|zone|space)|paved\s+(?:area|zone|space))\b/i;
const DEFAULT_LABEL_RADIUS_PT = 55;

/**
 * Applies pedestrian/plaza semantics to the chunked extraction bundle used by
 * the production planning pipeline. The raw-PDF enrichment logic needs page
 * text plus vector bounds, both of which are retained by the bundle, but the
 * sharded production writer previously never invoked that enrichment pass.
 *
 * This pass grants no world authority. It only persists path/plaza semantics so
 * later georegistration and current-state resolution can make the authority
 * decision normally. Ride-layout sheets get one narrow exception: an otherwise
 * unclassified CLOSED vector may become a plaza only when an explicit plaza/
 * pedestrian-area label is spatially adjacent. Track/support candidates already
 * classified by the ride semantic pass are never retyped.
 */
export async function enrichPlanningPedestrianBundle(bundleRoot, manifest, options = {}) {
  const root = path.resolve(bundleRoot);
  const aggregate = emptySummary();

  for (const page of manifest?.pages || []) {
    if (!page?.geometryFile) continue;
    const filename = path.resolve(root, page.geometryFile);
    const geometryCandidates = await readNdjson(filename);
    if (!geometryCandidates.length) continue;

    const extraction = {
      pages: [{
        pageNumber: Number(page.pageNumber || 1),
        text: page.text || { items: [] }
      }],
      normalizedEvidence: { geometryCandidates }
    };
    const summary = enrichPlanningPedestrianEvidence(extraction, options);
    const rideLayoutPlazas = enrichRideLayoutPlazas(geometryCandidates, page.text?.items || [], options);
    if (rideLayoutPlazas.count) {
      summary.counts ||= {};
      summary.counts.plaza = Number(summary.counts.plaza || 0) + rideLayoutPlazas.count;
      summary.matches = [...(summary.matches || []), ...rideLayoutPlazas.matches];
      summary.status = "enriched";
    }
    mergeSummary(aggregate, summary);
    if (enrichedCount(summary) > 0) await writeNdjson(filename, geometryCandidates);
    page.pedestrianExtraction = summary;
  }

  aggregate.status = aggregate.enrichedCandidates
    ? "enriched"
    : "no-pedestrian-or-parking-semantics";
  aggregate.policy = {
    authorityGranted: false,
    georegistrationStillRequired: true,
    temporalResolutionStillRequired: true,
    rideLayoutOpenRoutesRetyped: false,
    rideLayoutClosedPlazaRequiresExplicitNearbyLabel: true,
    terrainGeometryMutable: false,
    terrainElevationMutable: false
  };
  return aggregate;
}

function enrichRideLayoutPlazas(candidates, textItems, options) {
  const matches = [];
  for (const candidate of candidates || []) {
    if (normalizeClass(candidate?.classification) !== "ride_layout") continue;
    if (candidate.kind || candidate.featureKind || candidate.rideStructureEvidence) continue;
    if (candidate.closed !== true || !candidate.boundsPt) continue;
    const nearby = nearbyText(candidate.boundsPt, textItems, options);
    if (!nearby.length) continue;
    const text = nearby.map((entry) => entry.text).join(" ");
    if (!RIDE_LAYOUT_PLAZA.test(text)) continue;

    const tags = {
      ...(candidate.tags || candidate.properties?.tags || {}),
      highway: "pedestrian",
      "area:highway": "pedestrian",
      area: "yes",
      "planning:pedestrian_semantic": "pedestrian_plaza",
      "terrain:geometry_mutable": "no"
    };
    candidate.kind = "path";
    candidate.featureKind = "path";
    candidate.subtype = "pedestrian_plaza";
    candidate.semantic = "site-feature";
    candidate.tags = tags;
    candidate.label = nearby[0]?.text || candidate.label || null;
    candidate.properties = {
      ...(candidate.properties || {}),
      kind: "path",
      subtype: "pedestrian_plaza",
      label: candidate.label,
      tags
    };
    candidate.confidence = Math.max(Number(candidate.confidence || 0), 0.97);
    candidate.pedestrianEvidence = {
      schemaVersion: 1,
      source: "planning-pdf-explicit-ride-layout-plaza-label",
      confidence: 0.97,
      nearbyText: nearby.map((entry) => entry.text).slice(0, 8),
      worldGeometryAuthority: false,
      georegistrationRequired: true,
      temporalResolutionRequired: true,
      terrainGeometryMutable: false,
      terrainElevationMutable: false
    };
    matches.push({
      candidateId: candidate.id || null,
      pageNumber: candidate.pageNumber || 1,
      kind: "path",
      subtype: "pedestrian_plaza",
      confidence: 0.97,
      nearbyText: nearby.map((entry) => entry.text).slice(0, 5)
    });
  }
  return { count: matches.length, matches };
}

function nearbyText(bounds, items, options) {
  const radius = Math.max(5, Number(options.planningPedestrianLabelRadiusPt) || DEFAULT_LABEL_RADIUS_PT);
  const cx = (Number(bounds.minX) + Number(bounds.maxX)) / 2;
  const cy = (Number(bounds.minY) + Number(bounds.maxY)) / 2;
  const values = [];
  for (const item of items || []) {
    const text = String(item?.text || "").trim();
    const x = Number(item?.xPt), y = Number(item?.yPt);
    if (!text || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const dx = x < bounds.minX ? bounds.minX - x : x > bounds.maxX ? x - bounds.maxX : 0;
    const dy = y < bounds.minY ? bounds.minY - y : y > bounds.maxY ? y - bounds.maxY : 0;
    const edgeDistance = Math.hypot(dx, dy);
    if (edgeDistance > radius) continue;
    values.push({ text, edgeDistance, centerDistance: Math.hypot(x - cx, y - cy) });
  }
  return values.sort((a, b) => a.edgeDistance - b.edgeDistance || a.centerDistance - b.centerDistance || a.text.localeCompare(b.text)).slice(0, 8);
}

function emptySummary() {
  return {
    schemaVersion: 1,
    status: "not-run",
    pagesProcessed: 0,
    enrichedCandidates: 0,
    counts: {
      path: 0,
      plaza: 0,
      road: 0,
      parkingArea: 0,
      parkingBay: 0,
      parkingAisle: 0,
      parkingIsland: 0,
      ambiguous: 0,
      unlabeled: 0
    },
    matches: []
  };
}

function mergeSummary(target, source) {
  target.pagesProcessed += 1;
  for (const [key, value] of Object.entries(source?.counts || {})) {
    target.counts[key] = Number(target.counts[key] || 0) + Number(value || 0);
  }
  target.enrichedCandidates += enrichedCount(source);
  const room = Math.max(0, 500 - target.matches.length);
  if (room) target.matches.push(...(source?.matches || []).slice(0, room));
}

function enrichedCount(summary) {
  const counts = summary?.counts || {};
  return ["path", "plaza", "road", "parkingArea", "parkingBay", "parkingAisle", "parkingIsland"]
    .reduce((sum, key) => sum + Number(counts[key] || 0), 0);
}

function normalizeClass(value) {
  return String(value || "unknown").trim().toLowerCase().replace(/[\s-]+/g, "_");
}
