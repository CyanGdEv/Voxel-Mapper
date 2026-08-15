# Universal BBox Source Registry

Voxel Mapper must choose evidence from the requested geographic extent rather than from a hard-coded park or country profile.

## Contract

Input is a WGS84 bounding box. The registry returns two answers per evidence kind:

- **recommended** — the highest-quality known provider covering the bbox;
- **selected** — the highest-ranked provider whose acquisition adapter is currently implemented.

This distinction is intentional. A provider may be better than the current executable fallback without making the build fail or silently pretending its data was acquired.

## Evidence kinds

- `osm` — base vector geometry and spatial reference.
- `terrain` — DTM / bare-earth elevation.
- `lidar` — DSM / point-cloud or surface detail suitable for roofs and fine geometry.
- `planning` — planning/development-control drawings and authoritative proposal geometry.
- `trees` — individual trees, canopy or vegetation evidence.
- `imagery` — aerial/satellite appearance evidence.
- `hydrology` — water bodies, channels, drainage and related geometry.
- `landcover` — ground-cover classification and vegetation context.

## Ranking

Provider ranking is deterministic and bounded. It combines bbox coverage, authority, freshness, directness, kind-specific completeness and spatial resolution. Sparse catalogs and jurisdiction-discovery providers are penalized slightly because a bbox hit is not proof of an immediately downloadable asset.

A user preference is a bounded boost, not blanket authority. It therefore cannot make a poor or non-covering provider win over materially stronger evidence.

## Initial registry

The first registry includes global fallbacks plus high-value regional sources:

- OpenStreetMap / Overpass
- Copernicus DEM GLO-30
- Open-Meteo / Copernicus DEM GLO-90
- ESA WorldCover 10 m
- Sentinel-2 L2A
- OpenAerialMap
- local planning-authority discovery
- Environment Agency LiDAR for England
- USGS 3DEP for the United States
- national hydrography-authority discovery

The registry is deliberately larger than the current downloader set. `adapter-pending` gaps are emitted explicitly and are the implementation queue for acquisition work.

## Safety boundary

This layer does **not** modify the existing terrain interpolation, slope reconstruction, raster compiler or Bedrock world writer. It only determines which upstream evidence should be requested.

## Next adapters

Highest-value acquisition adapters after this registry are:

1. local planning-authority jurisdiction discovery;
2. Copernicus DEM GLO-30 tile acquisition;
3. ESA WorldCover tile acquisition;
4. USGS 3DEP discovery/acquisition;
5. Sentinel-2 / STAC imagery search;
6. OpenAerialMap search;
7. national hydrography discovery.

The fidelity engine's missing-attribute queue should later be used to request only the evidence kinds needed for low-confidence areas, so second-pass acquisition stays fast and bounded.
