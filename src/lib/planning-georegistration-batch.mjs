import { georegisterPlanningEvidence } from "./planning-georegistration.mjs";

/**
 * Runs the spatial registration gate independently for every document page.
 * PDF page coordinates are local to that page; sharing a transform between
 * pages/documents would be a severe accuracy error even when page numbers or
 * drawing scales happen to match.
 */
export function georegisterPlanningEvidenceBatch(extraction, referenceFeatures = [], options = {}) {
  const groups = splitPlanningEvidenceByPage(extraction);
  if (!groups.length) {
    return {
      schemaVersion: 1,
      status: "unregistered",
      groupCount: 0,
      registeredGroupCount: 0,
      unregisteredGroupCount: 0,
      registrations: [],
      registeredEvidence: emptyRegisteredEvidence(),
      warnings: ["No page-scoped planning evidence was available for georegistration."]
    };
  }

  const registrations = [];
  for (const group of groups) {
    const controlPoints = controlsForGroup(options.controlPoints || [], group, groups.length);
    const result = georegisterPlanningEvidence(group.extraction, referenceFeatures, {
      ...options,
      controlPoints
    });
    registrations.push({
      key: group.key,
      contentHash: group.contentHash,
      pageNumber: group.pageNumber,
      status: result.status,
      solution: result.solution,
      automaticMatches: result.automaticMatches,
      explicitControlPoints: result.explicitControlPoints,
      automaticControlPoints: result.automaticControlPoints,
      registeredEvidence: result.registeredEvidence
    });
  }

  const successful = registrations.filter((entry) => entry.status === "registered" && entry.registeredEvidence);
  const failed = registrations.filter((entry) => entry.status !== "registered");
  return {
    schemaVersion: 1,
    status: successful.length === registrations.length ? "registered" : successful.length ? "partially-registered" : "unregistered",
    groupCount: registrations.length,
    registeredGroupCount: successful.length,
    unregisteredGroupCount: failed.length,
    registrations,
    registeredEvidence: mergeRegisteredEvidence(successful.map((entry) => entry.registeredEvidence)),
    unregisteredPages: failed.map((entry) => ({
      key: entry.key,
      contentHash: entry.contentHash,
      pageNumber: entry.pageNumber,
      rejectionReasons: entry.solution?.rejectionReasons || ["registration-failed"]
    })),
    warnings: groups.length > 1 && (options.controlPoints || []).some((point) => !point.contentHash && !point.pageNumber)
      ? ["Unscoped explicit control points were ignored because the extraction contains multiple page coordinate systems."]
      : []
  };
}

export function splitPlanningEvidenceByPage(extraction) {
  const groups = new Map();
  const ensure = (contentHash, pageNumber) => {
    const hash = contentHash || extraction?.contentHash || "unknown-document";
    const page = Number(pageNumber || 1);
    const key = `${hash}:p${page}`;
    if (!groups.has(key)) groups.set(key, {
      key, contentHash: hash, pageNumber: page,
      geometryCandidates: [], verticalObservations: [], materialObservations: [], drawingMetadata: []
    });
    return groups.get(key);
  };

  // Legacy/full extraction manifests may still contain page-scoped evidence.
  // New compact manifests keep only page summaries here and store semantic
  // evidence once in normalizedEvidence below.
  for (const document of extraction?.documents || []) {
    for (const page of document?.pages || []) {
      const group = ensure(document.contentHash, page.pageNumber);
      group.geometryCandidates.push(...(page.geometryCandidates || []));
      group.verticalObservations.push(...(page.verticalObservations || []));
      group.materialObservations.push(...(page.materialObservations || []));
      if (page.metadata) group.drawingMetadata.push({ ...page.metadata, contentHash: page.metadata.contentHash || document.contentHash });
    }
  }

  // Canonical merged extraction evidence is retained once at the top level.
  // Rebuild per-page groups from that canonical set without requiring duplicate
  // page geometry in each document summary.
  const flat = extraction?.normalizedEvidence || {};
  for (const candidate of flat.geometryCandidates || []) {
    const group = ensure(candidate.contentHash, candidate.pageNumber);
    if (!group.geometryCandidates.some((entry) => entry.id === candidate.id)) group.geometryCandidates.push(candidate);
  }
  for (const observation of flat.verticalObservations || []) {
    const group = ensure(observation.contentHash, observation.pageNumber);
    if (!hasEquivalent(group.verticalObservations, observation, "vertical")) group.verticalObservations.push(observation);
  }
  for (const observation of flat.materialObservations || []) {
    const group = ensure(observation.contentHash, observation.pageNumber);
    if (!hasEquivalent(group.materialObservations, observation, "material")) group.materialObservations.push(observation);
  }
  for (const metadata of flat.drawingMetadata || []) {
    const contentHash = metadata.contentHash || extraction?.contentHash || null;
    const group = ensure(contentHash, metadata.pageNumber);
    const normalized = { ...metadata, contentHash: metadata.contentHash || group.contentHash };
    if (!hasMetadataEquivalent(group.drawingMetadata, normalized)) group.drawingMetadata.push(normalized);
  }

  return [...groups.values()]
    .filter((group) => group.geometryCandidates.length || group.verticalObservations.length || group.materialObservations.length)
    .sort((a, b) => a.contentHash.localeCompare(b.contentHash) || a.pageNumber - b.pageNumber)
    .map((group) => ({
      key: group.key,
      contentHash: group.contentHash,
      pageNumber: group.pageNumber,
      extraction: {
        schemaVersion: 1,
        contentHash: group.contentHash,
        pageCount: 1,
        normalizedEvidence: {
          schemaVersion: 1,
          coordinateSpace: "pdf-user-space-points",
          georegistrationStatus: "required",
          worldGeometryReady: false,
          geometryCandidates: group.geometryCandidates,
          verticalObservations: group.verticalObservations,
          materialObservations: group.materialObservations,
          drawingMetadata: group.drawingMetadata
        }
      }
    }));
}

function controlsForGroup(values, group, groupCount) {
  const controls = values || [];
  if (groupCount === 1) return controls;
  return controls.filter((point) => {
    if (!point.contentHash && !point.pageNumber) return false;
    const hashMatches = !point.contentHash || point.contentHash === group.contentHash;
    const pageMatches = !point.pageNumber || Number(point.pageNumber) === group.pageNumber;
    return hashMatches && pageMatches;
  });
}

function mergeRegisteredEvidence(values) {
  const result = emptyRegisteredEvidence();
  for (const value of values || []) {
    result.geometryCandidates.push(...(value.geometryCandidates || []));
    result.verticalObservations.push(...(value.verticalObservations || []));
    result.materialObservations.push(...(value.materialObservations || []));
    result.drawingMetadata.push(...(value.drawingMetadata || []));
  }
  result.registeredPageCount = values.length;
  result.worldGeometryReady = values.length > 0;
  return result;
}

function emptyRegisteredEvidence() {
  return {
    schemaVersion: 1,
    coordinateSpace: "local-world-metres",
    georegistrationStatus: "page-scoped",
    worldGeometryReady: false,
    worldGeometryAuthority: false,
    spatialAuthorityEligible: true,
    temporalResolutionRequired: true,
    promotionRule: "temporal/current-state and per-attribute fusion remain mandatory after page-scoped spatial registration",
    registeredPageCount: 0,
    geometryCandidates: [],
    verticalObservations: [],
    materialObservations: [],
    drawingMetadata: []
  };
}

function hasEquivalent(values, candidate, type) {
  return values.some((entry) => {
    if ((entry.contentHash || null) !== (candidate.contentHash || null)) return false;
    if (Number(entry.pageNumber || 1) !== Number(candidate.pageNumber || 1)) return false;
    if (type === "vertical") return entry.label === candidate.label && entry.valueM === candidate.valueM && entry.xPt === candidate.xPt && entry.yPt === candidate.yPt;
    return entry.material === candidate.material && entry.xPt === candidate.xPt && entry.yPt === candidate.yPt;
  });
}

function hasMetadataEquivalent(values, candidate) {
  return values.some((entry) =>
    (entry.contentHash || null) === (candidate.contentHash || null) &&
    Number(entry.pageNumber || 1) === Number(candidate.pageNumber || 1) &&
    (entry.drawingNumber || null) === (candidate.drawingNumber || null) &&
    (entry.revision || null) === (candidate.revision || null) &&
    (entry.status || null) === (candidate.status || null) &&
    (entry.issueDate || null) === (candidate.issueDate || null)
  );
}
