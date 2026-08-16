const DEFAULT_LINE_TOLERANCE_PT = 4;
const DEFAULT_MAX_CODE_DISTANCE_PT = 180;
const DEFAULT_MAX_SWATCH_DISTANCE_PT = 190;
const DEFAULT_SWATCH_MAX_SPAN_PT = 84;
const DEFAULT_SWATCH_MIN_SPAN_PT = 3;
const DEFAULT_HATCH_CELL_SIZE_PT = 64;
const DEFAULT_MIN_HATCH_STROKES = 3;

/**
 * Learns page-local planning legend semantics and emits additional material
 * observations at drawing codes / matching filled or hatched polygons.
 *
 * This resolver is intentionally non-authoritative. It never creates geometry,
 * moves geometry, changes terrain or grants current-state authority. Every
 * emitted observation remains in PDF page space and must pass the existing
 * georegistration, temporal-current and spatial association gates downstream.
 */
export function resolvePlanningLegend(input = {}, options = {}) {
  const pageNumber = Number(input.pageNumber || 1);
  const contentHash = input.contentHash || null;
  const textItems = normalizeTextItems(input.textItems || []);
  const vectorPaths = input.vectorPaths || [];
  const geometryCandidates = input.geometryCandidates || [];
  const directMaterials = (input.materialObservations || []).filter((entry) => entry?.material);
  const hatchIndex = buildHatchIndex(vectorPaths, options);
  const provisional = [];

  for (let materialIndex = 0; materialIndex < directMaterials.length; materialIndex += 1) {
    const observation = directMaterials[materialIndex];
    const role = String(observation.role || "surface").toLowerCase();
    const sourceItems = new Set(observation.evidenceItemIndices || []);
    const code = findNearbyLegendCode(textItems, observation, sourceItems, options);
    const swatch = findNearbyLegendSwatch(vectorPaths, observation, hatchIndex, options);
    if (!code && !swatch) continue;

    const fillKey = swatch ? fillStyleKey(swatch.path) : null;
    const hatch = swatch ? hatchSignatureForSwatch(swatch.path, swatch.index, hatchIndex, options) : null;
    provisional.push({
      id: `${contentHash || "document"}:p${pageNumber}:legend:${materialIndex}`,
      contentHash,
      pageNumber,
      material: observation.material,
      role,
      confidence: roundConfidence(Number(observation.confidence || 0.72) * (code && (fillKey || hatch) ? 0.98 : 0.94)),
      materialObservationIndex: materialIndex,
      materialRaw: observation.raw || null,
      materialXPt: finiteOrNull(observation.xPt),
      materialYPt: finiteOrNull(observation.yPt),
      code: code?.code || null,
      rawCode: code?.raw || null,
      codeItemIndex: code?.index ?? null,
      codeFontSizePt: code?.fontSizePt ?? null,
      swatchVectorPathIndex: swatch?.index ?? null,
      swatchBoundsPt: swatch?.path?.bounds || null,
      fillStyleKey: fillKey,
      hatchStyleKey: hatch?.key || null,
      hatchStrokeCount: hatch?.count || 0,
      propagationEligible: role === "surface",
      source: "pdf-planning-legend"
    });
  }

  const codeConflicts = conflictingKeys(provisional, "code");
  const fillConflicts = conflictingKeys(provisional, "fillStyleKey");
  const hatchConflicts = conflictingKeys(provisional, "hatchStyleKey");
  const entries = provisional.map((entry) => ({
    ...entry,
    codeAccepted: Boolean(entry.code) && !codeConflicts.has(entry.code),
    fillAccepted: Boolean(entry.fillStyleKey) && !fillConflicts.has(entry.fillStyleKey),
    hatchAccepted: Boolean(entry.hatchStyleKey) && !hatchConflicts.has(entry.hatchStyleKey),
    conflictReasons: [
      entry.code && codeConflicts.has(entry.code) ? "legend-code-maps-to-multiple-materials" : null,
      entry.fillStyleKey && fillConflicts.has(entry.fillStyleKey) ? "legend-fill-style-maps-to-multiple-materials" : null,
      entry.hatchStyleKey && hatchConflicts.has(entry.hatchStyleKey) ? "legend-hatch-style-maps-to-multiple-materials" : null
    ].filter(Boolean)
  }));

  const inferred = [];
  inferred.push(...materialObservationsFromCodes(entries, textItems, pageNumber, contentHash));
  inferred.push(...materialObservationsFromGeometry(entries, geometryCandidates, vectorPaths, hatchIndex, pageNumber, contentHash, options));
  const materialObservations = dedupeMaterialObservations(inferred);
  const acceptedEntries = entries.filter((entry) => entry.propagationEligible && (entry.codeAccepted || entry.fillAccepted || entry.hatchAccepted));

  return {
    schemaVersion: 1,
    status: entries.length ? (acceptedEntries.length ? "resolved" : "review-required") : "no-legend-evidence",
    terrainPolicy: {
      geometryMutable: false,
      elevationMutable: false,
      surfacePaintEvidenceOnly: true
    },
    counts: {
      directMaterialLabels: directMaterials.length,
      legendEntries: entries.length,
      acceptedEntries: acceptedEntries.length,
      codeMappings: entries.filter((entry) => entry.propagationEligible && entry.codeAccepted).length,
      fillMappings: entries.filter((entry) => entry.propagationEligible && entry.fillAccepted).length,
      hatchMappings: entries.filter((entry) => entry.propagationEligible && entry.hatchAccepted).length,
      inferredMaterialObservations: materialObservations.length,
      conflicts: new Set([...codeConflicts, ...fillConflicts, ...hatchConflicts]).size
    },
    entries,
    materialObservations
  };
}

export function normalizeLegendCode(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!/^[A-Z]{1,3}\s*[-_.]?\s*\d{1,3}[A-Z]?$/.test(raw)) return null;
  const normalized = raw.replace(/[^A-Z0-9]/g, "");
  return normalized.length >= 2 && normalized.length <= 7 ? normalized : null;
}

export function fillStyleKey(path) {
  if (!path?.closed || !/fill/.test(String(path.paint || "")) || !Array.isArray(path.fillColor)) return null;
  const color = quantizeColor(path.fillColor, 4);
  if (!color) return null;
  if (color.every((value) => value >= 248)) return null;
  return `fill:${color.join(",")}`;
}

export function hatchStrokeStyleKey(path) {
  if (!path || path.closed || !/stroke/.test(String(path.paint || ""))) return null;
  const points = commandPoints(path.commands || []);
  if (points.length < 2) return null;
  const first = points[0], last = points[points.length - 1];
  const dx = last[0] - first[0], dy = last[1] - first[1];
  const length = Math.hypot(dx, dy);
  if (!(length >= 1.5 && length <= 220)) return null;
  let angle = Math.atan2(dy, dx) * 180 / Math.PI;
  if (angle < 0) angle += 180;
  if (angle >= 180) angle -= 180;
  const angleBucket = Math.round(angle / 15) * 15 % 180;
  const stroke = quantizeColor(path.strokeColor || [0, 0, 0], 8) || [0, 0, 0];
  const width = Math.round(Number(path.lineWidthPt || 1) * 4) / 4;
  const dash = (path.dash || []).slice(0, 6).map((value) => Math.round(Number(value || 0) * 2) / 2).join(",");
  return `hatch:a${angleBucket}:c${stroke.join(",")}:w${width}:d${dash}`;
}

function findNearbyLegendCode(items, observation, sourceItems, options) {
  if (!Number.isFinite(Number(observation.xPt)) || !Number.isFinite(Number(observation.yPt))) return null;
  const lineTolerance = positive(options.legendLineTolerancePt, DEFAULT_LINE_TOLERANCE_PT);
  const maxDistance = positive(options.legendMaxCodeDistancePt, DEFAULT_MAX_CODE_DISTANCE_PT);
  const candidates = [];
  for (const item of items) {
    if (sourceItems.has(item.index)) continue;
    const code = normalizeLegendCode(item.text);
    if (!code || !Number.isFinite(item.xPt) || !Number.isFinite(item.yPt)) continue;
    const dy = Math.abs(item.yPt - Number(observation.yPt));
    const dx = Math.abs(item.xPt - Number(observation.xPt));
    if (dy > lineTolerance || dx > maxDistance) continue;
    const rightPenalty = item.xPt > Number(observation.xPt) ? 8 : 0;
    candidates.push({ ...item, code, raw: item.text, score: dy * 12 + dx + rightPenalty });
  }
  candidates.sort((a, b) => a.score - b.score || a.index - b.index);
  return candidates[0] || null;
}

function findNearbyLegendSwatch(paths, observation, hatchIndex, options) {
  if (!Number.isFinite(Number(observation.xPt)) || !Number.isFinite(Number(observation.yPt))) return null;
  const maxDistance = positive(options.legendMaxSwatchDistancePt, DEFAULT_MAX_SWATCH_DISTANCE_PT);
  const maxSpan = positive(options.legendSwatchMaxSpanPt, DEFAULT_SWATCH_MAX_SPAN_PT);
  const minSpan = positive(options.legendSwatchMinSpanPt, DEFAULT_SWATCH_MIN_SPAN_PT);
  const candidates = [];
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    if (!path?.closed || !path.bounds) continue;
    const width = path.bounds.maxX - path.bounds.minX;
    const height = path.bounds.maxY - path.bounds.minY;
    if (width < minSpan || height < minSpan || width > maxSpan || height > maxSpan) continue;
    const area = width * height;
    if (!(area >= minSpan * minSpan && area <= maxSpan * maxSpan)) continue;
    const center = boundsCenter(path.bounds);
    const dx = center[0] - Number(observation.xPt);
    const dy = center[1] - Number(observation.yPt);
    const distance = Math.hypot(dx, dy);
    if (distance > maxDistance || Math.abs(dy) > Math.max(30, maxSpan * 0.55)) continue;
    const fill = fillStyleKey(path);
    const hatch = hatchSignatureForSwatch(path, index, hatchIndex, options);
    if (!fill && !hatch) continue;
    const rightPenalty = dx > 0 ? 12 : 0;
    candidates.push({ index, path, score: distance + rightPenalty - (fill ? 3 : 0) - (hatch ? 4 : 0) });
  }
  candidates.sort((a, b) => a.score - b.score || a.index - b.index);
  return candidates[0] || null;
}

function materialObservationsFromCodes(entries, textItems, pageNumber, contentHash) {
  const result = [];
  const byCode = uniqueAcceptedEntryMap(entries, "code", "codeAccepted");
  for (const item of textItems) {
    const code = normalizeLegendCode(item.text);
    const entry = code ? byCode.get(code) : null;
    if (!entry || !entry.propagationEligible || item.index === entry.codeItemIndex) continue;
    if (!Number.isFinite(item.xPt) || !Number.isFinite(item.yPt)) continue;
    if (Number.isFinite(entry.codeFontSizePt) && Number.isFinite(item.fontSizePt)) {
      const ratio = item.fontSizePt / Math.max(0.01, entry.codeFontSizePt);
      if (ratio < 0.45 || ratio > 2.4) continue;
    }
    result.push(materialObservation({
      contentHash,
      pageNumber,
      xPt: item.xPt,
      yPt: item.yPt,
      material: entry.material,
      confidence: Math.min(0.82, entry.confidence * 0.88),
      source: "pdf-legend-code-material",
      raw: item.text,
      entry,
      evidenceMethod: "legend-code"
    }));
  }
  return result;
}

function materialObservationsFromGeometry(entries, geometryCandidates, vectorPaths, hatchIndex, pageNumber, contentHash, options) {
  const result = [];
  const fillEntries = uniqueAcceptedEntryMap(entries, "fillStyleKey", "fillAccepted");
  const hatchEntries = uniqueAcceptedEntryMap(entries, "hatchStyleKey", "hatchAccepted");
  const minHatch = Math.max(2, Math.floor(positive(options.legendMinHatchStrokes, DEFAULT_MIN_HATCH_STROKES)));
  const sourceSwatches = new Set(entries.map((entry) => entry.swatchVectorPathIndex).filter(Number.isInteger));

  for (const candidate of geometryCandidates || []) {
    if (!candidate?.closed || !candidate.boundsPt || !Number.isInteger(candidate.vectorPathIndex)) continue;
    if (sourceSwatches.has(candidate.vectorPathIndex)) continue;
    const path = vectorPaths[candidate.vectorPathIndex];
    if (!path) continue;
    const center = boundsCenter(candidate.boundsPt);
    const matches = [];

    const fillKey = fillStyleKey(path);
    const fillEntry = fillKey ? fillEntries.get(fillKey) : null;
    if (fillEntry?.propagationEligible) {
      matches.push({ entry: fillEntry, method: "legend-fill", confidence: Math.min(0.8, fillEntry.confidence * 0.86) });
    }

    for (const [hatchKey, hatchEntry] of hatchEntries) {
      if (!hatchEntry.propagationEligible) continue;
      const count = queryHatchCount(hatchIndex, hatchKey, candidate.boundsPt, sourceSwatches);
      if (count >= minHatch) {
        matches.push({ entry: hatchEntry, method: "legend-hatch", confidence: Math.min(0.76, hatchEntry.confidence * 0.8), hatchCount: count });
      }
    }

    const materials = new Set(matches.map((match) => match.entry.material));
    if (materials.size !== 1 || !matches.length) continue;
    matches.sort((a, b) => b.confidence - a.confidence || a.method.localeCompare(b.method));
    const best = matches[0];
    result.push(materialObservation({
      contentHash,
      pageNumber,
      xPt: center[0],
      yPt: center[1],
      material: best.entry.material,
      confidence: best.confidence,
      source: best.method === "legend-fill" ? "pdf-legend-fill-material" : "pdf-legend-hatch-material",
      raw: best.entry.rawCode || best.entry.materialRaw || best.entry.material,
      entry: best.entry,
      evidenceMethod: best.method,
      vectorPathIndex: candidate.vectorPathIndex,
      hatchStrokeCount: best.hatchCount || 0
    }));
  }
  return result;
}

function materialObservation({ contentHash, pageNumber, xPt, yPt, material, confidence, source, raw, entry, evidenceMethod, vectorPathIndex = null, hatchStrokeCount = 0 }) {
  return {
    contentHash,
    pageNumber,
    xPt: finiteOrNull(xPt),
    yPt: finiteOrNull(yPt),
    material,
    role: "surface",
    raw,
    confidence: roundConfidence(confidence),
    source,
    georegistrationRequired: true,
    legendEvidence: {
      schemaVersion: 1,
      entryId: entry.id,
      code: entry.code || null,
      evidenceMethod,
      swatchVectorPathIndex: entry.swatchVectorPathIndex ?? null,
      vectorPathIndex,
      fillStyleKey: entry.fillStyleKey || null,
      hatchStyleKey: entry.hatchStyleKey || null,
      hatchStrokeCount,
      terrainGeometryMutable: false
    }
  };
}

function uniqueAcceptedEntryMap(entries, keyField, acceptedField) {
  const map = new Map();
  for (const entry of entries) {
    const key = entry[keyField];
    if (!entry[acceptedField] || !key || !entry.propagationEligible) continue;
    const existing = map.get(key);
    if (!existing || entry.confidence > existing.confidence) map.set(key, entry);
  }
  return map;
}

function conflictingKeys(entries, field) {
  const groups = new Map();
  for (const entry of entries) {
    if (!entry.propagationEligible || !entry[field]) continue;
    if (!groups.has(entry[field])) groups.set(entry[field], new Set());
    groups.get(entry[field]).add(entry.material);
  }
  return new Set([...groups.entries()].filter(([, materials]) => materials.size > 1).map(([key]) => key));
}

function buildHatchIndex(paths, options) {
  const cellSize = positive(options.legendHatchCellSizePt, DEFAULT_HATCH_CELL_SIZE_PT);
  const signatures = new Map();
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    const signature = hatchStrokeStyleKey(path);
    if (!signature || !path.bounds) continue;
    const center = boundsCenter(path.bounds);
    const cell = cellKey(center[0], center[1], cellSize);
    if (!signatures.has(signature)) signatures.set(signature, new Map());
    const cells = signatures.get(signature);
    if (!cells.has(cell)) cells.set(cell, []);
    cells.get(cell).push({ index, x: center[0], y: center[1] });
  }
  return { cellSize, signatures };
}

function hatchSignatureForSwatch(path, pathIndex, hatchIndex, options) {
  if (!path?.bounds) return null;
  const records = queryAllHatchRecords(hatchIndex, path.bounds, new Set([pathIndex]));
  const counts = new Map();
  for (const record of records) counts.set(record.signature, (counts.get(record.signature) || 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const minimum = Math.max(2, Math.floor(positive(options.legendMinSwatchHatchStrokes, 2)));
  return ranked[0] && ranked[0][1] >= minimum ? { key: ranked[0][0], count: ranked[0][1] } : null;
}

function queryHatchCount(index, signature, bounds, excludedIndexes = new Set()) {
  return queryHatchRecords(index, signature, bounds, excludedIndexes).length;
}

function queryAllHatchRecords(index, bounds, excludedIndexes = new Set()) {
  const result = [];
  for (const signature of index.signatures.keys()) {
    result.push(...queryHatchRecords(index, signature, bounds, excludedIndexes).map((record) => ({ ...record, signature })));
  }
  return result;
}

function queryHatchRecords(index, signature, bounds, excludedIndexes = new Set()) {
  const cells = index.signatures.get(signature);
  if (!cells || !bounds) return [];
  const cellSize = index.cellSize;
  const minX = Math.floor(bounds.minX / cellSize), maxX = Math.floor(bounds.maxX / cellSize);
  const minY = Math.floor(bounds.minY / cellSize), maxY = Math.floor(bounds.maxY / cellSize);
  const result = [];
  for (let cx = minX; cx <= maxX; cx += 1) {
    for (let cy = minY; cy <= maxY; cy += 1) {
      for (const record of cells.get(`${cx}:${cy}`) || []) {
        if (excludedIndexes.has(record.index)) continue;
        if (record.x < bounds.minX || record.x > bounds.maxX || record.y < bounds.minY || record.y > bounds.maxY) continue;
        result.push(record);
      }
    }
  }
  return result;
}

function normalizeTextItems(values) {
  return (values || []).map((item, index) => ({
    index,
    text: String(item?.text || item?.str || "").trim(),
    xPt: finiteOrNull(item?.xPt ?? item?.transform?.[4]),
    yPt: finiteOrNull(item?.yPt ?? item?.transform?.[5]),
    widthPt: finiteOrNull(item?.widthPt ?? item?.width),
    heightPt: finiteOrNull(item?.heightPt ?? item?.height),
    fontSizePt: finiteOrNull(item?.fontSizePt)
  })).filter((item) => item.text);
}

function dedupeMaterialObservations(values) {
  const ordered = [...values].sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0) || String(a.source).localeCompare(String(b.source)));
  const seen = new Set();
  const result = [];
  for (const value of ordered) {
    const key = `${value.pageNumber}:${value.material}:${round(value.xPt, 1)}:${round(value.yPt, 1)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result.sort((a, b) => finiteSort(b.yPt, a.yPt) || finiteSort(a.xPt, b.xPt) || String(a.material).localeCompare(String(b.material)));
}

function commandPoints(commands) {
  const result = [];
  for (const command of commands || []) {
    if (Number.isFinite(command?.x) && Number.isFinite(command?.y)) result.push([Number(command.x), Number(command.y)]);
  }
  return result;
}

function boundsCenter(bounds) {
  return [(Number(bounds.minX) + Number(bounds.maxX)) / 2, (Number(bounds.minY) + Number(bounds.maxY)) / 2];
}

function quantizeColor(values, step) {
  if (!Array.isArray(values) || values.length < 3) return null;
  return values.slice(0, 3).map((value) => {
    const number = Math.max(0, Math.min(255, Number(value) || 0));
    return Math.max(0, Math.min(255, Math.round(number / step) * step));
  });
}

function cellKey(x, y, cellSize) {
  return `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`;
}

function finiteSort(left, right) {
  if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
  if (Number.isFinite(left)) return -1;
  if (Number.isFinite(right)) return 1;
  return 0;
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function round(value, places = 2) {
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** places;
  return Math.round(Number(value) * factor) / factor;
}

function roundConfidence(value) {
  return Math.max(0, Math.min(1, Math.round(Number(value || 0) * 1000) / 1000));
}
