import { pointInRing, polygonScanlineSpans } from "./geo.mjs";

const AREA_TYPES = new Set(["Polygon", "MultiPolygon"]);
const LINE_TYPES = new Set(["LineString", "MultiLineString"]);

/**
 * Enrich canonical map features with high-detail parking semantics without
 * inventing geometry. Kerbs, crossings, arrows and hatching are accepted only
 * when explicit source geometry/tags exist. Bay orientation is measured from
 * the bay polygon itself and is therefore descriptive, not procedural.
 */
export function normalizeParkingDetailFeatures(map) {
  const features = map?.features || [];
  const parkingAreas = features.filter((feature) => feature?.parkingEvidence?.role === "area" && AREA_TYPES.has(feature?.localGeometry?.type));
  const summary = {
    schemaVersion: 1,
    status: "complete",
    orientedBays: 0,
    kerbs: 0,
    crossings: 0,
    arrows: 0,
    hatching: 0,
    islands: 0,
    explicitLineworkFeatures: 0,
    outsideParkingContext: 0,
    policy: {
      inferredKerbsAllowed: false,
      inferredCrossingStripesAllowed: false,
      inferredArrowsAllowed: false,
      inferredHatchingAllowed: false,
      bayOrientationDerivedOnlyFromExplicitGeometry: true,
      terrainElevationMutable: false
    }
  };

  for (const feature of features) {
    if (feature?.parkingEvidence?.role === "bay" && AREA_TYPES.has(feature?.localGeometry?.type)) {
      const orientation = measureBayOrientation(feature.localGeometry);
      if (orientation) {
        feature.parkingEvidence.orientation = orientation;
        summary.orientedBays += 1;
      }
    }

    const detail = detectDetail(feature);
    if (!detail) continue;
    const inParking = parkingAreas.some((area) => geometryCenterInside(feature.localGeometry, area.localGeometry));
    if (!inParking && !explicitParkingContext(feature)) {
      summary.outsideParkingContext += 1;
      continue;
    }
    feature.parkingDetailEvidence = {
      schemaVersion: 1,
      role: detail.role,
      subtype: detail.subtype,
      source: feature?.source?.provider || feature?.authority?.layer || "unknown",
      authorityLayer: feature?.authority?.layer || null,
      authorityRank: Number(feature?.authority?.rank || 0),
      explicitGeometry: true,
      exactLinework: LINE_TYPES.has(feature?.localGeometry?.type),
      parkingContext: inParking ? "inside-parking-area" : "explicit-tag",
      terrainElevationMutable: false,
      inferredPatternAllowed: false
    };
    summary[detail.counter] += 1;
    if (LINE_TYPES.has(feature?.localGeometry?.type)) summary.explicitLineworkFeatures += 1;
  }

  map.parkingDetailEvidence = summary;
  return summary;
}

/**
 * Label planning vectors as parking detail before the generic planning compiler.
 * This grants no authority: registration/currentness/ambiguity gates still apply.
 */
export function preparePlanningParkingDetailEvidence(evidence = {}) {
  const candidates = (evidence.geometryCandidates || []).map((candidate) => {
    const semantic = planningDetailSemantic(candidate);
    if (!semantic) return candidate;
    const copy = { ...candidate, tags: { ...(candidate.tags || candidate.properties?.tags || {}) } };
    copy.tags["planning:parking_detail_semantic"] = semantic.subtype;
    copy.tags["parking:layout_inferred"] = "no";
    copy.parkingDetailEvidence = {
      schemaVersion: 1,
      source: "planning-pdf-parking-detail-semantic",
      role: semantic.role,
      subtype: semantic.subtype,
      confidence: Math.max(Number(candidate.confidence || 0), semantic.confidence),
      exactLinework: LINE_TYPES.has(candidate?.localGeometry?.type || candidate?.geometry?.type),
      inferredPatternAllowed: false,
      worldGeometryAuthority: candidate.worldGeometryAuthority === true,
      georegistrationRequired: candidate.georegistrationStatus !== "registered",
      temporalResolutionRequired: candidate?.planningTemporal?.state !== "current"
    };

    if (semantic.role === "kerb") {
      copy.kind = "barrier";
      copy.featureKind = "barrier";
      copy.subtype = "parking_kerb";
      copy.semantic = "site-edge";
      copy.tags.barrier = "kerb";
    } else if (semantic.role === "island") {
      copy.kind = "surface";
      copy.featureKind = "surface";
      copy.subtype = "parking_island";
      copy.semantic = "site-feature";
    } else {
      // Crossing/arrow/hatching are paint-only evidence. The generic topology
      // compiler must never convert road-marking linework into road geometry.
      copy.kind = "surface";
      copy.featureKind = "surface";
      copy.subtype = semantic.subtype;
      copy.semantic = "site-feature";
    }
    copy.properties = { ...(candidate.properties || {}), kind: copy.kind, subtype: copy.subtype, tags: copy.tags };
    return copy;
  });
  return { ...evidence, geometryCandidates: candidates };
}

/**
 * Render exact parking detail linework. Polygon-only arrows/hatching/crossings
 * are retained as evidence but do not synthesize an internal pattern. Kerb
 * linework is emitted as a raised half-block slab via the existing stateful
 * Bedrock replacement pipeline.
 */
export function renderParkingDetails(compilation, { map, sources } = {}) {
  const stats = {
    schemaVersion: 1,
    status: "complete",
    features: 0,
    exactLineworkFeatures: 0,
    kerbFeatures: 0,
    crossingFeatures: 0,
    arrowFeatures: 0,
    hatchingFeatures: 0,
    islandFeatures: 0,
    markingCells: 0,
    kerbCells: 0,
    polygonPatternsDeferred: 0,
    operations: 0,
    estimatedBlocks: 0,
    policy: {
      exactLineworkOnlyForMarkingPatterns: true,
      polygonPatternInferenceAllowed: false,
      kerbsUseRaisedStatefulSlabs: true,
      terrainElevationMutable: false
    }
  };
  const bounds = compilation?.meta?.bounds;
  if (!bounds) return { ...stats, status: "missing-compilation-bounds" };
  const minDatum = Number(compilation?.meta?.elevationDatumM || 0);
  const features = (map?.features || []).filter((feature) => feature?.parkingDetailEvidence?.role);
  compilation.meta ||= {};
  compilation.meta.statefulBlockReplacements ||= [];
  const replacementByCell = new Map(compilation.meta.statefulBlockReplacements.map((item) => [`${item.x},${item.y},${item.z}`, item]));

  for (const feature of features) {
    const role = feature.parkingDetailEvidence.role;
    stats.features += 1;
    if (role === "kerb") stats.kerbFeatures += 1;
    else if (role === "crossing") stats.crossingFeatures += 1;
    else if (role === "arrow") stats.arrowFeatures += 1;
    else if (role === "hatching") stats.hatchingFeatures += 1;
    else if (role === "island") stats.islandFeatures += 1;

    const lines = geometryLines(feature.localGeometry);
    if (!lines.length) {
      // An explicit polygon proves the feature extent, but not its internal
      // paint pattern. Keep it in QA rather than fabricating zebra stripes,
      // arrows or diagonal hatch spacing.
      if (["crossing", "arrow", "hatching"].includes(role)) stats.polygonPatternsDeferred += 1;
      if (role === "island") renderIslandBoundary(feature, compilation, sources, minDatum, bounds, replacementByCell, stats);
      continue;
    }
    stats.exactLineworkFeatures += 1;

    const cells = new Map();
    for (const line of lines) {
      for (let index = 1; index < line.length; index += 1) {
        for (const cell of rasterLine(line[index - 1], line[index])) {
          if (cell.x < bounds.minX || cell.x > bounds.maxX || cell.z < bounds.minZ || cell.z > bounds.maxZ) continue;
          cells.set(`${cell.x},${cell.z}`, cell);
        }
      }
    }

    for (const { x, z } of cells.values()) {
      const y = terrainY(sources, x, z, minDatum);
      if (role === "kerb") {
        appendCellOperation(compilation, 1.83, x, y + 1, z, "minecraft:stone_bricks", stats);
        const replacement = {
          x, y: y + 1, z,
          name: kerbSlabBlock(feature),
          states: { "minecraft:vertical_half": "bottom" },
          kind: "parking-kerb-slab",
          featureId: feature.id || null
        };
        replacementByCell.set(`${x},${y + 1},${z}`, replacement);
        stats.kerbCells += 1;
      } else {
        appendCellOperation(compilation, 1.82, x, y, z, markingBlock(feature, role), stats);
        stats.markingCells += 1;
      }
    }
  }

  compilation.meta.statefulBlockReplacements = [...replacementByCell.values()].sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y || a.name.localeCompare(b.name));
  compilation.meta.parkingDetailEvidence = stats;
  compilation.stats ||= {};
  compilation.stats.parkingDetailFeatures = stats.features;
  compilation.stats.parkingKerbCells = stats.kerbCells;
  compilation.stats.parkingDetailMarkingCells = stats.markingCells;
  compilation.stats.parkingDeferredPatternPolygons = stats.polygonPatternsDeferred;
  for (const chunk of compilation.chunks || []) chunk.o.sort((a, b) => a[0] - b[0]);
  return stats;
}

function detectDetail(feature) {
  const tags = feature?.tags || {};
  const subtype = norm(feature?.subtype);
  const barrier = norm(tags.barrier);
  const crossing = norm(tags.crossing || tags["crossing:markings"]);
  const roadMarking = norm(tags.road_marking || tags.marking || tags["road_marking"]);
  const detail = norm(tags["planning:parking_detail_semantic"] || tags["parking:detail"]);
  if (subtype === "parking_island" || detail === "parking_island") return { role: "island", subtype: "parking_island", counter: "islands" };
  if (barrier === "kerb" || barrier === "curb" || subtype.includes("kerb") || detail === "parking_kerb") return { role: "kerb", subtype: "parking_kerb", counter: "kerbs" };
  if (crossing || subtype.includes("crossing") || detail === "parking_crossing") return { role: "crossing", subtype: "parking_crossing", counter: "crossings" };
  if (/arrow|direction/.test(`${roadMarking} ${subtype} ${detail}`)) return { role: "arrow", subtype: "parking_direction_arrow", counter: "arrows" };
  if (/hatch|chevron|keep_clear/.test(`${roadMarking} ${subtype} ${detail}`)) return { role: "hatching", subtype: "parking_hatching", counter: "hatching" };
  return null;
}

function planningDetailSemantic(candidate) {
  const explicit = norm(candidate?.tags?.["planning:parking_detail_semantic"] || candidate?.properties?.tags?.["planning:parking_detail_semantic"]);
  if (explicit) return semanticFromSubtype(explicit);
  const text = [candidate?.label, candidate?.name, candidate?.description, candidate?.raw, candidate?.properties?.label, candidate?.properties?.name]
    .filter(Boolean).join(" ").toLowerCase();
  if (/\b(car\s*park\s+kerb|parking\s+kerb|kerb\s+line|curb\s+line|raised\s+kerb)\b/.test(text)) return { role: "kerb", subtype: "parking_kerb", confidence: 0.97 };
  if (/\b(car\s*park\s+pedestrian\s+crossing|parking\s+crossing|zebra\s+crossing|pedestrian\s+crossing)\b/.test(text)) return { role: "crossing", subtype: "parking_crossing", confidence: 0.97 };
  if (/\b(direction(?:al)?\s+arrow|traffic\s+arrow|one[- ]way\s+arrow|parking\s+arrow)\b/.test(text)) return { role: "arrow", subtype: "parking_direction_arrow", confidence: 0.96 };
  if (/\b(hatched\s+area|hatching|chevron\s+marking|keep\s+clear\s+hatching)\b/.test(text)) return { role: "hatching", subtype: "parking_hatching", confidence: 0.96 };
  if (/\b(parking\s+island|car\s*park\s+island|landscape(?:d)?\s+island|traffic\s+island)\b/.test(text)) return { role: "island", subtype: "parking_island", confidence: 0.96 };
  return null;
}

function semanticFromSubtype(subtype) {
  if (subtype.includes("kerb")) return { role: "kerb", subtype: "parking_kerb", confidence: 0.97 };
  if (subtype.includes("crossing")) return { role: "crossing", subtype: "parking_crossing", confidence: 0.97 };
  if (subtype.includes("arrow")) return { role: "arrow", subtype: "parking_direction_arrow", confidence: 0.96 };
  if (subtype.includes("hatch") || subtype.includes("chevron")) return { role: "hatching", subtype: "parking_hatching", confidence: 0.96 };
  if (subtype.includes("island")) return { role: "island", subtype: "parking_island", confidence: 0.96 };
  return null;
}

function measureBayOrientation(geometry) {
  const rings = outerRings(geometry);
  let best = null;
  for (const ring of rings) {
    for (let index = 1; index < ring.length; index += 1) {
      const a = ring[index - 1], b = ring[index];
      const dx = Number(b?.[0]) - Number(a?.[0]);
      const dz = Number(b?.[1]) - Number(a?.[1]);
      const length = Math.hypot(dx, dz);
      if (!Number.isFinite(length) || length <= 0) continue;
      if (!best || length > best.lengthM) {
        let angle = Math.atan2(dz, dx) * 180 / Math.PI;
        angle = ((angle % 180) + 180) % 180;
        best = { angleDeg: Math.round(angle * 10) / 10, lengthM: Math.round(length * 10) / 10 };
      }
    }
  }
  if (!best) return null;
  return { method: "longest-explicit-polygon-edge", ...best, inferred: false };
}

function renderIslandBoundary(feature, compilation, sources, minDatum, bounds, replacementByCell, stats) {
  const cells = geometryCells(feature.localGeometry, bounds);
  if (!cells.size) return;
  const boundary = [...cells.values()].filter(({ x, z }) => [[-1,0],[1,0],[0,-1],[0,1]].some(([dx,dz]) => !cells.has(`${x + dx},${z + dz}`)));
  for (const { x, z } of boundary) {
    const y = terrainY(sources, x, z, minDatum);
    appendCellOperation(compilation, 1.83, x, y + 1, z, "minecraft:stone_bricks", stats);
    replacementByCell.set(`${x},${y + 1},${z}`, {
      x, y: y + 1, z,
      name: kerbSlabBlock(feature),
      states: { "minecraft:vertical_half": "bottom" },
      kind: "parking-island-kerb-slab",
      featureId: feature.id || null
    });
    stats.kerbCells += 1;
  }
}

function geometryLines(geometry) {
  if (geometry?.type === "LineString") return [geometry.coordinates || []];
  if (geometry?.type === "MultiLineString") return geometry.coordinates || [];
  return [];
}
function rasterLine(a, b) {
  let x0 = Math.round(Number(a?.[0])), z0 = Math.round(Number(a?.[1]));
  const x1 = Math.round(Number(b?.[0])), z1 = Math.round(Number(b?.[1]));
  if (![x0, z0, x1, z1].every(Number.isFinite)) return [];
  const out = [];
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  const dz = -Math.abs(z1 - z0), sz = z0 < z1 ? 1 : -1;
  let err = dx + dz;
  while (true) {
    out.push({ x: x0, z: z0 });
    if (x0 === x1 && z0 === z1) break;
    const e2 = 2 * err;
    if (e2 >= dz) { err += dz; x0 += sx; }
    if (e2 <= dx) { err += dx; z0 += sz; }
  }
  return out;
}
function geometryCells(geometry, bounds) {
  const result = new Map();
  const polygons = geometry?.type === "Polygon" ? [geometry.coordinates] : geometry?.type === "MultiPolygon" ? geometry.coordinates : [];
  for (const polygon of polygons) {
    const holes = polygon.slice(1);
    for (const [x1, x2, z] of polygonScanlineSpans(polygon)) {
      if (z < bounds.minZ || z > bounds.maxZ) continue;
      for (let x = Math.max(x1, bounds.minX); x <= Math.min(x2, bounds.maxX); x += 1) {
        if (holes.some((ring) => pointInRing(x + 0.5, z + 0.5, ring))) continue;
        result.set(`${x},${z}`, { x, z });
      }
    }
  }
  return result;
}
function geometryCenterInside(inner, outer) {
  const points = outerRings(inner).flat();
  if (!points.length) return false;
  const x = points.reduce((sum, point) => sum + Number(point[0]), 0) / points.length;
  const z = points.reduce((sum, point) => sum + Number(point[1]), 0) / points.length;
  return outerRings(outer).some((ring) => pointInRing(x, z, ring));
}
function outerRings(geometry) {
  if (geometry?.type === "Polygon") return geometry.coordinates?.length ? [geometry.coordinates[0]] : [];
  if (geometry?.type === "MultiPolygon") return (geometry.coordinates || []).map((polygon) => polygon?.[0]).filter(Boolean);
  return [];
}
function explicitParkingContext(feature) {
  const text = `${norm(feature?.subtype)} ${norm(feature?.tags?.["parking:detail"])} ${norm(feature?.tags?.["planning:parking_detail_semantic"])}`;
  return /parking|car_park/.test(text);
}
function terrainY(sources, x, z, minDatum) {
  const absolute = typeof sources?.elevation?.sampleLocal === "function" ? sources.elevation.sampleLocal(x, z) : null;
  return Number.isFinite(absolute) ? Math.round(absolute - minDatum) : 0;
}
function markingBlock(feature, role) {
  const colour = norm(feature?.tags?.["marking:colour"] || feature?.tags?.marking_colour || feature?.tags?.colour);
  if (colour === "yellow") return "minecraft:yellow_concrete";
  if (colour === "blue") return "minecraft:blue_concrete";
  if (role === "crossing" && colour === "red") return "minecraft:red_concrete";
  return "minecraft:white_concrete";
}
function kerbSlabBlock(feature) {
  const material = norm(feature?.tags?.material || feature?.tags?.surface || feature?.tags?.["kerb:material"]);
  if (/sandstone/.test(material)) return "minecraft:sandstone_slab";
  if (/brick/.test(material)) return "minecraft:brick_slab";
  return "minecraft:stone_brick_slab";
}
function appendCellOperation(compilation, phase, x, y, z, block, stats) {
  const paletteIndex = ensurePalette(compilation, block);
  const chunkX = Math.floor(x / 16), chunkZ = Math.floor(z / 16);
  let chunk = (compilation.chunks || []).find((value) => value.x === chunkX && value.z === chunkZ);
  if (!chunk) {
    chunk = { x: chunkX, z: chunkZ, o: [] };
    compilation.chunks ||= [];
    compilation.chunks.push(chunk);
  }
  chunk.o.push([phase, x, y, z, x, y, z, paletteIndex]);
  stats.operations += 1;
  stats.estimatedBlocks += 1;
  if (compilation.stats) {
    compilation.stats.rawOperations = Number(compilation.stats.rawOperations || 0) + 1;
    compilation.stats.estimatedBlocks = Number(compilation.stats.estimatedBlocks || 0) + 1;
  }
}
function ensurePalette(compilation, block) {
  compilation.palette ||= [];
  const found = compilation.palette.indexOf(block);
  if (found >= 0) return found;
  compilation.palette.push(block);
  return compilation.palette.length - 1;
}
function norm(value) { return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_"); }
