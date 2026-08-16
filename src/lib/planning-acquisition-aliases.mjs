function firstUrl(application) {
  const value = application?.["documentation-url"] ?? application?.documentationUrl;
  const values = Array.isArray(value) ? value : [value];
  for (const entry of values) {
    if (!entry) continue;
    try {
      const url = new URL(String(entry));
      if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
    } catch {}
  }
  return null;
}

function normalizedReference(value) {
  return String(value || "").toUpperCase().replace(/\s+/g, " ").trim();
}

function normalizedText(value) {
  return String(value || "").toLowerCase()
    .replace(/&amp;/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalDescription(value) {
  return normalizedText(value)
    .replace(/\brevised submission\b/g, " ")
    .replace(/\bresubmission\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function publicRegisterScore(value) {
  if (!value) return 0;
  let url;
  try { url = new URL(value); } catch { return 0; }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  let score = 0;
  if (host.startsWith("publicaccess.")) score += 60;
  if (path.includes("/portal/servlets/")) score += 60;
  if (/applicationsearchservlet$/i.test(url.pathname)) score += 30;
  return score;
}

function baseReference(reference) {
  const value = normalizedReference(reference);
  if (!value) return null;
  const stripped = value
    .replace(/\s+(?:MSA|CONSULTATION|CONSULT|CON)$/i, "")
    .trim();
  return stripped && stripped !== value ? stripped : null;
}

function findExplicitReferenceTarget(application, candidates) {
  const description = normalizedText(application?.description ?? application?.name);
  if (!description) return null;
  let best = null;
  for (const candidate of candidates) {
    if (candidate === application || !candidate?.reference) continue;
    const referenceText = normalizedText(candidate.reference);
    if (referenceText.length < 6 || !description.includes(referenceText)) continue;
    if (!best || publicRegisterScore(firstUrl(candidate)) > publicRegisterScore(firstUrl(best))) best = candidate;
  }
  return best;
}

function findDescriptionTarget(application, candidates) {
  const description = canonicalDescription(application?.description ?? application?.name);
  if (description.length < 40) return null;
  let best = null;
  for (const candidate of candidates) {
    if (candidate === application) continue;
    const candidateDescription = canonicalDescription(candidate?.description ?? candidate?.name);
    if (candidateDescription !== description) continue;
    if (!best || publicRegisterScore(firstUrl(candidate)) > publicRegisterScore(firstUrl(best))) best = candidate;
  }
  return best;
}

/**
 * Collapse only acquisition-time aliases, never lifecycle evidence. The caller
 * should retain the original application snapshot for temporal/authority work.
 *
 * An application is treated as an acquisition alias only when another record in
 * the same bbox has a strictly stronger first-party PublicAccess-style register
 * URL and one of three high-confidence relationships is present:
 *   - the secondary record's reference is a suffix variant of the primary ref;
 *   - its description explicitly names the primary application reference; or
 *   - both long descriptions are identical after removing "revised submission".
 *
 * This is intentionally generic across councils and does not encode park names,
 * application IDs, or vendor hostnames.
 */
export function collapsePlanningAcquisitionAliases(applications = []) {
  const source = Array.isArray(applications) ? applications.filter(Boolean) : [];
  const byReference = new Map();
  for (const application of source) {
    const reference = normalizedReference(application.reference);
    if (reference && !byReference.has(reference)) byReference.set(reference, application);
  }

  const aliases = [];
  const excluded = new Set();

  for (const application of source) {
    const sourceUrl = firstUrl(application);
    const sourceScore = publicRegisterScore(sourceUrl);
    let target = null;
    let reason = null;

    const base = baseReference(application.reference);
    if (base && byReference.has(base)) {
      target = byReference.get(base);
      reason = "reference-suffix-alias";
    }

    if (!target) {
      target = findExplicitReferenceTarget(application, source);
      if (target) reason = "explicit-related-application-reference";
    }

    if (!target) {
      target = findDescriptionTarget(application, source);
      if (target) reason = "equivalent-description";
    }

    if (!target || target === application) continue;
    const targetUrl = firstUrl(target);
    const targetScore = publicRegisterScore(targetUrl);
    if (!targetUrl || targetScore <= sourceScore) continue;

    excluded.add(application);
    aliases.push({
      reference: application.reference ?? null,
      documentationUrl: sourceUrl,
      canonicalReference: target.reference ?? null,
      canonicalDocumentationUrl: targetUrl,
      reason
    });
  }

  return {
    applications: source.filter((application) => !excluded.has(application)),
    aliases
  };
}
