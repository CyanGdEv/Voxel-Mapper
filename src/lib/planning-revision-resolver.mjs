const CURRENT_CONFIDENCE_GATE = 0.85;

/**
 * Resolves planning-document revision lineage separately from real-world current
 * state. A later proposed drawing may supersede an older document revision, but
 * it does not supersede an older as-built/current physical observation until
 * implementation evidence exists.
 */
export function resolvePlanningRevisionAuthority(registeredEvidence, catalog = {}, options = {}) {
  const referenceDate = parseDate(options.referenceDate) || new Date();
  const documentIndex = new Map((catalog.documents || []).map((document) => [document.contentHash, document]));
  const applications = catalog.applications || {};
  const pages = collectPages(registeredEvidence, documentIndex, applications, referenceDate);
  const lineages = buildLineages(pages, documentIndex, applications);
  const lineageResolution = new Map();

  for (const lineage of lineages) {
    resolveLineage(lineage, documentIndex, options);
    for (const member of lineage.members) {
      const key = pageKey(member.contentHash, member.pageNumber);
      if (!lineageResolution.has(key)) lineageResolution.set(key, []);
      lineageResolution.get(key).push(member.lineageDecision);
    }
  }

  const pageDecisions = new Map();
  for (const page of pages) {
    const memberships = lineageResolution.get(page.key) || [];
    const decision = resolvePageAuthority(page, memberships, options);
    page.decision = decision;
    pageDecisions.set(page.key, decision);
  }

  const resolvedEvidence = annotateEvidence(registeredEvidence, pageDecisions);
  const summary = summarize(pages, lineages, resolvedEvidence);
  return {
    schemaVersion: 1,
    status: summary.unresolvedPages === 0 ? "resolved" : summary.authoritativeCurrentPages > 0 ? "partially-resolved" : "unresolved",
    referenceDate: referenceDate.toISOString(),
    policy: {
      documentRevisionRule: "latest comparable/explicitly chained document revision wins document lineage",
      physicalCurrentRule: "newer proposed/approved drawings do not displace older current/as-built evidence without implementation proof",
      currentAuthorityConfidenceGate: Number(options.currentAuthorityConfidenceGate ?? CURRENT_CONFIDENCE_GATE),
      planningApprovalAloneIsCurrent: false,
      georegistrationStillRequired: true
    },
    summary,
    pages,
    lineages,
    resolvedEvidence
  };
}

export function resolvePlanningLifecycleEvidence({ drawingStatus, applicationTemporal, classification, issueDate }, referenceDate = new Date()) {
  const title = lifecycleFromStatus(drawingStatus, "drawing-title-block");
  const applicationValues = Array.isArray(applicationTemporal)
    ? applicationTemporal
    : applicationTemporal ? [applicationTemporal] : [];
  const applicationStates = applicationValues.map((value) => lifecycleFromApplication(value)).filter(Boolean);
  const candidates = [title, ...applicationStates].filter(Boolean);

  if (classification === "survey" && !candidates.some((entry) => entry.state === "current")) {
    candidates.push({ state: "current", confidence: issueDate ? 0.78 : 0.66, reason: "survey-observation", source: "document-classification" });
  }

  if (!candidates.length) return { state: "unknown", confidence: 0.45, reason: "no-explicit-lifecycle-evidence", source: null, observedAt: normalizeDate(issueDate) };

  const excluded = candidates.filter((entry) => ["demolished", "refused", "withdrawn", "superseded"].includes(entry.state));
  if (excluded.length) {
    const winner = excluded.sort((a, b) => b.confidence - a.confidence)[0];
    return { ...winner, observedAt: normalizeDate(issueDate) };
  }

  const current = candidates.filter((entry) => entry.state === "current");
  const proposed = candidates.filter((entry) => entry.state === "proposed");
  if (current.length && proposed.length) {
    const strongestCurrent = current.sort((a, b) => b.confidence - a.confidence)[0];
    const strongestProposed = proposed.sort((a, b) => b.confidence - a.confidence)[0];
    if (strongestCurrent.source === "drawing-title-block" && strongestCurrent.confidence >= 0.95) {
      return { ...strongestCurrent, observedAt: normalizeDate(issueDate) };
    }
    return {
      state: "unknown",
      confidence: round(Math.min(strongestCurrent.confidence, strongestProposed.confidence)),
      reason: "conflicting-current-and-proposed-lifecycle-evidence",
      source: "combined",
      observedAt: normalizeDate(issueDate)
    };
  }

  const winner = [...candidates].sort((a, b) => lifecycleRank(b.state) - lifecycleRank(a.state) || b.confidence - a.confidence)[0];
  return { ...winner, observedAt: normalizeDate(issueDate) };
}

export function comparePlanningRevisions(a, b) {
  const left = parseRevision(a), right = parseRevision(b);
  if (!left || !right) return null;
  if (left.kind !== right.kind) return null;
  if (left.kind === "number") return Math.sign(left.number - right.number);
  if (left.kind === "letter") return Math.sign(left.number - right.number);
  if (left.kind === "prefixed-number" && left.prefix === right.prefix) return Math.sign(left.number - right.number);
  return null;
}

function collectPages(registeredEvidence, documentIndex, applications, referenceDate) {
  const byKey = new Map();
  const ensure = (contentHash, pageNumber) => {
    const hash = contentHash || "unknown-document";
    const page = Number(pageNumber || 1);
    const key = pageKey(hash, page);
    if (!byKey.has(key)) {
      const document = documentIndex.get(hash) || null;
      const applicationKeys = document?.applicationKeys || [];
      byKey.set(key, {
        key,
        contentHash: hash,
        pageNumber: page,
        classification: document?.classification || null,
        applicationKeys,
        documentLabels: document?.labels || [],
        drawingNumber: null,
        revision: null,
        drawingStatus: null,
        issueDate: null,
        spatiallyRegistered: true,
        lifecycle: null,
        decision: null
      });
    }
    return byKey.get(key);
  };

  for (const metadata of registeredEvidence?.drawingMetadata || []) {
    const page = ensure(metadata.contentHash, metadata.pageNumber);
    page.drawingNumber = metadata.drawingNumber || page.drawingNumber;
    page.revision = metadata.revision || page.revision;
    page.drawingStatus = metadata.status || page.drawingStatus;
    page.issueDate = metadata.issueDate || page.issueDate;
  }
  for (const collection of [registeredEvidence?.geometryCandidates, registeredEvidence?.verticalObservations, registeredEvidence?.materialObservations]) {
    for (const item of collection || []) ensure(item.contentHash, item.pageNumber);
  }

  const pages = [...byKey.values()].sort((a, b) => a.contentHash.localeCompare(b.contentHash) || a.pageNumber - b.pageNumber);
  for (const page of pages) {
    const temporal = page.applicationKeys.map((key) => applications[key]?.temporal).filter(Boolean);
    page.lifecycle = resolvePlanningLifecycleEvidence({
      drawingStatus: page.drawingStatus,
      applicationTemporal: temporal,
      classification: page.classification,
      issueDate: page.issueDate
    }, referenceDate);
  }
  return pages;
}

function buildLineages(pages, documentIndex, applications) {
  const groups = new Map();
  for (const page of pages) {
    const appKeys = page.applicationKeys.length ? page.applicationKeys : ["unlinked"];
    for (const applicationKey of appKeys) {
      const identity = lineageIdentity(page, documentIndex.get(page.contentHash));
      const key = `${applicationKey}::${identity}`;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          applicationKey,
          applicationReference: applications[applicationKey]?.reference || null,
          identity,
          drawingNumber: page.drawingNumber || null,
          members: [],
          documentLatest: null,
          worldCurrent: null,
          conflicts: []
        });
      }
      groups.get(key).members.push({ ...page, lineageDecision: null });
    }
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function resolveLineage(lineage, documentIndex, options) {
  const members = lineage.members;
  const supersededBy = new Map();

  // Strongest signal: content-addressed acquisition observed the same document
  // resource changing bytes and retained the previous hash.
  for (const member of members) {
    const document = documentIndex.get(member.contentHash);
    for (const previous of document?.previousContentHashes || []) {
      const prior = members.find((candidate) => candidate.contentHash === previous);
      if (prior) supersededBy.set(prior.key, member.key);
    }
  }

  // Next signal: title-block revisions are ordered only when their syntax is
  // directly comparable. P03 > P02 and C > B; P03 vs C01 is deliberately not guessed.
  for (const left of members) {
    for (const right of members) {
      if (left.key === right.key || !left.revision || !right.revision) continue;
      const comparison = comparePlanningRevisions(left.revision, right.revision);
      if (comparison != null && comparison < 0) supersededBy.set(left.key, right.key);
    }
  }

  const nonSuperseded = members.filter((member) => !supersededBy.has(member.key));
  lineage.documentLatest = selectDocumentLatest(nonSuperseded, lineage);
  lineage.worldCurrent = selectPhysicalCurrent(members, supersededBy, lineage, options);

  for (const member of members) {
    const documentSupersededBy = supersededBy.get(member.key) || null;
    const sameTopRevisionConflict = lineage.documentLatest == null && !documentSupersededBy && members.length > 1;
    const isWorldCurrent = lineage.worldCurrent?.key === member.key;
    member.lineageDecision = {
      lineageKey: lineage.key,
      documentRevisionState: documentSupersededBy ? "superseded" : sameTopRevisionConflict ? "ambiguous" : "latest",
      supersededBy: documentSupersededBy,
      worldSelectionState: isWorldCurrent ? "selected-current" : member.lifecycle.state === "current" ? "current-not-selected" : "not-current",
      currentAuthorityEligible: isWorldCurrent,
      lifecycleState: member.lifecycle.state,
      lifecycleConfidence: member.lifecycle.confidence
    };
  }
}

function selectDocumentLatest(candidates, lineage) {
  if (!candidates.length) return null;
  if (candidates.length === 1) return compactMember(candidates[0]);
  const withRevision = candidates.filter((member) => member.revision);
  if (withRevision.length === candidates.length) {
    let best = candidates[0];
    let ambiguous = false;
    for (const candidate of candidates.slice(1)) {
      const comparison = comparePlanningRevisions(candidate.revision, best.revision);
      if (comparison == null || comparison === 0) ambiguous = true;
      else if (comparison > 0) { best = candidate; ambiguous = false; }
    }
    if (!ambiguous) return compactMember(best);
  }
  lineage.conflicts.push("multiple-non-superseded-document-revisions");
  return null;
}

function selectPhysicalCurrent(members, supersededBy, lineage, options) {
  const gate = Number(options.currentAuthorityConfidenceGate ?? CURRENT_CONFIDENCE_GATE);
  const current = members.filter((member) => member.lifecycle.state === "current" && member.lifecycle.confidence >= gate);
  if (!current.length) return null;

  // Among physically-current observations, prefer a later comparable revision.
  // A newer proposed drawing is intentionally ignored here.
  let best = current[0];
  let ambiguous = false;
  for (const candidate of current.slice(1)) {
    if (candidate.drawingNumber && best.drawingNumber && candidate.drawingNumber === best.drawingNumber && candidate.revision && best.revision) {
      const comparison = comparePlanningRevisions(candidate.revision, best.revision);
      if (comparison == null || comparison === 0) ambiguous = true;
      else if (comparison > 0) { best = candidate; ambiguous = false; }
      continue;
    }
    const candidateDoc = supersededBy.get(best.key) === candidate.key;
    const bestDoc = supersededBy.get(candidate.key) === best.key;
    if (candidateDoc) { best = candidate; ambiguous = false; }
    else if (!bestDoc) ambiguous = true;
  }
  if (ambiguous) {
    lineage.conflicts.push("multiple-ambiguous-current-observations");
    return null;
  }
  return compactMember(best);
}

function resolvePageAuthority(page, memberships, options) {
  const gate = Number(options.currentAuthorityConfidenceGate ?? CURRENT_CONFIDENCE_GATE);
  const selected = memberships.filter((entry) => entry.currentAuthorityEligible);
  const ambiguous = memberships.some((entry) => entry.documentRevisionState === "ambiguous");
  const supersededEverywhere = memberships.length > 0 && memberships.every((entry) => entry.documentRevisionState === "superseded");
  const lifecycle = page.lifecycle;

  if (supersededEverywhere && lifecycle.state !== "current") {
    return decision("superseded", Math.max(lifecycle.confidence, 0.96), "document-revision-superseded", false, memberships);
  }
  if (["refused", "withdrawn", "demolished", "superseded"].includes(lifecycle.state)) {
    return decision(lifecycle.state, lifecycle.confidence, lifecycle.reason, false, memberships);
  }
  if (ambiguous) return decision("unknown", Math.min(lifecycle.confidence, 0.6), "ambiguous-document-revision-lineage", false, memberships);
  if (selected.length === 1 && lifecycle.state === "current" && lifecycle.confidence >= gate) {
    return decision("current", lifecycle.confidence, lifecycle.reason, true, memberships);
  }
  if (selected.length > 1) return decision("unknown", 0.55, "conflicting-current-lineages", false, memberships);
  if (lifecycle.state === "proposed") return decision("proposed", lifecycle.confidence, lifecycle.reason, false, memberships);
  if (lifecycle.state === "current") return decision("current", lifecycle.confidence, "current-evidence-below-or-conflicted-authority-gate", false, memberships);
  return decision("unknown", lifecycle.confidence, lifecycle.reason, false, memberships);
}

function decision(state, confidence, reason, authority, memberships) {
  return {
    state,
    confidence: round(confidence),
    reason,
    temporalResolved: state !== "unknown",
    worldGeometryAuthority: Boolean(authority),
    lineageMemberships: memberships
  };
}

function annotateEvidence(evidence, decisions) {
  const annotate = (entry) => {
    const key = pageKey(entry.contentHash, entry.pageNumber);
    const temporal = decisions.get(key) || decision("unknown", 0.45, "missing-page-temporal-resolution", false, []);
    return {
      ...entry,
      planningTemporal: temporal,
      temporalResolutionRequired: !temporal.temporalResolved,
      worldGeometryAuthority: temporal.worldGeometryAuthority
    };
  };
  const geometryCandidates = (evidence?.geometryCandidates || []).map(annotate);
  const verticalObservations = (evidence?.verticalObservations || []).map(annotate);
  const materialObservations = (evidence?.materialObservations || []).map(annotate);
  const drawingMetadata = (evidence?.drawingMetadata || []).map(annotate);
  const allResolved = [...decisions.values()].every((entry) => entry.temporalResolved);
  const anyAuthority = [...decisions.values()].some((entry) => entry.worldGeometryAuthority);
  return {
    ...(evidence || {}),
    schemaVersion: 2,
    temporalResolutionRequired: !allResolved,
    temporalResolutionStatus: allResolved ? "resolved" : "partial",
    worldGeometryAuthority: anyAuthority,
    geometryCandidates,
    verticalObservations,
    materialObservations,
    drawingMetadata
  };
}

function summarize(pages, lineages, evidence) {
  const temporalStates = {};
  const revisionStates = {};
  let authoritativeCurrentPages = 0;
  let unresolvedPages = 0;
  for (const page of pages) {
    const state = page.decision?.state || "unknown";
    temporalStates[state] = (temporalStates[state] || 0) + 1;
    if (page.decision?.worldGeometryAuthority) authoritativeCurrentPages += 1;
    if (!page.decision?.temporalResolved) unresolvedPages += 1;
    for (const membership of page.decision?.lineageMemberships || []) {
      const revision = membership.documentRevisionState || "unknown";
      revisionStates[revision] = (revisionStates[revision] || 0) + 1;
    }
  }
  return {
    pageCount: pages.length,
    lineageCount: lineages.length,
    authoritativeCurrentPages,
    nonAuthoritativePages: pages.length - authoritativeCurrentPages,
    unresolvedPages,
    temporalStates,
    revisionStates,
    authoritativeGeometryCandidates: (evidence.geometryCandidates || []).filter((entry) => entry.worldGeometryAuthority).length,
    authoritativeVerticalObservations: (evidence.verticalObservations || []).filter((entry) => entry.worldGeometryAuthority).length,
    authoritativeMaterialObservations: (evidence.materialObservations || []).filter((entry) => entry.worldGeometryAuthority).length,
    conflicts: lineages.reduce((sum, lineage) => sum + lineage.conflicts.length, 0)
  };
}

function lineageIdentity(page, document) {
  if (page.drawingNumber) return `drawing:${canonical(page.drawingNumber)}`;
  const label = (document?.labels || []).find(Boolean);
  if (label) return `label:${canonicalLabel(label)}`;
  return `document:${page.contentHash}:p${page.pageNumber}`;
}

function lifecycleFromStatus(value, source) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return null;
  if (/as[- ]?built|record|existing|current|implemented|completed|built|operational/.test(text)) {
    return { state: "current", confidence: /as[- ]?built|record/.test(text) ? 0.99 : 0.93, reason: `explicit-${text.replace(/\s+/g, "-")}-status`, source };
  }
  if (/demolish|demolished|removed/.test(text)) return { state: "demolished", confidence: 0.97, reason: "explicit-demolition-status", source };
  if (/refused|rejected/.test(text)) return { state: "refused", confidence: 0.98, reason: "explicit-refusal-status", source };
  if (/withdrawn|cancelled|canceled/.test(text)) return { state: "withdrawn", confidence: 0.97, reason: "explicit-withdrawal-status", source };
  if (/superseded|obsolete/.test(text)) return { state: "superseded", confidence: 0.98, reason: "explicit-superseded-status", source };
  if (/construction|tender/.test(text)) return { state: "proposed", confidence: 0.82, reason: "issued-for-delivery-does-not-prove-built", source };
  if (/approved|granted|consent/.test(text)) return { state: "proposed", confidence: 0.74, reason: "approval-does-not-prove-construction", source };
  if (/planning|proposed|preliminary|submitted|pending|outline|reserved/.test(text)) return { state: "proposed", confidence: 0.91, reason: "explicit-proposal-status", source };
  return null;
}

function lifecycleFromApplication(temporal) {
  const statuses = temporal?.statusEvidence || [];
  const candidates = statuses.map((value) => lifecycleFromStatus(value, "planning-application")).filter(Boolean);
  return candidates.sort((a, b) => lifecycleRank(b.state) - lifecycleRank(a.state) || b.confidence - a.confidence)[0] || null;
}

function lifecycleRank(state) {
  return ({ demolished: 9, refused: 8, withdrawn: 8, superseded: 8, current: 7, proposed: 5, unknown: 0 })[state] || 0;
}

function parseRevision(value) {
  const text = String(value || "").trim().toUpperCase().replace(/^REV(?:ISION)?\s*/i, "");
  if (!text) return null;
  if (/^\d+$/.test(text)) return { kind: "number", number: Number(text) };
  if (/^[A-Z]$/.test(text)) return { kind: "letter", number: text.charCodeAt(0) - 64 };
  const prefixed = text.match(/^([A-Z]+)[-_ ]?(\d+)$/);
  if (prefixed) return { kind: "prefixed-number", prefix: prefixed[1], number: Number(prefixed[2]) };
  return null;
}

function compactMember(member) {
  return {
    key: member.key,
    contentHash: member.contentHash,
    pageNumber: member.pageNumber,
    drawingNumber: member.drawingNumber,
    revision: member.revision,
    lifecycle: member.lifecycle
  };
}

function canonical(value) { return String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, ""); }
function canonicalLabel(value) {
  return canonical(String(value || "")
    .replace(/\brev(?:ision)?\s*[A-Z0-9._/-]+/ig, " ")
    .replace(/\b(?:P|C|S)\d{1,4}\b/ig, " ")) || "unknown";
}
function pageKey(contentHash, pageNumber) { return `${contentHash || "unknown-document"}:p${Number(pageNumber || 1)}`; }
function parseDate(value) { const date = value instanceof Date ? value : value ? new Date(value) : null; return date && Number.isFinite(date.getTime()) ? date : null; }
function normalizeDate(value) { const date = parseDate(value); return date ? date.toISOString() : null; }
function round(value, places = 3) { const factor = 10 ** places; return Math.round(Number(value || 0) * factor) / factor; }
