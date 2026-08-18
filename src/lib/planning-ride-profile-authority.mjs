import { matchPointObservation } from "./planning-authority-fusion-base.mjs";

const AUTHORITY_LAYER = "planning-current-authority";
const AUTHORITY_SOURCE = "Planning current-state authority";
const DEFAULT_SAMPLE_M = 1;
const DEFAULT_ANCHOR_TOLERANCE_M = 8;
const DEFAULT_MIN_ANCHOR_SEPARATION_M = 5;
const DEFAULT_ANCHOR_MERGE_M = 0.75;

/**
 * Adds a planning-current verticalProfile candidate to ride tracks when the
 * strict authority handoff contains at least two independently positioned,
 * absolute ride-level observations on the registered plan view.
 *
 * This is intentionally fail-closed:
 * - only strict current authority observations are considered;
 * - generic building/ground levels are ignored;
 * - relative RL values are not treated as AOD unless the observation declares
 *   an absolute datum;
 * - the profile never extrapolates beyond the first/last proven anchor;
 * - ambiguous ride association stays rejected by the existing point matcher.
 */
export function attachPlanningRideProfileCandidates(map, options = {}) {
  const observations = (options.planningAuthorityEvidenceData?.verticalObservations || [])
    .filter(isCurrentAuthority)
    .filter(isRideLevelObservation);
  const rideFeatures = (map?.features || []).filter((feature) => feature?.kind === "ride_track" && feature?.localGeometry);
  const grouped = new Map();
  const rejected = {};
  const matches = [];

  for (const observation of observations) {
    const match = matchPointObservation(observation, rideFeatures, (kind) => kind === "ride_track", options);
    if (!match.accepted) {
      increment(rejected, `association-${match.reason}`);
      continue;
    }
    if (!grouped.has(match.feature.id)) grouped.set(match.feature.id, { feature: match.feature, observations: [] });
    grouped.get(match.feature.id).observations.push({ ...observation, associationScore: match.score, associationDistanceM: match.distanceM });
    matches.push({
      featureId: match.feature.id,
      featureName: match.feature.name || null,
      sourceRef: pageRef(observation),
      valueM: Number(observation.valueM),
      label: observation.label || null,
      distanceM: match.distanceM ?? null,
      score: match.score ?? null
    });
  }

  const profiles = [];
  for (const { feature, observations: featureObservations } of grouped.values()) {
    const result = buildPlanningRideProfile(feature, featureObservations, options);
    if (!result.accepted) {
      increment(rejected, result.reason);
      continue;
    }
    addProfileCandidate(feature, result.profile, result);
    profiles.push({
      featureId: feature.id,
      featureName: feature.name || null,
      anchorCount: result.anchorCount,
      verticalCoverage: result.profile.coverage.vertical,
      heightRangeM: result.profile.heightRangeM,
      sourceRefs: result.sourceRefs
    });
  }

  return {
    schemaVersion: 1,
    inputObservations: observations.length,
    matchedObservations: matches.length,
    acceptedProfiles: profiles.length,
    profiles,
    rejected,
    matches: matches.slice(0, Math.max(1, Number(options.maxPlanningRideProfileQaMatches || 250))),
    policy: {
      strictCurrentAuthorityOnly: true,
      absoluteDatumRequired: true,
      minimumAnchors: 2,
      extrapolationAllowed: false,
      ambiguousRideAssociationFailsClosed: true,
      terrainElevationMutable: false
    }
  };
}

export function materializePlanningRideProfileWinners(map) {
  const changes = [];
  for (const feature of map?.features || []) {
    if (feature?.kind !== "ride_track") continue;
    const winner = feature.evidenceGraph?.attributes?.verticalProfile?.winner;
    if (!winner || winner.authorityLayer !== AUTHORITY_LAYER) continue;
    const profile = winner.materializeValue;
    if (!validProfile(profile)) continue;
    if (feature.evidenceResolution?.verticalProfile?.authorityLayer === AUTHORITY_LAYER) continue;

    const before = compactProfile(feature.rideProfile);
    feature.rideProfile = clone(profile);
    feature.vertical ||= {};
    feature.vertical.explicit = Number(profile.coverage?.vertical || 0) > 0;
    feature.verification ||= {};
    feature.verification.vertical = Number(profile.coverage?.vertical || 0) >= 0.999
      ? "planning-current-authority"
      : "planning-current-authority-partial";
    feature.evidenceResolution ||= {};
    feature.evidenceResolution.verticalProfile = {
      source: winner.source,
      sourceRef: winner.sourceRef,
      authorityLayer: winner.authorityLayer,
      score: winner.score,
      method: winner.method,
      before,
      after: compactProfile(feature.rideProfile)
    };
    changes.push({
      featureId: feature.id,
      featureKind: feature.kind,
      attribute: "verticalProfile",
      sourceRef: winner.sourceRef,
      score: winner.score,
      coverage: profile.coverage.vertical,
      anchorCount: profile.validation?.anchorCount || null
    });
  }
  return { schemaVersion: 1, applied: changes.length, changes };
}

export function buildPlanningRideProfile(feature, observations, options = {}) {
  const lines = localLineStrings(feature?.localGeometry);
  if (!lines.length) return { accepted: false, reason: "ride-profile-missing-line-geometry" };
  const sampleSpacingM = Math.max(0.5, Number(options.planningRideProfileSampleM) || DEFAULT_SAMPLE_M);
  const anchorToleranceM = Math.max(0.5, Number(options.planningRideProfileAnchorToleranceM) || DEFAULT_ANCHOR_TOLERANCE_M);
  const minimumSeparationM = Math.max(1, Number(options.planningRideProfileMinAnchorSeparationM) || DEFAULT_MIN_ANCHOR_SEPARATION_M);
  const mergeDistanceM = Math.max(0.1, Number(options.planningRideProfileAnchorMergeM) || DEFAULT_ANCHOR_MERGE_M);

  const projected = [];
  for (const observation of observations || []) {
    if (!isRideLevelObservation(observation)) continue;
    const point = [Number(observation.localX), Number(observation.localZ)];
    if (!point.every(Number.isFinite)) continue;
    const projection = nearestProjection(point, lines);
    if (!projection || projection.distanceM > anchorToleranceM) continue;
    projected.push({
      ...projection,
      elevationM: Number(observation.valueM),
      confidence: clamp(Number(observation.confidence ?? 0.9)),
      sourceRef: pageRef(observation),
      label: observation.label || null,
      raw: observation.raw || null
    });
  }
  if (projected.length < 2) return { accepted: false, reason: "ride-profile-fewer-than-two-positioned-absolute-levels" };

  const byPart = new Map();
  for (const anchor of projected) {
    if (!byPart.has(anchor.partIndex)) byPart.set(anchor.partIndex, []);
    byPart.get(anchor.partIndex).push(anchor);
  }

  const parts = [];
  const acceptedAnchors = [];
  let totalSamples = 0;
  let verticalSamples = 0;
  let directSamples = 0;
  let interpolatedSamples = 0;

  for (let partIndex = 0; partIndex < lines.length; partIndex += 1) {
    const line = lines[partIndex];
    const samples = resampleLine(line, sampleSpacingM);
    totalSamples += samples.length;
    const anchors = mergeNearbyAnchors((byPart.get(partIndex) || []).sort((a, b) => a.chainageM - b.chainageM), mergeDistanceM);
    const separated = anchors.length >= 2 && anchors[anchors.length - 1].chainageM - anchors[0].chainageM >= minimumSeparationM;
    if (!separated) {
      parts.push(samples.map((sample) => emptySample(sample)));
      continue;
    }
    acceptedAnchors.push(...anchors);
    const rendered = samples.map((sample) => {
      const bracket = interpolationBracket(anchors, sample.chainageM);
      if (!bracket) return emptySample(sample);
      const [left, right] = bracket;
      const direct = Math.abs(sample.chainageM - left.chainageM) <= sampleSpacingM * 0.45
        ? left
        : Math.abs(sample.chainageM - right.chainageM) <= sampleSpacingM * 0.45 ? right : null;
      if (direct) {
        verticalSamples += 1;
        directSamples += 1;
        return {
          ...sample,
          elevationM: direct.elevationM,
          bankingDeg: null,
          evidence: "planning-verified",
          confidence: direct.confidence,
          sourceRef: direct.sourceRef
        };
      }
      const span = right.chainageM - left.chainageM;
      if (!(span > 0)) return emptySample(sample);
      const fraction = (sample.chainageM - left.chainageM) / span;
      verticalSamples += 1;
      interpolatedSamples += 1;
      return {
        ...sample,
        elevationM: left.elevationM + (right.elevationM - left.elevationM) * fraction,
        bankingDeg: null,
        evidence: "interpolated",
        confidence: Math.min(left.confidence, right.confidence) * 0.82,
        sourceRef: `${left.sourceRef}|${right.sourceRef}`,
        interpolatedBetweenM: [round(left.chainageM), round(right.chainageM)]
      };
    });
    parts.push(rendered);
  }

  if (acceptedAnchors.length < 2 || verticalSamples === 0) {
    return { accepted: false, reason: "ride-profile-anchors-do-not-span-a-track-part" };
  }

  const values = parts.flat().filter((sample) => Number.isFinite(sample.elevationM));
  const coverage = totalSamples ? verticalSamples / totalSamples : 0;
  const confidence = values.length
    ? values.reduce((sum, sample) => sum + Number(sample.confidence || 0), 0) / values.length
    : 0;
  const sourceRefs = [...new Set(acceptedAnchors.map((anchor) => anchor.sourceRef))].sort();
  const profile = {
    schemaVersion: 1,
    method: "planning-current-registered-absolute-track-level-anchors",
    source: {
      provider: AUTHORITY_SOURCE,
      sourceRefs,
      evidence: "verified-current georegistered plan-view absolute ride levels"
    },
    coordinateReference: { horizontal: "local 1 m map grid", elevation: "metres AOD/declared absolute datum" },
    parts,
    sampleCount: totalSamples,
    evidenceCounts: {
      "planning-verified": directSamples,
      interpolated: interpolatedSamples,
      none: Math.max(0, totalSamples - verticalSamples)
    },
    coverage: { vertical: round(coverage), banking: 0 },
    confidence: round(confidence),
    heightRangeM: {
      min: round(Math.min(...values.map((sample) => sample.elevationM))),
      max: round(Math.max(...values.map((sample) => sample.elevationM)))
    },
    bankingMethod: "unknown",
    warnings: [
      "Profile uses only strict-current planning level anchors registered to the plan view.",
      "No banking is claimed without explicit banking evidence.",
      ...(coverage < 0.999 ? ["Track outside the proven anchor span remains 2D-only; no vertical extrapolation was performed."] : [])
    ],
    validation: {
      anchorCount: acceptedAnchors.length,
      anchorSourceRefs: sourceRefs,
      anchorToleranceM,
      minimumAnchorSeparationM: minimumSeparationM,
      extrapolatedSamples: 0,
      terrainElevationChanged: false
    }
  };

  return {
    accepted: true,
    profile,
    anchorCount: acceptedAnchors.length,
    sourceRefs,
    confidence
  };
}

function addProfileCandidate(feature, profile, result) {
  feature.planningAuthorityCandidates ||= [];
  const quality = {
    authority: 0.9,
    directness: clamp(0.88 + 0.1 * Number(profile.coverage?.vertical || 0)),
    confidence: clamp(result.confidence || profile.confidence || 0.9),
    recency: 1,
    resolution: 0.82,
    temporal: 0.997
  };
  const score = 0.34 * quality.authority + 0.24 * quality.directness + 0.15 * quality.confidence +
    0.10 * quality.recency + 0.10 * quality.resolution + 0.07 * quality.temporal;
  feature.planningAuthorityCandidates.push({
    schemaVersion: 1,
    attribute: "verticalProfile",
    value: compactProfile(profile),
    materializeValue: clone(profile),
    role: null,
    method: profile.method,
    source: AUTHORITY_SOURCE,
    sourceRef: result.sourceRefs.join(","),
    authorityLayer: AUTHORITY_LAYER,
    authorityRank: 360,
    observedAt: null,
    quality,
    score: round(score),
    provenance: {
      anchorCount: result.anchorCount,
      sourceRefs: result.sourceRefs,
      extrapolationAllowed: false,
      terrainElevationMutable: false
    },
    worldGeometryAuthority: true
  });
}

function isRideLevelObservation(entry) {
  if (!isCurrentAuthority(entry)) return false;
  if (!Number.isFinite(Number(entry?.valueM))) return false;
  const classification = normalizeClass(entry?.classification);
  const raw = String(entry?.raw || "");
  const label = String(entry?.label || "").toUpperCase().replace(/\s+/g, " ").trim();
  const rideContext = classification === "ride_layout" || /\b(track|rail|coaster|ride)\b/i.test(raw);
  if (!rideContext) return false;
  const declaredAod = String(entry?.datum || "").toUpperCase() === "AOD" || /\bAOD\b/i.test(raw) || label === "AOD";
  if (!declaredAod) return false;
  return /^(AOD|RL|R\.L\.|TRACK LEVEL|TRACK RL|TOP OF RAIL|RAIL LEVEL|TOR)$/i.test(label) || /\b(track level|top of rail|rail level|track\s+r\.?l\.?|tor)\b/i.test(raw);
}

function isCurrentAuthority(entry) {
  return entry?.worldGeometryAuthority === true && entry?.planningTemporal?.state === "current";
}

function nearestProjection(point, lines) {
  let best = null;
  for (let partIndex = 0; partIndex < lines.length; partIndex += 1) {
    const line = lines[partIndex];
    let chainage = 0;
    for (let index = 1; index < line.length; index += 1) {
      const a = line[index - 1], b = line[index];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const length = Math.hypot(dx, dz);
      if (!(length > 0)) continue;
      const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / (length * length)));
      const x = a[0] + dx * t, z = a[1] + dz * t;
      const distanceM = Math.hypot(point[0] - x, point[1] - z);
      const candidate = { partIndex, chainageM: chainage + length * t, x, z, distanceM };
      if (!best || distanceM < best.distanceM) best = candidate;
      chainage += length;
    }
  }
  return best;
}

function mergeNearbyAnchors(values, mergeDistanceM) {
  const groups = [];
  for (const value of values) {
    const previous = groups[groups.length - 1];
    if (!previous || value.chainageM - previous[previous.length - 1].chainageM > mergeDistanceM) groups.push([value]);
    else previous.push(value);
  }
  return groups.map((group) => ({
    ...group[0],
    chainageM: median(group.map((value) => value.chainageM)),
    elevationM: median(group.map((value) => value.elevationM)),
    confidence: Math.min(...group.map((value) => value.confidence)),
    sourceRef: [...new Set(group.map((value) => value.sourceRef))].sort().join("|")
  }));
}

function interpolationBracket(anchors, chainageM) {
  if (!anchors.length || chainageM < anchors[0].chainageM || chainageM > anchors[anchors.length - 1].chainageM) return null;
  for (let index = 1; index < anchors.length; index += 1) {
    if (chainageM <= anchors[index].chainageM) return [anchors[index - 1], anchors[index]];
  }
  return null;
}

function resampleLine(line, spacingM) {
  if (!line?.length) return [];
  const result = [{ x: line[0][0], z: line[0][1], chainageM: 0 }];
  let chainage = 0;
  for (let index = 1; index < line.length; index += 1) {
    const [x0, z0] = line[index - 1], [x1, z1] = line[index];
    const length = Math.hypot(x1 - x0, z1 - z0);
    if (!length) continue;
    const steps = Math.max(1, Math.ceil(length / spacingM));
    for (let step = 1; step <= steps; step += 1) {
      const fraction = step / steps;
      result.push({ x: x0 + (x1 - x0) * fraction, z: z0 + (z1 - z0) * fraction, chainageM: chainage + length * fraction });
    }
    chainage += length;
  }
  return result;
}

function emptySample(sample) {
  return { ...sample, elevationM: null, bankingDeg: null, evidence: "none", confidence: 0, sourceRef: null };
}

function localLineStrings(geometry) {
  if (geometry?.type === "LineString") return [geometry.coordinates || []];
  if (geometry?.type === "MultiLineString") return geometry.coordinates || [];
  return [];
}

function validProfile(profile) {
  return Boolean(profile?.parts?.length && Number(profile?.coverage?.vertical) > 0 && Array.isArray(profile.parts));
}

function compactProfile(profile) {
  if (!profile) return null;
  return {
    coverage: clone(profile.coverage || null),
    heightRangeM: clone(profile.heightRangeM || null),
    method: profile.method || null,
    sampleCount: Number(profile.sampleCount || 0),
    confidence: Number(profile.confidence || 0),
    validation: clone(profile.validation || null)
  };
}

function pageRef(entry) { return `${entry?.contentHash || "unknown"}:p${entry?.pageNumber || 1}`; }
function normalizeClass(value) { return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_"); }
function increment(bucket, key) { bucket[key] = (bucket[key] || 0) + 1; }
function clamp(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }
function round(value, places = 3) { const number = Number(value); if (!Number.isFinite(number)) return null; const factor = 10 ** places; return Math.round(number * factor) / factor; }
function median(values) { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); if (!sorted.length) return NaN; const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
