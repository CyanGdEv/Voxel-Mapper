import * as base from "./evidence-graph-base.mjs";

export * from "./evidence-graph-base.mjs";

/**
 * Builds the canonical per-attribute graph, then materializes only safe
 * non-geometry winners back onto the feature. Geometry remains controlled by
 * the dedicated spatial/planning authority pipelines because changing WGS84
 * geometry here without regenerating localGeometry would be unsafe.
 */
export function buildEvidenceGraph(map, sources = {}, options = {}) {
  const summary = base.buildEvidenceGraph(map, sources, options);
  const materialization = materializeEvidenceWinners(map, options);
  summary.materialization = materialization;
  map.evidenceGraph = summary;
  return summary;
}

export function materializeEvidenceWinners(map, options = {}) {
  const minimumScore = Math.max(0.72, Number(options.minAttributeMaterializationScore ?? 0.72));
  const summary = {
    schemaVersion: 1,
    minimumScore,
    featuresChanged: 0,
    appliedAttributes: 0,
    geometryDeferred: 0,
    conflictsDeferred: 0,
    lowConfidenceDeferred: 0,
    byAttribute: {}
  };

  for (const feature of map?.features || []) {
    const attributes = feature.evidenceGraph?.attributes || {};
    let changed = false;
    for (const [attribute, entry] of Object.entries(attributes)) {
      const winner = entry?.winner;
      if (!winner) continue;
      if (attribute === "geometry") {
        // Spatial replacement is deliberately handled elsewhere. The evidence
        // graph still records the winner and alternatives for traceability.
        summary.geometryDeferred += 1;
        continue;
      }
      if (entry.conflict) {
        summary.conflictsDeferred += 1;
        continue;
      }
      if (!(Number(winner.score) >= minimumScore)) {
        summary.lowConfidenceDeferred += 1;
        continue;
      }
      if (!applyAttributeWinner(feature, attribute, winner)) continue;
      feature.attributeAuthority ||= {};
      feature.attributeAuthority[attribute] = compactWinner(winner);
      summary.appliedAttributes += 1;
      summary.byAttribute[attribute] = (summary.byAttribute[attribute] || 0) + 1;
      changed = true;
    }
    if (changed) summary.featuresChanged += 1;
  }
  return summary;
}

function applyAttributeWinner(feature, attribute, winner) {
  const value = winner.value;
  feature.tags ||= {};
  feature.vertical ||= { heightM: null, heightSource: null, minHeightM: 0, elevationM: null, explicit: false };

  if (attribute === "height" && Number.isFinite(Number(value))) {
    const numeric = Number(value);
    if (feature.vertical.heightM === numeric && feature.vertical.heightSource === winner.method) return false;
    feature.vertical.heightM = numeric;
    feature.vertical.heightSource = winner.method || winner.source || "evidence-winner";
    feature.vertical.heightConfidence = winner.score;
    feature.vertical.explicit = true;
    return true;
  }

  if (attribute === "groundElevation" && Number.isFinite(Number(value))) {
    const numeric = Number(value);
    if (feature.vertical.elevationM === numeric) return false;
    feature.vertical.elevationM = numeric;
    feature.vertical.explicit = true;
    return true;
  }

  if (attribute === "roof" && value && typeof value === "object") {
    if (sameValue(feature.roof, value)) return false;
    feature.roof = structuredCloneSafe(value);
    return true;
  }

  if (attribute === "material" && value != null) {
    if (typeof value === "object") {
      if (sameValue(feature.materialPalette, value)) return false;
      feature.materialPalette = structuredCloneSafe(value);
    } else {
      const text = String(value);
      if (String(feature.tags.material || feature.tags["building:material"] || feature.tags.surface || "") === text) return false;
      if (feature.kind === "building") feature.tags["building:material"] = text;
      else feature.tags.surface = text;
    }
    feature.materialEvidence = {
      source: winner.source,
      method: winner.method,
      score: winner.score,
      authorityRank: winner.authorityRank
    };
    return true;
  }

  if (attribute === "width" && Number.isFinite(Number(value))) {
    const numeric = Number(value);
    if (Number(feature.tags.width) === numeric) return false;
    feature.tags.width = numeric;
    feature.surfaceEvidence ||= {};
    feature.surfaceEvidence.widthM = numeric;
    feature.surfaceEvidence.widthMethod = winner.method || "evidence-winner";
    return true;
  }

  // verticalProfile is intentionally diagnostic here: the winner currently
  // carries profile coverage/summary rather than the full XYZ sample array.
  return false;
}

function compactWinner(winner) {
  return {
    source: winner.source,
    sourceRef: winner.sourceRef,
    method: winner.method,
    authorityLayer: winner.authorityLayer,
    authorityRank: winner.authorityRank,
    score: winner.score,
    observedAt: winner.observedAt || null
  };
}

function sameValue(a, b) {
  try { return JSON.stringify(a) === JSON.stringify(b); }
  catch { return a === b; }
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
