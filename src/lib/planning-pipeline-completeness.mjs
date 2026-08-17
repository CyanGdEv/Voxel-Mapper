export function activeShardIdsFromCounts(counts = {}) {
  return Object.entries(counts || {})
    .filter(([, count]) => Number(count || 0) > 0)
    .map(([shard]) => Number(shard))
    .filter((shard) => Number.isInteger(shard) && shard >= 0)
    .sort((a, b) => a - b);
}

export function assertCompleteShardCoverage(stage, expectedShards, observedShards) {
  const expected = normalizeShardIds(expectedShards);
  const observed = normalizeShardIds(observedShards);
  if (!expected.length) return { expected, observed, complete: true };

  const observedSet = new Set(observed);
  const expectedSet = new Set(expected);
  const missing = expected.filter((shard) => !observedSet.has(shard));
  const unexpected = observed.filter((shard) => !expectedSet.has(shard));
  if (missing.length || unexpected.length) {
    throw new Error(
      `${stage} shard coverage incomplete: expected=[${expected.join(",")}], observed=[${observed.join(",")}], missing=[${missing.join(",")}], unexpected=[${unexpected.join(",")}]`
    );
  }
  return { expected, observed, complete: true };
}

export function expectedShardIdsFromManifests(manifests, field) {
  const values = (manifests || [])
    .map((manifest) => normalizeShardIds(manifest?.[field]))
    .filter((shards) => shards.length > 0);
  if (!values.length) return [];
  const canonical = values[0];
  for (const candidate of values.slice(1)) {
    if (candidate.length !== canonical.length || candidate.some((value, index) => value !== canonical[index])) {
      throw new Error(
        `Planning shard manifests disagree on ${field}: expected=[${canonical.join(",")}], saw=[${candidate.join(",")}]`
      );
    }
  }
  return canonical;
}

function normalizeShardIds(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0))]
    .sort((a, b) => a - b);
}
