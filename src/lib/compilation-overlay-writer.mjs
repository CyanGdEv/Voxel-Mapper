export function buildPhaseOneTerrainTopIndex(compilation) {
  const terrain = new Map();
  for (const chunk of compilation?.chunks || []) {
    for (const operation of chunk.o || []) {
      if (Number(operation?.[0]) !== 1) continue;
      const [x1, y1, z1, x2, y2, z2] = operation.slice(1, 7).map(Number);
      if (![x1, y1, z1, x2, y2, z2].every(Number.isFinite)) continue;
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x += 1) {
        for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z += 1) {
          const y = Math.max(y1, y2);
          const key = terrainCellKey(x, z);
          if (!terrain.has(key) || terrain.get(key) < y) terrain.set(key, y);
        }
      }
    }
  }
  return terrain;
}

/**
 * Creates a post-terrain compilation writer that has no terrain mutation API.
 * Every structural write can be constrained to y > the exact phase-1 terrain
 * top captured before any later overlays are emitted.
 */
export function createAboveTerrainCompilationWriter(compilation, terrain, metrics = {}) {
  const paletteIndex = new Map((compilation?.palette || []).map((block, index) => [block, index]));
  const chunks = new Map((compilation?.chunks || []).map((chunk) => [`${chunk.x},${chunk.z}`, chunk]));
  const bounds = compilation?.meta?.bounds || null;
  metrics.skippedBelowTerrainWrites ||= 0;
  metrics.skippedOutsideBoundsWrites ||= 0;
  metrics.writtenVoxels ||= 0;

  const blockIndex = (block) => {
    if (paletteIndex.has(block)) return paletteIndex.get(block);
    const index = compilation.palette.length;
    compilation.palette.push(block);
    paletteIndex.set(block, index);
    return index;
  };

  const terrainY = (x, z) => terrain.get(terrainCellKey(Math.round(x), Math.round(z))) ?? null;
  const cell = (phase, xValue, yValue, zValue, block, rules = {}) => {
    const x = Math.round(Number(xValue));
    const y = Math.round(Number(yValue));
    const z = Math.round(Number(zValue));
    if (![x, y, z].every(Number.isFinite) || !block) return false;
    if (bounds && (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ)) {
      metrics.skippedOutsideBoundsWrites += 1;
      return false;
    }
    const groundY = terrainY(x, z);
    if (rules.aboveTerrainOnly !== false && (groundY == null || y <= groundY)) {
      metrics.skippedBelowTerrainWrites += 1;
      return false;
    }
    if (rules.allowAir !== true && block === "minecraft:air") return false;

    const cx = floorDiv(x, 16);
    const cz = floorDiv(z, 16);
    const key = `${cx},${cz}`;
    if (!chunks.has(key)) {
      const chunk = { x: cx, z: cz, o: [] };
      chunks.set(key, chunk);
      compilation.chunks.push(chunk);
    }
    const palette = blockIndex(block);
    chunks.get(key).o.push([phase, x, y, z, x, y, z, palette]);
    metrics.writtenVoxels += 1;
    return true;
  };

  const finish = () => {
    for (const chunk of compilation.chunks || []) chunk.o.sort((a, b) => Number(a[0]) - Number(b[0]));
    compilation.chunks.sort((a, b) => a.z - b.z || a.x - b.x);
    compilation.stats ||= {};
    compilation.stats.operations = compilation.chunks.reduce((sum, chunk) => sum + (chunk.o?.length || 0), 0);
    compilation.stats.chunks = compilation.chunks.length;
    return metrics;
  };

  return { cell, terrainY, finish };
}

export function terrainCellKey(x, z) {
  return `${Math.round(x)},${Math.round(z)}`;
}

function floorDiv(value, divisor) {
  return Math.floor(Number(value) / divisor);
}
