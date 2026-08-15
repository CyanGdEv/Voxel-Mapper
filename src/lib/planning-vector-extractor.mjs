import path from "node:path";
import { readFile } from "node:fs/promises";

const DEFAULT_MAX_PAGES = 240;
const DEFAULT_MAX_VECTOR_PATHS_PER_PAGE = 25_000;
const DEFAULT_MAX_TEXT_ITEMS_PER_PAGE = 50_000;
const DEFAULT_MAX_COMMANDS_PER_PATH = 20_000;

const MATERIAL_PATTERNS = [
  ["weathered_asphalt", /\bweathered\s+(?:asphalt|tarmac|bitmac)\b/i],
  ["fresh_black_asphalt", /\b(?:new|fresh|black)\s+(?:asphalt|tarmac|bitmac)\b/i],
  ["red_tarmac", /\bred\s+(?:tarmac|asphalt|bitmac)\b/i],
  ["resin_bound_beige", /\b(?:beige|buff)\s+resin(?:-bound)?\b|\bresin(?:-bound)?\s+(?:beige|buff)\b/i],
  ["resin_bound_grey", /\bgr(?:e|a)y\s+resin(?:-bound)?\b|\bresin(?:-bound)?\s+gr(?:e|a)y\b/i],
  ["concrete", /\bconcrete\b/i],
  ["brick", /\bbrick(?:work| paving| pavers?)?\b/i],
  ["stone", /\b(?:natural\s+)?stone\b|\bgranite\b/i],
  ["timber", /\btimber\b|\bwood(?:en)?\b/i],
  ["steel", /\bsteel\b/i],
  ["glass", /\bglass\b|\bglazing\b/i],
  ["slate_roof", /\bslate\b/i],
  ["clay_tile_roof", /\bclay\s+tiles?\b|\broof\s+tiles?\b/i],
  ["metal_roof", /\b(?:metal|zinc|aluminium|aluminum)\s+(?:roof|cladding|sheet)\b/i],
  ["gravel", /\bgravel\b|\bchippings\b/i],
  ["grass", /\bgrass\b|\bturf\b/i]
];

const LEVEL_LABELS = "FFL|SSL|AOD|RL|R\\.?L\\.?|RIDGE|EAVES?|GROUND\\s+LEVEL|GL|TOW|BOW|TOP\\s+OF\\s+WALL|BOTTOM\\s+OF\\s+WALL";

export async function extractPlanningDocument(item, options = {}) {
  if (!item?.contentHash || !item?.objectPath) throw new Error("Planning extraction item requires contentHash and objectPath");
  const cacheDir = path.resolve(options.cacheDir || ".tpmap-cache");
  const filename = path.resolve(cacheDir, "planning-documents", item.objectPath);
  const contentType = String(item.contentType || "").toLowerCase();
  const extension = path.extname(filename).toLowerCase();
  const common = {
    schemaVersion: 1,
    contentHash: item.contentHash,
    objectPath: item.objectPath,
    contentType: item.contentType || null,
    classification: item.classification || "unknown",
    applicationKeys: item.applicationKeys || [],
    acquisitionShard: item.acquisitionShard ?? item.shard ?? null,
    coordinatePolicy: {
      extractedSpace: "document-page-space",
      worldGeometryAuthority: false,
      promotionRule: "geometry remains non-authoritative until independent georegistration succeeds"
    }
  };

  if (contentType === "application/pdf" || extension === ".pdf") {
    return extractPdfPlanningDocument(filename, item, common, options);
  }
  if (contentType.startsWith("image/") || [".png", ".jpg", ".jpeg", ".tif", ".tiff"].includes(extension)) {
    return {
      ...common,
      status: "raster-fallback-required",
      method: "raster-document",
      pageCount: 1,
      pages: [],
      normalizedEvidence: emptyNormalizedEvidence(),
      rasterFallbackQueue: [{
        contentHash: item.contentHash,
        pageNumber: 1,
        objectPath: item.objectPath,
        classification: item.classification || "unknown",
        reason: "source-document-is-raster-image",
        priority: item.priority ?? 0
      }],
      warnings: ["Raster planning document requires image interpretation; no false vector geometry was manufactured."]
    };
  }
  return {
    ...common,
    status: "unsupported",
    method: "none",
    pageCount: 0,
    pages: [],
    normalizedEvidence: emptyNormalizedEvidence(),
    rasterFallbackQueue: [],
    warnings: [`Unsupported planning extraction content type: ${item.contentType || extension || "unknown"}`]
  };
}

export async function extractPdfPlanningDocument(filename, item, common = {}, options = {}) {
  const bytes = new Uint8Array(await readFile(filename));
  const engine = options.pdfEngine || await loadPdfJsEngine();
  const loadingTask = engine.getDocument({
    data: bytes,
    disableWorker: true,
    isEvalSupported: false,
    useWorkerFetch: false,
    stopAtErrors: false
  });
  const document = await (loadingTask?.promise || loadingTask);
  const maxPages = clampInt(options.maxPlanningPdfPages ?? DEFAULT_MAX_PAGES, 1, 2_000);
  if (document.numPages > maxPages) throw new Error(`Planning PDF has ${document.numPages} pages; limit is ${maxPages}`);

  const pages = [];
  const geometryCandidates = [];
  const verticalObservations = [];
  const materialObservations = [];
  const drawingMetadata = [];
  const rasterFallbackQueue = [];

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const pageEvidence = await extractPdfPage(page, engine.OPS || {}, {
        ...options,
        pageNumber,
        classification: item.classification || "unknown",
        contentHash: item.contentHash
      });
      pages.push(pageEvidence);
      geometryCandidates.push(...pageEvidence.geometryCandidates);
      verticalObservations.push(...pageEvidence.verticalObservations);
      materialObservations.push(...pageEvidence.materialObservations);
      if (pageEvidence.metadata) drawingMetadata.push(pageEvidence.metadata);
      if (pageEvidence.rasterFallback.required) {
        rasterFallbackQueue.push({
          contentHash: item.contentHash,
          pageNumber,
          objectPath: item.objectPath,
          classification: item.classification || "unknown",
          reason: pageEvidence.rasterFallback.reason,
          priority: item.priority ?? 0
        });
      }
    }
  } finally {
    await document.destroy?.();
  }

  return {
    ...common,
    status: "extracted",
    method: "pdfjs-vector-first",
    pageCount: pages.length,
    vectorPageCount: pages.filter((page) => page.vector.pathCount > 0).length,
    textPageCount: pages.filter((page) => page.text.characterCount > 0).length,
    rasterFallbackPageCount: rasterFallbackQueue.length,
    pages,
    normalizedEvidence: {
      schemaVersion: 1,
      coordinateSpace: "pdf-user-space-points",
      georegistrationStatus: "required",
      worldGeometryReady: false,
      geometryCandidates,
      verticalObservations,
      materialObservations,
      drawingMetadata
    },
    rasterFallbackQueue,
    warnings: rasterFallbackQueue.length
      ? [`${rasterFallbackQueue.length} page(s) require raster fallback because vector/text evidence is insufficient.`]
      : []
  };
}

export async function extractPdfPage(page, OPS, options = {}) {
  const pageNumber = Number(options.pageNumber || 1);
  const viewport = page.getViewport ? page.getViewport({ scale: 1 }) : viewportFromPage(page);
  const [textContent, operatorList] = await Promise.all([
    page.getTextContent ? page.getTextContent({ disableCombineTextItems: false }) : { items: [] },
    page.getOperatorList ? page.getOperatorList() : { fnArray: [], argsArray: [] }
  ]);
  const text = normalizeTextItems(textContent?.items || [], options);
  const vector = extractVectorOperations(operatorList || {}, OPS, options);
  const pageText = text.items.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
  const metadata = extractDrawingMetadata(pageText, pageNumber);
  const verticalObservations = extractVerticalObservations(text.items, pageNumber, options.contentHash);
  const materialObservations = extractMaterialObservations(text.items, pageNumber, options.contentHash);
  const geometryCandidates = buildPageGeometryCandidates(vector.paths, {
    classification: options.classification,
    contentHash: options.contentHash,
    pageNumber
  });
  const rasterFallback = assessRasterFallback({
    classification: options.classification,
    textCharacters: text.characterCount,
    vectorPaths: vector.pathCount,
    meaningfulVectorPaths: geometryCandidates.length,
    imagePaintOps: vector.imagePaintOps
  });

  return {
    pageNumber,
    widthPt: finiteOrNull(viewport?.width),
    heightPt: finiteOrNull(viewport?.height),
    rotation: finiteOrNull(viewport?.rotation ?? page.rotate ?? 0),
    text,
    vector: {
      pathCount: vector.pathCount,
      imagePaintOps: vector.imagePaintOps,
      truncated: vector.truncated,
      paths: vector.paths
    },
    metadata,
    geometryCandidates,
    verticalObservations,
    materialObservations,
    rasterFallback
  };
}

export function extractVectorOperations(operatorList, OPS, options = {}) {
  const fnArray = operatorList.fnArray || [];
  const argsArray = operatorList.argsArray || [];
  const maxPaths = clampInt(options.maxVectorPathsPerPage ?? DEFAULT_MAX_VECTOR_PATHS_PER_PAGE, 1, 250_000);
  const state = defaultGraphicsState();
  const stack = [];
  let pending = [];
  const paths = [];
  let imagePaintOps = 0;
  let truncated = false;

  const paint = (kind, close = false) => {
    for (const pathEntry of pending) {
      if (paths.length >= maxPaths) { truncated = true; break; }
      const record = finalizePath(pathEntry, state, kind, close);
      if (record) paths.push(record);
    }
    pending = [];
  };

  for (let index = 0; index < fnArray.length; index += 1) {
    const fn = fnArray[index];
    const args = argsArray[index] || [];
    if (fn === OPS.save) { stack.push(cloneGraphicsState(state)); continue; }
    if (fn === OPS.restore) {
      const restored = stack.pop();
      if (restored) Object.assign(state, restored);
      continue;
    }
    if (fn === OPS.transform) { state.transform = multiplyMatrices(state.transform, normalizeMatrix(args)); continue; }
    if (fn === OPS.setLineWidth) { state.lineWidthPt = finiteOrNull(args[0]) ?? state.lineWidthPt; continue; }
    if (fn === OPS.setDash) { state.dash = Array.isArray(args[0]) ? args[0].map(Number) : []; continue; }
    if (fn === OPS.setStrokeRGBColor) { state.strokeColor = normalizeRgb(args); continue; }
    if (fn === OPS.setFillRGBColor) { state.fillColor = normalizeRgb(args); continue; }
    if (fn === OPS.constructPath) {
      pending.push(...parseConstructPath(args, state.transform, OPS, options));
      continue;
    }
    if (fn === OPS.stroke) { paint("stroke"); continue; }
    if (fn === OPS.closeStroke) { paint("stroke", true); continue; }
    if (fn === OPS.fill || fn === OPS.eoFill) { paint("fill"); continue; }
    if (fn === OPS.fillStroke || fn === OPS.eoFillStroke) { paint("fill-stroke"); continue; }
    if (fn === OPS.closeFillStroke || fn === OPS.closeEOFillStroke) { paint("fill-stroke", true); continue; }
    if (fn === OPS.endPath) { pending = []; continue; }
    if (isImagePaintOperation(fn, OPS)) imagePaintOps += 1;
  }
  // Some generated PDFs leave a path without an explicit paint operation. Keep
  // it as construction geometry, but at lower semantic confidence downstream.
  for (const pathEntry of pending) {
    if (paths.length >= maxPaths) { truncated = true; break; }
    const record = finalizePath(pathEntry, state, "construction", false);
    if (record) paths.push(record);
  }
  return { paths, pathCount: paths.length, imagePaintOps, truncated };
}

export function extractDrawingMetadata(text, pageNumber = 1) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return null;
  const scale = value.match(/\bscale\s*(?:at\s*)?1\s*[:/]\s*(\d{1,6})\b/i) || value.match(/\b1\s*[:/]\s*(\d{2,6})\b/);
  const drawing = value.match(/\b(?:drawing|dwg)\s*(?:no\.?|number|ref\.?)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{2,})/i);
  const revision = value.match(/\b(?:rev(?:ision)?\.?)\s*[:#-]?\s*([A-Z0-9]{1,8})\b/i);
  const status = value.match(/\b(?:status)\s*[:#-]?\s*(planning|construction|tender|as[- ]built|preliminary|approved|proposed)\b/i);
  if (!scale && !drawing && !revision && !status) return null;
  return {
    pageNumber,
    scaleDenominator: scale ? Number(scale[1]) : null,
    drawingNumber: drawing?.[1] || null,
    revision: revision?.[1] || null,
    status: status?.[1]?.toLowerCase() || null,
    source: "pdf-text-title-block"
  };
}

export function extractVerticalObservations(textItems, pageNumber = 1, contentHash = null) {
  const observations = [];
  const labelled = new RegExp(`\\b(${LEVEL_LABELS})\\s*[:=]?\\s*([+-]?\\d{1,4}(?:\\.\\d{1,4})?)\\s*(?:m)?\\b`, "ig");
  const aodAfter = /\b([+-]?\d{1,4}(?:\.\d{1,4})?)\s*m?\s*AOD\b/ig;
  for (const item of textItems || []) {
    const raw = String(item.text || "");
    for (const match of raw.matchAll(labelled)) {
      observations.push(verticalObservation(item, pageNumber, contentHash, match[1], Number(match[2]), match[0], 0.9));
    }
    for (const match of raw.matchAll(aodAfter)) {
      observations.push(verticalObservation(item, pageNumber, contentHash, "AOD", Number(match[1]), match[0], 0.82));
    }
  }
  return dedupeObservations(observations, (entry) => `${entry.pageNumber}:${round(entry.xPt, 1)}:${round(entry.yPt, 1)}:${entry.label}:${entry.valueM}`);
}

export function extractMaterialObservations(textItems, pageNumber = 1, contentHash = null) {
  const observations = [];
  for (const item of textItems || []) {
    const raw = String(item.text || "").trim();
    if (!raw) continue;
    for (const [material, pattern] of MATERIAL_PATTERNS) {
      if (!pattern.test(raw)) continue;
      observations.push({
        contentHash,
        pageNumber,
        xPt: finiteOrNull(item.xPt),
        yPt: finiteOrNull(item.yPt),
        material,
        raw,
        confidence: 0.76,
        source: "pdf-text-material-label",
        georegistrationRequired: true
      });
    }
  }
  return dedupeObservations(observations, (entry) => `${entry.pageNumber}:${entry.material}:${round(entry.xPt, 1)}:${round(entry.yPt, 1)}:${entry.raw}`);
}

export function buildPageGeometryCandidates(paths, context = {}) {
  const classification = String(context.classification || "unknown");
  const result = [];
  for (let index = 0; index < (paths || []).length; index += 1) {
    const vector = paths[index];
    const bounds = vector.bounds;
    if (!bounds) continue;
    const spanX = bounds.maxX - bounds.minX;
    const spanY = bounds.maxY - bounds.minY;
    if (Math.max(spanX, spanY) < 2 || vector.pointCount < 2) continue;
    const semantic = geometrySemantic(classification, vector.closed);
    if (!semantic) continue;
    result.push({
      id: `${context.contentHash || "document"}:p${context.pageNumber || 1}:v${index}`,
      contentHash: context.contentHash || null,
      pageNumber: context.pageNumber || 1,
      vectorPathIndex: index,
      classification,
      semantic,
      closed: vector.closed,
      paint: vector.paint,
      boundsPt: bounds,
      pointCount: vector.pointCount,
      commands: vector.commands,
      confidence: vector.paint === "construction" ? 0.32 : 0.48,
      coordinateSpace: "pdf-user-space-points",
      georegistrationRequired: true,
      worldGeometryAuthority: false
    });
  }
  return result;
}

export function assessRasterFallback({ classification, textCharacters, vectorPaths, meaningfulVectorPaths, imagePaintOps }) {
  const cls = String(classification || "unknown");
  if (imagePaintOps > 0 && meaningfulVectorPaths < 4 && textCharacters < 120) {
    return { required: true, reason: "image-dominant-page-with-insufficient-vector-evidence" };
  }
  if (vectorPaths === 0 && textCharacters < 30) {
    return { required: true, reason: "no-usable-vector-or-text-evidence" };
  }
  if (["site_plan", "floor_plan", "roof_plan", "elevation", "section", "ride_layout", "landscape_plan"].includes(cls) && meaningfulVectorPaths === 0) {
    return { required: true, reason: "drawing-class-without-meaningful-vector-geometry" };
  }
  return { required: false, reason: null };
}

export async function loadPdfJsEngine() {
  try {
    const module = await import("pdfjs-dist/legacy/build/pdf.mjs");
    return { getDocument: module.getDocument, OPS: module.OPS };
  } catch (error) {
    throw new Error(
      `PDF vector extraction requires pdfjs-dist. Install pdfjs-dist or run the GitHub planning extraction workflow. ${error?.message || ""}`.trim()
    );
  }
}

function normalizeTextItems(items, options) {
  const maxItems = clampInt(options.maxTextItemsPerPage ?? DEFAULT_MAX_TEXT_ITEMS_PER_PAGE, 1, 500_000);
  const normalized = [];
  let characterCount = 0;
  for (const item of items.slice(0, maxItems)) {
    const text = String(item?.str || item?.text || "").trim();
    if (!text) continue;
    const transform = Array.isArray(item.transform) ? item.transform : [1, 0, 0, 1, 0, 0];
    const fontSizePt = Math.hypot(Number(transform[2] || 0), Number(transform[3] || 0)) || Math.hypot(Number(transform[0] || 0), Number(transform[1] || 0)) || null;
    normalized.push({
      text,
      xPt: finiteOrNull(transform[4]),
      yPt: finiteOrNull(transform[5]),
      widthPt: finiteOrNull(item.width),
      heightPt: finiteOrNull(item.height),
      fontSizePt: finiteOrNull(fontSizePt),
      fontName: item.fontName || null,
      direction: item.dir || null
    });
    characterCount += text.length;
  }
  return {
    itemCount: normalized.length,
    characterCount,
    truncated: items.length > maxItems,
    items: normalized
  };
}

function parseConstructPath(args, matrix, OPS, options) {
  const operators = Array.isArray(args[0]) || ArrayBuffer.isView(args[0]) ? [...args[0]] : [];
  const coordinates = Array.isArray(args[1]) || ArrayBuffer.isView(args[1]) ? [...args[1]] : [];
  const maxCommands = clampInt(options.maxCommandsPerPath ?? DEFAULT_MAX_COMMANDS_PER_PATH, 1, 250_000);
  let coordinateIndex = 0;
  let current = null;
  const subpaths = [];
  const ensure = () => {
    if (!current) { current = { commands: [], closed: false }; subpaths.push(current); }
    return current;
  };
  const point = () => {
    const value = transformPoint(matrix, Number(coordinates[coordinateIndex++] || 0), Number(coordinates[coordinateIndex++] || 0));
    return value;
  };

  for (const op of operators) {
    if (subpaths.reduce((sum, entry) => sum + entry.commands.length, 0) >= maxCommands) break;
    if (op === OPS.moveTo) {
      current = { commands: [], closed: false };
      subpaths.push(current);
      const p = point(); current.commands.push({ op: "M", x: p[0], y: p[1] });
    } else if (op === OPS.lineTo) {
      const p = point(); ensure().commands.push({ op: "L", x: p[0], y: p[1] });
    } else if (op === OPS.curveTo) {
      const a = point(), b = point(), c = point();
      ensure().commands.push({ op: "C", x1: a[0], y1: a[1], x2: b[0], y2: b[1], x: c[0], y: c[1] });
    } else if (op === OPS.curveTo2) {
      const b = point(), c = point();
      ensure().commands.push({ op: "C2", x2: b[0], y2: b[1], x: c[0], y: c[1] });
    } else if (op === OPS.curveTo3) {
      const a = point(), c = point();
      ensure().commands.push({ op: "C3", x1: a[0], y1: a[1], x: c[0], y: c[1] });
    } else if (op === OPS.closePath) {
      ensure().commands.push({ op: "Z" });
      ensure().closed = true;
    } else if (op === OPS.rectangle) {
      const x = Number(coordinates[coordinateIndex++] || 0), y = Number(coordinates[coordinateIndex++] || 0);
      const width = Number(coordinates[coordinateIndex++] || 0), height = Number(coordinates[coordinateIndex++] || 0);
      const corners = [[x, y], [x + width, y], [x + width, y + height], [x, y + height]].map(([px, py]) => transformPoint(matrix, px, py));
      current = { commands: [
        { op: "M", x: corners[0][0], y: corners[0][1] },
        { op: "L", x: corners[1][0], y: corners[1][1] },
        { op: "L", x: corners[2][0], y: corners[2][1] },
        { op: "L", x: corners[3][0], y: corners[3][1] },
        { op: "Z" }
      ], closed: true };
      subpaths.push(current);
    }
  }
  return subpaths.filter((entry) => entry.commands.length);
}

function finalizePath(entry, state, paint, forceClose) {
  const commands = [...entry.commands];
  const closed = forceClose || entry.closed || commands.some((command) => command.op === "Z");
  if (forceClose && !commands.some((command) => command.op === "Z")) commands.push({ op: "Z" });
  const points = pathPoints(commands);
  if (points.length < 2) return null;
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return {
    commands,
    closed,
    paint,
    lineWidthPt: state.lineWidthPt,
    strokeColor: state.strokeColor,
    fillColor: state.fillColor,
    dash: state.dash,
    pointCount: points.length,
    bounds: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
  };
}

function pathPoints(commands) {
  const result = [];
  for (const command of commands || []) {
    if (Number.isFinite(command.x) && Number.isFinite(command.y)) result.push([command.x, command.y]);
  }
  return result;
}

function geometrySemantic(classification, closed) {
  if (classification === "ride_layout") return closed ? "ride-envelope-or-structure" : "ride-centerline-or-edge";
  if (classification === "floor_plan") return closed ? "building-footprint-or-room" : "building-linework";
  if (classification === "roof_plan") return closed ? "roof-plane-or-footprint" : "roof-linework";
  if (classification === "landscape_plan") return closed ? "landscape-area-or-path" : "landscape-edge-or-route";
  if (classification === "demolition_plan") return closed ? "demolition-footprint" : "demolition-linework";
  if (classification === "site_plan" || classification === "location_plan") return closed ? "site-feature-or-building-footprint" : "site-edge-or-route";
  if (classification === "elevation" || classification === "section") return "vertical-profile-linework";
  return closed ? "unclassified-closed-geometry" : "unclassified-linework";
}

function verticalObservation(item, pageNumber, contentHash, label, valueM, raw, confidence) {
  return {
    contentHash,
    pageNumber,
    xPt: finiteOrNull(item.xPt),
    yPt: finiteOrNull(item.yPt),
    label: String(label || "").toUpperCase().replace(/\s+/g, " "),
    valueM,
    raw,
    confidence,
    source: "pdf-text-level-label",
    datum: /AOD/i.test(`${label} ${raw}`) ? "AOD" : "drawing-unspecified",
    georegistrationRequired: true
  };
}

function assessFinitePoint(value) {
  return Array.isArray(value) && value.length >= 2 && value.every(Number.isFinite);
}

function transformPoint(matrix, x, y) {
  const [a, b, c, d, e, f] = normalizeMatrix(matrix);
  const result = [a * x + c * y + e, b * x + d * y + f];
  return assessFinitePoint(result) ? result : [0, 0];
}

function multiplyMatrices(left, right) {
  const [a1, b1, c1, d1, e1, f1] = normalizeMatrix(left);
  const [a2, b2, c2, d2, e2, f2] = normalizeMatrix(right);
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1
  ];
}

function normalizeMatrix(value) {
  const input = Array.isArray(value) || ArrayBuffer.isView(value) ? [...value] : [];
  return input.length >= 6 && input.slice(0, 6).every((entry) => Number.isFinite(Number(entry)))
    ? input.slice(0, 6).map(Number)
    : [1, 0, 0, 1, 0, 0];
}

function defaultGraphicsState() {
  return { transform: [1, 0, 0, 1, 0, 0], lineWidthPt: 1, strokeColor: null, fillColor: null, dash: [] };
}

function cloneGraphicsState(state) {
  return {
    transform: [...state.transform],
    lineWidthPt: state.lineWidthPt,
    strokeColor: state.strokeColor ? [...state.strokeColor] : null,
    fillColor: state.fillColor ? [...state.fillColor] : null,
    dash: [...state.dash]
  };
}

function normalizeRgb(args) {
  const values = Array.isArray(args) || ArrayBuffer.isView(args) ? [...args] : [];
  if (values.length < 3) return null;
  return values.slice(0, 3).map((entry) => {
    const value = Number(entry);
    return Number.isFinite(value) ? Math.max(0, Math.min(255, value <= 1 ? Math.round(value * 255) : Math.round(value))) : 0;
  });
}

function isImagePaintOperation(fn, OPS) {
  return [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintSolidColorImageMask].filter((value) => value != null).includes(fn);
}

function viewportFromPage(page) {
  const view = Array.isArray(page?.view) ? page.view : [0, 0, 0, 0];
  return { width: Math.abs(Number(view[2] || 0) - Number(view[0] || 0)), height: Math.abs(Number(view[3] || 0) - Number(view[1] || 0)), rotation: page?.rotate || 0 };
}

function emptyNormalizedEvidence() {
  return {
    schemaVersion: 1,
    coordinateSpace: "document-pixels",
    georegistrationStatus: "required",
    worldGeometryReady: false,
    geometryCandidates: [],
    verticalObservations: [],
    materialObservations: [],
    drawingMetadata: []
  };
}

function dedupeObservations(values, keyFn) {
  const seen = new Set();
  return values.filter((value) => {
    const key = keyFn(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, places = 2) {
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** places;
  return Math.round(Number(value) * factor) / factor;
}

function clampInt(value, min, max) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : min;
}
