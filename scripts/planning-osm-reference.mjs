#!/usr/bin/env node
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { bboxCenter, parseBbox } from "../src/lib/geo.mjs";
import { cachedJson, fetchJson, sha256 } from "../src/lib/io.mjs";
import { normalizeMap } from "../src/lib/osm.mjs";
import { buildOverpassQuery } from "../src/lib/sources.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.bbox || !args.out) {
  console.error("Usage: planning-osm-reference.mjs --bbox south,west,north,east --out FILE [--cache DIR] [--overpass-url URL] [--refresh]");
  process.exit(2);
}

const bbox = parseBbox(args.bbox);
const center = bboxCenter(bbox);
const cacheRoot = path.resolve(args.cache || ".tpmap-cache");
const endpoint = args.overpassUrl || "https://overpass-api.de/api/interpreter";
const query = buildOverpassQuery(bbox);
const userAgent = process.env.TPMAP_CONTACT ? `VoxelMapper/0.12 (${process.env.TPMAP_CONTACT})` : "VoxelMapper/0.12 planning-georegistration";
const { data, cacheHit } = await cachedJson({
  cacheDir: path.join(cacheRoot, "planning-georeg-osm"),
  key: `${endpoint}\n${query}`,
  noCache: Boolean(args.refresh),
  fetcher: () => fetchJson(endpoint, {
    method: "POST",
    headers: {
      "User-Agent": userAgent,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
    },
    body: new URLSearchParams({ data: query })
  }, { timeoutMs: 180_000, retries: 2 })
});
if (!Array.isArray(data?.elements)) throw new Error("Overpass georegistration reference returned no elements array");

const sources = {
  parkName: "Bounding Box Georegistration Reference",
  bbox,
  center,
  suppliedBoundary: null,
  osm: { data, source: "live", cacheHit, endpoint, queryHash: sha256(query) },
  elevation: { provider: "none", resolutionM: null, points: [] }
};
const map = await normalizeMap(sources, { planning: [], override: [] });
const features = map.features
  .filter((feature) => ["Polygon", "MultiPolygon"].includes(feature.localGeometry?.type))
  .filter((feature) => ["building", "structure", "path", "road", "ride_track", "barrier", "water", "terrain_detail"].includes(feature.kind))
  .map((feature) => ({
    id: feature.id,
    name: feature.name || null,
    kind: feature.kind,
    subtype: feature.subtype || null,
    localGeometry: feature.localGeometry,
    source: feature.source || null,
    authority: feature.authority || { layer: "osm", rank: 100 }
  }));

const output = {
  schemaVersion: 1,
  bbox,
  center,
  provider: "OpenStreetMap Overpass",
  endpoint,
  queryHash: sha256(query),
  cacheHit,
  featureCount: features.length,
  byKind: countBy(features, (feature) => feature.kind),
  coordinateSpace: "local-world-metres",
  features
};
await mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
await writeFile(path.resolve(args.out), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ out: path.resolve(args.out), featureCount: features.length, cacheHit, byKind: output.byKind }, null, 2));

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (token === "--refresh") { result.refresh = true; continue; }
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = values[++index];
    if (value == null || value.startsWith("--")) throw new Error(`${token} requires a value`);
    result[key] = value;
  }
  return result;
}
function countBy(values, getter) {
  const result = {};
  for (const value of values) { const key = getter(value) || "unknown"; result[key] = (result[key] || 0) + 1; }
  return result;
}
