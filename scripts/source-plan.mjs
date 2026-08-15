#!/usr/bin/env node
import { parseBbox } from "../src/lib/geo.mjs";
import { resolveSourcePlan, SOURCE_KINDS } from "../src/lib/source-registry.mjs";
import { RUNTIME_SOURCE_PROVIDERS } from "../src/lib/runtime-source-providers.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const values = (name) => {
  const result = [];
  for (let index = 0; index < args.length; index += 1) if (args[index] === name && args[index + 1]) result.push(args[index + 1]);
  return result;
};

if (args.includes("--help") || !value("--bbox")) {
  console.log(`Voxel Mapper source plan\n\nUsage:\n  node scripts/source-plan.mjs --bbox south,west,north,east [options]\n\nOptions:\n  --kind KIND              Resolve only this kind (repeatable)\n  --prefer PROVIDER_ID     Prefer a provider (repeatable)\n  --exclude PROVIDER_ID    Exclude a provider (repeatable)\n  --max-per-kind N         Keep N ranked candidates per kind\n  --json                    Print full JSON rather than compact text\n\nKinds: ${SOURCE_KINDS.join(", ")}`);
  process.exit(value("--bbox") ? 0 : 2);
}

const bbox = parseBbox(value("--bbox"));
const kinds = values("--kind");
const plan = resolveSourcePlan(bbox, {
  providers: RUNTIME_SOURCE_PROVIDERS,
  kinds: kinds.length ? kinds : undefined,
  preferredProviderIds: values("--prefer"),
  excludedProviderIds: values("--exclude"),
  maxPerKind: Number(value("--max-per-kind") || 5)
});

if (args.includes("--json")) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

console.log(`BBox: ${bbox.south},${bbox.west},${bbox.north},${bbox.east}`);
console.log(`Resolved executable kinds: ${plan.summary.executableKinds}/${plan.summary.requestedKinds}`);
for (const kind of plan.requestedKinds) {
  const best = plan.recommended[kind];
  const executable = plan.selected[kind];
  const suffix = best && executable && best.providerId !== executable.providerId
    ? ` (best known: ${best.providerName}, adapter pending)`
    : "";
  console.log(`${kind.padEnd(10)} ${executable ? `${executable.providerName} score=${executable.score}` : "NO EXECUTABLE PROVIDER"}${suffix}`);
}
if (plan.gaps.length) {
  console.log("\nAdapter gaps:");
  for (const gap of plan.gaps) console.log(`- ${gap.kind}: ${gap.reason}${gap.recommendedProviderId ? ` (${gap.recommendedProviderId})` : ""}`);
}
