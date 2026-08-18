const DEFAULT_REFERENCE_DATE = () => new Date();

const REQUIRED_ATTRIBUTES = {
  building: ["geometry", "height", "roof", "material"],
  structure: ["geometry", "height", "material"],
  path: ["geometry", "width", "material"],
  road: ["geometry", "width", "material"],
  ride_track: ["geometry", "verticalProfile"],
  vegetation: ["geometry", "height"],
  barrier: ["geometry", "height", "material"],
  water: ["geometry"],
  terrain_detail: ["geometry"]
};

/**
 * Builds a per-attribute evidence graph after all geometry/vertical enrichments.
 * The graph is diagnostic first: it records winners, alternatives, conflicts and
 * missing attributes without changing the proven terrain/slope pipeline.
 */
export function buildEvidenceGraph(map, sources = {}, options = {}) {
  const referenceDate = parseDate(options.referenceDate) || DEFAULT_REFERENCE_DATE();
  const summary = {
    schemaVersion: 1,
    referenceDate: referenceDate.toISOString(),
    featureCount: map.features?.length || 0,
    attributeCount: 0,
    evidencedAttributes: 0,
    missingAttributes: 0,
    lowConfidenceAttributes: 0,
    conflictAttributes: 0,
    temporal: {},
    byKind: {},
    byAttribute: {},
    acquisitionQueue: []
  };

  for (const feature of map.features || []) {
    const graph = buildFeatureEvidence(feature, sources, { ...options, referenceDate });
    feature.evidenceGraph = graph;
    increment(summary.temporal, graph.temporal.state);
    const kind = feature.kind || "unknown";
    summary.byKind[kind] ||= { features: 0, required: 0, evidenced: 0, missing: 0, lowConfidence: 0, conflicts: 0 };
    summary.byKind[kind].features += 1;

    for (const [attribute, entry] of Object.entries(graph.attributes)) {
      summary.attributeCount += 1;
      summary.byAttribute[attribute] ||= { total: 0, evidenced: 0, missing: 0, lowConfidence: 0, conflicts: 0 };
      summary.byAttribute[attribute].total += 1;
      if (entry.winner) {
        summary.evidencedAttributes += 1;
        summary.byAttribute[attribute].evidenced += 1;
      } else {
        summary.missingAttributes += 1;
        summary.byAttribute[attribute].missing += 1;
      }
      if (entry.winner && entry.winner.score < 0.72) {
        summary.lowConfidenceAttributes += 1;
        summary.byAttribute[attribute].lowConfidence += 1;
      }
      if (entry.conflict) {
        summary.conflictAttributes += 1;
        summary.byAttribute[attribute].conflicts += 1;
      }
    }

    const required = requiredAttributes(feature);
    summary.byKind[kind].required += required.length;
    for (const attribute of required) {
      const entry = graph.attributes[attribute];
      const gap = graph.gaps.find((item) => item.attribute === attribute);
      if (entry?.winner) summary.byKind[kind].evidenced += 1;
      if (gap?.status === "missing") summary.byKind[kind].missing += 1;
      else if (gap?.status === "low-confidence") summary.byKind[kind].lowConfidence += 1;
    }
    for (const gap of graph.gaps) {
      summary.acquisitionQueue.push({ featureId: feature.id, kind, ...gap });
    }
    summary.byKind[kind].conflicts += Object.values(graph.attributes).filter((entry) => entry.conflict).length;
  }

  summary.acquisitionQueue.sort((a, b) => b.priority - a.priority || a.featureId.localeCompare(b.featureId));
  summary.acquisitionQueue = summary.acquisitionQueue.slice(0, Math.max(1, Number(options.maxEvidenceQueue || 500)));
  map.evidenceGraph = summary;
  return summary;
}

export function buildFeatureEvidence(feature, sources = {}, options = {}) {
  const referenceDate = options.referenceDate instanceof Date ? options.referenceDate : (parseDate(options.referenceDate) || DEFAULT_REFERENCE_DATE());
  const temporal = resolveTemporalState(feature, referenceDate);
  const history = Array.isArray(feature.evidenceHistory) ? feature.evidenceHistory : [];
  const candidates = collectCandidates(feature, sources, temporal, referenceDate)
    .concat(history.flatMap((snapshot) => candidatesFromSnapshot(snapshot, referenceDate)));
  const attributes = {};
  for (const candidate of candidates) {
    attributes[candidate.attribute] ||= [];
    attributes[candidate.attribute].push(candidate);
  }

  const resolved = {};
  for (const [attribute, list] of Object.entries(attributes)) {
    const ranked = [...list].sort((a, b) => b.score - a.score || b.authorityRank - a.authorityRank);
    const winner = ranked[0] || null;
    const runnerUp = ranked[1] || null;
    resolved[attribute] = {
      winner,
      alternatives: ranked.slice(1, 5),
      conflict: Boolean(winner && runnerUp && materiallyDifferent(attribute, winner.value, runnerUp.value) && Math.abs(winner.score - runnerUp.score) < 0.12)
    };
  }

  const gaps = [];
  for (const attribute of requiredAttributes(feature)) {
    const entry = resolved[attribute];
    if (!entry?.winner) {
      gaps.push({ attribute, status: "missing", priority: gapPriority(feature.kind, attribute, 0), reason: "no-usable-evidence" });
    } else if (entry.winner.score < 0.72) {
      gaps.push({ attribute, status: "low-confidence", priority: gapPriority(feature.kind, attribute, entry.winner.score), reason: "winner-below-high-fidelity-gate", score: entry.winner.score });
    }
  }
  if (["proposed", "unknown", "superseded"].includes(temporal.state)) {
    gaps.push({ attribute: "currentState", status: temporal.state === "unknown" ? "missing" : "low-confidence", priority: temporal.state === "proposed" ? 94 : 88, reason: `temporal-state-${temporal.state}`, score: temporal.confidence });
  }

  return { schemaVersion: 1, temporal, attributes: resolved, gaps };
}

export function resolveTemporalState(feature, referenceDate = DEFAULT_REFERENCE_DATE()) {
  const values = [
    feature.tags?.application_status,
    feature.tags?.planning_status,
    feature.tags?.status,
    feature.source?.applicationStatus,
    feature.source?.status,
    feature.tags?.lifecycle
  ].filter(Boolean).map((value) => String(value).trim().toLowerCase());
  const text = values.join(" ");

  let state = "unknown", confidence = 0.45, reason = "no-explicit-lifecycle-evidence";
  if (feature.tags?.demolished || feature.tags?.["demolished:building"] || /demolish|demolished|removed/.test(text)) {
    state = "demolished"; confidence = 0.96; reason = "explicit-demolition-evidence";
  } else if (/superseded|obsolete|withdrawn|refused|rejected|cancelled/.test(text)) {
    state = /refused|rejected|withdrawn|cancelled/.test(text) ? "refused" : "superseded";
    confidence = 0.94; reason = `planning-status-${state}`;
  } else if (/under construction|construction|implemented|completed|built|operational|existing|current|as built/.test(text)) {
    state = "current"; confidence = 0.92; reason = "explicit-current-state";
  } else if (/proposed|pending|submitted|outline|reserved matters/.test(text)) {
    state = "proposed"; confidence = 0.90; reason = "explicit-proposal-state";
  } else if (/approved|granted|consent/.test(text)) {
    state = "proposed"; confidence = 0.72; reason = "approval-does-not-prove-construction";
  } else if (feature.authority?.layer === "osm" || feature.verification?.plan === "surveyed") {
    state = "current"; confidence = feature.verification?.plan === "surveyed" ? 0.96 : 0.76;
    reason = feature.verification?.plan === "surveyed" ? "verified-observation" : "current-public-map-observation";
  }

  const observedAt = newestDate([
    feature.source?.observedAt,
    feature.source?.timestamp,
    feature.tags?.checked_at,
    feature.tags?.survey_date,
    feature.tags?.capture_date
  ]);
  const ageDays = observedAt ? Math.max(0, (referenceDate - observedAt) / 86_400_000) : null;
  return {
    state,
    confidence: round(confidence),
    reason,
    observedAt: observedAt?.toISOString() || null,
    ageDays: ageDays === null ? null : Math.round(ageDays)
  };
}

export function snapshotFeatureEvidence(feature, reason = "superseded") {
  return {
    reason,
    featureId: feature.id,
    kind: feature.kind,
    geometry: feature.geometry || null,
    vertical: feature.vertical ? { ...feature.vertical } : null,
    roof: feature.roof ? structuredCloneSafe(feature.roof) : null,
    materialPalette: feature.materialPalette ? structuredCloneSafe(feature.materialPalette) : null,
    tags: feature.tags ? { ...feature.tags } : {},
    source: feature.source ? { ...feature.source } : {},
    authority: feature.authority ? { ...feature.authority } : {},
    verification: feature.verification ? { ...feature.verification } : {}
  };
}

function collectCandidates(feature, sources, temporal, referenceDate) {
  const result = [];
  const base = baseMetadata(feature, temporal, referenceDate);
  if (feature.geometry) result.push(makeCandidate("geometry", feature.geometry, base, "feature-geometry"));
  if (Number.isFinite(feature.vertical?.heightM)) result.push(makeCandidate("height", feature.vertical.heightM, {
    ...base, directness: verticalDirectness(feature.vertical.heightSource, feature.verification?.vertical)
  }, feature.vertical.heightSource || "feature-height"));
  if (Number.isFinite(feature.vertical?.elevationM)) result.push(makeCandidate("groundElevation", feature.vertical.elevationM, {
    ...base, directness: verticalDirectness(feature.vertical.heightSource, feature.verification?.vertical)
  }, "feature-elevation"));
  if (feature.roof) result.push(makeCandidate("roof", feature.roof, {
    ...base,
    authorityRank: Math.max(base.authorityRank, feature.roof.source === "lidar-dsm-surface" ? 320 : base.authorityRank),
    directness: feature.roof.source === "lidar-dsm-surface" ? 0.98 : base.directness,
    confidence: number(feature.roof.confidence, base.confidence),
    resolutionM: number(feature.roof.resolutionM ?? sources.elevation?.resolutionM, null)
  }, feature.roof.source || "feature-roof"));

  const material = feature.materialPalette || feature.tags?.material || feature.tags?.["building:material"] || feature.tags?.surface || null;
  if (material) result.push(makeCandidate("material", material, base, feature.materialPalette ? "planning-material-palette" : "feature-material"));
  const width = number(feature.tags?.width ?? feature.tags?.est_width ?? feature.surfaceEvidence?.widthM, null);
  if (width !== null) result.push(makeCandidate("width", width, {
    ...base, directness: /prior|estimate/i.test(String(feature.surfaceEvidence?.widthMethod || "")) ? 0.45 : base.directness
  }, feature.surfaceEvidence?.widthMethod || "feature-width"));
  if (feature.rideProfile?.coverage?.vertical > 0) result.push(makeCandidate("verticalProfile", {
    coverage: feature.rideProfile.coverage.vertical,
    heightRangeM: feature.rideProfile.heightRangeM,
    method: feature.rideProfile.method
  }, {
    ...base,
    authorityRank: Math.max(base.authorityRank, 260),
    directness: feature.rideProfile.coverage.vertical >= 0.999 ? 0.96 : 0.78,
    confidence: number(feature.rideProfile.confidence, base.confidence)
  }, feature.rideProfile.method || "ride-profile"));
  return result;
}

function candidatesFromSnapshot(snapshot, referenceDate) {
  const temporal = resolveTemporalState(snapshot, referenceDate);
  const base = baseMetadata(snapshot, temporal, referenceDate);
  const result = [];
  if (snapshot.geometry) result.push(makeCandidate("geometry", snapshot.geometry, base, `${snapshot.reason || "history"}:geometry`));
  if (Number.isFinite(snapshot.vertical?.heightM)) result.push(makeCandidate("height", snapshot.vertical.heightM, base, `${snapshot.reason || "history"}:height`));
  if (snapshot.roof) result.push(makeCandidate("roof", snapshot.roof, base, `${snapshot.reason || "history"}:roof`));
  const material = snapshot.materialPalette || snapshot.tags?.material || snapshot.tags?.["building:material"] || snapshot.tags?.surface || null;
  if (material) result.push(makeCandidate("material", material, base, `${snapshot.reason || "history"}:material`));
  const width = number(snapshot.tags?.width ?? snapshot.tags?.est_width, null);
  if (width !== null) result.push(makeCandidate("width", width, base, `${snapshot.reason || "history"}:width`));
  return result;
}

function baseMetadata(feature, temporal, referenceDate) {
  const authorityRank = number(feature.authority?.rank, inferAuthorityRank(feature));
  const observedAt = newestDate([feature.source?.observedAt, feature.source?.timestamp, feature.tags?.checked_at, feature.tags?.survey_date]);
  return {
    source: feature.source?.provider || feature.authority?.layer || "unknown",
    sourceRef: feature.source?.applicationReference || feature.source?.elementId || feature.id || null,
    authorityLayer: feature.authority?.layer || null,
    authorityRank,
    directness: inferDirectness(feature),
    confidence: inferConfidence(feature),
    recency: recencyScore(observedAt, referenceDate),
    resolutionM: number(feature.source?.resolutionM, null),
    temporalState: temporal.state,
    temporalConfidence: temporal.confidence,
    observedAt: observedAt?.toISOString() || null
  };
}

function makeCandidate(attribute, value, metadata, method) {
  const quality = {
    authority: clamp(metadata.authorityRank / 400),
    directness: clamp(metadata.directness),
    confidence: clamp(metadata.confidence),
    recency: clamp(metadata.recency),
    resolution: resolutionScore(metadata.resolutionM),
    temporal: temporalScore(metadata.temporalState, metadata.temporalConfidence)
  };
  const score = 0.34 * quality.authority + 0.24 * quality.directness + 0.15 * quality.confidence +
    0.10 * quality.recency + 0.10 * quality.resolution + 0.07 * quality.temporal;
  return {
    attribute,
    value,
    method,
    source: metadata.source,
    sourceRef: metadata.sourceRef,
    authorityLayer: metadata.authorityLayer,
    authorityRank: metadata.authorityRank,
    observedAt: metadata.observedAt,
    quality,
    score: round(score)
  };
}

function requiredAttributes(feature) {
  return REQUIRED_ATTRIBUTES[feature.kind] || ["geometry"];
}

function gapPriority(kind, attribute, score) {
  const base = {
    geometry: 100,
    verticalProfile: 98,
    height: 92,
    roof: 86,
    width: 84,
    material: 72,
    groundElevation: 70
  }[attribute] || 60;
  const kindBoost = kind === "ride_track" ? 4 : kind === "building" ? 3 : ["path", "road"].includes(kind) ? 2 : 0;
  return Math.min(100, Math.round(base + kindBoost - score * 10));
}

function inferAuthorityRank(feature) {
  if (feature.verification?.plan === "surveyed") return 400;
  if (feature.authority?.layer === "planning") return 300;
  if (/lidar/i.test(String(feature.source?.provider || ""))) return 280;
  if (feature.authority?.layer === "osm") return 100;
  return 120;
}

function inferDirectness(feature) {
  const plan = String(feature.verification?.plan || "").toLowerCase();
  const vertical = String(feature.verification?.vertical || "").toLowerCase();
  const provider = String(feature.source?.provider || "").toLowerCase();
  if (plan.includes("survey") || vertical.includes("survey")) return 1;
  if (plan.includes("planning") || provider.includes("architect") || provider.includes("planning")) return 0.96;
  if (provider.includes("lidar") || vertical.includes("dsm")) return 0.97;
  if (vertical.includes("tagged")) return 0.82;
  if (plan.includes("public-map") || provider.includes("openstreetmap")) return 0.74;
  if (plan.includes("inferred") || vertical.includes("inferred")) return 0.35;
  return 0.62;
}

function inferConfidence(feature) {
  const values = [feature.confidence, feature.roof?.confidence, feature.rideProfile?.confidence]
    .map((value) => Number(value)).filter(Number.isFinite);
  return values.length ? Math.max(...values.map((value) => value > 1 ? value / 100 : value)) : 0.72;
}

function verticalDirectness(source, verification) {
  const text = `${source || ""} ${verification || ""}`.toLowerCase();
  if (/survey|planning-drawing|architect/.test(text)) return 0.98;
  if (/lidar|dsm-minus-dtm/.test(text)) return 0.97;
  if (/height|levels|tagged/.test(text)) return 0.82;
  if (/infer|prior/.test(text)) return 0.35;
  return 0.62;
}

function recencyScore(observedAt, referenceDate) {
  if (!observedAt) return 0.64;
  const days = Math.max(0, (referenceDate - observedAt) / 86_400_000);
  if (days <= 365 * 2) return 1;
  if (days <= 365 * 5) return 0.90;
  if (days <= 365 * 10) return 0.76;
  if (days <= 365 * 20) return 0.62;
  return 0.48;
}

function resolutionScore(resolutionM) {
  if (!Number.isFinite(resolutionM) || resolutionM <= 0) return 0.66;
  if (resolutionM <= 0.25) return 1;
  if (resolutionM <= 0.5) return 0.96;
  if (resolutionM <= 1) return 0.92;
  if (resolutionM <= 2) return 0.82;
  if (resolutionM <= 5) return 0.68;
  if (resolutionM <= 10) return 0.52;
  return 0.30;
}

function temporalScore(state, confidence) {
  const base = { current: 1, unknown: 0.62, proposed: 0.45, superseded: 0.12, refused: 0.04, demolished: 0.04 }[state] ?? 0.55;
  return clamp(base * (0.65 + 0.35 * clamp(confidence)));
}

function materiallyDifferent(attribute, a, b) {
  if (attribute === "height" || attribute === "groundElevation" || attribute === "width") {
    return Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) > (attribute === "width" ? 0.75 : 1.0);
  }
  return stable(a) !== stable(b);
}

function stable(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return String(value);
  try { return JSON.stringify(canonicalize(value)); } catch { return "[object]"; }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function newestDate(values) {
  const dates = values.map(parseDate).filter(Boolean).sort((a, b) => b - a);
  return dates[0] || null;
}

function parseDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }
function round(value) { return Math.round(value * 1000) / 1000; }
function increment(object, key) { object[key] = (object[key] || 0) + 1; }
function structuredCloneSafe(value) { return JSON.parse(JSON.stringify(value)); }
