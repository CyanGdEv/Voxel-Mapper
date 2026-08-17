const DEFAULT_BUFFER_M = 50;
const EPSILON = 1e-7;

/**
 * Bounds the current OSM planning reference to the requested park area and
 * removes relation/way duplicates that describe the same named physical
 * feature. This keeps georegistration local and prevents a long intersecting
 * OSM relation from polluting current-feature ambiguity scoring.
 */
export function normalizePlanningGeoregReferenceFeatures(features, projector, bbox, options = {}) {
  const bufferM = finiteNonNegative(options.bufferM, DEFAULT_BUFFER_M);
  const rect = localClipRect(projector, bbox, bufferM);
  const bounded = [];
  let clippedFeatureCount = 0;
  let droppedOutsideBbox = 0;
  let excludedBuildingNo = 0;

  for (const feature of features || []) {
    if (!feature?.localGeometry) continue;
    if (feature.kind === "building" && String(feature.tags?.building || "").toLowerCase() === "no") {
      excludedBuildingNo += 1;
      continue;
    }
    const clipped = clipGeometryToRect(feature.localGeometry, rect);
    if (!clipped) {
      droppedOutsideBbox += 1;
      continue;
    }
    if (!sameGeometry(feature.localGeometry, clipped)) clippedFeatureCount += 1;
    bounded.push({ ...feature, localGeometry: clipped });
  }

  const deduped = deduplicateRelationWayFeatures(bounded);
  return {
    features: deduped.features,
    summary: {
      schemaVersion: 1,
      clipBufferM: bufferM,
      inputFeatures: (features || []).length,
      outputFeatures: deduped.features.length,
      clippedFeatureCount,
      droppedOutsideBbox,
      excludedBuildingNo,
      deduplicatedFeatureCount: deduped.removed,
      clipRect: rect
    }
  };
}

export function clipGeometryToRect(geometry, rect) {
  if (!geometry || !rect) return null;
  if (geometry.type === "LineString") return clippedLineGeometry(geometry.coordinates || [], rect);
  if (geometry.type === "MultiLineString") {
    const parts = (geometry.coordinates || []).flatMap((line) => clipLineString(line, rect));
    if (!parts.length) return null;
    return parts.length === 1 ? { type: "LineString", coordinates: parts[0] } : { type: "MultiLineString", coordinates: parts };
  }
  if (geometry.type === "Polygon") {
    const polygon = clipPolygonCoordinates(geometry.coordinates || [], rect);
    return polygon ? { type: "Polygon", coordinates: polygon } : null;
  }
  if (geometry.type === "MultiPolygon") {
    const polygons = (geometry.coordinates || []).map((polygon) => clipPolygonCoordinates(polygon, rect)).filter(Boolean);
    if (!polygons.length) return null;
    return polygons.length === 1 ? { type: "Polygon", coordinates: polygons[0] } : { type: "MultiPolygon", coordinates: polygons };
  }
  return null;
}

export function deduplicateRelationWayFeatures(features) {
  const relationKeys = new Set();
  for (const feature of features || []) {
    if (feature?.source?.elementType !== "relation") continue;
    const key = namedPhysicalFeatureKey(feature);
    if (key) relationKeys.add(key);
  }

  const result = [];
  let removed = 0;
  for (const feature of features || []) {
    const key = namedPhysicalFeatureKey(feature);
    if (
      feature?.source?.elementType === "way" &&
      key && relationKeys.has(key) &&
      relationOverlapsWay(feature, features, key)
    ) {
      removed += 1;
      continue;
    }
    result.push(feature);
  }
  return { features: result, removed };
}

function localClipRect(projector, bbox, bufferM) {
  if (!projector?.forward) throw new Error("Planning georeg reference requires a local projector");
  const corners = [
    projector.forward([bbox.west, bbox.south]),
    projector.forward([bbox.east, bbox.south]),
    projector.forward([bbox.east, bbox.north]),
    projector.forward([bbox.west, bbox.north])
  ];
  const xs = corners.map(([x]) => x), zs = corners.map(([, z]) => z);
  return {
    minX: Math.min(...xs) - bufferM,
    maxX: Math.max(...xs) + bufferM,
    minZ: Math.min(...zs) - bufferM,
    maxZ: Math.max(...zs) + bufferM
  };
}

function clippedLineGeometry(points, rect) {
  const parts = clipLineString(points, rect);
  if (!parts.length) return null;
  return parts.length === 1 ? { type: "LineString", coordinates: parts[0] } : { type: "MultiLineString", coordinates: parts };
}

function clipLineString(points, rect) {
  if (!Array.isArray(points) || points.length < 2) return [];
  const parts = [];
  let current = null;
  for (let index = 1; index < points.length; index += 1) {
    const segment = clipSegment(points[index - 1], points[index], rect);
    if (!segment) {
      if (current?.length >= 2) parts.push(current);
      current = null;
      continue;
    }
    const [start, end] = segment;
    if (!current) current = [start, end];
    else if (samePoint(current[current.length - 1], start)) current.push(end);
    else {
      if (current.length >= 2) parts.push(current);
      current = [start, end];
    }
  }
  if (current?.length >= 2) parts.push(current);
  return parts.map(removeConsecutiveDuplicates).filter((part) => part.length >= 2);
}

function clipSegment(a, b, rect) {
  if (!validPoint(a) || !validPoint(b)) return null;
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const p = [-dx, dx, -dz, dz];
  const q = [a[0] - rect.minX, rect.maxX - a[0], a[1] - rect.minZ, rect.maxZ - a[1]];
  let t0 = 0, t1 = 1;
  for (let index = 0; index < 4; index += 1) {
    if (Math.abs(p[index]) < EPSILON) {
      if (q[index] < 0) return null;
      continue;
    }
    const t = q[index] / p[index];
    if (p[index] < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 - t1 > EPSILON) return null;
  }
  return [
    [a[0] + t0 * dx, a[1] + t0 * dz],
    [a[0] + t1 * dx, a[1] + t1 * dz]
  ];
}

function clipPolygonCoordinates(rings, rect) {
  if (!Array.isArray(rings) || !rings.length) return null;
  const exterior = clipRing(rings[0], rect);
  if (!exterior) return null;
  const holes = rings.slice(1).map((ring) => clipRing(ring, rect)).filter(Boolean);
  return [exterior, ...holes];
}

function clipRing(ring, rect) {
  if (!Array.isArray(ring) || ring.length < 4) return null;
  let points = stripClosingPoint(ring).filter(validPoint);
  if (points.length < 3) return null;
  points = clipPolygonEdge(points, (point) => point[0] >= rect.minX - EPSILON, (a, b) => intersectVertical(a, b, rect.minX));
  points = clipPolygonEdge(points, (point) => point[0] <= rect.maxX + EPSILON, (a, b) => intersectVertical(a, b, rect.maxX));
  points = clipPolygonEdge(points, (point) => point[1] >= rect.minZ - EPSILON, (a, b) => intersectHorizontal(a, b, rect.minZ));
  points = clipPolygonEdge(points, (point) => point[1] <= rect.maxZ + EPSILON, (a, b) => intersectHorizontal(a, b, rect.maxZ));
  points = removeConsecutiveDuplicates(points);
  if (points.length < 3) return null;
  return [...points, [...points[0]]];
}

function clipPolygonEdge(points, inside, intersect) {
  if (!points.length) return [];
  const output = [];
  let previous = points[points.length - 1];
  let previousInside = inside(previous);
  for (const current of points) {
    const currentInside = inside(current);
    if (currentInside) {
      if (!previousInside) output.push(intersect(previous, current));
      output.push(current);
    } else if (previousInside) output.push(intersect(previous, current));
    previous = current;
    previousInside = currentInside;
  }
  return output.filter(validPoint);
}

function intersectVertical(a, b, x) {
  const dx = b[0] - a[0];
  if (Math.abs(dx) < EPSILON) return [x, a[1]];
  const t = (x - a[0]) / dx;
  return [x, a[1] + t * (b[1] - a[1])];
}
function intersectHorizontal(a, b, z) {
  const dz = b[1] - a[1];
  if (Math.abs(dz) < EPSILON) return [a[0], z];
  const t = (z - a[1]) / dz;
  return [a[0] + t * (b[0] - a[0]), z];
}

function namedPhysicalFeatureKey(feature) {
  const name = String(feature?.name || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!name) return null;
  return `${feature.kind || ""}|${feature.subtype || ""}|${name}`;
}

function relationOverlapsWay(way, features, key) {
  const wayBounds = geometryBounds(way.localGeometry);
  if (!wayBounds) return false;
  return (features || []).some((relation) => {
    if (relation?.source?.elementType !== "relation" || namedPhysicalFeatureKey(relation) !== key) return false;
    const relationBounds = geometryBounds(relation.localGeometry);
    if (!relationBounds) return false;
    return bboxCoverageRatio(wayBounds, relationBounds) >= 0.9;
  });
}

function geometryBounds(geometry) {
  const points = geometryPoints(geometry);
  if (!points.length) return null;
  const xs = points.map(([x]) => x), zs = points.map(([, z]) => z);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}
function geometryPoints(geometry) {
  if (geometry?.type === "LineString") return geometry.coordinates || [];
  if (geometry?.type === "MultiLineString") return (geometry.coordinates || []).flat();
  if (geometry?.type === "Polygon") return (geometry.coordinates || []).flat();
  if (geometry?.type === "MultiPolygon") return (geometry.coordinates || []).flat(2);
  return [];
}
function bboxCoverageRatio(inner, outer) {
  const xCoverage = axisCoverage(inner.minX, inner.maxX, outer.minX, outer.maxX);
  const zCoverage = axisCoverage(inner.minZ, inner.maxZ, outer.minZ, outer.maxZ);
  return Math.min(xCoverage, zCoverage);
}
function axisCoverage(innerMin, innerMax, outerMin, outerMax) {
  const span = innerMax - innerMin;
  if (span <= EPSILON) return innerMin >= outerMin - EPSILON && innerMin <= outerMax + EPSILON ? 1 : 0;
  const overlap = Math.max(0, Math.min(innerMax, outerMax) - Math.max(innerMin, outerMin));
  return Math.max(0, Math.min(1, overlap / span));
}

function sameGeometry(a, b) { return JSON.stringify(roundGeometry(a)) === JSON.stringify(roundGeometry(b)); }
function roundGeometry(geometry) {
  const roundValue = (value) => Array.isArray(value)
    ? value.map(roundValue)
    : Number.isFinite(value) ? Math.round(value * 1000) / 1000 : value;
  return geometry ? { type: geometry.type, coordinates: roundValue(geometry.coordinates) } : null;
}
function stripClosingPoint(ring) {
  if (ring.length > 1 && samePoint(ring[0], ring[ring.length - 1])) return ring.slice(0, -1);
  return ring.slice();
}
function removeConsecutiveDuplicates(points) {
  const output = [];
  for (const point of points || []) if (!output.length || !samePoint(output[output.length - 1], point)) output.push(point);
  return output;
}
function samePoint(a, b) { return validPoint(a) && validPoint(b) && Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON; }
function validPoint(point) { return Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]); }
function finiteNonNegative(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}
