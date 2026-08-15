#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFile, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";

const project = path.resolve(import.meta.dirname, "..");
const finalDir = path.join(project, "out", "alton-towers-terrain-aware-rides-v080-2026-08-02");
const worldSource = path.join(finalDir, "alton-towers_1to1.mcworld");
const worldOutput = path.join(project, "out", "Alton_Towers_1to1_Terrain_Aware_Rides_v0.8.0_2026-08-02.mcworld");
const sourceOutput = path.join(project, "out", "ThemePark_Map_v0.8.0_Terrain_Aware_Rides.zip");
const evidenceOutput = path.join(project, "out", "Alton_Towers_1to1_Terrain_Aware_Rides_Evidence_v0.8.0_2026-08-02.zip");

const validation = JSON.parse(await readFile(path.join(finalDir, "WORLD_VALIDATION.json"), "utf8"));
const evidence = JSON.parse(await readFile(path.join(finalDir, "evidence.json"), "utf8"));
const profiles = JSON.parse(await readFile(path.join(finalDir, "ride-profiles.json"), "utf8"));
const structures = evidence.compilation?.meta?.verticalStats || {};
if (validation.status !== "passed" || validation.rideStructures?.status !== "passed") {
  throw new Error("terrain-aware world validation did not pass");
}
if (structures.rideTerrainMode !== "inferred" || structures.rideTunnelExcavatedBlocks <= 0 ||
  structures.rideTunnelPortalFrames <= 0 || structures.rideSupportFrames <= 0) {
  throw new Error("release is missing required terrain-aware ride output");
}
const alignmentStatuses = profiles.profiles.map((entry) => entry.profile?.planSemantics?.alignment?.status);
if (!alignmentStatuses.length || alignmentStatuses.some((status) => status !== "aligned-within-1m")) {
  throw new Error("one or more replacement ride profiles failed the release alignment gate");
}

await copyFile(worldSource, worldOutput);

const sourceRoot = "ThemePark_Map_v0.8.0_Terrain_Aware_Rides";
const sourceArchive = {};
await collect(project, sourceRoot, sourceArchive, (relative) => {
  const top = relative.split("/")[0];
  return !["node_modules", "out", ".tpmap-cache", ".tpmap-cache-v03", ".git"].includes(top);
});
await writeFile(sourceOutput, Buffer.from(zipSync(sourceArchive, { level: 9 })));

const evidenceRoot = "Alton_Towers_1to1_Terrain_Aware_Rides_Evidence_v0.8.0_2026-08-02";
const evidenceArchive = {};
const evidenceFiles = [
  "RELEASE_NOTES.md", "ACCURACY_REPORT.md", "WORLD_VALIDATION.md", "WORLD_VALIDATION.json",
  "fidelity.json", "building-labels.json", "ride-profiles.json", "evidence.json",
  "world-manifest.json", "block-palette.json", "build-result.json", "alton-towers.geojson",
  "preview.svg", "preview.html"
];
for (const filename of evidenceFiles) {
  evidenceArchive[`${evidenceRoot}/${filename}`] = new Uint8Array(await readFile(path.join(finalDir, filename)));
}
const additionalEvidence = {
  "POINT_CLOUD_SOURCE.md": path.join(project, "out", "alton-towers-accuracy-v06-2026-08-02", "POINT_CLOUD_SOURCE.md"),
  "UNIVERSAL_SOURCE_ARCHITECTURE.md": path.join(project, "UNIVERSAL_SOURCE_ARCHITECTURE.md"),
  "portable-ride-profiles.geojson": path.join(project, "out", "alton-towers-universal-v07-input", "ride-profiles-from-v06.geojson")
};
for (const [filename, source] of Object.entries(additionalEvidence)) {
  evidenceArchive[`${evidenceRoot}/${filename}`] = new Uint8Array(await readFile(source));
}
const rawSources = {
  "alton-towers-overpass.json": path.join(project, ".tpmap-cache-v03", "overpass", "b45028eb1be839d72489fccbfa995b0cdbcc701ee522a48d1543a7d0c165ac8b.json"),
  "alton-towers-dtm-1m.tif": path.join(project, ".tpmap-cache-v03", "lidar", "coverage", "496243546b65d7a24cc650a2f1a2d75246396e546178a6c013283092950363a3.tif"),
  "alton-towers-dsm-1m.tif": path.join(project, ".tpmap-cache-v03", "lidar", "coverage", "1e04ff6e487bd0dd25f5dd517f43b85c1c04e954838fa95db7947d733d41d8aa.tif"),
  "ea-survey-index.json": path.join(project, ".tpmap-cache-v03", "lidar", "survey-index", "cc455fa5b742a1ff80dce89123f7a984a01a2bbc583fb611f07a5d9421a7add5.json"),
  "ostn15-grid.tif": path.join(project, ".tpmap-cache-v03", "lidar", "ostn15", "a5c48c405f0ec27a7c19c3664c16e88fe344a5ad8d1dd86027405cddc5142934.tif")
};
for (const [filename, source] of Object.entries(rawSources)) {
  evidenceArchive[`${evidenceRoot}/raw-sources/${filename}`] = new Uint8Array(await readFile(source));
}

const checksumTargets = [
  [path.basename(worldOutput), worldOutput],
  ...evidenceFiles.map((filename) => [filename, path.join(finalDir, filename)]),
  ...Object.entries(additionalEvidence),
  ...Object.entries(rawSources).map(([filename, source]) => [`raw-sources/${filename}`, source])
];
const checksumLines = [];
for (const [name, filename] of checksumTargets) checksumLines.push(`${await sha256File(filename)}  ${name}`);
evidenceArchive[`${evidenceRoot}/SHA256SUMS.txt`] = new TextEncoder().encode(`${checksumLines.join("\n")}\n`);
await writeFile(evidenceOutput, Buffer.from(zipSync(evidenceArchive, { level: 9 })));

for (const filename of [worldOutput, sourceOutput, evidenceOutput]) {
  const info = await stat(filename);
  const digest = await sha256File(filename);
  console.log(JSON.stringify({ path: filename, bytes: info.size, sha256: digest }));
}
const sourceEntries = Object.keys(unzipSync(new Uint8Array(await readFile(sourceOutput))));
const evidenceEntries = Object.keys(unzipSync(new Uint8Array(await readFile(evidenceOutput))));
for (const required of ["/src/lib/raster.mjs", "/src/lib/ride-profile.mjs", "/test/core.test.mjs", "/UNIVERSAL_SOURCE_ARCHITECTURE.md"]) {
  if (!sourceEntries.some((entry) => entry.endsWith(required))) throw new Error(`source archive missing ${required}`);
}
for (const required of ["/fidelity.json", "/WORLD_VALIDATION.json", "/portable-ride-profiles.geojson", "/RELEASE_NOTES.md"]) {
  if (!evidenceEntries.some((entry) => entry.endsWith(required))) throw new Error(`evidence archive missing ${required}`);
}

async function collect(directory, prefix, archive, include, relative = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (!include(childRelative)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(full, `${prefix}/${entry.name}`, archive, include, childRelative);
    else archive[`${prefix}/${entry.name}`] = new Uint8Array(await readFile(full));
  }
}

async function sha256File(filename) {
  return createHash("sha256").update(await readFile(filename)).digest("hex");
}
