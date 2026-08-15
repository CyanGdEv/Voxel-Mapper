# Universal high-fidelity source architecture

ThemePark Map uses a universal capability model rather than a list of park-specific datasets. A source is accepted when it can supply one or more standard observations inside a bounded park polygon with usable provenance, licence, timestamp, CRS, resolution, and confidence.

## Source cascade

| Priority | Capability | Universal baseline | Optional discovery/upgrade | Compiler status in 0.11 |
|---:|---|---|---|---|
| 1 | Park and route topology | OpenStreetMap/Overpass | Rights-cleared sub-metre imagery, Overture Transportation, authoritative open route data, portable GeoJSON | OSM, conservative Overture gap fill, provenance-gated public GeoJSON, and connected orthophoto recovery implemented |
| 2 | Bare-earth terrain and surface height | Global DEM | STAC/OGC-discovered local DTM/DSM, LiDAR/COPC/LAZ | Global 90 m and UK/local 1 m adapters implemented; generic STAC next |
| 3 | Path edges, width, colour, and material | Standard map tags plus disclosed route-class width priors | Open/licensed sub-metre orthophotos; park/user observations | Local RGB GeoTIFF mosaics, visible-edge envelopes, colour/material gates, even-width rasterization, and bounded priors implemented; live catalogue discovery next |
| 4 | Individual trees | Mapped tree points/rows and broad land cover | 1 m canopy height, local LiDAR, crown segmentation, field inventory | Tagged/DSM point-tree compiler implemented; canopy raster segmentation next |
| 5 | Bridge topology and height | Bridge/layer/tunnel semantics | DSM/DTM, LiDAR, authoritative bridge inventory, portable survey | Deck/rail/support compiler and DSM/tag evidence implemented |
| 6 | Ride tunnels and supports | OSM tunnel/location/layer topology plus portable vertical profile | Planning sections, manufacturer/survey centreline and support schedule, classified LiDAR | Terrain intersection, excavation, portals, and disclosed support priors implemented |
| 7 | Natural paths and landforms | Mapped surface/geology tags | Public park GIS, geological inventory, orthophoto, field observations | Natural palettes, exact rock/cliff markers, mapped rock surfaces, and disclosed polygon-cluster inference implemented |
| 8 | Change detection | Element timestamps | Repeated imagery, source editions, official construction updates | Evidence dates implemented; automatic change reconciliation next |

Global baseline candidates include:

- Overture Transportation: https://docs.overturemaps.org/guides/transportation/
- ESA WorldCover 10 m land cover: https://esa-worldcover.org/en/data-access
- Meta/WRI canopy-height data registry: https://registry.opendata.aws/dataforgood-fb-forests/
- OpenAerialMap imagery/API: https://openaerialmap.org/ and https://docs.openaerialmap.org/api/api/

These datasets are complementary. No one source provides every queue line, paving colour, individual tree, and bridge deck worldwide.

Overture Transportation is intentionally not treated as independent confirmation of OSM: its primary source is OSM, enhanced with TomTom and local/regional authoritative data. The adapter accepts only clear gaps and withholds duplicates or partial overlaps. Truly independent observations enter through provenance-complete `--public-data`, orthophoto, elevation, point-cloud, or verified profile adapters.

## Universal normalized observations

Every adapter emits WGS84 GeoJSON plus the following normalized properties. The core compiler never needs to know the park or source country.

### Paths

- `kind=path|road`
- `width` or `est_width`, metres
- `surface`/`material`
- `surface:colour` as observed sRGB hex
- `surface:pattern` or `paving_stones:pattern`
- `queue`, `access`, `service`, `backstage`
- `checked_at`, `source_name`, `source_url`, `license`, `verified`

When no scalar width is observed, the compiler records a nominal class prior, uncertainty range, confidence, and the tags that selected it. This improves the physical world over a one-block centreline without relabelling inference as measurement. Source-only mode remains available for strict visual evidence maps.

An optional rights-cleared RGB orthophoto adapter may refine a mapped linear route. It samples bidirectional CIELAB cross-sections, rejects vegetation and image gaps, filters inconsistent widths, and emits a variable-width envelope plus shadow-rejected colour evidence. The hierarchy is explicit surveyed/mapped width, accepted image edge, tagged estimate, lane derivation, then class prior. Image-derived material and pattern are independently nullable and cannot overwrite explicit tags. Incomplete-provenance `assist` imagery is QA-only.

The same accepted mapped-path appearance can seed a conservative walkable-area recovery pass. Classification may expand only through connected, image-visible hardscape inside the park boundary. Mapped buildings, water, and vegetation are hard exclusion masks. Connected components are polygonized, reduced to a medial graph, and labelled as connectors, extensions, or image-visible branches relative to the mapped route anchors. Evidence mode may append accepted area geometry; QA mode writes identical candidates without mutating the map. Isolated hardscape, weak-confidence edges, steep DTM grades, and water crossings remain review-only.

Recovered path polygons follow the same DTM as the world. `path-terrain-mode=evidence` preserves its integerized surface unchanged. Optional `conform` mode applies a two-pass, path-only 3×3 median filter bounded to the source height by `path-terrain-max-cut-fill-m`; mapped routes are fixed anchors, and cut/fill cells and volumes are reported. This is surface conformance, not evidence of real retaining walls, steps, or bridge structure.

The normalized orthophoto evidence retains provider, catalogue URL, licence, capture date, EPSG code, ground-sample distance, file SHA-256, accepted/rejected cross-sections, edge contrast, confidence, and rejection reason. QA-only land-cover candidates never overwrite mapped land or water polygons.

### Bridges

- all path fields
- `bridge`, `bridge:structure`, `covered`
- `bridge:deck:ele`, metres in the declared elevation datum
- `bridge:clearance`, metres
- optional per-vertex deck elevations in a future profile schema

`layer` is retained as relative topology and is never converted directly to metres.

### Natural paths and landforms

- `kind=path|road` plus `surface=ground|dirt|earth|mud|compacted|fine_gravel|gravel`
- `kind=terrain_detail`, `natural=rock|stone|boulder|cliff`, or `geological=outcrop|boulder`
- optional `height_m`, `diameter_m`, `width`, or `circumference`
- `kind=surface`, `natural=bare_rock|scree|shingle`, or a quarry/outcrop subtype
- provider, catalogue URL, licence, observation date, and positional accuracy

Exact point dimensions are compiled against the same DTM as the world. Unknown dimensions remain position markers. Broad polygons prove a surface class, not individual boulder locations; only plausible mode may add deterministic clusters inside them, and those clusters are counted separately. Paths, buildings, water, attractions, rails, and ride corridors are collision exclusions.

### Trees

- `kind=vegetation`, `natural=tree|tree_row`
- `height_m`, `diameter_crown`, `tree_spacing_m`, `tree_count`
- `leaf_type`, `leaf_cycle`, `species`
- provenance fields as above

Broad canopy is a separate observation. Verified mode may use it to classify land cover or detect candidate crowns, but cannot invent random individual trees from a coarse polygon.

### Ride structures

- `kind=ride_track` plus absolute per-vertex elevation and evidence tier
- `tunnel=yes` or `location=underground` for topology; `layer` remains relative only
- optional `tunnel_clearance_width_m`, `tunnel_clearance_above_m`, `tunnel_clearance_below_m`, and `tunnel_cover_m`
- optional `support_spacing_m` and `support_min_height_m`
- portable `replaces=osm:way:...` retains the replaced feature's tunnel/layer semantics and plan-source provenance

The compiler intersects the vertical profile with the DTM. It excavates only where the clearance envelope meets generated terrain. Hidden elevation gaps may be filled only in inferred mode and are evidence-coloured yellow. Uniform support spacing is a universal visualization prior, not an engineering support schedule; a surveyed/manufacturer schedule should replace it when available.

## Fusion rules

For each feature, candidate observations are ranked by:

1. geometry and timestamp validity;
2. explicit provenance and licence compatibility;
3. ground resolution and stated positional/vertical accuracy;
4. source authority and directness;
5. agreement with independent observations;
6. visibility/occlusion quality.

For source-level geometry fusion, explicit verified replacements outrank licensed public observations, which outrank the OSM base map. Overture is gap-fill only. A partially overlapping line is withheld instead of adding a duplicate half-route, and the decision is recorded in `source-fusion.json`.

The winning value retains every source record and conflict. Missing values remain `null`. A lower-resolution source fills a gap only when a higher-resolution source has no usable observation; it never overwrites better evidence.

## Acceptance gates

| Area | High-fidelity gate |
|---|---|
| Paths | Every source-visible guest route is in the graph; unexpected components and dangling endpoints are reviewed; observed widths cover at least 90% of visible route length |
| Surface | Material and sRGB colour are observed from tagged or radiometrically normalized imagery; laying pattern is explicit or marked unknown; nearest block colour error is reported |
| Trees | Each emitted tree has an observed centre plus tagged/DSM/canopy height; crown diameter and species remain independently nullable |
| Bridges | Route endpoints connect, deck is not buried, supports meet terrain, and vertical clearance is explicit/measured; otherwise the feature is a plan marker |
| Ride structures | Tunnel topology and vertical profile agree with terrain; hidden-height inference is counted separately; support bases meet DTM and inferred spacing is disclosed |
| Evidence | Every feature exposes provider, date, resolution/accuracy where available, licence, method, and confidence |

The correct product promise is “high fidelity where source capability exists, explicit gaps everywhere else,” not a universal guarantee that public data contains every real-world detail.
