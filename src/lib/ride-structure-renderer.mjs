const PHASE_ENCLOSURE_SHELL = 8.1;
const PHASE_ENCLOSURE_ROOF = 8.2;
const PHASE_PORTAL_CLEARANCE = 8.3;
const PHASE_SUPPORTS = 8.5;
const PHASE_ACCESS = 8.6;

/**
 * Renders the evidence-linked 3D ride structure model into an already compiled
 * world. This deliberately happens after immutable terrain compilation so every
 * structural write can be checked against the exact existing phase-1 terrain
 * top. Sound-tunnel portal clearing is allowed only strictly above that top;
 * it therefore cannot excavate, flatten, raise or otherwise alter terrain.
 */
export function renderRideStructures3d({ compilation, rideStructures, map, options = {} } = {}) {
  const result = {
    schemaVersion: 1,
    status: "processed",
    structures: 0,
    supportStructures: 0,
    supportVoxels: 0,
    footingVoxels: 0,
    enclosureStructures: 0,
    enclosureShellVoxels: 0,
    enclosureRoofVoxels: 0,
    portalClearanceVoxels: 0,
    accessStructures: 0,
    accessVoxels: 0,
    skippedBelowTerrainWrites: 0,
    deferred: 0,
    terrainGeometryChanged: false,
    terrainElevationChanged: false
  };
  if (!compilation?.chunks || !Array.isArray(compilation.palette) || !rideStructures?.structures?.length) {
    result.status = "no-ride-structures";
    return result;
  }

  const terrain = buildTerrainTopIndex(compilation);
  const writer = buildCompilationWriter(compilation, terrain, result);
  const trackIndex = new Map((map?.features || []).filter((feature) => feature.kind === "ride_track").map((feature) => [feature.id, feature]));

  for (const structure of rideStructures.structures) {
    let written = 0;
    if (structure.kind === "support") {
      written = renderSupport(structure, writer, terrain, result);
      if (written) result.supportStructures += 1;
    } else if (structure.kind === "enclosure") {
      written = renderEnclosure(structure, writer, terrain, trackIndex.get(structure.rideId), compilation, result);
      if (written) result.enclosureStructures += 1;
    } else if (structure.kind === "access") {
      written = renderAccess(structure, writer, terrain, trackIndex.get(structure.rideId), compilation, result);
      if (written) result.accessStructures += 1;
    }
    if (written) result.structures += 1;
    else result.deferred += 1;
  }

  for (const chunk of compilation.chunks) chunk.o.sort((a, b) => a[0] - b[0]);
  compilation.chunks.sort((a, b) => a.z - b.z || a.x - b.x);
  compilation.stats ||= {};
  compilation.meta ||= {};
  compilation.stats.rideStructure3dStructures = result.structures;
  compilation.stats.rideStructure3dSupportVoxels = result.supportVoxels;
  compilation.stats.rideStructure3dEnclosureVoxels = result.enclosureShellVoxels + result.enclosureRoofVoxels;
  compilation.stats.rideStructure3dPortalClearanceVoxels = result.portalClearanceVoxels;
  compilation.stats.rideStructure3dAccessVoxels = result.accessVoxels;
  compilation.stats.operations = compilation.chunks.reduce((sum, chunk) => sum + chunk.o.length, 0);
  compilation.stats.chunks = compilation.chunks.length;
  compilation.meta.rideStructure3d = {
    schemaVersion: 1,
    structures: result.structures,
    soundTunnels: rideStructures.summary?.soundTunnels || 0,
    tracedSupports: rideStructures.summary?.tracedSupportStructures || 0,
    templateLinkedSupports: rideStructures.summary?.templateLinkedSupports || 0,
    terrainGeometryMutable: false,
    portalClearanceRule: "air writes are rejected at or below existing phase-1 terrain top"
  };
  result.status = result.structures ? "rendered" : "evidence-deferred";
  return result;
}

function renderSupport(structure, writer, terrain, result) {
  const memberBlock = supportBlock(structure.material);
  const footingBlock = "minecraft:smooth_stone";
  const referenceY = supportReferenceTerrainY(structure, terrain);
  if (referenceY == null) return 0;
  let written = 0;

  for (const member of structure.members || []) {
    const from = memberPoint(member.from, referenceY);
    const to = memberPoint(member.to, referenceY);
    if (!from || !to) continue;
    for (const [x, y, z] of line3dCells(from, to)) {
      if (writer.cell(PHASE_SUPPORTS, x, y, z, memberBlock, { aboveTerrainOnly: true })) {
        result.supportVoxels += 1; written += 1;
      }
    }
  }
  for (const footing of structure.footings || []) {
    for (const [x, z] of geometryPlanCells(footing.geometry)) {
      const groundY = terrain.get(key2(x, z));
      if (groundY == null) continue;
      if (writer.cell(PHASE_SUPPORTS, x, groundY + 1, z, footingBlock, { aboveTerrainOnly: true })) {
        result.footingVoxels += 1; written += 1;
      }
    }
  }
  return written;
}

function renderEnclosure(structure, writer, terrain, track, compilation, result) {
  const ring = polygonRing(structure.footprint);
  if (ring.length < 4) return 0;
  const perimeter = polylineCells(ring, true);
  const groundSamples = perimeter.map(([x, z]) => terrain.get(key2(x, z))).filter(Number.isFinite).sort((a, b) => a - b);
  if (!groundSamples.length) return 0;
  const baseY = groundSamples[Math.floor(groundSamples.length / 2)];
  const bottomY = baseY + Math.max(1, Math.round(Number(structure.minHeightM || 0)) + 1);
  const topY = baseY + Math.max(2, Math.round(Number(structure.heightM || 0)));
  if (topY <= bottomY) return 0;
  const wallBlock = enclosureBlock(structure.wallMaterial);
  const roofBlock = enclosureBlock(structure.roofMaterial);
  let written = 0;

  for (const [x, z] of perimeter) {
    for (let y = bottomY; y <= topY; y += 1) {
      if (writer.cell(PHASE_ENCLOSURE_SHELL, x, y, z, wallBlock, { aboveTerrainOnly: true })) {
        result.enclosureShellVoxels += 1; written += 1;
      }
    }
  }
  for (const [x, z] of polygonCells(ring)) {
    if (writer.cell(PHASE_ENCLOSURE_ROOF, x, topY, z, roofBlock, { aboveTerrainOnly: true })) {
      result.enclosureRoofVoxels += 1; written += 1;
    }
  }

  // A sound/themed enclosure is a built shell. Its portals clear only blocks
  // above the terrain top; unlike the ride-profile terrain tunnel compiler this
  // path never excavates ground.
  for (const portal of structure.portals || []) {
    const trackY = portalTrackY(portal, track, compilation);
    if (trackY == null) continue;
    const direction = normalize2(portal.direction || [1, 0]);
    const right = [-direction[1], direction[0]];
    const halfWidth = Math.max(1, Math.ceil(Number(portal.clearanceWidthM || 3) / 2));
    const below = Math.max(0, Math.ceil(Number(portal.clearanceBelowTrackM || 1)));
    const above = Math.max(2, Math.ceil(Number(portal.clearanceAboveTrackM || 3)));
    for (let along = -2; along <= 2; along += 1) {
      for (let across = -halfWidth; across <= halfWidth; across += 1) {
        const x = Math.round(portal.x + direction[0] * along + right[0] * across);
        const z = Math.round(portal.z + direction[1] * along + right[1] * across);
        const terrainY = terrain.get(key2(x, z));
        for (let y = trackY - below; y <= trackY + above; y += 1) {
          if (terrainY == null || y <= terrainY) { result.skippedBelowTerrainWrites += 1; continue; }
          if (writer.cell(PHASE_PORTAL_CLEARANCE, x, y, z, "minecraft:air", { aboveTerrainOnly: true })) {
            result.portalClearanceVoxels += 1; written += 1;
          }
        }
      }
    }
  }
  return written;
}

function renderAccess(structure, writer, terrain, track, compilation, result) {
  if (!track) return 0;
  const samples = structure.samples || [];
  if (samples.length < 2) return 0;
  let written = 0;
  const block = accessBlock(structure.material, structure.subtype);
  for (let i = 1; i < samples.length; i += 1) {
    const a = accessWorldPoint(samples[i - 1], track, compilation);
    const b = accessWorldPoint(samples[i], track, compilation);
    if (!a || !b) continue;
    for (const [x, y, z] of line3dCells(a, b)) {
      if (writer.cell(PHASE_ACCESS, x, y, z, block, { aboveTerrainOnly: true })) {
        result.accessVoxels += 1; written += 1;
      }
      if (structure.subtype === "ride_catwalk") {
        // One simple outer safety rail is emitted only where the observed
        // catwalk exists; no route-wide catwalk is inferred.
        const railY = y + 1;
        if (writer.cell(PHASE_ACCESS, x, railY, z, "minecraft:iron_bars", { aboveTerrainOnly: true })) {
          result.accessVoxels += 1; written += 1;
        }
      }
    }
  }
  return written;
}

function buildTerrainTopIndex(compilation) {
  const terrain = new Map();
  for (const chunk of compilation.chunks || []) {
    for (const op of chunk.o || []) {
      if (Number(op[0]) !== 1) continue;
      const [x1, y1, z1, x2, y2, z2] = op.slice(1, 7).map(Number);
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x += 1) {
        for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z += 1) {
          const y = Math.max(y1, y2);
          const key = key2(x, z);
          if (!terrain.has(key) || terrain.get(key) < y) terrain.set(key, y);
        }
      }
    }
  }
  return terrain;
}

function buildCompilationWriter(compilation, terrain, result) {
  const paletteIndex = new Map(compilation.palette.map((block, index) => [block, index]));
  const chunks = new Map(compilation.chunks.map((chunk) => [`${chunk.x},${chunk.z}`, chunk]));
  const bounds = compilation.meta?.bounds || null;
  const blockIndex = (block) => {
    if (paletteIndex.has(block)) return paletteIndex.get(block);
    const index = compilation.palette.length;
    compilation.palette.push(block); paletteIndex.set(block, index); return index;
  };
  const cell = (phase, xValue, yValue, zValue, block, rules = {}) => {
    const x = Math.round(Number(xValue)), y = Math.round(Number(yValue)), z = Math.round(Number(zValue));
    if (![x, y, z].every(Number.isFinite)) return false;
    if (bounds && (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ)) return false;
    const terrainY = terrain.get(key2(x, z));
    if (rules.aboveTerrainOnly && (terrainY == null || y <= terrainY)) {
      result.skippedBelowTerrainWrites += 1;
      return false;
    }
    const cx = floorDiv(x, 16), cz = floorDiv(z, 16), key = `${cx},${cz}`;
    if (!chunks.has(key)) {
      const chunk = { x: cx, z: cz, o: [] };
      chunks.set(key, chunk); compilation.chunks.push(chunk);
    }
    const index = blockIndex(block);
    chunks.get(key).o.push([phase, x, y, z, x, y, z, index]);
    return true;
  };
  return { cell };
}

function supportReferenceTerrainY(structure, terrain) {
  const points = [];
  for (const member of structure.members || []) {
    if (member.from) points.push([member.from.x, member.from.z]);
    if (member.to) points.push([member.to.x, member.to.z]);
  }
  for (const footing of structure.footings || []) points.push(...geometryPlanCells(footing.geometry));
  const values = points.map(([x, z]) => terrain.get(key2(Math.round(x), Math.round(z)))).filter(Number.isFinite).sort((a, b) => a - b);
  return values.length ? values[Math.floor(values.length / 2)] : null;
}
function memberPoint(value, referenceY) {
  if (!value || !Number.isFinite(Number(value.x)) || !Number.isFinite(Number(value.z))) return null;
  return [Math.round(value.x), Math.round(referenceY + Number(value.dyM || 0) + 1), Math.round(value.z)];
}
function portalTrackY(portal, track, compilation) {
  const datum = Number(compilation.meta?.elevationDatumM || 0);
  if (Number.isFinite(Number(portal.elevationM))) return Math.round(Number(portal.elevationM) - datum);
  const nearest = nearestTrackSample(track, portal.x, portal.z);
  return nearest && Number.isFinite(Number(nearest.elevationM)) ? Math.round(Number(nearest.elevationM) - datum) : null;
}
function accessWorldPoint(sample, track, compilation) {
  const nearest = nearestTrackSample(track, sample.x, sample.z);
  if (!nearest || !Number.isFinite(Number(nearest.elevationM))) return null;
  const datum = Number(compilation.meta?.elevationDatumM || 0);
  return [Math.round(sample.x), Math.round(Number(nearest.elevationM) - datum + Number(sample.dyFromTrackM || 0)), Math.round(sample.z)];
}
function nearestTrackSample(track, x, z) {
  const samples = track?.rideProfile?.samples || [];
  let best = null;
  for (const sample of samples) {
    if (!Number.isFinite(Number(sample.x)) || !Number.isFinite(Number(sample.z))) continue;
    const distance = Math.hypot(Number(sample.x) - Number(x), Number(sample.z) - Number(z));
    if (!best || distance < best.distance) best = { ...sample, distance };
  }
  return best;
}

function line3dCells(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz), 1);
  const result = [], seen = new Set();
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const point = [Math.round(a[0] + dx * t), Math.round(a[1] + dy * t), Math.round(a[2] + dz * t)];
    const key = point.join(",");
    if (!seen.has(key)) { seen.add(key); result.push(point); }
  }
  return result;
}
function polylineCells(points, close = false) {
  const result = [], seen = new Set();
  const segments = [];
  for (let i = 1; i < points.length; i += 1) segments.push([points[i - 1], points[i]]);
  if (close && points.length > 2) segments.push([points[points.length - 1], points[0]]);
  for (const [a, b] of segments) {
    const dx = b[0] - a[0], dz = b[1] - a[1], steps = Math.max(Math.abs(Math.round(dx)), Math.abs(Math.round(dz)), 1);
    for (let i = 0; i <= steps; i += 1) {
      const x = Math.round(a[0] + dx * i / steps), z = Math.round(a[1] + dz * i / steps), key = key2(x, z);
      if (!seen.has(key)) { seen.add(key); result.push([x, z]); }
    }
  }
  return result;
}
function polygonCells(ring) {
  const xs = ring.map((p) => p[0]), zs = ring.map((p) => p[1]);
  const minX = Math.floor(Math.min(...xs)), maxX = Math.ceil(Math.max(...xs)), minZ = Math.floor(Math.min(...zs)), maxZ = Math.ceil(Math.max(...zs));
  const result = [];
  for (let z = minZ; z <= maxZ; z += 1) for (let x = minX; x <= maxX; x += 1) if (pointInPolygon([x + 0.5, z + 0.5], ring)) result.push([x, z]);
  return result;
}
function geometryPlanCells(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Point") return [[Math.round(geometry.coordinates[0]), Math.round(geometry.coordinates[1])]];
  if (geometry.type === "LineString") return polylineCells(geometry.coordinates || []);
  if (geometry.type === "Polygon") return polygonCells(geometry.coordinates?.[0] || []);
  return [];
}
function polygonRing(geometry) { return geometry?.type === "Polygon" ? (geometry.coordinates?.[0] || []) : geometry?.type === "MultiPolygon" ? (geometry.coordinates?.[0]?.[0] || []) : []; }
function pointInPolygon(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > point[1]) !== (zj > point[1])) && point[0] < (xj - xi) * (point[1] - zi) / ((zj - zi) || 1e-12) + xi) inside = !inside;
  }
  return inside;
}
function supportBlock(material) {
  if (material === "timber") return "minecraft:stripped_spruce_log";
  if (material === "concrete") return "minecraft:light_gray_concrete";
  if (material === "stone") return "minecraft:stone_bricks";
  return "minecraft:iron_bars";
}
function enclosureBlock(material) {
  if (material === "timber") return "minecraft:dark_oak_planks";
  if (material === "brick") return "minecraft:brick_block";
  if (material === "stone") return "minecraft:stone_bricks";
  if (material === "concrete") return "minecraft:light_gray_concrete";
  if (material === "steel") return "minecraft:iron_block";
  return "minecraft:gray_concrete";
}
function accessBlock(material, subtype) {
  if (material === "timber") return "minecraft:spruce_planks";
  if (subtype === "ride_access_detail") return "minecraft:iron_bars";
  return "minecraft:iron_trapdoor";
}
function normalize2(v) { const x = Number(v?.[0] || 0), z = Number(v?.[1] || 0), length = Math.hypot(x, z) || 1; return [x / length, z / length]; }
function key2(x, z) { return `${Math.round(x)},${Math.round(z)}`; }
function floorDiv(value, divisor) { return Math.floor(Number(value) / divisor); }
