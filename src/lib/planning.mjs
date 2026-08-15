import path from "node:path";
import { geometryBounds, geometryMapCoordinates, walkPositions } from "./geo.mjs";
import { UserError } from "./errors.mjs";
import { readJson, sha256, sha256File } from "./io.mjs";
import { createMaterialRegistry, paletteSummary, resolveFeatureMaterialPalettes } from "./material-palettes.mjs";

const DEFAULT_MAX_APPLICATIONS = 680;
const DEFAULT_MATCH_TOLERANCE_M = 8;
const DEFAULT_MIN_MATCH_SCORE = 0.64;
const PLANNING_AUTHORITY = 300;

/**
 * Planning is an authoritative geometry edit layer, not a second base map.
 * OSM establishes the initial world geometry/reference frame; accepted planning
 * observations may add, replace, retag or delete lower-authority features.
 */
export async function fusePlanningApplications(features, projector, options = {}) {
  const files = options.planning || [];
  const summary = {
    schemaVersion: 1,
    status: files.length ? "active" : "disabled",
    policy: {
      baseGeometry: "OpenStreetMap",
      authority: "planning drawings override lower-authority map geometry where matched",
      terrain: "unchanged: planning fusion does not modify the terrain/DTM slope pipeline",
      maxApplications: options.maxPlanningApplications ?? DEFAULT_MAX_APPLICATIONS,
      automaticMatchToleranceM: options.planningMatchToleranceM ?? DEFAULT_MATCH_TOLERANCE_M,
      minimumAutomaticMatchScore: options.planningMinMatchScore ?? DEFAULT_MIN_MATCH_SCORE
    },
    files: [], applications: 0, drawings: 0, materials: 0, observations: 0,
    added: 0, replaced: 0, deleted: 0, retagged: 0, unmatchedDeletes: 0,
    explicitMatches: 0, automaticMatches: 0, ambiguousMatches: 0,
    byKind: {}, warnings: [], materialPalettes: null
  };
  if (!files.length) return { summary, materialRegistry: createMaterialRegistry([]) };

  const bundles = [];
  for (const filename of files) bundles.push(await loadPlanningBundle(path.resolve(filename)));
  const applications = bundles.flatMap((bundle) => bundle.applications);
  const maxApplications = Math.floor(Number(options.maxPlanningApplications ?? DEFAULT_MAX_APPLICATIONS));
  if (!Number.isInteger(maxApplications) || maxApplications < 1) throw new UserError("--max-planning-applications must be a positive integer");
  if (applications.length > maxApplications) {
    throw new UserError(`Planning bundle contains ${applications.length} applications; limit is ${maxApplications}`,
      "Split the park into bounded planning batches or deliberately raise --max-planning-applications.");
  }

  const materialRecords = bundles.flatMap((bundle) => bundle.materials)
    .concat(applications.flatMap((application) => application.materials || []));
  const materialRegistry = createMaterialRegistry(materialRecords);
  summary.materials = materialRecords.length;
  summary.materialPalettes = paletteSummary(materialRegistry);
  summary.applications = applications.length;
  summary.files = await Promise.all(files.map(async (filename) => ({
    file: path.basename(filename), sha256: await sha256File(path.resolve(filename))
  })));

  for (const application of applications) {
    const observations = await materializeApplicationObservations(application, projector, materialRegistry);
    summary.drawings += application.drawings?.length || 0;
    for (const observation of observations) {
      summary.observations += 1;
      increment(summary.byKind, observation.feature?.kind || observation.kind || "unknown");
      applyPlanningObservation(features, observation, summary, options);
    }
  }
  if (!summary.observations) summary.status = "active-no-observations";
  return { summary, materialRegistry };
}

async function loadPlanningBundle(filename) {
  const raw = await readJson(filename);
  const baseDir = path.dirname(filename);
  if (raw?.type === "FeatureCollection") {
    const reference = raw.properties?.application_reference || raw.application_reference || path.basename(filename);
    return {
      materials: raw.materials || raw.properties?.materials || [],
      applications: [{
        reference,
        sourceUrl: raw.properties?.source_url || raw.source_url || null,
        license: raw.properties?.license || raw.license || null,
        checkedAt: raw.properties?.checked_at || null,
        baseDir,
        features: raw.features || [],
        drawings: []
      }]
    };
  }
  if (!raw || !Array.isArray(raw.applications)) {
    throw new UserError(`--planning ${path.basename(filename)} must be GeoJSON or a manifest with an applications array`);
  }
  return {
    materials: raw.materials || [],
    applications: raw.applications.map((application, index) => ({
      ...application,
      reference: application.reference || application.application_reference || `application-${index + 1}`,
      baseDir
    }))
  };
}

async function materializeApplicationObservations(application, projector, materialRegistry) {
  const rawFeatures = [];
  if (Array.isArray(application.features)) rawFeatures.push(...application.features);
  if (application.feature_collection?.features) rawFeatures.push(...application.feature_collection.features);
  for (const drawing of application.drawings || []) {
    if (Array.isArray(drawing.features)) rawFeatures.push(...drawing.features.map((feature) => attachDrawing(feature, drawing)));
    if (drawing.geojson?.features) rawFeatures.push(...drawing.geojson.features.map((feature) => attachDrawing(feature, drawing)));
    const filename = drawing.file || drawing.geojson_file || drawing.extracted_geojson;
    if (filename) {
      const collection = await readJson(path.resolve(application.baseDir, filename));
      if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
        throw new UserError(`Planning drawing ${filename} must be a GeoJSON FeatureCollection`);
      }
      rawFeatures.push(...collection.features.map((feature) => attachDrawing(feature, drawing)));
    }
  }
  for (const filename of application.feature_files || application.geometry_files || []) {
    const collection = await readJson(path.resolve(application.baseDir, filename));
    if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
      throw new UserError(`Planning feature file ${filename} must be a GeoJSON FeatureCollection`);
    }
    rawFeatures.push(...collection.features);
  }
  return rawFeatures.map((raw, index) => normalizeObservation(raw, application, projector, materialRegistry, index));
}

function normalizeObservation(raw, application, projector, materialRegistry, index) {
  const properties = raw.properties || {};
  const operation = String(properties.operation || properties.planning_operation || "auto").toLowerCase();
  if (!["auto", "add", "replace", "delete", "retag"].includes(operation)) {
    throw new UserError(`Planning ${application.reference} feature ${index} has unsupported operation ${operation}`);
  }
  const target = normalizeTarget(properties.target || properties.target_id || properties.replaces || properties.osm_id);
  if (operation !== "delete" && !raw.geometry) {
    throw new UserError(`Planning ${application.reference} feature ${index} requires geometry unless operation=delete`);
  }
  const kind = properties.kind || classifyPlanning(properties);
  if (!kind && operation !== "delete") {
    throw new UserError(`Planning ${application.reference} feature ${index} requires kind or recognizable planning semantics`);
  }
  const geometry = raw.geometry || null;
  const feature = geometry ? {
    id: properties.id || `planning:${safe(application.reference)}:${index}:${sha256(raw).slice(0, 10)}`,
    name: properties.name || properties.label || null,
    kind,
    subtype: properties.subtype || inferSubtype(properties, kind),
    tags: stripControlProperties(properties),
    geometry,
    localGeometry: geometryMapCoordinates(geometry, projector.forward),
    vertical: {
      heightM: numberOrNull(properties.height_m ?? properties.height),
      heightSource: numberOrNull(properties.height_m ?? properties.height) !== null ? "planning-drawing" : null,
      minHeightM: numberOrNull(properties.min_height_m) ?? 0,
      elevationM: numberOrNull(properties.elevation_m ?? properties.ele),
      explicit: numberOrNull(properties.height_m ?? properties.height) !== null || numberOrNull(properties.elevation_m ?? properties.ele) !== null
    },
    source: {
      provider: properties.source_name || "Planning application / architect drawing",
      applicationReference: application.reference,
      drawingId: properties._drawing_id || properties.drawing_id || null,
      drawingTitle: properties._drawing_title || properties.drawing_title || null,
      drawingRevision: properties._drawing_revision || properties.revision || null,
      sourceUrl: properties.source_url || application.sourceUrl || application.source_url || null,
      timestamp: properties.checked_at || application.checkedAt || application.checked_at || null,
      license: properties.license || application.license || null
    },
    verification: {
      plan: "planning-authoritative",
      vertical: numberOrNull(properties.height_m ?? properties.height ?? properties.elevation_m ?? properties.ele) !== null
        ? "planning-drawing" : "unknown"
    },
    authority: {
      layer: "planning",
      rank: PLANNING_AUTHORITY,
      geometryLocked: true,
      applicationReference: application.reference
    }
  } : null;
  if (feature) feature.materialPalette = resolveFeatureMaterialPalettes(feature, materialRegistry);
  return { operation, target, feature, kind: kind || properties.kind || null, properties, applicationReference: application.reference };
}

function applyPlanningObservation(features, observation, summary, options) {
  const toleranceM = Number(options.planningMatchToleranceM ?? DEFAULT_MATCH_TOLERANCE_M);
  const minScore = Number(options.planningMinMatchScore ?? DEFAULT_MIN_MATCH_SCORE);
  let match = observation.target ? explicitMatch(features, observation.target) : null;
  if (match) summary.explicitMatches += 1;
  if (!match && ["auto", "replace", "delete", "retag"].includes(observation.operation)) {
    const automatic = automaticMatch(features, observation.feature, observation.kind, toleranceM, minScore,
      observation.operation === "delete" ? Math.max(0.78, minScore) : minScore);
    if (automatic?.ambiguous) summary.ambiguousMatches += 1;
    else if (automatic) {
      match = automatic;
      summary.automaticMatches += 1;
    }
  }

  if (observation.operation === "delete") {
    if (!match) { summary.unmatchedDeletes += 1; return; }
    features.splice(match.index, 1);
    summary.deleted += 1;
    return;
  }
  if (observation.operation === "retag") {
    if (!match) return;
    const target = match.feature;
    target.tags = { ...target.tags, ...observation.feature.tags };
    target.name = observation.feature.name || target.name;
    target.source = { ...observation.feature.source, modifies: target.id };
    target.verification = observation.feature.verification;
    target.authority = observation.feature.authority;
    target.materialPalette = observation.feature.materialPalette || target.materialPalette;
    summary.retagged += 1;
    return;
  }

  const shouldReplace = observation.operation === "replace" || (observation.operation === "auto" && match);
  if (shouldReplace && match) {
    observation.feature.source.replaces = match.feature.id;
    observation.feature.planningMatch = compactMatch(match);
    features.splice(match.index, 1, observation.feature);
    summary.replaced += 1;
    return;
  }
  if (observation.operation === "replace" && !match) {
    summary.warnings.push(`No replacement target found for planning feature ${observation.feature?.id || observation.applicationReference}; added instead.`);
  }
  features.push(observation.feature);
  summary.added += 1;
}

function explicitMatch(features, target) {
  const index = features.findIndex((feature) => feature.id === target || feature.source?.elementId === target ||
    `osm:${feature.source?.elementType}:${feature.source?.elementId}` === target);
  return index >= 0 ? { index, feature: features[index], score: 1, method: "explicit-target" } : null;
}

function automaticMatch(features, planningFeature, kind, toleranceM, minimumScore) {
  if (!planningFeature?.localGeometry) return null;
  const ranked = features.map((feature, index) => ({ index, feature, ...matchScore(planningFeature, feature, toleranceM, kind) }))
    .filter((candidate) => candidate.compatible && candidate.score >= minimumScore)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  if (ranked[1] && ranked[0].score - ranked[1].score < 0.06) return { ambiguous: true };
  return { ...ranked[0], method: "spatial-authority-match" };
}

function matchScore(planning, candidate, toleranceM, requestedKind) {
  if ((candidate.authority?.rank || 100) >= PLANNING_AUTHORITY) return { compatible: false, score: 0 };
  const compatible = compatibleKinds(planning.kind || requestedKind, candidate.kind);
  if (!compatible) return { compatible: false, score: 0 };
  const a = geometryBounds(planning.localGeometry), b = geometryBounds(candidate.localGeometry);
  const centroidDistance = distance(boundsCenter(a), boundsCenter(b));
  const expandedIntersects = a.minX <= b.maxX + toleranceM && a.maxX >= b.minX - toleranceM &&
    a.minZ <= b.maxZ + toleranceM && a.maxZ >= b.minZ - toleranceM;
  if (!expandedIntersects) return { compatible: true, score: 0 };
  const overlap = bboxOverlap(a, b);
  const shapeDistance = meanGeometryDistance(planning.localGeometry, candidate.localGeometry);
  const distanceScore = Math.max(0, 1 - Math.min(shapeDistance, toleranceM * 2) / (toleranceM * 2));
  const centroidScore = Math.max(0, 1 - centroidDistance / Math.max(1, toleranceM * 3));
  const sameName = normalizeName(planning.name) && normalizeName(planning.name) === normalizeName(candidate.name);
  const score = 0.30 + 0.25 * overlap + 0.25 * distanceScore + 0.10 * centroidScore + (sameName ? 0.10 : 0);
  return { compatible: true, score: Math.round(score * 1000) / 1000, distanceM: Math.round(shapeDistance * 10) / 10 };
}

function compatibleKinds(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const groups = [new Set(["path", "road"]), new Set(["building", "structure"]), new Set(["ride_track", "rail"])];
  return groups.some((group) => group.has(a) && group.has(b));
}

function bboxOverlap(a, b) {
  const ix = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const iz = Math.max(0, Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ));
  const intersection = ix * iz;
  const aa = Math.max(0.01, (a.maxX - a.minX) * (a.maxZ - a.minZ));
  const ba = Math.max(0.01, (b.maxX - b.minX) * (b.maxZ - b.minZ));
  return Math.max(0, Math.min(1, intersection / Math.min(aa, ba)));
}

function meanGeometryDistance(a, b) {
  const pa = positions(a), pb = positions(b);
  if (!pa.length || !pb.length) return Infinity;
  const oneWay = (from, to) => from.reduce((sum, point) => sum + Math.min(...to.map((other) => distance(point, other))), 0) / from.length;
  return (oneWay(sample(pa, 24), sample(pb, 24)) + oneWay(sample(pb, 24), sample(pa, 24))) / 2;
}

function positions(geometry) {
  const result = [];
  walkPositions(geometry, (point) => result.push(point));
  return result;
}

function sample(values, maximum) {
  if (values.length <= maximum) return values;
  const result = [];
  for (let i = 0; i < maximum; i += 1) result.push(values[Math.round(i * (values.length - 1) / (maximum - 1))]);
  return result;
}

function classifyPlanning(properties) {
  if (properties.roller_coaster === "track" || properties.ride_track) return "ride_track";
  if (properties.building || properties.building_type) return "building";
  if (properties.highway || properties.path || properties.footway) return "path";
  if (properties.road || properties.carriageway) return "road";
  if (properties.water || properties.waterbody) return "water";
  if (properties.barrier || properties.fence || properties.wall) return "barrier";
  if (properties.tree || properties.vegetation) return "vegetation";
  if (properties.surface || properties.material_code || properties.surface_material_code) return "surface";
  return null;
}

function inferSubtype(properties, kind) {
  return properties.building || properties.highway || properties.barrier || properties.surface || `${kind || "detail"}:planning`;
}

function stripControlProperties(properties) {
  const result = { ...properties };
  for (const key of ["operation", "planning_operation", "target", "target_id", "replaces", "osm_id", "_drawing_id", "_drawing_title", "_drawing_revision"]) delete result[key];
  return result;
}

function attachDrawing(feature, drawing) {
  return { ...feature, properties: {
    ...(feature.properties || {}),
    _drawing_id: drawing.id || drawing.number || null,
    _drawing_title: drawing.title || null,
    _drawing_revision: drawing.revision || null
  } };
}

function normalizeTarget(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  if (/^osm:(node|way|relation):\d+$/.test(text)) return text;
  if (/^(node|way|relation):\d+$/.test(text)) return `osm:${text}`;
  return text;
}

function compactMatch(match) {
  return { method: match.method, score: match.score, distanceM: match.distanceM ?? null, targetId: match.feature.id };
}

const boundsCenter = (b) => [(b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2];
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const normalizeName = (value) => String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const safe = (value) => String(value).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
const numberOrNull = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const increment = (object, key) => { object[key] = (object[key] || 0) + 1; };
