import path from "node:path";
import { enrichPlanningPedestrianEvidence } from "./planning-pedestrian-enrichment.mjs";
import { readNdjson, writeNdjson } from "./planning-evidence-bundle.mjs";

/**
 * Applies pedestrian/plaza semantics to the chunked extraction bundle used by
 * the production planning pipeline. The raw-PDF enrichment logic needs page
 * text plus vector bounds, both of which are retained by the bundle, but the
 * sharded production writer previously never invoked that enrichment pass.
 *
 * This pass grants no world authority. It only persists path/plaza semantics so
 * later georegistration and current-state resolution can make the authority
 * decision normally.
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
    terrainGeometryMutable: false,
    terrainElevationMutable: false
  };
  return aggregate;
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
