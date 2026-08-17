export const MAX_GITHUB_PLANNING_RUNNER_SHARDS = 4;

export function clampGithubPlanningRunnerShards(value, fallback = MAX_GITHUB_PLANNING_RUNNER_SHARDS) {
  const parsed = Number(value);
  const fallbackParsed = Number(fallback);
  const requested = Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : (Number.isFinite(fallbackParsed) && fallbackParsed > 0
      ? Math.floor(fallbackParsed)
      : MAX_GITHUB_PLANNING_RUNNER_SHARDS);
  return Math.max(1, Math.min(MAX_GITHUB_PLANNING_RUNNER_SHARDS, requested));
}
