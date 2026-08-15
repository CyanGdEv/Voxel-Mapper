#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFile, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";

const project = path.resolve(import.meta.dirname, "..");
const finalDir = path.join(project, "out", "alton-towers-accuracy-v06-2026-08-02");
const worldSource = path.join(finalDir, "alton-towers_1to1.mcworld");
const worldOutput = path.join(project, "out", "Alton_Towers_1to1_Evidence_v0.6.0_2026-08-02.mcworld");
const sourceOutput = path.join(project, "out", "ThemePark_Map_v0.6.0_3D_Evidence.zip");
const evidenceOutput = path.join(project, "out", "Alton_Towers_1to1_Evidence_v0.6.0_2026-08-02.zip");

await copyFile(worldSource, worldOutput);

const sourceRoot = "ThemePark_Map_v0.6.0_3D_Evidence";
const sourceArchive = {};
await collect(project, sourceRoot, sourceArchive, (relative) => {
  const top = relative.split("/")[0];
  return !["node_modules", "out", ".tpmap-cache", ".tpmap-cache-v03", ".git"].includes(top);
});
await writeFile(sourceOutput, Buffer.from(zipSync(sourceArchive, { level: 9 })));

const evidenceRoot = "Alton_Towers_1to1_Evidence_v0.6.0_2026-08-02";
const evidenceArchive = {};
const evidenceFiles = [
  "ACCURACY_REPORT.md", "POINT_CLOUD_SOURCE.md", "WORLD_VALIDATION.md", "WORLD_VALIDATION.json",
  "building-labels.json", "ride-profiles.json", "evidence.json", "world-manifest.json",
  "block-palette.json", "build-result.json", "alton-towers.geojson", "preview.svg", "preview.html"
];
for (const filename of evidenceFiles) {
  evidenceArchive[`${evidenceRoot}/${filename}`] = new Uint8Array(await readFile(path.join(finalDir, filename)));
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
if (!sourceEntries.some((entry) => entry.endsWith("/src/lib/raster.mjs"))) throw new Error("source archive verification failed");
if (!evidenceEntries.some((entry) => entry.endsWith("/ride-profiles.json"))) throw new Error("evidence archive verification failed");

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
