const DEFAULT_ASSOCIATION_MAX_M = 28;
const DEFAULT_ASSOCIATION_AMBIGUITY_M = 4;
const STRUCTURE_SUBTYPES = new Set([
  "sound_tunnel", "ride_enclosure", "ride_catwalk", "ride_platform", "ride_access_detail", "ride_building"
]);
const SUPPORT_SUBTYPES = new Set([
  "support_column", "support_frame", "support_brace", "support_footing", "support_footprint", "support_member"
]);

/**
 * Builds a ride-linked 3D structural model after planning/current-state
 * authority has already been resolved. The model is evidence-first:
 *
 * - current planning/survey geometry is traced exactly in plan view;
 * - explicit dimensions are used when available;
 * - section/elevation templates may add brace/member geometry only through an
 *   exact, unambiguous support-code link;
 * - missing vertical evidence is deferred rather than replaced by a generic
 *   A-frame guess;
 * - the older raster support inference remains available only for rides that
 *   have no authoritative structural evidence at all.
 */
export function reconstructRideStructures3d(map, options = {}) {
  const tracks = (map?.features || []).filter((feature) => feature.kind === "ride_track" && feature.localGeometry);
  const candidates = (map?.features || []).filter(isAuthoritativeRideStructureFeature);
  const templates = currentRideTemplates(options.planningAuthorityEvidenceData?.rideStructureTemplates || []);
  const templateByCode = indexTemplatesByCode(templates);
  const model = {
    schemaVersion: 1,
    status: "processed",
    policy: {
      evidenceFirst: true,
      genericSupportInferenceIsFallbackOnly: true,
      sectionTemplatesRequireExactSupportCode: true,
      ambiguousRideAssociationFailsClosed: true,
      terrainGeometryMutable: false,
      soundTunnelIsBuiltStructureNotTerrainTunnel: true
    },
    rides: [],
    structures: [],
    designFamilies: [],
    deferred: [],
    summary: {
      inputRideTracks: tracks.length,
      authoritativeStructuralFeatures: candidates.length,
      currentTemplates: templates.length,
      reconstructedStructures: 0,
      tracedSupportStructures: 0,
      templateLinkedSupports: 0,
      soundTunnels: 0,
      catwalks: 0,
      platforms: 0,
      deferredMissingVertical: 0,
      deferredAmbiguousRide: 0,
      deferredTemplateAmbiguity: 0
    }
  };

  for (const feature of candidates) {
    const association = associateStructureToRide(feature, tracks, options);
    if (!association.accepted) {
      model.deferred.push(deferred(feature, association.reason));
      if (association.reason === "ambiguous-ride-association") model.summary.deferredAmbiguousRide += 1;
      continue;
    }
    const structure = reconstructFeature(feature, association, templateByCode, options);
    if (!structure.accepted) {
      model.deferred.push(deferred(feature, structure.reason, { rideId: association.track.id, supportCode: supportCode(feature) }));
      if (/vertical|height/.test(structure.reason)) model.summary.deferredMissingVertical += 1;
      if (/template-ambiguous/.test(structure.reason)) model.summary.deferredTemplateAmbiguity += 1;
      continue;
    }
    model.structures.push(structure.value);
    model.summary.reconstructedStructures += 1;
    if (structure.value.kind === "support") {
      model.summary.tracedSupportStructures += 1;
      if (structure.value.templateLink?.accepted) model.summary.templateLinkedSupports += 1;
    }
    if (structure.value.subtype === "sound_tunnel") model.summary.soundTunnels += 1;
    if (structure.value.subtype === "ride_catwalk") model.summary.catwalks += 1;
    if (structure.value.subtype === "ride_platform") model.summary.platforms += 1;
  }

  model.designFamilies = buildDesignFamilies(model.structures);
  const byRide = new Map();
  for (const track of tracks) byRide.set(track.id, { rideId: track.id, rideName: track.name || null, structures: [], structuralEvidencePresent: false });
  for (const structure of model.structures) {
    if (!byRide.has(structure.rideId)) byRide.set(structure.rideId, { rideId: structure.rideId, rideName: null, structures: [], structuralEvidencePresent: false });
    const ride = byRide.get(structure.rideId);
    ride.structures.push(structure.id);
    ride.structuralEvidencePresent = true;
  }
  model.rides = [...byRide.values()].sort((a, b) => String(a.rideId).localeCompare(String(b.rideId)));
  if (!model.structures.length) model.status = candidates.length ? "evidence-deferred" : "no-authoritative-ride-structures";
  map.rideStructures3d = model;
  return model;
}

export function associateStructureToRide(feature, tracks, options = {}) {
  const explicitId = feature.tags?.["ride_structure:ride_id"] || feature.tags?.ride_id || feature.rideId || null;
  if (explicitId) {
    const exact = tracks.find((track) => String(track.id) === String(explicitId));
    if (exact) return { accepted: true, track: exact, method: "explicit-ride-id", distanceM: 0 };
  }
  const explicitName = normalizeName(feature.tags?.["ride_structure:ride"] || feature.tags?.ride || feature.tags?.attraction || "");
  if (explicitName) {
    const nameMatches = tracks.filter((track) => normalizeName(track.name) === explicitName);
    if (nameMatches.length === 1) return { accepted: true, track: nameMatches[0], method: "explicit-ride-name", distanceM: 0 };
    if (nameMatches.length > 1) return { accepted: false, reason: "ambiguous-explicit-ride-name" };
  }

  const point = geometryRepresentativePoint(feature.localGeometry);
  if (!point) return { accepted: false, reason: "missing-structure-position" };
  const ranked = tracks.map((track) => ({ track, distanceM: distanceToGeometry(point, track.localGeometry) }))
    .filter((entry) => Number.isFinite(entry.distanceM))
    .sort((a, b) => a.distanceM - b.distanceM || String(a.track.id).localeCompare(String(b.track.id)));
  const best = ranked[0];
  const maxM = finite(options.rideStructureAssociationMaxM, DEFAULT_ASSOCIATION_MAX_M);
  const ambiguity = finite(options.rideStructureAssociationAmbiguityM, DEFAULT_ASSOCIATION_AMBIGUITY_M);
  if (!best || best.distanceM > maxM) return { accepted: false, reason: "no-nearby-ride-track" };
  if (ranked[1] && ranked[1].distanceM - best.distanceM < ambiguity) return { accepted: false, reason: "ambiguous-ride-association" };
  return { accepted: true, track: best.track, method: "nearest-authoritative-track", distanceM: round(best.distanceM) };
}

function reconstructFeature(feature, association, templateByCode, options) {
  const subtype = rideSubtype(feature);
  if (feature.kind === "ride_support" || SUPPORT_SUBTYPES.has(subtype)) {
    return reconstructSupport(feature, association, templateByCode, options);
  }
  if (subtype === "sound_tunnel" || subtype === "ride_enclosure") return reconstructEnclosure(feature, association, subtype);
  if (subtype === "ride_catwalk" || subtype === "ride_platform" || subtype === "ride_access_detail") {
    return reconstructTrackLinkedAccess(feature, association, subtype);
  }
  return { accepted: false, reason: "unsupported-ride-structure-subtype" };
}

function reconstructSupport(feature, association, templateByCode, options) {
  const subtype = rideSubtype(feature) || "support_member";
  const code = supportCode(feature);
  const templateCandidates = code ? (templateByCode.get(code) || []) : [];
  if (templateCandidates.length > 1) return { accepted: false, reason: "support-template-ambiguous" };
  const template = templateCandidates[0] || null;
  const explicitHeightM = verticalHeight(feature);
  const anchor = geometryRepresentativePoint(feature.localGeometry);
  if (!anchor) return { accepted: false, reason: "missing-support-plan-anchor" };

  let members = [];
  let heightSource = null;
  let templateLink = { accepted: false, code: code || null, templateId: null };
  if (template) {
    const traced = traceTemplateMembers(template, feature, anchor);
    if (traced.length) {
      members = traced;
      heightSource = "planning-section-template";
      templateLink = {
        accepted: true,
        code,
        templateId: template.id,
        sourceTemplateIds: template.sourceTemplateIds || [template.id]
      };
    }
  }

  if (!members.length) {
    if (subtype === "support_footing") {
      return { accepted: true, value: supportRecord(feature, association, subtype, code, [], [{ geometry: clone(feature.localGeometry), dyM: 0 }], 0, "terrain-surface", templateLink) };
    }
    if (explicitHeightM == null) return { accepted: false, reason: "support-vertical-evidence-missing" };
    members = supportMembersFromPlan(feature.localGeometry, subtype, explicitHeightM);
    if (!members.length) return { accepted: false, reason: "support-plan-geometry-not-renderable" };
    heightSource = feature.vertical?.heightSource || "planning-explicit-height";
  }

  const maxDy = members.reduce((max, member) => Math.max(max, member.from?.dyM || 0, member.to?.dyM || 0), 0);
  return {
    accepted: true,
    value: supportRecord(feature, association, subtype, code, members, footingDescriptors(feature, subtype), maxDy, heightSource, templateLink)
  };
}

function reconstructEnclosure(feature, association, subtype) {
  const polygon = polygonOuterRing(feature.localGeometry);
  if (polygon.length < 4) return { accepted: false, reason: "enclosure-requires-polygon-footprint" };
  const heightM = verticalHeight(feature);
  if (heightM == null || heightM < 2) return { accepted: false, reason: "enclosure-explicit-height-missing" };
  const minHeightM = finiteOrNull(feature.vertical?.minHeightM) ?? 0;
  const trackCrossings = trackPolygonCrossings(association.track, polygon);
  return {
    accepted: true,
    value: {
      schemaVersion: 1,
      id: `ride-structure:${feature.id}`,
      featureId: feature.id,
      rideId: association.track.id,
      rideName: association.track.name || null,
      kind: "enclosure",
      subtype,
      footprint: clone(feature.localGeometry),
      heightM,
      minHeightM,
      wallMaterial: structuralMaterial(feature, subtype),
      roofMaterial: structuralMaterial(feature, subtype),
      trackCrossings,
      portals: trackCrossings.map((crossing, index) => ({
        id: `${feature.id}:portal:${index}`,
        x: crossing.x,
        z: crossing.z,
        elevationM: crossing.elevationM,
        direction: crossing.direction,
        clearanceWidthM: 3,
        clearanceAboveTrackM: 3,
        clearanceBelowTrackM: 1,
        source: "track-footprint-intersection"
      })),
      terrainExcavation: false,
      terrainGeometryMutable: false,
      source: sourceRecord(feature, association),
      confidence: structuralConfidence(feature)
    }
  };
}

function reconstructTrackLinkedAccess(feature, association, subtype) {
  const points = geometryPoints(feature.localGeometry);
  if (points.length < 2) return { accepted: false, reason: "access-structure-linework-missing" };
  const samples = points.map(([x, z]) => ({ x, z, dyFromTrackM: subtype === "ride_catwalk" ? -1 : 0 }));
  return {
    accepted: true,
    value: {
      schemaVersion: 1,
      id: `ride-structure:${feature.id}`,
      featureId: feature.id,
      rideId: association.track.id,
      rideName: association.track.name || null,
      kind: "access",
      subtype,
      samples,
      trackLinkedElevation: true,
      material: structuralMaterial(feature, subtype),
      terrainGeometryMutable: false,
      source: sourceRecord(feature, association),
      confidence: structuralConfidence(feature)
    }
  };
}

function supportRecord(feature, association, subtype, code, members, footings, heightM, heightSource, templateLink) {
  return {
    schemaVersion: 1,
    id: `ride-structure:${feature.id}`,
    featureId: feature.id,
    rideId: association.track.id,
    rideName: association.track.name || null,
    kind: "support",
    subtype,
    supportCode: code,
    members,
    footings,
    heightM: round(heightM),
    heightSource,
    material: structuralMaterial(feature, subtype),
    templateLink,
    terrainGeometryMutable: false,
    source: sourceRecord(feature, association),
    confidence: structuralConfidence(feature)
  };
}

function supportMembersFromPlan(geometry, subtype, heightM) {
  const points = geometryPoints(geometry);
  if (!points.length) return [];
  if (subtype === "support_column" || subtype === "support_footprint" || geometry.type === "Point" || /Polygon/.test(geometry.type || "")) {
    const [x, z] = geometryRepresentativePoint(geometry);
    return [{ role: "column", from: { x, z, dyM: 0 }, to: { x, z, dyM: heightM }, source: "plan-anchor-plus-explicit-height" }];
  }
  if (subtype === "support_frame" && points.length >= 2) {
    const a = points[0], b = points[points.length - 1];
    return [
      { role: "column", from: { x: a[0], z: a[1], dyM: 0 }, to: { x: a[0], z: a[1], dyM: heightM }, source: "plan-frame-plus-explicit-height" },
      { role: "column", from: { x: b[0], z: b[1], dyM: 0 }, to: { x: b[0], z: b[1], dyM: heightM }, source: "plan-frame-plus-explicit-height" },
      { role: "crossbeam", from: { x: a[0], z: a[1], dyM: heightM }, to: { x: b[0], z: b[1], dyM: heightM }, source: "plan-frame-plus-explicit-height" }
    ];
  }
  if (subtype === "support_member" && points.length >= 2) {
    const a = points[0], b = points[points.length - 1];
    return [{ role: "top-member", from: { x: a[0], z: a[1], dyM: heightM }, to: { x: b[0], z: b[1], dyM: heightM }, source: "plan-member-plus-explicit-height" }];
  }
  // A brace drawn only in plan view does not reveal which end is high/low.
  // Without a linked section template, defer it instead of inventing the slope.
  return [];
}

function traceTemplateMembers(template, feature, anchor) {
  const commands = template.commands || [];
  if (!commands.length || !template.scaleDenominator) return [];
  const scaleMPerPt = Number(template.scaleDenominator) * 0.0254 / 72;
  if (!Number.isFinite(scaleMPerPt) || scaleMPerPt <= 0) return [];
  const orientation = planOrientation(feature.localGeometry);
  const bounds = template.boundsPt;
  if (!bounds) return [];
  const originX = (bounds.minX + bounds.maxX) / 2;
  const originY = bounds.minY;
  const members = [];
  let cursor = null;
  const worldPoint = (command) => {
    const sx = (Number(command.x) - originX) * scaleMPerPt;
    const dyM = Math.max(0, (Number(command.y) - originY) * scaleMPerPt);
    return { x: anchor[0] + orientation[0] * sx, z: anchor[1] + orientation[1] * sx, dyM };
  };
  for (const command of commands) {
    if (!Number.isFinite(command.x) || !Number.isFinite(command.y)) continue;
    const point = worldPoint(command);
    if (command.op === "M") { cursor = point; continue; }
    if (["L", "C", "C2", "C3"].includes(command.op) && cursor) {
      members.push({ role: "template-member", from: cursor, to: point, source: "planning-section-template" });
      cursor = point;
    }
  }
  return members.filter((member) => distance3(member.from, member.to) >= 0.25);
}

function currentRideTemplates(values) {
  return (values || []).filter((template) =>
    template?.templateAuthorityEligible === true ||
    (template?.planningTemporal?.state === "current" && Number(template?.planningTemporal?.confidence || 0) >= 0.85)
  );
}

/**
 * A single support detail sheet normally draws one frame as many independent
 * vector paths. Those paths are not conflicting templates. Merge all current
 * paths with the same support code on the same document/page into one design.
 * The same code on two current pages remains ambiguous and fails closed.
 */
function indexTemplatesByCode(values) {
  const byCodePage = new Map();
  for (const template of values || []) {
    const code = normalizeCode(template.supportCode);
    if (!code) continue;
    const pageKey = `${template.contentHash || "unknown"}:p${Number(template.pageNumber || 1)}`;
    const key = `${code}|${pageKey}`;
    if (!byCodePage.has(key)) byCodePage.set(key, { code, pageKey, templates: [] });
    byCodePage.get(key).templates.push(template);
  }

  const result = new Map();
  for (const group of byCodePage.values()) {
    const templates = group.templates.sort((a, b) => String(a.id || "").localeCompare(String(b.id || "")));
    const scales = [...new Set(templates.map((entry) => Number(entry.scaleDenominator)).filter(Number.isFinite))];
    const bounds = unionBounds(templates.map((entry) => entry.boundsPt).filter(Boolean));
    const composite = {
      ...templates[0],
      id: `ride-support-template:${group.code}:${group.pageKey}`,
      supportCode: group.code,
      commands: templates.flatMap((entry) => entry.commands || []),
      boundsPt: bounds,
      scaleDenominator: scales.length === 1 ? scales[0] : null,
      sourceTemplateIds: templates.map((entry) => entry.id).filter(Boolean),
      sourcePathCount: templates.length,
      composite: true
    };
    if (!result.has(group.code)) result.set(group.code, []);
    result.get(group.code).push(composite);
  }
  for (const templates of result.values()) templates.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return result;
}

function unionBounds(values) {
  if (!values.length) return null;
  return {
    minX: Math.min(...values.map((entry) => Number(entry.minX))),
    minY: Math.min(...values.map((entry) => Number(entry.minY))),
    maxX: Math.max(...values.map((entry) => Number(entry.maxX))),
    maxY: Math.max(...values.map((entry) => Number(entry.maxY)))
  };
}
function supportCode(feature) { return normalizeCode(feature.tags?.["ride_structure:support_code"] || feature.supportCode || ""); }
function rideSubtype(feature) { return String(feature.tags?.["ride_structure:type"] || feature.subtype || "").toLowerCase(); }
function verticalHeight(feature) {
  const value = finiteOrNull(feature.vertical?.heightM ?? feature.heightM ?? feature.tags?.["ride_structure:height_m"]);
  return value != null && value > 0 && value < 250 ? value : null;
}
function isAuthoritativeRideStructureFeature(feature) {
  if (!feature?.localGeometry) return false;
  const authoritative = feature.authority?.worldGeometryAuthority === true || Number(feature.authority?.rank || 0) >= 360 || /survey|verified/.test(String(feature.authority?.layer || feature.verification?.plan || ""));
  if (!authoritative) return false;
  const subtype = rideSubtype(feature);
  return feature.kind === "ride_support" || STRUCTURE_SUBTYPES.has(subtype) || SUPPORT_SUBTYPES.has(subtype);
}
function sourceRecord(feature, association) {
  return {
    provider: feature.source?.provider || null,
    contentHash: feature.source?.contentHash || null,
    pageNumber: feature.source?.pageNumber || null,
    sourceRef: feature.source?.sourceRef || null,
    rideAssociationMethod: association.method,
    rideAssociationDistanceM: association.distanceM ?? null,
    authorityLayer: feature.authority?.layer || null
  };
}
function structuralMaterial(feature, subtype) {
  const material = String(feature.tags?.material || feature.tags?.structure_material || "").toLowerCase();
  if (/timber|wood/.test(material)) return "timber";
  if (/concrete/.test(material)) return "concrete";
  if (/brick/.test(material)) return "brick";
  if (/stone|masonry/.test(material)) return "stone";
  if (/steel|metal|iron/.test(material)) return "steel";
  if (subtype === "sound_tunnel") return "observed-or-neutral-structure";
  return "steel";
}
function structuralConfidence(feature) { return round(Math.max(Number(feature.confidence || 0), feature.authority?.worldGeometryAuthority ? 0.92 : 0.8)); }
function footingDescriptors(feature, subtype) {
  if (subtype === "support_footing") return [{ geometry: clone(feature.localGeometry), dyM: 0 }];
  const point = geometryRepresentativePoint(feature.localGeometry);
  return point ? [{ geometry: { type: "Point", coordinates: point }, dyM: 0, inferredFrom: "authoritative-support-anchor" }] : [];
}
function buildDesignFamilies(structures) {
  const families = new Map();
  for (const structure of structures.filter((entry) => entry.kind === "support")) {
    const signature = [structure.subtype, structure.material, structure.templateLink?.templateId || "no-template", round(structure.heightM || 0)].join("|");
    if (!families.has(signature)) families.set(signature, { id: `support-family:${families.size + 1}`, signature, subtype: structure.subtype, material: structure.material, templateId: structure.templateLink?.templateId || null, members: [], instances: [] });
    const family = families.get(signature);
    family.instances.push(structure.id);
    family.members = structure.templateLink?.accepted ? clone(structure.members) : family.members;
  }
  return [...families.values()].map((family) => ({ ...family, instanceCount: family.instances.length }));
}

/**
 * Intersects each 3D track-plan segment with every enclosure edge. Endpoint
 * inside/outside transitions alone are insufficient because a coarse segment
 * can enter and leave an enclosure while both endpoints remain outside.
 */
function trackPolygonCrossings(track, ring) {
  const points = trackProfilePoints(track);
  const crossings = [];
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1], b = points[index];
    const hits = [];
    for (let edgeIndex = 1; edgeIndex < ring.length; edgeIndex += 1) {
      const t = segmentIntersectionFraction([a.x, a.z], [b.x, b.z], ring[edgeIndex - 1], ring[edgeIndex]);
      if (t == null) continue;
      if (hits.some((entry) => Math.abs(entry - t) < 1e-6)) continue;
      hits.push(t);
    }
    if (ring.length > 2 && !samePlanPoint(ring[0], ring[ring.length - 1])) {
      const t = segmentIntersectionFraction([a.x, a.z], [b.x, b.z], ring[ring.length - 1], ring[0]);
      if (t != null && !hits.some((entry) => Math.abs(entry - t) < 1e-6)) hits.push(t);
    }
    hits.sort((left, right) => left - right);
    for (const t of hits) {
      const elevationA = finiteOrNull(a.elevationM), elevationB = finiteOrNull(b.elevationM);
      const crossing = {
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
        elevationM: elevationA != null && elevationB != null ? elevationA + (elevationB - elevationA) * t : null,
        direction: normalize2([b.x - a.x, b.z - a.z])
      };
      if (crossings.some((entry) => Math.hypot(entry.x - crossing.x, entry.z - crossing.z) < 0.05)) continue;
      crossings.push(crossing);
    }
  }
  return crossings.slice(0, 8);
}
function segmentIntersectionFraction(a, b, c, d) {
  const rx = b[0] - a[0], rz = b[1] - a[1];
  const sx = d[0] - c[0], sz = d[1] - c[1];
  const denominator = cross2(rx, rz, sx, sz);
  if (Math.abs(denominator) < 1e-10) return null;
  const qx = c[0] - a[0], qz = c[1] - a[1];
  const t = cross2(qx, qz, sx, sz) / denominator;
  const u = cross2(qx, qz, rx, rz) / denominator;
  const epsilon = 1e-9;
  if (t < -epsilon || t > 1 + epsilon || u < -epsilon || u > 1 + epsilon) return null;
  return Math.max(0, Math.min(1, t));
}
function cross2(ax, az, bx, bz) { return ax * bz - az * bx; }
function samePlanPoint(a, b) { return Math.hypot(Number(a?.[0]) - Number(b?.[0]), Number(a?.[1]) - Number(b?.[1])) < 1e-9; }
function trackProfilePoints(track) {
  if (track.rideProfile?.samples?.length) return track.rideProfile.samples.filter((sample) => Number.isFinite(sample.x) && Number.isFinite(sample.z));
  return geometryPoints(track.localGeometry).map(([x, z]) => ({ x, z, elevationM: null }));
}
function pointInPolygon(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    const intersect = ((zi > point[1]) !== (zj > point[1])) && (point[0] < (xj - xi) * (point[1] - zi) / ((zj - zi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
function geometryRepresentativePoint(geometry) {
  const points = geometryPoints(geometry);
  if (!points.length) return null;
  return [points.reduce((sum, p) => sum + p[0], 0) / points.length, points.reduce((sum, p) => sum + p[1], 0) / points.length];
}
function geometryPoints(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Point") return finitePoint(geometry.coordinates) ? [[Number(geometry.coordinates[0]), Number(geometry.coordinates[1])]] : [];
  if (geometry.type === "LineString") return (geometry.coordinates || []).filter(finitePoint).map((p) => [Number(p[0]), Number(p[1])]);
  if (geometry.type === "MultiLineString") return (geometry.coordinates || []).flat().filter(finitePoint).map((p) => [Number(p[0]), Number(p[1])]);
  if (geometry.type === "Polygon") return (geometry.coordinates?.[0] || []).filter(finitePoint).map((p) => [Number(p[0]), Number(p[1])]);
  if (geometry.type === "MultiPolygon") return (geometry.coordinates?.[0]?.[0] || []).filter(finitePoint).map((p) => [Number(p[0]), Number(p[1])]);
  return [];
}
function polygonOuterRing(geometry) { return /Polygon/.test(geometry?.type || "") ? geometryPoints(geometry) : []; }
function distanceToGeometry(point, geometry) {
  const points = geometryPoints(geometry);
  if (!points.length) return Infinity;
  if (points.length === 1) return Math.hypot(point[0] - points[0][0], point[1] - points[0][1]);
  let best = Infinity;
  for (let i = 1; i < points.length; i += 1) best = Math.min(best, distancePointToSegment(point, points[i - 1], points[i]));
  return best;
}
function distancePointToSegment(p, a, b) {
  const vx = b[0] - a[0], vz = b[1] - a[1], wx = p[0] - a[0], wz = p[1] - a[1];
  const vv = vx * vx + vz * vz;
  const t = vv > 0 ? Math.max(0, Math.min(1, (wx * vx + wz * vz) / vv)) : 0;
  return Math.hypot(p[0] - (a[0] + vx * t), p[1] - (a[1] + vz * t));
}
function planOrientation(geometry) {
  const points = geometryPoints(geometry);
  if (points.length >= 2) {
    let best = null;
    for (let i = 1; i < points.length; i += 1) {
      const dx = points[i][0] - points[i - 1][0], dz = points[i][1] - points[i - 1][1], length = Math.hypot(dx, dz);
      if (!best || length > best.length) best = { dx, dz, length };
    }
    if (best?.length > 0) return [best.dx / best.length, best.dz / best.length];
  }
  return [1, 0];
}
function deferred(feature, reason, extra = {}) { return { featureId: feature.id, kind: feature.kind, subtype: rideSubtype(feature), reason, sourceRef: feature.source?.sourceRef || null, ...extra }; }
function finitePoint(p) { return Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])); }
function normalizeName(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function normalizeCode(value) { return String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || null; }
function normalize2(v) { const length = Math.hypot(v[0], v[1]) || 1; return [v[0] / length, v[1] / length]; }
function distance3(a, b) { return Math.hypot((b.x || 0) - (a.x || 0), (b.z || 0) - (a.z || 0), (b.dyM || 0) - (a.dyM || 0)); }
function finite(value, fallback) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
function finiteOrNull(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function round(value) { const number = Number(value); return Number.isFinite(number) ? Math.round(number * 1000) / 1000 : null; }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
