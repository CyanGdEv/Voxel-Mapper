import path from "node:path";
import proj4 from "proj4";
import { unzipSync } from "fflate";
import { cachedBinary, ensureDir, fetchBinary, fetchJson, sha256 } from "./io.mjs";

const OS_DOWNLOADS = "https://api.os.uk/downloads/v1/products/OpenMapLocal/downloads";
const EPSG_27700 = "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +units=m +no_defs";
const WGS84 = "+proj=longlat +datum=WGS84 +no_defs";

/**
 * Acquire the open OS OpenMap - Local vector tile(s) covering a bbox and retain
 * only SurfaceWater_Area / SurfaceWater_Line features. The source is an
 * independent licensed observation: it can improve/supersede OSM water geometry
 * but it supplies no bathymetry and therefore never authorizes bed excavation.
 */
export async function acquireOsOpenMapLocalHydrology(options, provider = null) {
  const bbox = options.bbox;
  const tiles = gridSquaresForBbox(bbox);
  const fetchJsonImpl = options.fetchJsonImpl || fetchJson;
  const fetchBinaryImpl = options.fetchBinaryImpl || fetchBinary;
  const cacheDir = path.join(options.cacheDir || options.cache || ".tpmap-cache", "os-openmap-local-water");
  await ensureDir(cacheDir);

  const features = [];
  const attempts = [];
  for (const area of tiles) {
    try {
      const listUrl = new URL(options.osOpenMapLocalDownloadsUrl || OS_DOWNLOADS);
      listUrl.searchParams.set("area", area);
      listUrl.searchParams.set("format", "GML");
      const downloads = await fetchJsonImpl(listUrl, { headers: { Accept: "application/json" } });
      const selected = selectGmlDownload(downloads, area);
      if (!selected?.url) throw new Error(`OS OpenMap - Local has no GML download for grid square ${area}`);

      const { filename, cacheHit } = await cachedBinary({
        cacheDir,
        key: `${selected.url}\n${selected.md5 || selected.fileName || area}`,
        noCache: options.noCache,
        extension: ".zip",
        fetcher: () => fetchBinaryImpl(selected.url, { headers: { Accept: "application/zip" } }, { timeoutMs: 240_000, retries: 2 })
      });
      const bytes = await import("node:fs/promises").then(({ readFile }) => readFile(filename));
      const archive = unzipSync(new Uint8Array(bytes));
      const gmlEntries = Object.entries(archive).filter(([name]) => /\.gml$/i.test(name));
      if (!gmlEntries.length) throw new Error(`OS OpenMap - Local ${area} archive contains no GML`);
      let accepted = 0;
      for (const [name, data] of gmlEntries) {
        const parsed = parseOpenMapLocalWaterGml(Buffer.from(data).toString("utf8"), bbox, area, name);
        accepted += parsed.length;
        features.push(...parsed);
      }
      attempts.push({ area, status: "success", cacheHit, features: accepted, fileName: selected.fileName || null });
    } catch (error) {
      attempts.push({ area, status: "failed", message: error?.message || String(error) });
      if (options.strictSourceAcquisition) throw error;
    }
  }

  const deduped = dedupeFeatures(features);
  return {
    provider: provider?.providerName || "Ordnance Survey OS OpenMap - Local",
    providerId: provider?.providerId || "os-openmap-local-water",
    status: deduped.length ? "acquired" : attempts.some((entry) => entry.status === "failed") ? "failed-or-empty" : "acquired-empty",
    sourceUrl: "https://osdatahub.os.uk/downloads/open/OpenMapLocal",
    license: "OGL-3.0",
    dataset: "OS OpenMap - Local / SurfaceWater",
    nominalViewingScale: "1:10,000",
    bathymetryProvided: false,
    features: deduped,
    featureCount: deduped.length,
    tiles,
    acquisitionAttempts: attempts
  };
}

export function parseOpenMapLocalWaterGml(xml, bbox, area = null, sourceFile = null) {
  const features = [];
  const featurePattern = /<(?:\w+:)?(SurfaceWater_Area|SurfaceWater_Line)\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?\1>/gi;
  let match;
  while ((match = featurePattern.exec(xml))) {
    const type = match[1];
    const attrs = match[2] || "";
    const body = match[3] || "";
    const id = /(?:gml:)?id=["']([^"']+)["']/i.exec(attrs)?.[1] || sha256(`${area || ""}:${match.index}:${body.slice(0, 500)}`).slice(0, 20);
    const rings = [...body.matchAll(/<(?:\w+:)?posList\b[^>]*>([\s\S]*?)<\/(?:\w+:)?posList>/gi)]
      .map((entry) => parsePosList(entry[1]))
      .filter((points) => points.length >= 2);
    if (!rings.length) continue;

    let geometry;
    if (type === "SurfaceWater_Area") {
      const polygonRings = rings.filter((points) => points.length >= 4).map(closeRing);
      if (!polygonRings.length) continue;
      geometry = { type: "Polygon", coordinates: polygonRings };
    } else {
      geometry = { type: "LineString", coordinates: rings[0] };
    }
    if (!geometryIntersectsBbox(geometry, bbox)) continue;
    features.push({
      id: `public:os-openmap-local:${id}`,
      name: null,
      kind: "water",
      subtype: type === "SurfaceWater_Area" ? "surface-water-area" : "surface-water-line",
      tags: {
        natural: "water",
        water: type === "SurfaceWater_Area" ? "surface_water" : undefined,
        waterway: type === "SurfaceWater_Line" ? "watercourse" : undefined,
        source_feature_type: type
      },
      geometry,
      source: {
        provider: "Ordnance Survey",
        sourceUrl: "https://osdatahub.os.uk/downloads/open/OpenMapLocal",
        license: "OGL-3.0",
        dataset: "OS OpenMap - Local",
        gridSquare: area,
        file: sourceFile
      },
      verification: { plan: "licensed-public-observation", vertical: "unknown" },
      authority: { layer: "licensed-public-water", rank: 300, geometryLocked: false }
    });
  }
  return features;
}

export function gridSquaresForBbox(bbox) {
  const samples = [];
  for (const lat of [bbox.south, bbox.north, (bbox.south + bbox.north) / 2]) {
    for (const lon of [bbox.west, bbox.east, (bbox.west + bbox.east) / 2]) samples.push([lon, lat]);
  }
  const tiles = new Set();
  for (const point of samples) {
    const [easting, northing] = proj4(WGS84, EPSG_27700, point);
    const grid = os100kmGridSquare(easting, northing);
    if (grid) tiles.add(grid);
  }
  return [...tiles].sort();
}

function parsePosList(text) {
  const values = String(text).trim().split(/\s+/).map(Number).filter(Number.isFinite);
  const points = [];
  for (let i = 0; i + 1 < values.length; i += 2) {
    const [lon, lat] = proj4(EPSG_27700, WGS84, [values[i], values[i + 1]]);
    if (Number.isFinite(lon) && Number.isFinite(lat)) points.push([lon, lat]);
  }
  return points;
}

function closeRing(points) {
  const ring = [...points];
  if (!ring.length) return ring;
  const first = ring[0], last = ring.at(-1);
  if (Math.abs(first[0] - last[0]) > 1e-10 || Math.abs(first[1] - last[1]) > 1e-10) ring.push([...first]);
  return ring;
}

function geometryIntersectsBbox(geometry, bbox) {
  const points = geometry.type === "Polygon" ? geometry.coordinates.flat() : geometry.coordinates;
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const [lon, lat] of points) {
    minLon = Math.min(minLon, lon); minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon); maxLat = Math.max(maxLat, lat);
  }
  return maxLon >= bbox.west && minLon <= bbox.east && maxLat >= bbox.south && minLat <= bbox.north;
}

function selectGmlDownload(downloads, area) {
  const list = Array.isArray(downloads) ? downloads : downloads?.downloads || [];
  return list.find((entry) => String(entry.area || "").toUpperCase() === area && String(entry.format || "").toUpperCase() === "GML")
    || list.find((entry) => String(entry.area || "").toUpperCase() === area && /GML/i.test(String(entry.format || "")))
    || null;
}

function dedupeFeatures(features) {
  const seen = new Set();
  const result = [];
  for (const feature of features) {
    const key = feature.id || sha256(feature.geometry);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(feature);
  }
  return result;
}

function os100kmGridSquare(easting, northing) {
  if (!(easting >= 0 && easting < 700000 && northing >= 0 && northing < 1300000)) return null;
  const e100k = Math.floor(easting / 100000), n100k = Math.floor(northing / 100000);
  let l1 = (19 - n100k) - ((19 - n100k) % 5) + Math.floor((e100k + 10) / 5);
  let l2 = ((19 - n100k) * 5) % 25 + (e100k % 5);
  if (l1 > 7) l1 += 1;
  if (l2 > 7) l2 += 1;
  return String.fromCharCode(l1 + 65, l2 + 65);
}
