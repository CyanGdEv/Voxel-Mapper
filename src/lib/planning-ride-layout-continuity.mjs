const DEFAULT_ENDPOINT_TOLERANCE_PT = 3;
const DEFAULT_STYLE_WIDTH_TOLERANCE_PT = 0.08;

/**
 * Recovers CAD/PDF ride centrelines that were split into several independently
 * stroked vector paths. Recovery starts only from an explicit track seed that
 * the normal ride semantic pass already classified from nearby engineering
 * text. Unlabelled fragments may join that seed only when they are open
 * ride-layout linework, have the same stroke style, and are endpoint-connected.
 *
 * This is semantic recovery only. It cannot grant georegistration, temporal or
 * world authority, and it never bridges a geometric gap larger than the tight
 * PDF-space endpoint tolerance.
 */
export function recoverPlanningRideTrackContinuity(extraction, options = {}) {
  const candidates = extraction?.normalizedEvidence?.geometryCandidates || [];
  const pageByNumber = new Map((extraction?.pages || []).map((page) => [Number(page?.pageNumber || 1), page]));
  const tolerancePt = Math.max(0.1, Number(options.rideTrackContinuityEndpointTolerancePt) || DEFAULT_ENDPOINT_TOLERANCE_PT);
  const widthTolerancePt = Math.max(0.001, Number(options.rideTrackContinuityWidthTolerancePt) || DEFAULT_STYLE_WIDTH_TOLERANCE_PT);
  const summary = {
    schemaVersion: 1,
    status: "processed",
    seedTracks: 0,
    recoveredTrackFragments: 0,
    rejectedDisconnected: 0,
    rejectedStyleMismatch: 0,
    rejectedMissingVector: 0,
    ambiguousStyleGroups: 0,
    pages: [],
    policy: {
      requiresExplicitTrackSeed: true,
      sameRideLayoutPageRequired: true,
      sameStrokeStyleRequired: true,
      endpointConnectivityRequired: true,
      endpointTolerancePt: tolerancePt,
      authorityGranted: false,
      georegistrationStillRequired: true,
      temporalCurrentStateStillRequired: true,
      terrainGeometryMutable: false,
      terrainElevationMutable: false
    }
  };

  const pageNumbers = [...new Set(candidates
    .filter((candidate) => normalizeClass(candidate?.classification) === "ride_layout")
    .map((candidate) => Number(candidate?.pageNumber || 1)))].sort((a, b) => a - b);

  for (const pageNumber of pageNumbers) {
    const page = pageByNumber.get(pageNumber);
    const pageCandidates = candidates.filter((candidate) =>
      Number(candidate?.pageNumber || 1) === pageNumber && normalizeClass(candidate?.classification) === "ride_layout");
    const seeds = pageCandidates.filter(isExplicitTrackSeed);
    summary.seedTracks += seeds.length;
    if (!seeds.length) {
      summary.pages.push({ pageNumber, seedTracks: 0, recoveredTrackFragments: 0, styleGroups: 0 });
      continue;
    }

    const seedRecords = seeds.map((candidate) => candidateRecord(candidate, page, widthTolerancePt)).filter(Boolean);
    summary.rejectedMissingVector += seeds.length - seedRecords.length;
    const styleGroups = groupByStyle(seedRecords);
    if (styleGroups.size > 1) summary.ambiguousStyleGroups += 1;

    const recoverable = pageCandidates.filter(isRecoverableTrackFragment)
      .map((candidate) => candidateRecord(candidate, page, widthTolerancePt))
      .filter((record) => {
        if (record) return true;
        summary.rejectedMissingVector += 1;
        return false;
      });

    let recoveredOnPage = 0;
    for (const [styleKey, groupSeeds] of styleGroups) {
      const network = [...groupSeeds];
      let changed = true;
      while (changed) {
        changed = false;
        for (const record of recoverable) {
          if (record.recovered || record.styleKey !== styleKey) continue;
          // A fragment that could match more than one explicitly seeded style
          // family is rejected rather than assigned by distance.
          const matchingSeedStyles = [...styleGroups.keys()].filter((key) => styleCompatible(record, styleGroups.get(key)?.[0], widthTolerancePt));
          if (matchingSeedStyles.length !== 1 || matchingSeedStyles[0] !== styleKey) continue;
          const connection = nearestEndpointConnection(record, network);
          if (!connection || connection.distancePt > tolerancePt) continue;
          markRecovered(record.candidate, network.map((entry) => entry.candidate.id), record.styleKey, connection.distancePt);
          record.recovered = true;
          network.push(record);
          recoveredOnPage += 1;
          summary.recoveredTrackFragments += 1;
          changed = true;
        }
      }
    }

    for (const record of recoverable.filter((record) => !record.recovered)) {
      const anyStyle = [...styleGroups.values()].some((seedsForStyle) => styleCompatible(record, seedsForStyle[0], widthTolerancePt));
      if (!anyStyle) summary.rejectedStyleMismatch += 1;
      else summary.rejectedDisconnected += 1;
    }
    summary.pages.push({
      pageNumber,
      seedTracks: seeds.length,
      recoveredTrackFragments: recoveredOnPage,
      styleGroups: styleGroups.size
    });
  }

  if (!summary.seedTracks) summary.status = "no-explicit-track-seeds";
  else if (!summary.recoveredTrackFragments) summary.status = "seeded-no-continuity-recovery";
  else summary.status = "recovered";
  extraction.rideTrackContinuity = summary;
  return summary;
}

function isExplicitTrackSeed(candidate) {
  return candidate?.kind === "ride_track" &&
    candidate?.subtype === "ride_track_centerline" &&
    candidate?.rideStructureEvidence?.source === "planning-pdf-ride-structure-semantic-enrichment";
}

function isRecoverableTrackFragment(candidate) {
  if (!candidate || candidate.closed === true) return false;
  if (candidate.kind || candidate.featureKind || candidate.rideStructureEvidence) return false;
  return normalizeClass(candidate.classification) === "ride_layout" &&
    String(candidate.semantic || "").toLowerCase() === "ride-centerline-or-edge";
}

function candidateRecord(candidate, page, widthTolerancePt) {
  const vector = page?.vector?.paths?.[candidate?.vectorPathIndex];
  const commands = candidate?.commands?.length ? candidate.commands : vector?.commands;
  const endpoints = pathEndpoints(commands);
  if (!vector || !endpoints) return null;
  return {
    candidate,
    vector,
    endpoints,
    styleKey: styleFingerprint(vector, widthTolerancePt),
    style: normalizedStyle(vector, widthTolerancePt),
    recovered: false
  };
}

function groupByStyle(records) {
  const groups = new Map();
  for (const record of records) {
    if (!groups.has(record.styleKey)) groups.set(record.styleKey, []);
    groups.get(record.styleKey).push(record);
  }
  return groups;
}

function styleFingerprint(vector, widthTolerancePt) {
  return JSON.stringify(normalizedStyle(vector, widthTolerancePt));
}

function normalizedStyle(vector, widthTolerancePt) {
  const width = Number(vector?.lineWidthPt);
  const widthBucket = Number.isFinite(width) ? Math.round(width / widthTolerancePt) : null;
  return {
    paint: String(vector?.paint || "unknown").toLowerCase(),
    widthBucket,
    strokeColor: normalizeColor(vector?.strokeColor),
    dash: Array.isArray(vector?.dash) ? vector.dash.map((value) => round(Number(value), 2)) : []
  };
}

function styleCompatible(left, right, widthTolerancePt) {
  if (!left || !right) return false;
  const a = left.style || normalizedStyle(left.vector, widthTolerancePt);
  const b = right.style || normalizedStyle(right.vector, widthTolerancePt);
  return a.paint === b.paint && a.widthBucket === b.widthBucket &&
    JSON.stringify(a.strokeColor) === JSON.stringify(b.strokeColor) &&
    JSON.stringify(a.dash) === JSON.stringify(b.dash);
}

function pathEndpoints(commands) {
  const points = (commands || [])
    .filter((command) => Number.isFinite(Number(command?.x)) && Number.isFinite(Number(command?.y)))
    .map((command) => [Number(command.x), Number(command.y)]);
  if (points.length < 2) return null;
  return [points[0], points[points.length - 1]];
}

function nearestEndpointConnection(record, network) {
  let best = null;
  for (const target of network) {
    for (const a of record.endpoints) {
      for (const b of target.endpoints) {
        const distancePt = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (!best || distancePt < best.distancePt) best = { distancePt, targetCandidateId: target.candidate.id };
      }
    }
  }
  return best;
}

function markRecovered(candidate, seedCandidateIds, styleKey, continuityDistancePt) {
  const confidence = Math.max(Number(candidate.confidence || 0), 0.9);
  const tags = {
    ...(candidate.tags || candidate.properties?.tags || {}),
    "ride_structure:type": "ride_track_centerline",
    "ride_structure:source": "planning-pdf",
    "terrain:geometry_mutable": "no"
  };
  candidate.kind = "ride_track";
  candidate.featureKind = "ride_track";
  candidate.subtype = "ride_track_centerline";
  candidate.semantic = "ride-track-centerline";
  candidate.tags = tags;
  candidate.properties = { ...(candidate.properties || {}), kind: "ride_track", subtype: "ride_track_centerline", tags };
  candidate.confidence = confidence;
  candidate.rideStructureEvidence = {
    schemaVersion: 1,
    role: "track",
    subtype: "ride_track_centerline",
    supportCode: null,
    nearbyText: [],
    confidence,
    source: "planning-pdf-ride-track-style-continuity",
    seedCandidateIds: [...new Set(seedCandidateIds)].sort(),
    styleFingerprint: styleKey,
    continuityDistancePt: round(continuityDistancePt, 3),
    terrainGeometryMutable: false,
    terrainElevationMutable: false,
    worldGeometryAuthority: false,
    georegistrationRequired: true,
    temporalResolutionRequired: true
  };
}

function normalizeColor(value) {
  if (!Array.isArray(value)) return value == null ? null : String(value);
  return value.map((entry) => round(Number(entry), 4));
}
function normalizeClass(value) { return String(value || "unknown").trim().toLowerCase().replace(/[\s-]+/g, "_"); }
function round(value, places = 3) { const number = Number(value); if (!Number.isFinite(number)) return null; const factor = 10 ** places; return Math.round(number * factor) / factor; }
