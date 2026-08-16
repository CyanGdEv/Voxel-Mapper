const DEFAULT_MAX_HEIGHT = 80;
const DEFAULT_MAX_CROWN_DIAMETER = 60;

/**
 * Deterministic, renderer-neutral tree geometry.
 *
 * Measured height and crown spread are treated as hard envelopes. The generator
 * changes only the internal voxel arrangement: tapered/leaning trunks, root
 * flare, connected primary/secondary branches and clustered foliage. It never
 * emits terrain or air writes.
 */
export function buildNaturalTreeGeometry(options = {}) {
  const heightBlocks = clamp(Math.round(Number(options.heightM)), 2, options.maxHeightBlocks ?? DEFAULT_MAX_HEIGHT);
  const crownDiameterBlocks = clamp(
    Math.round(Number(options.crownDiameterM ?? inferredCrownDiameter(heightBlocks, options))),
    1,
    options.maxCrownDiameterBlocks ?? DEFAULT_MAX_CROWN_DIAMETER
  );
  if (!Number.isFinite(heightBlocks) || !Number.isFinite(crownDiameterBlocks)) {
    return emptyGeometry("invalid-tree-dimensions");
  }

  const x = Math.round(Number(options.x || 0));
  const z = Math.round(Number(options.z || 0));
  const groundY = Math.round(Number(options.groundY || 0));
  const seed = Number(options.seed || 0) | 0;
  const archetype = classifyTreeArchetype(options.species, options.leafType);
  const palette = normalizeLeafPalette(options.leafPalette, archetype);
  const logBlock = options.logBlock || defaultLogBlock(archetype);
  const crownRadius = Math.max(0.5, crownDiameterBlocks / 2);
  const topY = groundY + heightBlocks;
  const terrainYAt = typeof options.terrainYAt === "function" ? options.terrainYAt : null;

  const wood = new Map();
  const leaves = new Map();
  const stats = {
    trunkVoxels: 0,
    branchVoxels: 0,
    rootVoxels: 0,
    leafVoxels: 0,
    foliageClusters: 0,
    primaryBranches: 0,
    secondaryBranches: 0,
    rootArms: 0
  };

  const trunk = buildTrunk({
    x, z, groundY, topY, heightBlocks, crownRadius,
    trunkDiameterM: options.trunkDiameterM,
    archetype, seed, logBlock, wood
  });
  stats.trunkVoxels = wood.size;

  const rootBefore = wood.size;
  buildRoots({
    x, z, groundY, crownRadius, trunkBaseRadius: trunk.baseRadius,
    archetype, seed, logBlock, wood, terrainYAt
  });
  stats.rootVoxels = wood.size - rootBefore;
  stats.rootArms = rootArmCount(heightBlocks, archetype);

  if (archetype === "conifer-tiered") {
    buildConiferCrown({
      x, z, groundY, topY, heightBlocks, crownRadius, seed,
      logBlock, palette, wood, leaves, stats
    });
  } else {
    buildBroadleafCrown({
      x, z, groundY, topY, heightBlocks, crownRadius, archetype, seed,
      trunk, logBlock, palette, wood, leaves, stats
    });
  }

  // Wood must remain visible through the canopy and keeps the branch graph
  // connected. Removing leaf/wood overlap also makes the output independent of
  // renderer operation ordering.
  for (const key of wood.keys()) leaves.delete(key);
  stats.leafVoxels = leaves.size;
  stats.branchVoxels = Math.max(0, wood.size - stats.trunkVoxels - stats.rootVoxels);

  const woodVoxels = sortedVoxels(wood);
  const leafVoxels = sortedVoxels(leaves);
  const bounds = geometryBounds([...woodVoxels, ...leafVoxels]);

  return {
    schemaVersion: 1,
    status: woodVoxels.length ? "generated" : "empty",
    shapeModel: "deterministic-natural-tree-v1",
    archetype,
    dimensions: {
      heightBlocks,
      crownDiameterBlocks,
      measuredHeightM: finiteOrNull(options.heightM),
      measuredCrownDiameterM: finiteOrNull(options.crownDiameterM),
      measuredTrunkDiameterM: finiteOrNull(options.trunkDiameterM)
    },
    envelope: {
      anchor: { x, y: groundY, z },
      topY,
      crownRadiusBlocks: crownRadius,
      maxHorizontalDistanceFromAnchor: crownRadius,
      hardHeightLimit: true,
      hardCrownLimit: true
    },
    bounds,
    woodVoxels,
    leafVoxels,
    stats
  };
}

export function classifyTreeArchetype(species, leafType) {
  const text = `${species || ""} ${leafType || ""}`.toLowerCase();
  if (/needle|conifer|pine|spruce|fir|cedar|yew|larch|redwood|sequoia/.test(text)) return "conifer-tiered";
  if (/birch|silver birch|betula|alder/.test(text)) return "birch-upright";
  if (/acacia|mimosa/.test(text)) return "acacia-spreading";
  if (/poplar|lombardy|aspen/.test(text)) return "broadleaf-upright";
  if (/cherry|prunus|blossom/.test(text)) return "cherry-rounded";
  return "broadleaf-spreading";
}

function buildTrunk(context) {
  const {
    x, z, groundY, topY, heightBlocks, crownRadius, trunkDiameterM,
    archetype, seed, logBlock, wood
  } = context;
  const conifer = archetype === "conifer-tiered";
  const trunkTopRelative = conifer
    ? heightBlocks
    : archetype === "acacia-spreading"
      ? Math.max(3, Math.round(heightBlocks * 0.58))
      : archetype === "birch-upright" || archetype === "broadleaf-upright"
        ? Math.max(3, Math.round(heightBlocks * 0.78))
        : Math.max(3, Math.round(heightBlocks * 0.68));
  const baseRadius = trunkRadiusFromEvidence(heightBlocks, trunkDiameterM);
  const leanBudget = Math.max(0, Math.min(2, Math.floor(crownRadius * 0.22)));
  let previous = [x, groundY + 1, z];
  for (let relativeY = 1; relativeY <= trunkTopRelative; relativeY += 1) {
    const fraction = relativeY / Math.max(1, trunkTopRelative);
    const swayX = leanBudget ? Math.round(
      Math.sin(fraction * Math.PI * 1.15 + unit(seed, 11) * Math.PI * 2) * leanBudget * fraction * 0.72
    ) : 0;
    const swayZ = leanBudget ? Math.round(
      Math.sin(fraction * Math.PI * 1.35 + unit(seed, 17) * Math.PI * 2) * leanBudget * fraction * 0.62
    ) : 0;
    const point = [x + swayX, Math.min(topY, groundY + relativeY), z + swayZ];
    const radius = Math.max(0, Math.round(baseRadius * (1 - fraction * 0.72)));
    for (const sample of line3d(previous, point)) stampWoodDisk(wood, sample, radius, logBlock, context);
    previous = point;
  }
  return { top: previous, topRelative: trunkTopRelative, baseRadius };
}

function buildRoots(context) {
  const { x, z, groundY, crownRadius, trunkBaseRadius, archetype, seed, logBlock, wood, terrainYAt } = context;
  const count = rootArmCount(Math.max(2, Math.round(crownRadius * 2.5)), archetype);
  const maxLength = Math.max(1, Math.min(4, Math.round(crownRadius * 0.42 + trunkBaseRadius)));
  const phase = unit(seed, 101) * Math.PI * 2;
  for (let index = 0; index < count; index += 1) {
    const angle = phase + (Math.PI * 2 * index / count) + (unit(seed, 110 + index) - 0.5) * 0.42;
    const length = Math.max(1, Math.round(maxLength * (0.68 + unit(seed, 130 + index) * 0.32)));
    let prior = [x, localRootY(x, z, groundY, terrainYAt), z];
    for (let step = 1; step <= length; step += 1) {
      const fraction = step / length;
      const rx = x + Math.round(Math.cos(angle) * step);
      const rz = z + Math.round(Math.sin(angle) * step);
      const ry = localRootY(rx, rz, groundY, terrainYAt);
      const point = [rx, ry, rz];
      for (const sample of line3d(prior, point)) {
        if (distance2d(sample[0], sample[2], x, z) <= crownRadius + 0.001) setVoxel(wood, sample[0], sample[1], sample[2], logBlock, "root");
      }
      prior = point;
      if (fraction > 0.65 && unit(seed, 170 + index * 13 + step) < 0.35) break;
    }
  }
}

function buildBroadleafCrown(context) {
  const {
    x, z, groundY, topY, heightBlocks, crownRadius, archetype, seed,
    trunk, logBlock, palette, wood, leaves, stats
  } = context;
  const branchBaseFraction = archetype === "acacia-spreading" ? 0.42
    : archetype === "birch-upright" || archetype === "broadleaf-upright" ? 0.55 : 0.46;
  const branchBaseY = groundY + Math.max(2, Math.round(heightBlocks * branchBaseFraction));
  const primaryCount = clamp(
    Math.round(4 + crownRadius * 0.55 + unit(seed, 201) * 2),
    archetype === "birch-upright" ? 4 : 5,
    archetype === "broadleaf-upright" ? 7 : 10
  );
  stats.primaryBranches = primaryCount;
  const phase = unit(seed, 211) * Math.PI * 2;
  const endpoints = [];

  for (let index = 0; index < primaryCount; index += 1) {
    const angle = phase + Math.PI * 2 * index / primaryCount + (unit(seed, 230 + index) - 0.5) * 0.55;
    const startFraction = clamp(0.46 + unit(seed, 250 + index) * 0.28, 0.4, 0.78);
    const startY = Math.max(branchBaseY, Math.min(trunk.top[1], groundY + Math.round(heightBlocks * startFraction)));
    const trunkAt = nearestWoodAtY(wood, x, z, startY) || [x, startY, z];
    const radialFactor = archetype === "broadleaf-upright" || archetype === "birch-upright"
      ? 0.45 + unit(seed, 270 + index) * 0.35
      : archetype === "acacia-spreading"
        ? 0.72 + unit(seed, 270 + index) * 0.25
        : 0.58 + unit(seed, 270 + index) * 0.38;
    const length = Math.max(2, crownRadius * radialFactor);
    const endX = x + Math.round(Math.cos(angle) * length);
    const endZ = z + Math.round(Math.sin(angle) * length);
    const rise = archetype === "acacia-spreading"
      ? Math.round((unit(seed, 290 + index) - 0.35) * Math.max(2, heightBlocks * 0.12))
      : Math.round((0.08 + unit(seed, 290 + index) * 0.22) * heightBlocks);
    const endY = clamp(startY + rise, branchBaseY, topY - (archetype === "birch-upright" ? 0 : 1));
    const endpoint = clampToCrown([endX, endY, endZ], x, z, crownRadius, topY, groundY);
    const midpoint = clampToCrown([
      Math.round((trunkAt[0] + endpoint[0]) / 2 + (unit(seed, 310 + index) - 0.5) * 2),
      Math.round((trunkAt[1] + endpoint[1]) / 2 + unit(seed, 330 + index) * 2),
      Math.round((trunkAt[2] + endpoint[2]) / 2 + (unit(seed, 350 + index) - 0.5) * 2)
    ], x, z, crownRadius, topY, groundY);
    emitBranch(wood, [trunkAt, midpoint, endpoint], logBlock, context, index < 3 ? 1 : 0);
    endpoints.push(endpoint);

    if (heightBlocks >= 9 && crownRadius >= 3 && unit(seed, 370 + index) > 0.28) {
      const forkAngle = angle + (unit(seed, 390 + index) > 0.5 ? 1 : -1) * (0.45 + unit(seed, 410 + index) * 0.42);
      const forkLength = Math.max(1.5, length * (0.32 + unit(seed, 430 + index) * 0.22));
      const fork = clampToCrown([
        endpoint[0] + Math.round(Math.cos(forkAngle) * forkLength),
        clamp(endpoint[1] + Math.round((unit(seed, 450 + index) - 0.2) * 3), branchBaseY, topY),
        endpoint[2] + Math.round(Math.sin(forkAngle) * forkLength)
      ], x, z, crownRadius, topY, groundY);
      emitBranch(wood, [endpoint, fork], logBlock, context, 0);
      endpoints.push(fork);
      stats.secondaryBranches += 1;
    }
  }

  // Add a few interior/top clusters so branches remain visible between lobes
  // instead of disappearing inside one solid ellipsoid.
  endpoints.push(clampToCrown([trunk.top[0], Math.min(topY, trunk.top[1] + 1), trunk.top[2]], x, z, crownRadius, topY, groundY));
  const targetClusters = clamp(
    Math.round(5 + crownRadius * 0.72),
    archetype === "birch-upright" ? 5 : 6,
    14
  );
  const clusters = sampleClusterAnchors(endpoints, targetClusters, seed);
  for (let index = 0; index < clusters.length; index += 1) {
    const center = clusters[index];
    const radial = distance2d(center[0], center[2], x, z) / Math.max(0.5, crownRadius);
    const baseRadius = Math.max(1.15, Math.min(3.6, 1.25 + crownRadius * 0.16 + unit(seed, 510 + index) * 1.1));
    const radiusX = archetype === "acacia-spreading" ? baseRadius * 1.25 : baseRadius;
    const radiusZ = archetype === "acacia-spreading" ? baseRadius * 1.15 : baseRadius * (0.88 + unit(seed, 530 + index) * 0.22);
    const radiusY = archetype === "birch-upright" || archetype === "broadleaf-upright"
      ? baseRadius * 1.18
      : archetype === "acacia-spreading" ? baseRadius * 0.62 : baseRadius * 0.82;
    stampFoliageCluster({
      leaves, wood, center, radiusX, radiusY, radiusZ, palette,
      x, z, crownRadius, groundY, topY, seed: mixSeed(seed, 550 + index),
      edgeDensity: clamp(0.68 - radial * 0.08, 0.52, 0.72)
    });
    stats.foliageClusters += 1;
  }
}

function buildConiferCrown(context) {
  const {
    x, z, groundY, topY, heightBlocks, crownRadius, seed,
    logBlock, palette, wood, leaves, stats
  } = context;
  const baseY = groundY + Math.max(2, Math.round(heightBlocks * 0.22));
  const usable = Math.max(2, topY - baseY);
  const tiers = clamp(Math.round(usable / 2.5), 4, 12);
  const phase = unit(seed, 601) * Math.PI * 2;
  for (let tier = 0; tier < tiers; tier += 1) {
    const fraction = tier / Math.max(1, tiers - 1);
    const y = baseY + Math.round(fraction * usable * 0.88);
    const tierRadius = Math.max(1, crownRadius * (0.95 - fraction * 0.68) * (0.82 + unit(seed, 620 + tier) * 0.22));
    const rays = 3 + (tier % 2) + (unit(seed, 640 + tier) > 0.58 ? 1 : 0);
    for (let ray = 0; ray < rays; ray += 1) {
      const angle = phase + tier * 0.72 + Math.PI * 2 * ray / rays + (unit(seed, 660 + tier * 7 + ray) - 0.5) * 0.34;
      const endpoint = clampToCrown([
        x + Math.round(Math.cos(angle) * tierRadius),
        clamp(y - (tier < tiers * 0.55 ? 1 : 0), groundY + 1, topY - 1),
        z + Math.round(Math.sin(angle) * tierRadius)
      ], x, z, crownRadius, topY, groundY);
      const start = nearestWoodAtY(wood, x, z, y) || [x, y, z];
      emitBranch(wood, [start, endpoint], logBlock, context, tier < 2 && crownRadius >= 4 ? 1 : 0);
      stats.primaryBranches += 1;
      const samples = line3d(start, endpoint);
      for (let sampleIndex = 1; sampleIndex < samples.length; sampleIndex += Math.max(1, Math.floor(samples.length / 2))) {
        const center = samples[sampleIndex];
        const clusterRadius = Math.max(0.9, Math.min(2.2, 0.8 + tierRadius * 0.18));
        stampFoliageCluster({
          leaves, wood, center,
          radiusX: clusterRadius * 1.15,
          radiusY: clusterRadius * 0.82,
          radiusZ: clusterRadius * 1.15,
          palette, x, z, crownRadius, groundY, topY,
          seed: mixSeed(seed, 690 + tier * 31 + ray * 5 + sampleIndex),
          edgeDensity: 0.64
        });
        stats.foliageClusters += 1;
      }
    }
  }
  // Compact leader tip prevents the default Minecraft cone while preserving a
  // recognizable conifer silhouette.
  for (let dy = 0; dy <= Math.min(3, heightBlocks - 1); dy += 1) {
    const center = [x, topY - dy, z];
    stampFoliageCluster({
      leaves, wood, center,
      radiusX: Math.max(0.75, 1.6 - dy * 0.18),
      radiusY: 1,
      radiusZ: Math.max(0.75, 1.6 - dy * 0.18),
      palette, x, z, crownRadius, groundY, topY,
      seed: mixSeed(seed, 760 + dy), edgeDensity: 0.72
    });
    stats.foliageClusters += 1;
  }
}

function emitBranch(wood, points, block, envelope, proximalRadius = 0) {
  for (let index = 1; index < points.length; index += 1) {
    const segment = line3d(points[index - 1], points[index]);
    for (let sample = 0; sample < segment.length; sample += 1) {
      const point = segment[sample];
      if (!insideEnvelope(point, envelope)) continue;
      const radius = proximalRadius && index === 1 && sample < Math.ceil(segment.length * 0.32) ? proximalRadius : 0;
      stampWoodDisk(wood, point, radius, block, envelope);
    }
  }
}

function stampWoodDisk(target, [cx, cy, cz], radius, block, envelope) {
  for (let dz = -radius; dz <= radius; dz += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx * dx + dz * dz > (radius + 0.25) ** 2) continue;
      const point = [cx + dx, cy, cz + dz];
      if (insideEnvelope(point, envelope)) setVoxel(target, point[0], point[1], point[2], block, "wood");
    }
  }
}

function stampFoliageCluster(context) {
  const {
    leaves, wood, center, radiusX, radiusY, radiusZ, palette,
    x, z, crownRadius, groundY, topY, seed, edgeDensity
  } = context;
  const minX = Math.floor(center[0] - radiusX), maxX = Math.ceil(center[0] + radiusX);
  const minY = Math.max(groundY + 2, Math.floor(center[1] - radiusY));
  const maxY = Math.min(topY, Math.ceil(center[1] + radiusY));
  const minZ = Math.floor(center[2] - radiusZ), maxZ = Math.ceil(center[2] + radiusZ);
  for (let yy = minY; yy <= maxY; yy += 1) {
    for (let zz = minZ; zz <= maxZ; zz += 1) {
      for (let xx = minX; xx <= maxX; xx += 1) {
        if (distance2d(xx, zz, x, z) > crownRadius + 0.001) continue;
        const nx = (xx - center[0]) / Math.max(0.5, radiusX);
        const ny = (yy - center[1]) / Math.max(0.5, radiusY);
        const nz = (zz - center[2]) / Math.max(0.5, radiusZ);
        const distance = nx * nx + ny * ny + nz * nz;
        if (distance > 1.08) continue;
        const key = voxelKey(xx, yy, zz);
        if (wood.has(key)) continue;
        const density = distance < 0.48 ? 0.93 : distance < 0.78 ? 0.82 : edgeDensity;
        const roll = voxelUnit(xx, yy, zz, seed);
        if (roll > density) continue;
        const block = palette[hash3d(xx, yy, zz, seed) % palette.length];
        setVoxel(leaves, xx, yy, zz, block, "leaf");
      }
    }
  }
}

function insideEnvelope([px, py, pz], context) {
  if (py <= context.groundY || py > context.topY) return false;
  return distance2d(px, pz, context.x, context.z) <= context.crownRadius + 0.001;
}

function clampToCrown(point, x, z, radius, topY, groundY) {
  let [px, py, pz] = point;
  const dx = px - x, dz = pz - z;
  const distance = Math.hypot(dx, dz);
  if (distance > radius && distance > 0) {
    const scale = radius / distance;
    px = x + Math.round(dx * scale);
    pz = z + Math.round(dz * scale);
  }
  return [px, clamp(Math.round(py), groundY + 1, topY), pz];
}

function nearestWoodAtY(wood, fallbackX, fallbackZ, y) {
  let best = null;
  for (const voxel of wood.values()) {
    if (voxel.y !== y || voxel.role === "root") continue;
    const distance = Math.hypot(voxel.x - fallbackX, voxel.z - fallbackZ);
    if (!best || distance < best.distance) best = { point: [voxel.x, voxel.y, voxel.z], distance };
  }
  return best?.point || null;
}

function sampleClusterAnchors(values, target, seed) {
  if (!values.length) return [];
  const unique = [];
  const seen = new Set();
  for (const value of values) {
    const key = value.join(",");
    if (!seen.has(key)) { seen.add(key); unique.push(value); }
  }
  if (unique.length <= target) return unique;
  return unique
    .map((value, index) => ({ value, score: unit(seed, 800 + index) }))
    .sort((a, b) => a.score - b.score)
    .slice(0, target)
    .map((entry) => entry.value);
}

function localRootY(x, z, anchorGroundY, terrainYAt) {
  const sampled = Number(terrainYAt?.(x, z));
  return (Number.isFinite(sampled) ? Math.round(sampled) : anchorGroundY) + 1;
}

function rootArmCount(heightBlocks, archetype) {
  const base = archetype === "conifer-tiered" ? 4 : archetype === "birch-upright" ? 4 : 5;
  return clamp(base + Math.floor(heightBlocks / 16), 4, 7);
}

function trunkRadiusFromEvidence(heightBlocks, trunkDiameterM) {
  if (Number.isFinite(Number(trunkDiameterM)) && Number(trunkDiameterM) > 0) {
    return clamp(Math.floor(Number(trunkDiameterM) / 2), 0, 3);
  }
  if (heightBlocks >= 26) return 2;
  if (heightBlocks >= 15) return 1;
  return 0;
}

function inferredCrownDiameter(heightBlocks, options) {
  const archetype = classifyTreeArchetype(options.species, options.leafType);
  if (archetype === "conifer-tiered") return Math.max(3, Math.round(heightBlocks * 0.42));
  if (archetype === "broadleaf-upright" || archetype === "birch-upright") return Math.max(3, Math.round(heightBlocks * 0.46));
  if (archetype === "acacia-spreading") return Math.max(4, Math.round(heightBlocks * 0.72));
  return Math.max(4, Math.round(heightBlocks * 0.58));
}

function defaultLogBlock(archetype) {
  if (archetype === "conifer-tiered") return "minecraft:spruce_log";
  if (archetype === "birch-upright") return "minecraft:birch_log";
  if (archetype === "acacia-spreading") return "minecraft:acacia_log";
  if (archetype === "cherry-rounded") return "minecraft:cherry_log";
  return "minecraft:oak_log";
}

function normalizeLeafPalette(values, archetype) {
  const palette = [...new Set((values || []).filter((value) => typeof value === "string" && value.startsWith("minecraft:")))];
  if (palette.length) return palette;
  if (archetype === "conifer-tiered") return ["minecraft:spruce_leaves", "minecraft:dark_oak_leaves"];
  if (archetype === "birch-upright") return ["minecraft:birch_leaves", "minecraft:oak_leaves"];
  if (archetype === "acacia-spreading") return ["minecraft:acacia_leaves", "minecraft:oak_leaves"];
  if (archetype === "cherry-rounded") return ["minecraft:cherry_leaves"];
  return ["minecraft:oak_leaves", "minecraft:birch_leaves"];
}

function setVoxel(target, x, y, z, block, role) {
  const key = voxelKey(x, y, z);
  if (!target.has(key)) target.set(key, { x, y, z, block, role });
}

function sortedVoxels(map) {
  return [...map.values()].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x || String(a.block).localeCompare(String(b.block)));
}

function geometryBounds(values) {
  if (!values.length) return null;
  return {
    minX: Math.min(...values.map((value) => value.x)),
    minY: Math.min(...values.map((value) => value.y)),
    minZ: Math.min(...values.map((value) => value.z)),
    maxX: Math.max(...values.map((value) => value.x)),
    maxY: Math.max(...values.map((value) => value.y)),
    maxZ: Math.max(...values.map((value) => value.z))
  };
}

function line3d(from, to) {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz))));
  const result = [];
  let prior = null;
  for (let index = 0; index <= steps; index += 1) {
    const fraction = index / steps;
    const point = [
      Math.round(from[0] + dx * fraction),
      Math.round(from[1] + dy * fraction),
      Math.round(from[2] + dz * fraction)
    ];
    const key = point.join(",");
    if (key !== prior) result.push(point);
    prior = key;
  }
  return result;
}

function distance2d(x1, z1, x2, z2) {
  return Math.hypot(x1 - x2, z1 - z2);
}

function voxelKey(x, y, z) { return `${x},${y},${z}`; }
function finiteOrNull(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
function mixSeed(seed, salt) { return (Math.imul(seed | 0, 1664525) + Math.imul(salt | 0, 1013904223)) | 0; }
function unit(seed, salt) { return (hash3d(salt, seed, salt * 17, seed ^ 0x6d2b79f5) >>> 0) / 4294967295; }
function voxelUnit(x, y, z, seed) { return (hash3d(x, y, z, seed) >>> 0) / 4294967295; }
function hash3d(x, y, z, seed) {
  let value = (Math.imul(Math.round(x), 374761393) ^ Math.imul(Math.round(y), 2246822519) ^
    Math.imul(Math.round(z), 668265263) ^ Math.imul(seed | 0, 3266489917)) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 1274126177) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}

function emptyGeometry(status) {
  return {
    schemaVersion: 1,
    status,
    shapeModel: "deterministic-natural-tree-v1",
    archetype: null,
    dimensions: null,
    envelope: null,
    bounds: null,
    woodVoxels: [],
    leafVoxels: [],
    stats: {
      trunkVoxels: 0, branchVoxels: 0, rootVoxels: 0, leafVoxels: 0,
      foliageClusters: 0, primaryBranches: 0, secondaryBranches: 0, rootArms: 0
    }
  };
}
