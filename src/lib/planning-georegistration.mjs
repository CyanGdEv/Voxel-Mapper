import { geometryMapCoordinates, walkPositions } from "./geo.mjs";

const DEFAULT_INLIER_THRESHOLD_M = 1.5;
const DEFAULT_MAX_RMSE_M = 1.25;
const DEFAULT_MAX_RESIDUAL_M = 3.5;
const DEFAULT_MIN_INLIERS = 3;
const DEFAULT_MAX_SCALE_ERROR = 0.22;
const DEFAULT_MAX_AFFINE_ANISOTROPY = 0.08;
const DEFAULT_MAX_AFFINE_SHEAR = 0.08;

/**
 * Solves a document-page-space -> local-world-metre transform.
 *
 * This is deliberately an authority gate. A numerically solvable transform is
 * not considered registered unless it also passes residual, scale, reflection
 * and (for affine fits) distortion checks.
 */
export function solvePlanningGeoregistration(controlPoints, options = {}) {
  const points = normalizeControlPoints(controlPoints);
  const requestedModel = String(options.model || "similarity").toLowerCase();
  if (!["similarity", "affine", "auto"].includes(requestedModel)) {
    throw new Error(`Unsupported planning georegistration model: ${requestedModel}`);
  }
  if (points.length < 2) return failedSolution("insufficient-control-points", requestedModel, points.length);

  const similarity = robustFit(points, "similarity", options);
  let selected = similarity;
  if ((requestedModel === "affine" || requestedModel === "auto") && points.length >= 3) {
    const affine = robustFit(points, "affine", options);
    if (requestedModel === "affine") selected = affine;
    else if (affine && similarity && shouldPreferAffine(similarity, affine, options)) selected = affine;
    else if (!similarity) selected = affine;
  }
  if (!selected) return failedSolution("unsolved-transform", requestedModel, points.length);

  const expectedScale = expectedMetresPerPoint(options.scaleDenominator);
  const scaleCheck = validateScale(selected, expectedScale, options);
  const distortionCheck = validateDistortion(selected, options);
  const maxRmseM = finite(options.maxRmseM, DEFAULT_MAX_RMSE_M);
  const maxResidualM = finite(options.maxResidualM, DEFAULT_MAX_RESIDUAL_M);
  const minInliers = Math.max(selected.model === "affine" ? 3 : 2, Math.floor(finite(options.minInliers, DEFAULT_MIN_INLIERS)));
  const reasons = [];
  if (selected.inlierCount < minInliers) reasons.push(`inliers ${selected.inlierCount} < ${minInliers}`);
  if (!(selected.rmseM <= maxRmseM)) reasons.push(`RMSE ${round(selected.rmseM, 3)}m > ${maxRmseM}m`);
  if (!(selected.maxResidualM <= maxResidualM)) reasons.push(`max residual ${round(selected.maxResidualM, 3)}m > ${maxResidualM}m`);
  if (!scaleCheck.pass) reasons.push(scaleCheck.reason);
  if (!distortionCheck.pass) reasons.push(distortionCheck.reason);
  if (selected.determinant <= 0) reasons.push("reflected or degenerate transform");

  return {
    schemaVersion: 1,
    status: reasons.length ? "rejected" : "registered",
    pass: reasons.length === 0,
    model: selected.model,
    transform: selected.transform,
    controlPointCount: points.length,
    inlierCount: selected.inlierCount,
    outlierCount: points.length - selected.inlierCount,
    inlierIndexes: selected.inlierIndexes,
    residualsM: selected.residualsM,
    rmseM: selected.rmseM,
    maxResidualM: selected.maxResidualM,
    medianResidualM: selected.medianResidualM,
    scaleMPerPt: selected.scaleMPerPt,
    rotationDeg: selected.rotationDeg,
    determinant: selected.determinant,
    affine: selected.affine || null,
    expectedScaleMPerPt: expectedScale,
    scaleRelativeError: scaleCheck.relativeError,
    qualityGates: {
      minInliers,
      maxRmseM,
      maxResidualM,
      maxScaleRelativeError: finite(options.maxScaleRelativeError, DEFAULT_MAX_SCALE_ERROR),
      maxAffineAnisotropy: finite(options.maxAffineAnisotropy, DEFAULT_MAX_AFFINE_ANISOTROPY),
      maxAffineShear: finite(options.maxAffineShear, DEFAULT_MAX_AFFINE_SHEAR)
    },
    rejectionReasons: reasons,
    authority: {
      coordinateSpace: "local-world-metres",
      spatialRegistrationPassed: reasons.length === 0,
      temporalResolutionStillRequired: true,
      worldGeometryAuthority: false,
      promotionRule: "registered planning geometry is spatially eligible; temporal/current-state and per-attribute fusion remain mandatory"
    }
  };
}

/**
 * Attempts conservative automatic control-point discovery by matching closed
 * planning vectors to compatible mapped polygon features. The shape matcher is
 * rotation/translation/scale independent and uses a drawing-scale hint when
 * one is available. It returns candidate control points; the robust solver is
 * still responsible for final acceptance/rejection.
 */
export function discoverAutomaticPlanningControlPoints(extraction, referenceFeatures, options = {}) {
  const maxCandidates = Math.max(1, Math.floor(finite(options.maxPlanningShapeCandidates, 120)));
  const maxReferences = Math.max(1, Math.floor(finite(options.maxReferenceShapeCandidates, 400)));
  const maxShapeRmseM = finite(options.maxAutoShapeRmseM, 1.8);
  const expectedByPage = drawingScaleByPage(extraction);
  const planning = (extraction?.normalizedEvidence?.geometryCandidates || [])
    .filter((candidate) => candidate.closed && candidate.commands?.length)
    .slice(0, maxCandidates)
    .map((candidate) => ({ candidate, points: commandsToPoints(candidate.commands) }))
    .filter((entry) => uniquePoints(entry.points).length >= 3);
  const references = (referenceFeatures || [])
    .filter((feature) => compatibleReferenceKind(feature?.kind))
    .map((feature) => ({ feature, points: referenceOuterRing(feature?.localGeometry) }))
    .filter((entry) => entry.points.length >= 3)
    .slice(0, maxReferences);

  const hypotheses = [];
  for (const source of planning) {
    const sourcePoints = sampledPoints(uniquePoints(source.points), 96);
    for (const target of references) {
      if (!semanticCompatible(source.candidate.semantic, target.feature.kind)) continue;
      const targetPoints = sampledPoints(uniquePoints(target.points), 128);
      const fit = fitShapePair(sourcePoints, targetPoints);
      if (!fit) continue;
      const expectedScale = expectedByPage.get(source.candidate.pageNumber) || null;
      if (expectedScale) {
        const relativeError = Math.abs(fit.scaleMPerPt - expectedScale) / expectedScale;
        if (relativeError > finite(options.maxAutoScaleRelativeError, 0.28)) continue;
      }
      if (fit.rmseM > maxShapeRmseM) continue;
      hypotheses.push({ source, target, fit });
    }
  }

  hypotheses.sort((a, b) => a.fit.rmseM - b.fit.rmseM || b.fit.coverage - a.fit.coverage);
  const usedSource = new Set();
  const usedTarget = new Set();
  const controls = [];
  const matches = [];
  const maxMatches = Math.max(1, Math.floor(finite(options.maxAutomaticShapeMatches, 12)));
  for (const hypothesis of hypotheses) {
    const sourceId = hypothesis.source.candidate.id;
    const targetId = hypothesis.target.feature.id;
    if (usedSource.has(sourceId) || usedTarget.has(targetId)) continue;
    usedSource.add(sourceId); usedTarget.add(targetId);
    const pairControls = controlPointsFromShapeMatch(hypothesis.source.points, hypothesis.target.points, hypothesis.fit, {
      sourceId, targetId,
      maxPoints: Math.max(3, Math.floor(finite(options.controlPointsPerShapeMatch, 6)))
    });
    controls.push(...pairControls);
    matches.push({
      sourceCandidateId: sourceId,
      targetFeatureId: targetId,
      pageNumber: hypothesis.source.candidate.pageNumber,
      rmseM: hypothesis.fit.rmseM,
      scaleMPerPt: hypothesis.fit.scaleMPerPt,
      rotationDeg: hypothesis.fit.rotationDeg,
      controlPoints: pairControls.length
    });
    if (matches.length >= maxMatches) break;
  }
  return { controlPoints: controls, matches };
}

/**
 * Registers one merged vector-extraction manifest. Explicit control points can
 * be supplied and are combined with conservative automatically discovered
 * points. No candidate is promoted when the quality gate fails.
 */
export function georegisterPlanningEvidence(extraction, referenceFeatures = [], options = {}) {
  const automatic = options.disableAutomaticControlPoints
    ? { controlPoints: [], matches: [] }
    : discoverAutomaticPlanningControlPoints(extraction, referenceFeatures, options);
  const explicit = normalizeControlPoints(options.controlPoints || []);
  const all = [...explicit, ...automatic.controlPoints];
  const scaleDenominator = options.scaleDenominator || dominantDrawingScale(extraction);
  const solution = solvePlanningGeoregistration(all, { ...options, scaleDenominator });
  if (!solution.pass) {
    return {
      schemaVersion: 1,
      status: "unregistered",
      solution,
      automaticMatches: automatic.matches,
      explicitControlPoints: explicit.length,
      automaticControlPoints: automatic.controlPoints.length,
      registeredEvidence: null,
      originalEvidenceRetained: true
    };
  }
  const registeredEvidence = promotePlanningEvidence(extraction?.normalizedEvidence || {}, solution, options);
  return {
    schemaVersion: 1,
    status: "registered",
    solution,
    automaticMatches: automatic.matches,
    explicitControlPoints: explicit.length,
    automaticControlPoints: automatic.controlPoints.length,
    registeredEvidence,
    originalEvidenceRetained: true
  };
}

export function applyPlanningGeoregistrationPoint(point, solutionOrTransform) {
  const transform = solutionOrTransform?.transform || solutionOrTransform;
  if (!transform) throw new Error("Planning georegistration transform is required");
  const x = Number(point?.[0]), y = Number(point?.[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Planning georegistration point must be finite");
  if (transform.model === "affine") {
    return [transform.a * x + transform.b * y + transform.tx, transform.c * x + transform.d * y + transform.ty];
  }
  return [transform.a * x - transform.b * y + transform.tx, transform.b * x + transform.a * y + transform.ty];
}

export function applyPlanningGeoregistrationCommands(commands, solutionOrTransform) {
  return (commands || []).map((command) => {
    const result = { ...command };
    for (const suffix of ["", "1", "2"]) {
      const xKey = `x${suffix}`, yKey = `y${suffix}`;
      if (!Number.isFinite(command[xKey]) || !Number.isFinite(command[yKey])) continue;
      const [x, z] = applyPlanningGeoregistrationPoint([command[xKey], command[yKey]], solutionOrTransform);
      result[xKey] = x;
      result[`z${suffix}`] = z;
      delete result[yKey];
    }
    return result;
  });
}

function promotePlanningEvidence(evidence, solution, options) {
  const geometryCandidates = (evidence.geometryCandidates || []).map((candidate) => {
    const registeredCommands = applyPlanningGeoregistrationCommands(candidate.commands || [], solution);
    const localGeometry = commandsToLocalGeometry(candidate.commands || [], candidate.closed, solution);
    const promoted = {
      ...candidate,
      coordinateSpace: "local-world-metres",
      sourceCoordinateSpace: candidate.coordinateSpace || "pdf-user-space-points",
      georegistrationRequired: false,
      georegistrationStatus: "registered",
      spatialAuthorityEligible: true,
      worldGeometryAuthority: false,
      temporalResolutionRequired: true,
      registration: compactSolution(solution),
      registeredCommands,
      localGeometry
    };
    if (options.projector?.inverse && localGeometry) {
      promoted.geometry = geometryMapCoordinates(localGeometry, options.projector.inverse);
    }
    return promoted;
  });
  const verticalObservations = (evidence.verticalObservations || []).map((entry) => promotePositionedObservation(entry, solution));
  const materialObservations = (evidence.materialObservations || []).map((entry) => promotePositionedObservation(entry, solution));
  return {
    schemaVersion: 1,
    coordinateSpace: "local-world-metres",
    georegistrationStatus: "registered",
    worldGeometryReady: true,
    worldGeometryAuthority: false,
    spatialAuthorityEligible: true,
    temporalResolutionRequired: true,
    promotionRule: "temporal/current-state and per-attribute fusion must run before registered planning evidence can override lower-authority geometry",
    registration: compactSolution(solution),
    geometryCandidates,
    verticalObservations,
    materialObservations,
    drawingMetadata: evidence.drawingMetadata || []
  };
}

function promotePositionedObservation(entry, solution) {
  if (!Number.isFinite(entry?.xPt) || !Number.isFinite(entry?.yPt)) return { ...entry, georegistrationStatus: "registered-unpositioned" };
  const [localX, localZ] = applyPlanningGeoregistrationPoint([entry.xPt, entry.yPt], solution);
  return {
    ...entry,
    localX,
    localZ,
    coordinateSpace: "local-world-metres",
    georegistrationRequired: false,
    georegistrationStatus: "registered",
    registration: compactSolution(solution)
  };
}

function robustFit(points, model, options) {
  const sampleSize = model === "affine" ? 3 : 2;
  if (points.length < sampleSize) return null;
  const threshold = finite(options.inlierThresholdM, DEFAULT_INLIER_THRESHOLD_M);
  const maxSamples = Math.max(1, Math.floor(finite(options.maxRobustSamples, 600)));
  let best = null;
  let seen = 0;
  for (const indexes of combinations(points.length, sampleSize)) {
    if (seen++ >= maxSamples) break;
    const sample = indexes.map((index) => points[index]);
    const transform = model === "affine" ? fitAffine(sample) : fitSimilarity(sample);
    if (!transform || transformDeterminant(transform) <= 0) continue;
    const residuals = residualsFor(points, transform);
    const inliers = residuals.map((value, index) => value <= threshold ? index : -1).filter((index) => index >= 0);
    const score = { count: inliers.length, rmse: rmse(inliers.map((index) => residuals[index])) };
    if (!best || score.count > best.count || (score.count === best.count && score.rmse < best.rmse)) {
      best = { transform, inliers, count: score.count, rmse: score.rmse };
    }
  }
  if (!best || best.inliers.length < sampleSize) return null;
  let inlierIndexes = best.inliers;
  let transform = model === "affine" ? fitAffine(inlierIndexes.map((index) => points[index])) : fitSimilarity(inlierIndexes.map((index) => points[index]));
  if (!transform) return null;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const residuals = residualsFor(points, transform);
    const values = inlierIndexes.map((index) => residuals[index]);
    const med = median(values), mad = median(values.map((value) => Math.abs(value - med)));
    const adaptive = Math.max(threshold, med + 2.5 * 1.4826 * mad);
    const next = residuals.map((value, index) => value <= adaptive ? index : -1).filter((index) => index >= 0);
    if (next.length < sampleSize || sameIndexes(next, inlierIndexes)) break;
    inlierIndexes = next;
    transform = model === "affine" ? fitAffine(next.map((index) => points[index])) : fitSimilarity(next.map((index) => points[index]));
    if (!transform) return null;
  }
  const residualsM = residualsFor(points, transform);
  const inlierResiduals = inlierIndexes.map((index) => residualsM[index]);
  const metrics = transformMetrics(transform);
  return {
    model,
    transform: { model, ...transform },
    inlierIndexes,
    inlierCount: inlierIndexes.length,
    residualsM,
    rmseM: rmse(inlierResiduals),
    maxResidualM: Math.max(...inlierResiduals),
    medianResidualM: median(inlierResiduals),
    ...metrics
  };
}

function fitSimilarity(points) {
  const totalWeight = points.reduce((sum, point) => sum + point.weight, 0);
  if (!(totalWeight > 0)) return null;
  const sx = weightedMean(points, (point) => point.source[0], totalWeight);
  const sy = weightedMean(points, (point) => point.source[1], totalWeight);
  const txm = weightedMean(points, (point) => point.target[0], totalWeight);
  const tym = weightedMean(points, (point) => point.target[1], totalWeight);
  let dot = 0, cross = 0, denom = 0;
  for (const point of points) {
    const x = point.source[0] - sx, y = point.source[1] - sy;
    const u = point.target[0] - txm, v = point.target[1] - tym;
    dot += point.weight * (x * u + y * v);
    cross += point.weight * (x * v - y * u);
    denom += point.weight * (x * x + y * y);
  }
  if (!(denom > 1e-12)) return null;
  const a = dot / denom, b = cross / denom;
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.hypot(a, b) < 1e-12) return null;
  return { a, b, tx: txm - a * sx + b * sy, ty: tym - b * sx - a * sy };
}

function fitAffine(points) {
  const ata = Array.from({ length: 6 }, () => Array(6).fill(0));
  const atb = Array(6).fill(0);
  const add = (row, value, weight) => {
    for (let i = 0; i < 6; i += 1) {
      atb[i] += row[i] * value * weight;
      for (let j = 0; j < 6; j += 1) ata[i][j] += row[i] * row[j] * weight;
    }
  };
  for (const point of points) {
    const [x, y] = point.source, [u, v] = point.target, w = point.weight;
    add([x, y, 1, 0, 0, 0], u, w);
    add([0, 0, 0, x, y, 1], v, w);
  }
  const solved = solveLinearSystem(ata, atb);
  if (!solved) return null;
  return { a: solved[0], b: solved[1], tx: solved[2], c: solved[3], d: solved[4], ty: solved[5] };
}

function residualsFor(points, transform) {
  const wrapped = { model: "c" in transform ? "affine" : "similarity", ...transform };
  return points.map((point) => {
    const target = applyPlanningGeoregistrationPoint(point.source, wrapped);
    return Math.hypot(target[0] - point.target[0], target[1] - point.target[1]);
  });
}

function transformMetrics(transform) {
  if ("c" in transform) {
    const sx = Math.hypot(transform.a, transform.c);
    const sy = Math.hypot(transform.b, transform.d);
    const dot = transform.a * transform.b + transform.c * transform.d;
    const shear = Math.abs(dot / ((sx * sy) || 1));
    const mean = (sx + sy) / 2;
    return {
      scaleMPerPt: mean,
      rotationDeg: Math.atan2(transform.c, transform.a) * 180 / Math.PI,
      determinant: transform.a * transform.d - transform.b * transform.c,
      affine: { scaleX: sx, scaleY: sy, anisotropy: mean ? Math.abs(sx - sy) / mean : Infinity, shear }
    };
  }
  return {
    scaleMPerPt: Math.hypot(transform.a, transform.b),
    rotationDeg: Math.atan2(transform.b, transform.a) * 180 / Math.PI,
    determinant: transform.a * transform.a + transform.b * transform.b,
    affine: null
  };
}

function validateScale(solution, expectedScale, options) {
  if (!expectedScale) return { pass: true, relativeError: null, reason: null };
  const relativeError = Math.abs(solution.scaleMPerPt - expectedScale) / expectedScale;
  const maximum = finite(options.maxScaleRelativeError, DEFAULT_MAX_SCALE_ERROR);
  return { pass: relativeError <= maximum, relativeError, reason: `scale differs from drawing title-block by ${round(relativeError * 100, 1)}%` };
}

function validateDistortion(solution, options) {
  if (solution.model !== "affine") return { pass: true, reason: null };
  const maxAnisotropy = finite(options.maxAffineAnisotropy, DEFAULT_MAX_AFFINE_ANISOTROPY);
  const maxShear = finite(options.maxAffineShear, DEFAULT_MAX_AFFINE_SHEAR);
  if (solution.affine.anisotropy > maxAnisotropy) return { pass: false, reason: `affine anisotropy ${round(solution.affine.anisotropy, 4)} exceeds ${maxAnisotropy}` };
  if (solution.affine.shear > maxShear) return { pass: false, reason: `affine shear ${round(solution.affine.shear, 4)} exceeds ${maxShear}` };
  return { pass: true, reason: null };
}

function shouldPreferAffine(similarity, affine, options) {
  if (!affine) return false;
  const improvement = similarity.rmseM > 0 ? (similarity.rmseM - affine.rmseM) / similarity.rmseM : 0;
  return improvement >= finite(options.minAffineRmseImprovement, 0.35) && validateDistortion(affine, options).pass;
}

function fitShapePair(sourcePoints, targetPoints) {
  const sourcePair = farthestPair(sourcePoints), targetPair = farthestPair(targetPoints);
  if (!sourcePair || !targetPair || sourcePair.distance < 1e-9 || targetPair.distance < 0.5) return null;
  const hypotheses = [
    [targetPair.a, targetPair.b],
    [targetPair.b, targetPair.a]
  ];
  let best = null;
  for (const [ta, tb] of hypotheses) {
    const transform = fitSimilarity([
      { source: sourcePair.a, target: ta, weight: 1 },
      { source: sourcePair.b, target: tb, weight: 1 }
    ]);
    if (!transform) continue;
    const transformed = sourcePoints.map((point) => applyPlanningGeoregistrationPoint(point, { model: "similarity", ...transform }));
    const distances = transformed.map((point) => nearestPointDistance(point, targetPoints));
    const value = rmse(distances);
    const coverage = distances.filter((distance) => distance <= Math.max(1.5, targetPair.distance * 0.04)).length / distances.length;
    const metrics = transformMetrics(transform);
    const current = { transform, rmseM: value, coverage, ...metrics };
    if (!best || current.rmseM < best.rmseM) best = current;
  }
  return best;
}

function controlPointsFromShapeMatch(sourcePointsRaw, targetPointsRaw, fit, context) {
  const sourcePoints = sampledPoints(uniquePoints(sourcePointsRaw), 64);
  const targetPoints = uniquePoints(targetPointsRaw);
  const ranked = sourcePoints.map((source, index) => {
    const transformed = applyPlanningGeoregistrationPoint(source, { model: "similarity", ...fit.transform });
    const nearest = nearestPoint(transformed, targetPoints);
    return { source, target: nearest.point, residualM: nearest.distance, index };
  }).sort((a, b) => a.residualM - b.residualM);
  const chosen = [];
  for (const candidate of ranked) {
    if (chosen.some((entry) => Math.hypot(entry.source[0] - candidate.source[0], entry.source[1] - candidate.source[1]) < 8)) continue;
    if (chosen.some((entry) => Math.hypot(entry.target[0] - candidate.target[0], entry.target[1] - candidate.target[1]) < 0.75)) continue;
    chosen.push(candidate);
    if (chosen.length >= context.maxPoints) break;
  }
  return chosen.map((entry) => ({
    source: entry.source,
    target: entry.target,
    weight: 0.65,
    method: "automatic-shape-match",
    sourceId: context.sourceId,
    targetId: context.targetId,
    seedResidualM: entry.residualM
  }));
}

function commandsToLocalGeometry(commands, closed, solution) {
  const points = commandsToPoints(commands).map((point) => applyPlanningGeoregistrationPoint(point, solution));
  const unique = uniquePoints(points);
  if (closed && unique.length >= 3) return { type: "Polygon", coordinates: [[...unique, unique[0]]] };
  if (unique.length >= 2) return { type: "LineString", coordinates: unique };
  return null;
}

function commandsToPoints(commands) {
  const points = [];
  for (const command of commands || []) {
    if (Number.isFinite(command.x) && Number.isFinite(command.y)) points.push([command.x, command.y]);
  }
  return points;
}

function referenceOuterRing(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return geometry.coordinates?.[0] || [];
  if (geometry.type === "MultiPolygon") return geometry.coordinates?.[0]?.[0] || [];
  return [];
}

function compatibleReferenceKind(kind) {
  return ["building", "structure", "path", "road", "ride_track", "barrier", "water", "terrain_detail"].includes(String(kind || ""));
}

function semanticCompatible(semantic, kind) {
  const value = String(semantic || ""), target = String(kind || "");
  if (/building|roof/.test(value)) return target === "building" || target === "structure";
  if (/ride/.test(value)) return target === "ride_track" || target === "structure";
  if (/landscape|site-area|footprint/.test(value)) return ["building", "structure", "path", "road", "water", "terrain_detail"].includes(target);
  if (/demolition/.test(value)) return target === "building" || target === "structure";
  return target === "building" || target === "structure";
}

function drawingScaleByPage(extraction) {
  const result = new Map();
  for (const metadata of extraction?.normalizedEvidence?.drawingMetadata || []) {
    const scale = expectedMetresPerPoint(metadata?.scaleDenominator);
    if (scale) result.set(Number(metadata.pageNumber || 1), scale);
  }
  return result;
}

function dominantDrawingScale(extraction) {
  const counts = new Map();
  for (const metadata of extraction?.normalizedEvidence?.drawingMetadata || []) {
    const value = Number(metadata?.scaleDenominator);
    if (!Number.isFinite(value) || value <= 0) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] || null;
}

function expectedMetresPerPoint(scaleDenominator) {
  const scale = Number(scaleDenominator);
  return Number.isFinite(scale) && scale > 0 ? scale * 0.0254 / 72 : null;
}

function normalizeControlPoints(values) {
  return (values || []).map((point, index) => {
    const source = [Number(point?.source?.[0]), Number(point?.source?.[1])];
    const target = [Number(point?.target?.[0]), Number(point?.target?.[1])];
    if (![...source, ...target].every(Number.isFinite)) throw new Error(`Invalid planning control point ${index}`);
    return { ...point, source, target, weight: Number.isFinite(Number(point.weight)) && Number(point.weight) > 0 ? Number(point.weight) : 1 };
  });
}

function solveLinearSystem(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, index) => [...row, vector[index]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = a[col][col];
    for (let j = col; j <= n; j += 1) a[col][j] /= divisor;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let j = col; j <= n; j += 1) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map((row) => row[n]);
}

function combinations(n, k) {
  const values = [];
  const current = [];
  const visit = (start) => {
    if (current.length === k) { values.push([...current]); return; }
    for (let index = start; index < n; index += 1) {
      current.push(index); visit(index + 1); current.pop();
      if (values.length >= 5_000) return;
    }
  };
  visit(0);
  return values;
}

function farthestPair(points) {
  const values = sampledPoints(points, 96);
  let best = null;
  for (let i = 0; i < values.length; i += 1) for (let j = i + 1; j < values.length; j += 1) {
    const distance = Math.hypot(values[j][0] - values[i][0], values[j][1] - values[i][1]);
    if (!best || distance > best.distance) best = { a: values[i], b: values[j], distance };
  }
  return best;
}

function nearestPointDistance(point, points) { return nearestPoint(point, points).distance; }
function nearestPoint(point, points) {
  let best = { point: points[0], distance: Infinity };
  for (const target of points) {
    const distance = Math.hypot(point[0] - target[0], point[1] - target[1]);
    if (distance < best.distance) best = { point: target, distance };
  }
  return best;
}

function uniquePoints(points) {
  const result = [], seen = new Set();
  for (const point of points || []) {
    const key = `${round(point[0], 6)},${round(point[1], 6)}`;
    if (seen.has(key)) continue;
    seen.add(key); result.push([Number(point[0]), Number(point[1])]);
  }
  return result;
}

function sampledPoints(points, max) {
  if ((points || []).length <= max) return points || [];
  const result = [];
  const step = points.length / max;
  for (let index = 0; index < max; index += 1) result.push(points[Math.floor(index * step)]);
  return result;
}

function weightedMean(points, getter, total) { return points.reduce((sum, point) => sum + getter(point) * point.weight, 0) / total; }
function rmse(values) { return values.length ? Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length) : Infinity; }
function median(values) {
  if (!values.length) return Infinity;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function sameIndexes(a, b) { return a.length === b.length && a.every((value, index) => value === b[index]); }
function transformDeterminant(transform) { return "c" in transform ? transform.a * transform.d - transform.b * transform.c : transform.a * transform.a + transform.b * transform.b; }
function finite(value, fallback) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
function round(value, places = 6) { if (!Number.isFinite(Number(value))) return null; const factor = 10 ** places; return Math.round(Number(value) * factor) / factor; }
function compactSolution(solution) {
  return {
    model: solution.model,
    transform: solution.transform,
    rmseM: solution.rmseM,
    maxResidualM: solution.maxResidualM,
    inlierCount: solution.inlierCount,
    controlPointCount: solution.controlPointCount,
    scaleMPerPt: solution.scaleMPerPt,
    rotationDeg: solution.rotationDeg
  };
}
function failedSolution(reason, model, count) {
  return {
    schemaVersion: 1,
    status: "rejected",
    pass: false,
    model,
    controlPointCount: count,
    inlierCount: 0,
    rejectionReasons: [reason],
    authority: {
      coordinateSpace: "pdf-user-space-points",
      spatialRegistrationPassed: false,
      temporalResolutionStillRequired: true,
      worldGeometryAuthority: false
    }
  };
}
