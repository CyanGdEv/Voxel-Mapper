import { comparePlanningRevisions } from "./planning-revision-resolver.mjs";

const CURRENT_METADATA = /\b(?:as[- ]?built|record|existing|current|implemented|completed|built|operational)\b/i;
const NON_CURRENT_METADATA = /\b(?:planning|proposed|preliminary|submitted|pending|approved|granted|consent|construction|tender|superseded|obsolete|withdrawn|cancelled|canceled|refused|rejected|demolish|demolished|removed)\b/i;
const NON_CURRENT_OBJECT = new Set(["proposed", "removed", "demolished", "superseded", "withdrawn", "refused"]);

/**
 * Links geometry-backed planning objects to exact-code schedule/specification
 * observations across the merged planning-document set.
 *
 * This is deliberately an evidence-fusion pass, not an authority pass:
 * - exact canonical object code is mandatory (no fuzzy code matching)
 * - object families must be compatible
 * - only explicitly current/as-built/record/existing schedule pages participate
 * - later comparable current revisions win inside one drawing lineage
 * - conflicting current records fail closed
 * - the geometry object's attributes/kind/authority are never overwritten
 */
export function fusePlanningObjectSchedules(normalizedEvidence, options = {}) {
  if (!normalizedEvidence) return emptySummary("no-normalized-evidence");
  const candidates = normalizedEvidence.geometryCandidates || [];
  const metadata = normalizedEvidence.drawingMetadata || [];
  const records = collectScheduleRecords(metadata, options);
  const byCode = indexByCode(records);

  let objectsWithCode = 0;
  let resolved = 0;
  let conflicts = 0;
  let noCurrentRecord = 0;
  let incompatible = 0;

  for (const candidate of candidates) {
    const object = candidate?.planningObject;
    if (!object) continue;
    const code = canonicalObjectCode(object.objectCode);
    if (!code) {
      object.scheduleFusion = fusionResult("unresolved", object.objectCode || null, "missing-object-code");
      continue;
    }
    objectsWithCode += 1;

    const exact = byCode.get(code) || [];
    if (!exact.length) {
      noCurrentRecord += 1;
      object.scheduleFusion = fusionResult("unresolved", object.objectCode, "no-exact-current-schedule-record");
      continue;
    }

    const compatible = exact.filter((record) => compatibleObjectFamily(object, record));
    if (!compatible.length) {
      incompatible += 1;
      object.scheduleFusion = {
        ...fusionResult("unresolved", object.objectCode, "exact-code-records-have-incompatible-object-family"),
        rejectedRecordCount: exact.length,
        rejectedFamilies: [...new Set(exact.map((record) => record.objectType || "unknown"))].sort()
      };
      continue;
    }

    const selection = resolveCurrentRecords(compatible);
    if (selection.status === "conflict") {
      conflicts += 1;
      object.scheduleFusion = {
        ...fusionResult("conflict", object.objectCode, selection.reason),
        conflictFields: selection.conflictFields,
        sourceRecords: selection.records.map(compactRecord),
        reconstructionReady: false
      };
      continue;
    }

    if (selection.status !== "resolved") {
      noCurrentRecord += 1;
      object.scheduleFusion = fusionResult("unresolved", object.objectCode, selection.reason || "no-resolved-current-schedule-record");
      continue;
    }

    resolved += 1;
    const scheduleAttributes = mergeEquivalentAttributes(selection.records.map((record) => record.attributes || {}));
    object.scheduleFusion = {
      ...fusionResult("resolved", object.objectCode, "exact-code-current-schedule-record-resolved"),
      canonicalObjectCode: code,
      objectType: object.objectType || null,
      subtype: object.subtype || null,
      scheduleAttributes,
      sourceRecords: selection.records.map(compactRecord),
      sourceRecordCount: selection.records.length,
      reconstructionReady: false,
      authority: {
        evidenceOnly: true,
        exactCodeLinked: true,
        currentScheduleRequired: true,
        candidateGeoregistrationStillRequired: true,
        candidateTemporalCurrentStateStillRequired: true,
        grantsWorldGeometryAuthority: false,
        grantsTerrainGeometryAuthority: false,
        grantsTerrainElevationAuthority: false
      }
    };
  }

  const summary = {
    schemaVersion: 1,
    status: conflicts ? "resolved-with-conflicts" : resolved ? "resolved" : records.length ? "no-geometry-links" : "no-current-schedule-records",
    currentScheduleRecordCount: records.length,
    geometryObjectCount: candidates.filter((candidate) => candidate?.planningObject).length,
    geometryObjectsWithCode: objectsWithCode,
    resolvedObjectCount: resolved,
    conflictingObjectCount: conflicts,
    noCurrentRecordCount: noCurrentRecord,
    incompatibleFamilyCount: incompatible,
    policy: {
      exactCodeOnly: true,
      fuzzyCodeMatching: false,
      currentScheduleOnly: true,
      latestComparableCurrentRevisionWins: true,
      conflictingCurrentRecordsFailClosed: true,
      mutatesObjectAttributes: false,
      grantsWorldGeometryAuthority: false,
      terrainGeometryMutable: false,
      terrainElevationMutable: false
    }
  };
  normalizedEvidence.planningObjectScheduleFusion = summary;
  return summary;
}

export function collectPlanningObjectScheduleRecords(normalizedEvidence, options = {}) {
  return collectScheduleRecords(normalizedEvidence?.drawingMetadata || [], options).map(compactRecord);
}

export function canonicalObjectCode(value) {
  const text = String(value || "").trim().toUpperCase();
  if (!text) return null;
  const match = text.match(/^([A-Z]{1,8})\s*[-_:#./]?\s*(\d{1,5}[A-Z]?)$/);
  return match ? `${match[1]}${match[2]}` : null;
}

function collectScheduleRecords(metadataValues, options) {
  const records = [];
  for (const metadata of metadataValues || []) {
    const pageState = schedulePageState(metadata, options);
    if (pageState.state !== "current") continue;
    for (const observation of metadata?.planningObjectTextObservations || []) {
      const code = canonicalObjectCode(observation?.objectCode);
      if (!code) continue;
      const objectState = String(observation?.attributes?.status || "").toLowerCase();
      if (NON_CURRENT_OBJECT.has(objectState)) continue;
      records.push({
        ...observation,
        canonicalObjectCode: code,
        contentHash: observation.contentHash || metadata.contentHash || null,
        pageNumber: Number(observation.pageNumber || metadata.pageNumber || 1),
        drawingNumber: metadata.drawingNumber || null,
        revision: metadata.revision || null,
        drawingStatus: metadata.status || null,
        issueDate: metadata.issueDate || null,
        pageState
      });
    }
  }
  records.sort(recordOrder);
  return records;
}

function schedulePageState(metadata, options) {
  const temporal = metadata?.planningTemporal;
  if (temporal) {
    if (temporal.state === "current" && Number(temporal.confidence || 0) >= Number(options.currentScheduleConfidenceGate ?? 0.85)) {
      return { state: "current", confidence: Number(temporal.confidence || 0), source: "planning-temporal-resolution" };
    }
    return { state: "non-current", confidence: Number(temporal.confidence || 0), source: "planning-temporal-resolution", reason: temporal.reason || temporal.state };
  }

  const status = String(metadata?.status || "").trim();
  if (!status) return { state: "unknown", confidence: 0.45, source: "drawing-metadata", reason: "missing-explicit-current-status" };
  if (NON_CURRENT_METADATA.test(status)) return { state: "non-current", confidence: 0.95, source: "drawing-metadata", reason: "explicit-non-current-status" };
  if (CURRENT_METADATA.test(status)) return { state: "current", confidence: 0.92, source: "drawing-metadata", reason: "explicit-current-status" };
  return { state: "unknown", confidence: 0.5, source: "drawing-metadata", reason: "unrecognized-status" };
}

function indexByCode(records) {
  const map = new Map();
  for (const record of records) {
    if (!map.has(record.canonicalObjectCode)) map.set(record.canonicalObjectCode, []);
    map.get(record.canonicalObjectCode).push(record);
  }
  return map;
}

function compatibleObjectFamily(object, record) {
  if (!object?.objectType || !record?.objectType) return false;
  if (object.objectType !== record.objectType) return false;
  if (object.objectType === "ride_component" && object.subtype && record.subtype && object.subtype !== record.subtype) return false;
  return true;
}

function resolveCurrentRecords(records) {
  if (!records.length) return { status: "unresolved", reason: "no-current-records", records: [] };
  const lineages = new Map();
  for (const record of records) {
    const key = record.drawingNumber ? `drawing:${canonicalDrawing(record.drawingNumber)}` : `document:${record.contentHash || "unknown"}`;
    if (!lineages.has(key)) lineages.set(key, []);
    lineages.get(key).push(record);
  }

  const winners = [];
  for (const values of lineages.values()) {
    const selected = selectLatestComparable(values);
    if (selected.status === "conflict") return selected;
    winners.push(...selected.records);
  }
  if (!winners.length) return { status: "unresolved", reason: "no-current-lineage-winner", records: [] };

  const conflicts = conflictingAttributeKeys(winners);
  if (conflicts.length) {
    return { status: "conflict", reason: "conflicting-current-schedule-records", conflictFields: conflicts, records: winners };
  }
  return { status: "resolved", records: winners.sort(recordOrder) };
}

function selectLatestComparable(values) {
  const sorted = [...values].sort(recordOrder);
  if (sorted.length === 1) return { status: "resolved", records: sorted };

  let best = sorted[0];
  let peers = [best];
  for (const candidate of sorted.slice(1)) {
    if (candidate.revision && best.revision) {
      const comparison = comparePlanningRevisions(candidate.revision, best.revision);
      if (comparison != null && comparison > 0) {
        best = candidate;
        peers = [candidate];
        continue;
      }
      if (comparison != null && comparison < 0) continue;
      if (comparison === 0) {
        peers.push(candidate);
        continue;
      }
    }

    // When revision syntax is absent/incomparable, identical records are safe
    // duplicates. Different records are deliberately not ordered by date alone.
    if (attributesEquivalent(candidate.attributes, best.attributes)) peers.push(candidate);
    else {
      return {
        status: "conflict",
        reason: "ambiguous-current-schedule-revision-lineage",
        conflictFields: conflictingAttributeKeys([best, candidate]),
        records: [best, candidate].sort(recordOrder)
      };
    }
  }

  const conflicts = conflictingAttributeKeys(peers);
  if (conflicts.length) return { status: "conflict", reason: "conflicting-same-revision-schedule-records", conflictFields: conflicts, records: peers.sort(recordOrder) };
  return { status: "resolved", records: peers.sort(recordOrder) };
}

function conflictingAttributeKeys(records) {
  const valuesByKey = new Map();
  for (const record of records || []) {
    for (const [key, value] of Object.entries(reconstructionAttributes(record.attributes || {}))) {
      if (value == null) continue;
      if (!valuesByKey.has(key)) valuesByKey.set(key, new Set());
      valuesByKey.get(key).add(stableValue(value));
    }
  }
  return [...valuesByKey.entries()].filter(([, values]) => values.size > 1).map(([key]) => key).sort();
}

function mergeEquivalentAttributes(attributesValues) {
  const result = {};
  for (const attributes of attributesValues || []) {
    for (const [key, value] of Object.entries(reconstructionAttributes(attributes))) {
      if (value == null || Object.hasOwn(result, key)) continue;
      result[key] = value;
    }
  }
  return result;
}

function reconstructionAttributes(attributes = {}) {
  const { objectCode, status, materialCandidates, levelCandidates, ...rest } = attributes || {};
  return rest;
}

function attributesEquivalent(a, b) {
  return stableValue(reconstructionAttributes(a)) === stableValue(reconstructionAttributes(b));
}

function compactRecord(record) {
  return {
    id: record.id || null,
    canonicalObjectCode: record.canonicalObjectCode || canonicalObjectCode(record.objectCode),
    objectCode: record.objectCode || null,
    objectType: record.objectType || null,
    subtype: record.subtype || null,
    attributes: reconstructionAttributes(record.attributes || {}),
    raw: compactRaw(record.raw),
    contentHash: record.contentHash || null,
    pageNumber: Number(record.pageNumber || 1),
    drawingNumber: record.drawingNumber || null,
    revision: record.revision || null,
    drawingStatus: record.drawingStatus || null,
    issueDate: record.issueDate || null,
    confidence: finiteOrNull(record.confidence),
    source: record.source || null,
    spatialAuthorityEligible: false,
    worldGeometryAuthority: false
  };
}

function compactRaw(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 500) : null;
}

function fusionResult(status, code, reason) {
  return {
    schemaVersion: 1,
    status,
    objectCode: code || null,
    canonicalObjectCode: canonicalObjectCode(code),
    reason,
    reconstructionReady: false,
    grantsWorldGeometryAuthority: false,
    grantsTerrainGeometryAuthority: false,
    grantsTerrainElevationAuthority: false
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${key}:${stableValue(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function canonicalDrawing(value) { return String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, ""); }
function finiteOrNull(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function recordOrder(a, b) {
  return String(a.drawingNumber || "").localeCompare(String(b.drawingNumber || "")) ||
    String(a.revision || "").localeCompare(String(b.revision || ""), undefined, { numeric: true }) ||
    String(a.contentHash || "").localeCompare(String(b.contentHash || "")) ||
    Number(a.pageNumber || 0) - Number(b.pageNumber || 0) ||
    String(a.id || "").localeCompare(String(b.id || ""));
}
function emptySummary(status) {
  return {
    schemaVersion: 1,
    status,
    currentScheduleRecordCount: 0,
    geometryObjectCount: 0,
    geometryObjectsWithCode: 0,
    resolvedObjectCount: 0,
    conflictingObjectCount: 0,
    noCurrentRecordCount: 0,
    incompatibleFamilyCount: 0
  };
}
