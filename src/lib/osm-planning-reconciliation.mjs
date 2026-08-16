import path from "node:path";
import { geometryBounds, geometryMapCoordinates } from "./geo.mjs";
import { readJson, sha256 } from "./io.mjs";
import { matchGeometryCandidate } from "./planning-authority-fusion.mjs";

const PLANNING_AUTHORITY_RANK = 360;
const DEFAULT_MAX_ANCHORS = 128;
const DEFAULT_MAX_TERMS = 96;
const SUPPORTED_KINDS = new Set([
  "building", "structure", "path", "road", "ride_track", "barrier", "water", "terrain_detail"
]);
const GENERIC_NAMES = new Set([
  "area", "building", "entrance", "exit", "footpath", "footway", "path", "road", "service road", "track"
]);

/**
 * OSM is the bounded spatial/index layer for planning discovery. This index is
 * deliberately park-agnostic: it extracts the park identity plus named rides,
 * attractions and named sub-areas from whatever is present inside the bbox.
 * It does not grant OSM geometry authority over later planning evidence.
 */
export function buildOsmPlanningSearchIndex(osmData, options = {}) {
  const maxAnchors = clampInt(options.maxOsmPlanningAnchors ?? DEFAULT_MAX_ANCHORS, 8, 2_000);
  const maxTerms = clampInt(options.maxOsmPlanningSearchTerms ?? DEFAULT_MAX_TERMS, 8, 1_000);
  const anchors = [];
  const seen = new Set();

  for (const element of osmData?.elements || []) {
    const tags = element.tags || {};
    const role = planningAnchorRole(tags, element);
    if (!role) continue;
    const names = role === "park"
      ? [tags.name, tags["name:en"], tags.official_name, tags.short_name, tags["addr:postcode"]]
      : [tags.name, tags["name:en"], tags.official_name, tags.short_name];
    for (const value of names) {
      const name = cleanName(value);
      if (!name) continue;
      const normalized = normalizeText(name);
      if (!normalized || (GENERIC_NAMES.has(normalized) && role !== "park")) continue;
      const key = `${role}:${normalized}`;
      if (seen.has(key)) continue;
      seen.add(key);
      anchors.push({
        id: `osm:${element.type || "element"}:${element.id ?? sha256({ role, name }).slice(0, 12)}`,
        role,
        name,
        normalizedName: normalized,
        weight: anchorWeight(role),
        elementType: element.type || null,
        elementId: element.id ?? null,
        tags: compactAnchorTags(tags)
      });
    }
  }

  anchors.sort((a, b) => b.weight - a.weight || a.normalizedName.localeCompare(b.normalizedName));
  const selected = anchors.slice(0, maxAnchors);
  const searchTerms = [];
  const termSeen = new Set();
  for (const anchor of selected) {
    const normalized = anchor.normalizedName;
    if (termSeen.has(normalized)) continue;
    termSeen.add(normalized);
    searchTerms.push(anchor.name);
    if (searchTerms.length >= maxTerms) break;
  }

  return {
    schemaVersion: 1,
    anchorCount: selected.length,
    searchTermCount: searchTerms.length,
    byRole: countBy(selected, (entry) => entry.role),
    anchors: selected,
    searchTerms
  };
}

/**
 * Scores planning applications against OSM identity anchors. Bbox intersection
 * remains the recall mechanism; this relevance layer raises applications that
 * mention the exact park, ride, attraction or named area so their documents are
 * discovered/processed first without dropping unmatched applications.
 */
export function rankPlanningApplicationsByOsm(applications, indexOrOsm, options = {}) {
  const index = Array.isArray(indexOrOsm?.anchors)
    ? indexOrOsm
    : buildOsmPlanningSearchIndex(indexOrOsm, options);
  const ranked = (applications || []).map((application, originalIndex) => {
    const text = planningApplicationText(application);
    const normalized = normalizeText(text);
    const tokens = new Set(normalized.split(" ").filter(Boolean));
    const matches = [];
    for (const anchor of index.anchors || []) {
      const strength = textMatchStrength(normalized, tokens, anchor.normalizedName);
      if (strength <= 0) continue;
      matches.push({
        role: anchor.role,
        name: anchor.name,
        osmId: anchor.id,
        strength: round(strength),
        weightedScore: round(strength * anchor.weight)
      });
    }
    matches.sort((a, b) => b.weightedScore - a.weightedScore || b.strength - a.strength || a.name.localeCompare(b.name));
    const strongest = matches[0]?.weightedScore || 0;
    const corroboration = Math.min(0.12, Math.max(0, matches.length - 1) * 0.02);
    const score = round(Math.min(1, strongest + corroboration));
    return {
      ...application,
      osmRelevance: {
        schemaVersion: 1,
        score,
        matchedAnchorCount: matches.length,
        matches: matches.slice(0, 8)
      },
      __osmPlanningOriginalIndex: originalIndex
    };
  });

  ranked.sort((a, b) =>
    Number(b.osmRelevance?.score || 0) - Number(a.osmRelevance?.score || 0) ||
    Number(a.__osmPlanningOriginalIndex || 0) - Number(b.__osmPlanningOriginalIndex || 0));
  return ranked.map(({ __osmPlanningOriginalIndex, ...application }) => application);
}

/**
 * Applies topology-changing planning evidence before downstream path/ride/world
 * reconstruction. Existing matched current planning geometry is left to the
 * Evidence Graph bridge; this stage is intentionally limited to operations the
 * attribute bridge cannot express: additions and tombstones, plus explicitly
 * requested topology replacements.
 */
export async function reconcilePlanningTopology(map, options = {}) {
  const evidence = await loadAuthorityEvidence(options);
  const summary = {
    schemaVersion: 1,
    status: evidence ? "processed" : "disabled",
    added: 0,
    replaced: 0,
    deleted: 0,
    deferredMatched: 0,
    skipped: 0,
    changes: [],
    tombstones: []
  };
  if (!evidence) return summary;

  const candidates = evidence.geometryCandidates || [];
  for (const candidate of candidates) {
    const operation = topologyOperation(candidate);
    const currentAuthority = isCurrentAuthority(candidate);
    const demolished = isConfirmedDemolition(candidate);
    if (!operation && !currentAuthority && !demolished) continue;

    if (operation === "delete" && !currentAuthority && !demolished) {
      skip(summary, candidate, "delete-not-current-authority");
      continue;
    }
    if (operation === "delete" || demolished) {
      const target = findDeleteTarget(map.features || [], candidate, options);
      if (!target) { skip(summary, candidate, "delete-target-not-found"); continue; }
      if (!mutableLowerAuthority(target.feature)) { skip(summary, candidate, "delete-target-higher-authority"); continue; }
      const [removed] = map.features.splice(target.index, 1);
      const tombstone = {
        featureId: removed.id,
        featureKind: removed.kind,
        featureName: removed.name || null,
        source: removed.source || null,
        planningSourceRef: candidateSourceRef(candidate),
        reason: demolished ? "confirmed-demolition" : "planning-delete",
        match: compactMatch(target)
      };
      summary.deleted += 1;
      summary.tombstones.push(tombstone);
      summary.changes.push({ operation: "delete", ...tombstone });
      continue;
    }

    if (!currentAuthority) { skip(summary, candidate, "topology-edit-not-current-authority"); continue; }
    if (!candidate.localGeometry) { skip(summary, candidate, "missing-local-geometry"); continue; }

    const existing = findExistingTarget(map.features || [], candidate, options);
    if (operation === "replace") {
      if (!existing?.feature) { skip(summary, candidate, "replace-target-not-found"); continue; }
      if (!mutableLowerAuthority(existing.feature)) { skip(summary, candidate, "replace-target-higher-authority"); continue; }
      replaceFeatureGeometry(existing.feature, candidate, map);
      summary.replaced += 1;
      summary.changes.push({
        operation: "replace",
        featureId: existing.feature.id,
        featureKind: existing.feature.kind,
        planningSourceRef: candidateSourceRef(candidate),
        match: compactMatch(existing)
      });
      continue;
    }

    if (existing?.accepted) {
      summary.deferredMatched += 1;
      continue;
    }
    if (existing?.reason === "ambiguous") { skip(summary, candidate, "add-ambiguous-existing-match"); continue; }

    const kind = inferAddKind(candidate);
    if (!kind) { skip(summary, candidate, "add-kind-not-safe-to-infer"); continue; }
    const added = planningCandidateToFeature(candidate, kind, map);
    map.features.push(added);
    summary.added += 1;
    summary.changes.push({
      operation: "add",
      featureId: added.id,
      featureKind: added.kind,
      planningSourceRef: candidateSourceRef(candidate),
      reason: operation === "add" ? "explicit-planning-add" : "current-planning-gap-fill"
    });
  }

  summary.status = summary.added || summary.replaced || summary.deleted ? "applied" : "no-topology-changes";
  map.planningTopologyReconciliation = summary;
  return summary;
}

function planningAnchorRole(tags, element) {
  if (tags.tourism === "theme_park") return "park";
  if (isRide(tags)) return "ride";
  if (tags.attraction) return "attraction";
  if (!tags.name && !tags["name:en"] && !tags.official_name && !tags.short_name) return null;
  if (isNamedArea(tags, element)) return "area";
  return null;
}

function isRide(tags) {
  const attraction = String(tags.attraction || "").toLowerCase();
  const coaster = String(tags.roller_coaster || "").toLowerCase();
  const railway = String(tags.railway || "").toLowerCase();
  return Boolean(
    coaster ||
    attraction === "roller_coaster" || attraction === "water_slide" || attraction === "log_flume" || attraction === "dark_ride" ||
    railway === "roller_coaster"
  );
}

function isNamedArea(tags, element) {
  if (element?.type === "node" && tags.area !== "yes") return false;
  return Boolean(
    tags.area === "yes" || tags.building || tags.landuse || tags.leisure || tags.amenity || tags.shop || tags.man_made ||
    tags.natural || tags.water || tags.waterway || tags["area:highway"] || tags.tourism
  );
}

function anchorWeight(role) {
  return ({ park: 1, ride: 0.97, attraction: 0.9, area: 0.72 })[role] || 0.6;
}

function compactAnchorTags(tags) {
  const keys = ["tourism", "attraction", "roller_coaster", "railway", "building", "landuse", "leisure", "amenity", "shop", "man_made", "natural", "area:highway"];
  return Object.fromEntries(keys.filter((key) => tags[key] != null).map((key) => [key, tags[key]]));
}

function planningApplicationText(application) {
  const fields = [
    application.reference, application.name, application.description, application.address, application.site,
    application.location, application.proposal, application["development-description"], application["site-address"],
    application["address-text"], application["documentation-url"], application.documentationUrl
  ];
  return fields.flatMap(flattenText).filter(Boolean).join(" ");
}

function flattenText(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(flattenText);
  if (typeof value === "object") return Object.values(value).flatMap(flattenText);
  return [String(value)];
}

function textMatchStrength(applicationText, applicationTokens, anchorName) {
  if (!applicationText || !anchorName) return 0;
  if (applicationText.includes(anchorName)) return 1;
  const anchorTokens = anchorName.split(" ").filter((token) => token.length >= 3);
  if (!anchorTokens.length) return 0;
  const matched = anchorTokens.filter((token) => applicationTokens.has(token));
  if (anchorTokens.length === 1) return anchorTokens[0].length >= 5 && matched.length === 1 ? 0.72 : 0;
  const coverage = matched.length / anchorTokens.length;
  if (coverage < 0.67) return 0;
  return 0.48 + 0.42 * coverage;
}

async function loadAuthorityEvidence(options) {
  if (options.planningAuthorityEvidenceData) return options.planningAuthorityEvidenceData;
  if (!options.planningAuthorityEvidence) return null;
  return readJson(path.resolve(options.planningAuthorityEvidence));
}

function topologyOperation(candidate) {
  const value = String(
    candidate?.operation ?? candidate?.planningOperation ?? candidate?.topologyOperation ?? candidate?.editOperation ??
    candidate?.properties?.operation ?? ""
  ).toLowerCase().trim();
  return ["add", "replace", "delete"].includes(value) ? value : null;
}

function isCurrentAuthority(candidate) {
  return candidate?.worldGeometryAuthority === true && candidate?.planningTemporal?.state === "current";
}

function isConfirmedDemolition(candidate) {
  const state = candidate?.planningTemporal?.state;
  const confidence = Number(candidate?.planningTemporal?.confidence || 0);
  const semantic = `${candidate?.classification || ""} ${candidate?.semantic || ""}`.toLowerCase();
  return state === "demolished" && confidence >= 0.95 && /demolition|demolished|removed/.test(semantic);
}

function findExistingTarget(features, candidate, options) {
  const explicit = explicitTargetId(candidate);
  if (explicit) {
    const index = features.findIndex((feature) => matchesTargetId(feature, explicit));
    return index >= 0 ? { accepted: true, index, feature: features[index], score: 1, method: "explicit-target" } : { accepted: false, reason: "explicit-target-not-found" };
  }
  const eligible = features.filter(mutableLowerAuthority);
  const match = matchGeometryCandidate(candidate, eligible, options);
  if (!match.accepted) return match;
  return {
    ...match,
    accepted: true,
    index: features.indexOf(match.feature),
    method: "planning-current-spatial-match"
  };
}

function findDeleteTarget(features, candidate, options) {
  const explicit = explicitTargetId(candidate);
  if (explicit) {
    const index = features.findIndex((feature) => matchesTargetId(feature, explicit));
    return index >= 0 ? { accepted: true, index, feature: features[index], score: 1, method: "explicit-target" } : null;
  }
  if (!candidate?.localGeometry) return null;
  const requestedKind = inferDeleteKind(candidate);
  const tolerance = Number(options.planningAuthorityPointToleranceM ?? 12);
  const ranked = [];
  for (let index = 0; index < features.length; index += 1) {
    const feature = features[index];
    if (!mutableLowerAuthority(feature)) continue;
    if (requestedKind && feature.kind !== requestedKind && !compatibleDeleteKinds(requestedKind, feature.kind)) continue;
    const score = deletionMatchScore(candidate.localGeometry, feature.localGeometry, tolerance);
    if (score >= 0.72) ranked.push({ accepted: true, index, feature, score: round(score), method: "demolition-spatial-match" });
  }
  ranked.sort((a, b) => b.score - a.score || String(a.feature.id).localeCompare(String(b.feature.id)));
  if (!ranked.length) return null;
  if (ranked[1] && ranked[0].score - ranked[1].score < 0.08) return null;
  return ranked[0];
}

function explicitTargetId(candidate) {
  return candidate?.targetFeatureId || candidate?.targetId || candidate?.target || candidate?.replaces || candidate?.osmId || candidate?.properties?.target || null;
}

function matchesTargetId(feature, target) {
  const value = String(target);
  return feature.id === value || String(feature.source?.elementId ?? "") === value ||
    `osm:${feature.source?.elementType}:${feature.source?.elementId}` === value;
}

function mutableLowerAuthority(feature) {
  return feature && Number(feature.authority?.rank ?? 100) < PLANNING_AUTHORITY_RANK;
}

function inferAddKind(candidate) {
  const explicit = String(candidate?.kind || candidate?.featureKind || candidate?.properties?.kind || "").trim();
  if (SUPPORTED_KINDS.has(explicit)) return explicit;
  const semantic = String(candidate?.semantic || "");
  const classification = String(candidate?.classification || "");
  if (classification === "ride_layout" && /ride-centerline-or-edge/.test(semantic)) return "ride_track";
  return null;
}

function inferDeleteKind(candidate) {
  const explicit = String(candidate?.kind || candidate?.featureKind || candidate?.properties?.kind || "").trim();
  if (SUPPORTED_KINDS.has(explicit)) return explicit;
  if (/demolition-footprint/.test(String(candidate?.semantic || ""))) return "building";
  return null;
}

function compatibleDeleteKinds(a, b) {
  return new Set([a, b]).size === 2 && [a, b].every((kind) => ["building", "structure"].includes(kind));
}

function replaceFeatureGeometry(feature, candidate, map) {
  feature.evidenceHistory ||= [];
  feature.evidenceHistory.push({
    reason: "planning-topology-replace-prior",
    featureId: feature.id,
    geometry: clone(feature.geometry),
    localGeometry: clone(feature.localGeometry),
    source: clone(feature.source),
    authority: clone(feature.authority)
  });
  feature.geometry = candidate.geometry
    ? clone(candidate.geometry)
    : geometryMapCoordinates(candidate.localGeometry, map.projector.inverse);
  feature.localGeometry = clone(candidate.localGeometry);
  feature.authority = { ...(feature.authority || {}), attributeGeometry: "planning-current-authority" };
  feature.planningTopologyResolution = {
    operation: "replace",
    sourceRef: candidateSourceRef(candidate),
    planningTemporal: clone(candidate.planningTemporal || null)
  };
}

function planningCandidateToFeature(candidate, kind, map) {
  const sourceRef = candidateSourceRef(candidate);
  const idSeed = candidate.id || `${candidate.contentHash || "planning"}:p${candidate.pageNumber || 1}:${sourceRef || kind}`;
  const geometry = candidate.geometry
    ? clone(candidate.geometry)
    : geometryMapCoordinates(candidate.localGeometry, map.projector.inverse);
  return {
    id: `planning-current:${safeId(idSeed)}:${sha256({ kind, sourceRef, geometry }).slice(0, 10)}`,
    name: candidate.name || candidate.label || candidate.properties?.name || null,
    kind,
    subtype: candidate.subtype || candidate.properties?.subtype || `planning-${kind}`,
    tags: { ...(candidate.tags || candidate.properties?.tags || {}) },
    geometry,
    localGeometry: clone(candidate.localGeometry),
    vertical: {
      heightM: numberOrNull(candidate.heightM ?? candidate.properties?.height_m),
      heightSource: numberOrNull(candidate.heightM ?? candidate.properties?.height_m) != null ? "planning-current-authority" : null,
      minHeightM: numberOrNull(candidate.minHeightM ?? candidate.properties?.min_height_m) ?? 0,
      elevationM: numberOrNull(candidate.elevationM ?? candidate.properties?.elevation_m),
      explicit: numberOrNull(candidate.heightM ?? candidate.properties?.height_m ?? candidate.elevationM ?? candidate.properties?.elevation_m) != null
    },
    source: {
      provider: "Planning current-state authority",
      contentHash: candidate.contentHash || null,
      pageNumber: candidate.pageNumber || null,
      sourceRef,
      applicationReference: candidate.applicationReference || candidate.properties?.applicationReference || null,
      timestamp: candidate.planningTemporal?.observedAt || null,
      license: candidate.license || candidate.properties?.license || null
    },
    verification: { plan: "planning-current-authority", vertical: "unknown" },
    authority: {
      layer: "planning-current-authority",
      rank: PLANNING_AUTHORITY_RANK,
      geometryLocked: true,
      worldGeometryAuthority: true
    },
    planningTopologyResolution: {
      operation: "add",
      sourceRef,
      planningTemporal: clone(candidate.planningTemporal || null)
    }
  };
}

function deletionMatchScore(aGeometry, bGeometry, toleranceM) {
  const a = geometryBounds(aGeometry), b = geometryBounds(bGeometry);
  if (!a || !b) return 0;
  const ix = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const iz = Math.max(0, Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ));
  const intersection = ix * iz;
  const areaA = Math.max(0.01, (a.maxX - a.minX) * (a.maxZ - a.minZ));
  const areaB = Math.max(0.01, (b.maxX - b.minX) * (b.maxZ - b.minZ));
  const overlap = Math.min(1, intersection / Math.min(areaA, areaB));
  const centerA = [(a.minX + a.maxX) / 2, (a.minZ + a.maxZ) / 2];
  const centerB = [(b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2];
  const distance = Math.hypot(centerA[0] - centerB[0], centerA[1] - centerB[1]);
  const distanceScore = Math.max(0, 1 - distance / Math.max(1, toleranceM * 2));
  return 0.68 * overlap + 0.32 * distanceScore;
}

function compactMatch(match) {
  return match ? { method: match.method || null, score: match.score ?? null, distanceM: match.distanceM ?? null } : null;
}

function candidateSourceRef(candidate) {
  return candidate?.id || (candidate?.contentHash ? `${candidate.contentHash}:p${candidate.pageNumber || 1}` : null);
}

function skip(summary, candidate, reason) {
  summary.skipped += 1;
  summary.changes.push({ operation: "skip", planningSourceRef: candidateSourceRef(candidate), reason });
}

function cleanName(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length >= 2 && text.length <= 160 ? text : null;
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/&amp;/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function countBy(values, getter) {
  const result = {};
  for (const value of values || []) {
    const key = getter(value) || "unknown";
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeId(value) {
  return String(value || "planning").replace(/[^a-zA-Z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "planning";
}

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function round(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function clampInt(value, min, max) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : min;
}
