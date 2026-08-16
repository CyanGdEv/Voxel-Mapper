import { polygonScanlineSpans } from "./geo.mjs";
import { surfaceMaterialPalette } from "./material-palettes.mjs";

/**
 * Applies verified-current planning surface paint to the finished 1 m terrain
 * compilation. This phase never calculates, interpolates or changes terrain
 * elevation: it finds the already-compiled phase-1 top-surface run and writes a
 * replacement block at that exact Y coordinate.
 *
 * Keeping this after the base raster compiler has two advantages:
 *  - the authoritative DTM/LiDAR elevation raster remains immutable;
 *  - planning palettes may use all weighted blocks, rather than being reduced
 *    to the small base-surface code table.
 */
export function renderPlanningSurfacePaint({ compilation, changeSet, options = {} }) {
  const result = emptySummary();
  const mode = options.planningSurfacePaintMode || "render";
  result.mode = mode;
  if (mode === "off") {
    result.status = "disabled";
    attachSummary(compilation, result);
    return result;
  }

  const candidates = (changeSet?.candidates || []).filter((candidate) =>
    candidate?.planningOperation === "paint" && candidate?.kind === "surface"
  );
  result.candidateFeatures = candidates.length;
  if (!candidates.length) {
    result.status = "no-planning-surface-candidates";
    attachSummary(compilation, result);
    return result;
  }

  const surfaceRows = indexCompiledTopSurface(compilation);
  const paletteIndex = new Map((compilation.palette || []).map((block, index) => [block, index]));
  const chunkMap = new Map((compilation.chunks || []).map((chunk) => [`${chunk.x},${chunk.z}`, chunk]));
  const seed = Number(options.seed || 0) | 0;

  for (const candidate of candidates) {
    const material = String(candidate.compiledMaterial || candidate.tags?.surface || candidate.tags?.material || "").trim();
    const palette = surfaceMaterialPalette(material);
    const sourceRef = candidateRef(candidate);
    if (!palette) {
      result.deferredFeatures += 1;
      result.changes.push({
        sourceRef,
        material: material || null,
        status: "deferred-unsupported-surface-material",
        reason: "material-is-not-a-safe-built-in-ground-surface-palette"
      });
      continue;
    }
    if (!isAreaGeometry(candidate.localGeometry)) {
      result.rejectedFeatures += 1;
      result.changes.push({
        sourceRef,
        material: palette.key,
        status: "rejected",
        reason: "planning-surface-renderer-requires-area-geometry"
      });
      continue;
    }

    const featureSeed = seed ^ hashText(`${sourceRef || "planning"}:${palette.key}`);
    const featureResult = renderCandidate({
      candidate,
      palette,
      compilation,
      surfaceRows,
      paletteIndex,
      chunkMap,
      seed: featureSeed
    });
    if (!featureResult.cellWrites) {
      result.rejectedFeatures += 1;
      result.changes.push({
        sourceRef,
        material: palette.key,
        status: "rejected",
        reason: "planning-area-does-not-overlap-compiled-park-terrain"
      });
      continue;
    }

    result.renderedFeatures += 1;
    result.renderedCellWrites += featureResult.cellWrites;
    result.addedOperations += featureResult.operations;
    result.addedPaletteBlocks += featureResult.addedPaletteBlocks;
    result.materials[palette.key] ||= { features: 0, cellWrites: 0, pattern: palette.pattern, blocks: palette.blocks };
    result.materials[palette.key].features += 1;
    result.materials[palette.key].cellWrites += featureResult.cellWrites;
    result.changes.push({
      sourceRef,
      material: palette.key,
      status: "rendered",
      pattern: palette.pattern,
      paletteBlocks: palette.blocks,
      cellWrites: featureResult.cellWrites,
      operations: featureResult.operations,
      terrainGeometryChanged: false,
      terrainElevationChanged: false
    });
  }

  // Phase sort is stable in modern Node. Appended planning phase-1 operations
  // therefore remain after the original terrain phase-1 operation at the same
  // cell, so they replace only the top block before vertical phases execute.
  compilation.chunks = [...chunkMap.values()]
    .map((chunk) => ({ ...chunk, o: chunk.o.sort((a, b) => a[0] - b[0]) }))
    .sort((a, b) => a.z - b.z || a.x - b.x);

  result.status = result.renderedFeatures
    ? (result.deferredFeatures || result.rejectedFeatures ? "rendered-with-deferred-items" : "rendered")
    : result.deferredFeatures ? "deferred" : "rejected";
  result.terrainGeometryChanged = false;
  result.terrainElevationChanged = false;
  result.elevationPolicy = "reuse-exact-compiled-phase-1-ground-y";

  if (compilation.stats) {
    compilation.stats.rawOperations = Number(compilation.stats.rawOperations || 0) + result.addedOperations;
    compilation.stats.operations = Number(compilation.stats.operations || 0) + result.addedOperations;
    compilation.stats.estimatedBlocks = Number(compilation.stats.estimatedBlocks || 0) + result.renderedCellWrites;
    compilation.stats.chunks = compilation.chunks.length;
    compilation.stats.phaseCounts ||= {};
    compilation.stats.phaseCounts[1] = Number(compilation.stats.phaseCounts[1] || 0) + result.addedOperations;
    compilation.stats.planningSurfacePaintRenderedFeatures = result.renderedFeatures;
    compilation.stats.planningSurfacePaintRenderedCells = result.renderedCellWrites;
    compilation.stats.planningSurfacePaintDeferredFeatures = result.deferredFeatures;
    compilation.stats.planningSurfacePaintRejectedFeatures = result.rejectedFeatures;
  }
  attachSummary(compilation, result);
  return result;
}

export function blockForPlanningSurfacePalette(palette, x, z, seed = 0) {
  const blocks = (palette?.blocks || []).filter((entry) => entry?.block && Number(entry.weight) > 0);
  if (!blocks.length) return null;
  if (blocks.length === 1 || palette.pattern === "solid") return blocks[0].block;

  let hx = Math.round(x), hz = Math.round(z);
  if (palette.pattern === "mixed") {
    hx = Math.floor(hx / 3);
    hz = Math.floor(hz / 3);
  } else if (palette.pattern === "organic") {
    hx = Math.floor(hx / 4);
    hz = Math.floor(hz / 4);
  } else if (palette.pattern === "running_bond") {
    hx += (Math.abs(hz) % 2) * 2;
  }
  const roll = hash2d(hx, hz, seed ^ hashText(palette.key || "surface")) / 0x1_0000_0000;
  let cumulative = 0;
  for (const entry of blocks) {
    cumulative += Number(entry.weight || 0);
    if (roll < cumulative) return entry.block;
  }
  return blocks.at(-1).block;
}

function renderCandidate(context) {
  const { candidate, palette, compilation, surfaceRows, paletteIndex, chunkMap, seed } = context;
  let cellWrites = 0;
  let operations = 0;
  let addedPaletteBlocks = 0;
  for (const polygon of polygonParts(candidate.localGeometry)) {
    for (const [candidateX1, candidateX2, z] of polygonScanlineSpans(polygon)) {
      const terrainRuns = surfaceRows.get(z) || [];
      for (const terrain of terrainRuns) {
        const x1 = Math.max(candidateX1, terrain.x1);
        const x2 = Math.min(candidateX2, terrain.x2);
        if (x2 < x1) continue;
        let start = x1;
        let block = blockForPlanningSurfacePalette(palette, x1, z, seed);
        for (let x = x1 + 1; x <= x2 + 1; x += 1) {
          const nextBlock = x <= x2 ? blockForPlanningSurfacePalette(palette, x, z, seed) : null;
          if (x <= x2 && nextBlock === block) continue;
          const registered = registerBlock(block, compilation, paletteIndex);
          if (registered.added) addedPaletteBlocks += 1;
          appendRun(chunkMap, [1, start, terrain.y, z, x - 1, terrain.y, z, registered.index]);
          operations += 1;
          cellWrites += x - start;
          start = x;
          block = nextBlock;
        }
      }
    }
  }
  return { cellWrites, operations, addedPaletteBlocks };
}

function indexCompiledTopSurface(compilation) {
  const rows = new Map();
  for (const chunk of compilation?.chunks || []) {
    for (const operation of chunk.o || []) {
      if (operation[0] !== 1) continue;
      const [, x1, y1, z1, x2, y2, z2] = operation;
      if (y1 !== y2 || z1 !== z2) continue;
      if (!rows.has(z1)) rows.set(z1, []);
      rows.get(z1).push({ x1, x2, y: y1 });
    }
  }
  for (const runs of rows.values()) runs.sort((a, b) => a.x1 - b.x1 || a.x2 - b.x2);
  return rows;
}

function appendRun(chunkMap, operation) {
  const [, x1, , z1, x2, , z2] = operation;
  // Source phase-1 terrain runs are already split by chunk, and candidate runs
  // are intersected against those source runs, so this should normally be one
  // chunk. Keep a defensive split for future compiler changes.
  const minChunkX = floorDiv(x1, 16), maxChunkX = floorDiv(x2, 16);
  const minChunkZ = floorDiv(z1, 16), maxChunkZ = floorDiv(z2, 16);
  for (let chunkZ = minChunkZ; chunkZ <= maxChunkZ; chunkZ += 1) {
    for (let chunkX = minChunkX; chunkX <= maxChunkX; chunkX += 1) {
      const fromX = Math.max(x1, chunkX * 16);
      const toX = Math.min(x2, chunkX * 16 + 15);
      const fromZ = Math.max(z1, chunkZ * 16);
      const toZ = Math.min(z2, chunkZ * 16 + 15);
      const key = `${chunkX},${chunkZ}`;
      if (!chunkMap.has(key)) chunkMap.set(key, { x: chunkX, z: chunkZ, o: [] });
      chunkMap.get(key).o.push([
        operation[0], fromX, operation[2], fromZ,
        toX, operation[5], toZ, operation[7]
      ]);
    }
  }
}

function registerBlock(block, compilation, index) {
  let value = index.get(block);
  if (value !== undefined) return { index: value, added: false };
  value = compilation.palette.length;
  compilation.palette.push(block);
  index.set(block, value);
  return { index: value, added: true };
}

function attachSummary(compilation, summary) {
  if (!compilation?.meta) return;
  compilation.meta.planningSurfacePaintRender = summary;
}

function polygonParts(geometry) {
  if (geometry?.type === "Polygon") return geometry.coordinates?.length ? [geometry.coordinates] : [];
  if (geometry?.type === "MultiPolygon") return (geometry.coordinates || []).filter((polygon) => polygon?.length);
  return [];
}
function isAreaGeometry(geometry) { return ["Polygon", "MultiPolygon"].includes(geometry?.type); }
function candidateRef(candidate) { return candidate?.id || (candidate?.contentHash ? `${candidate.contentHash}:p${candidate.pageNumber || 1}` : null); }
function floorDiv(value, divisor) { return Math.floor(value / divisor); }
function hashText(value) {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash | 0;
}
function hash2d(x, z, seed = 0) {
  let value = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return (value ^ (value >>> 16)) >>> 0;
}
function emptySummary() {
  return {
    schemaVersion: 1,
    status: "not-run",
    mode: "render",
    candidateFeatures: 0,
    renderedFeatures: 0,
    deferredFeatures: 0,
    rejectedFeatures: 0,
    renderedCellWrites: 0,
    addedOperations: 0,
    addedPaletteBlocks: 0,
    terrainGeometryChanged: false,
    terrainElevationChanged: false,
    elevationPolicy: "reuse-exact-compiled-phase-1-ground-y",
    materials: {},
    changes: []
  };
}
