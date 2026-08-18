import path from "node:path";
import { fromFile } from "geotiff";
import { bboxCenter, createProjector } from "./geo.mjs";
import { UserError, invariant } from "./errors.mjs";
import { cachedBinary, ensureDir, fetchBinary, sha256File } from "./io.mjs";

const WEB_MERCATOR_MAX_LAT = 85.05112878;
const EARTH_RADIUS_M = 6_378_137;
const DEFAULT_ENDPOINT = "https://s3.amazonaws.com/elevation-tiles-prod/geotiff";
const DEFAULT_ZOOM = 14;
const DEFAULT_MAX_TILES = 64;

/**
 * Global, no-credential terrain fallback backed by the public Terrain Tiles
 * dataset. The source contains bare-earth elevation mosaics assembled from
 * regional DEMs (including 3DEP/UK data/ArcticDEM/SRTM where available).
 *
 * This adapter never claims LiDAR precision: 1 block still represents 1 metre
 * in the world, while the source resolution and provenance remain explicit.
 */
export async function acquireGlobalTerrainElevation(options = {}, provider = {}) {
  invariant(options.bbox, "Global terrain acquisition requires a WGS84 bounding box");
  if (options.bbox.south < -WEB_MERCATOR_MAX_LAT || options.bbox.north > WEB_MERCATOR_MAX_LAT) {
    throw new UserError(`Terrain Tiles supports Web Mercator latitudes only (±${WEB_MERCATOR_MAX_LAT.toFixed(6)}°)`);
  }

  const cacheRoot = path.join(options.cacheDir || path.resolve(options.cache || ".tpmap-cache"), "terrain-tiles");
  await ensureDir(cacheRoot);
  const maxTiles = Math.max(1, Math.floor(Number(options.globalTerrainMaxTiles || DEFAULT_MAX_TILES)));
  const requestedZoom = clamp(Math.floor(Number(options.globalTerrainZoom || DEFAULT_ZOOM)), 8, 14);
  const plan = chooseTilePlan(options.bbox, requestedZoom, maxTiles);
  const endpoint = String(options.globalTerrainTilesUrl || provider.endpoint || DEFAULT_ENDPOINT).replace(/\/$/, "");

  const tileSources = await mapConcurrent(plan.tiles, Math.max(1, Math.min(12, Number(options.globalTerrainConcurrency || 6))), async (tile) => {
    const url = `${endpoint}/${tile.z}/${tile.x}/${tile.y}.tif`;
    const cached = await cachedBinary({
      cacheDir: path.join(cacheRoot, String(tile.z), String(tile.x)),
      key: url,
      noCache: options.noCache,
      extension: ".tif",
      fetcher: () => fetchBinary(url, {
        headers: { "User-Agent": options.userAgent || "VoxelMapper/0.12", Accept: "image/tiff" }
      }, { timeoutMs: 120_000, retries: 2 })
    });
    return { ...tile, url, filename: cached.filename, cacheHit: cached.cacheHit };
  });

  const rasters = await mapConcurrent(tileSources, Math.max(1, Math.min(8, Number(options.globalTerrainDecodeConcurrency || 4))), readTerrainTile);
  invariant(rasters.length, "Global terrain provider returned no readable tiles");

  const center = bboxCenter(options.bbox);
  const localProjector = createProjector(center);
  const samplers = rasters.map((raster) => ({ raster, sample: createMercatorRasterSampler(raster) }));
  const nativeResolutionM = Math.min(...rasters.map((raster) => raster.resolutionM));
  const groundResolutionM = nativeResolutionM * Math.cos(center.lat * Math.PI / 180);
  const minM = Math.min(...rasters.map((raster) => raster.min));
  const maxM = Math.max(...rasters.map((raster) => raster.max));
  const hashes = await Promise.all(tileSources.map((tile) => sha256File(tile.filename)));

  const result = {
    provider: provider.providerName || provider.name || "AWS Open Data / Mapzen Terrain Tiles",
    providerId: provider.providerId || provider.id || "aws-terrain-tiles",
    sourceKind: "global-dem",
    terrainRole: "global-bare-earth-fallback",
    resolutionM: round3(groundResolutionM),
    nativeProjectedResolutionM: round3(nativeResolutionM),
    verticalAccuracyRmseM: null,
    datum: "source DEM vertical datum (mixed regional sources)",
    crs: "EPSG:3857",
    minM,
    maxM,
    points: [],
    tilePlan: {
      zoom: plan.zoom,
      tileCount: tileSources.length,
      requestedZoom,
      maxTiles,
      effectiveGroundResolutionM: round3(groundResolutionM)
    },
    tiles: tileSources.map((tile, index) => ({
      z: tile.z, x: tile.x, y: tile.y,
      cacheHit: tile.cacheHit,
      hash: hashes[index],
      source: tile.url
    })),
    attribution: "Terrain Tiles / Mapzen (Linux Foundation); underlying regional elevation sources require their own attribution",
    license: "https://github.com/tilezen/joerd/blob/master/docs/attribution.md",
    dataset: "https://registry.opendata.aws/terrain-tiles/",
    warning: "Global DEM fallback is lower-resolution than national LiDAR. It preserves 1 m world scale but does not claim 1 m measured terrain detail; no DSM/roof surface is available."
  };

  Object.defineProperties(result, {
    sampleLocal: {
      enumerable: false,
      value(x, z) {
        const [lon, lat] = localProjector.inverse([x, z]);
        const [mx, my] = lonLatToWebMercator(lon, lat);
        for (const { raster, sample } of samplers) {
          if (mx < raster.minX || mx > raster.maxX || my < raster.minY || my > raster.maxY) continue;
          const value = sample(mx, my);
          if (Number.isFinite(value)) return value;
        }
        return null;
      }
    },
    sampleSurfaceLocal: { enumerable: false, value: null },
    samplePairLocal: { enumerable: false, value: null }
  });
  return result;
}

export function chooseGlobalTerrainTilePlan(bbox, requestedZoom = DEFAULT_ZOOM, maxTiles = DEFAULT_MAX_TILES) {
  return chooseTilePlan(bbox, requestedZoom, maxTiles);
}

export function globalTerrainTileRange(bbox, zoom) {
  const z = clamp(Math.floor(Number(zoom)), 0, 22);
  const n = 2 ** z;
  const west = clamp(Number(bbox.west), -180, 180 - Number.EPSILON);
  const east = clamp(Number(bbox.east), -180, 180 - Number.EPSILON);
  const north = clamp(Number(bbox.north), -WEB_MERCATOR_MAX_LAT, WEB_MERCATOR_MAX_LAT);
  const south = clamp(Number(bbox.south), -WEB_MERCATOR_MAX_LAT, WEB_MERCATOR_MAX_LAT);
  const minX = clamp(Math.floor(((west + 180) / 360) * n), 0, n - 1);
  const maxX = clamp(Math.floor(((east + 180) / 360) * n), 0, n - 1);
  const minY = clamp(latToTileY(north, n), 0, n - 1);
  const maxY = clamp(latToTileY(south, n), 0, n - 1);
  return { z, minX, maxX, minY, maxY, count: (maxX - minX + 1) * (maxY - minY + 1) };
}

function chooseTilePlan(bbox, requestedZoom, maxTiles) {
  let zoom = requestedZoom;
  let range = globalTerrainTileRange(bbox, zoom);
  while (range.count > maxTiles && zoom > 8) {
    zoom -= 1;
    range = globalTerrainTileRange(bbox, zoom);
  }
  if (range.count > maxTiles) {
    throw new UserError(`Global terrain bbox requires ${range.count} tiles at z${zoom}; safety cap is ${maxTiles}`,
      "Use a tighter bbox or deliberately raise --global-terrain-max-tiles.");
  }
  const tiles = [];
  for (let y = range.minY; y <= range.maxY; y += 1) {
    for (let x = range.minX; x <= range.maxX; x += 1) tiles.push({ z: zoom, x, y });
  }
  return { zoom, range, tiles };
}

async function readTerrainTile(tile) {
  let tiff;
  try {
    tiff = await fromFile(tile.filename);
    const image = await tiff.getImage();
    const width = image.getWidth(), height = image.getHeight();
    invariant(width > 1 && height > 1, "Terrain tile is too small");
    const [minX, minY, maxX, maxY] = image.getBoundingBox().map(Number);
    const resolution = image.getResolution().map(Math.abs);
    const values = await image.readRasters({ samples: [0], interleave: true });
    const noData = image.getGDALNoData();
    let min = Infinity, max = -Infinity, validCells = 0;
    for (const value of values) {
      if (!validTerrain(value, noData)) continue;
      min = Math.min(min, value); max = Math.max(max, value); validCells += 1;
    }
    invariant(validCells > 0, "Terrain tile contains no valid elevation cells");
    return {
      ...tile, width, height, minX, minY, maxX, maxY,
      resolutionM: Math.max(resolution[0], resolution[1]), values, noData,
      min, max, validCells
    };
  } finally {
    await tiff?.close?.();
  }
}

function createMercatorRasterSampler(raster) {
  const pixelWidth = (raster.maxX - raster.minX) / raster.width;
  const pixelHeight = (raster.maxY - raster.minY) / raster.height;
  return (x, y) => {
    const fx = (x - raster.minX) / pixelWidth - 0.5;
    const fy = (raster.maxY - y) / pixelHeight - 0.5;
    if (fx < -0.5 || fy < -0.5 || fx > raster.width - 0.5 || fy > raster.height - 0.5) return null;
    const x0 = clamp(Math.floor(fx), 0, raster.width - 1), y0 = clamp(Math.floor(fy), 0, raster.height - 1);
    const x1 = Math.min(raster.width - 1, x0 + 1), y1 = Math.min(raster.height - 1, y0 + 1);
    const tx = clamp(fx - Math.floor(fx), 0, 1), ty = clamp(fy - Math.floor(fy), 0, 1);
    const samples = [
      [raster.values[y0 * raster.width + x0], (1 - tx) * (1 - ty)],
      [raster.values[y0 * raster.width + x1], tx * (1 - ty)],
      [raster.values[y1 * raster.width + x0], (1 - tx) * ty],
      [raster.values[y1 * raster.width + x1], tx * ty]
    ].filter(([value, weight]) => weight > 0 && validTerrain(value, raster.noData));
    if (!samples.length) return null;
    const weight = samples.reduce((sum, sample) => sum + sample[1], 0);
    return samples.reduce((sum, sample) => sum + sample[0] * sample[1], 0) / weight;
  };
}

function lonLatToWebMercator(lon, lat) {
  const clampedLat = clamp(lat, -WEB_MERCATOR_MAX_LAT, WEB_MERCATOR_MAX_LAT);
  return [
    EARTH_RADIUS_M * lon * Math.PI / 180,
    EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + clampedLat * Math.PI / 360))
  ];
}

function latToTileY(lat, n) {
  const radians = lat * Math.PI / 180;
  return Math.floor((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * n);
}

function validTerrain(value, noData) {
  if (!Number.isFinite(value)) return false;
  if (Number.isFinite(Number(noData)) && Math.abs(value - Number(noData)) < 1e-9) return false;
  // Reject known sentinel/outlier ranges without clipping legitimate high/low terrain.
  return value > -12_000 && value < 10_000;
}

async function mapConcurrent(items, concurrency, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) break;
      output[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value))); }
function round3(value) { return Math.round(Number(value) * 1000) / 1000; }
