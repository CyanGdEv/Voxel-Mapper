# Voxel Mapper

## v0.12.0 planning-authority architecture

Voxel Mapper now uses **OSM as the base geometry/reference layer and planning applications as a higher geometry authority**. Architect-drawing observations can automatically or explicitly replace, delete, retag, or add geometry. LiDAR DSM/DTM is then sampled against the final fused building footprint, allowing the world compiler to retain the baseline terrain while reconstructing building roofs from the correct plan shape.

The authority order is: **verified manual override > planning drawing > OSM base > secondary gap-fill evidence**. Planning geometry is locked so lower-confidence path-repair logic cannot silently reshape it. The default planning limit is **680 applications per build**.

Planning material schedules are converted to Minecraft palettes by role (`surface`, `wall`, `roof`, `floor`, `barrier`). Planning material evidence wins over imagery classification for the affected feature. See [`PLANNING_FUSION_ARCHITECTURE.md`](PLANNING_FUSION_ARCHITECTURE.md) and [`examples/planning-manifest.json`](examples/planning-manifest.json).

Example planning-authoritative build:

```bash
node src/cli.mjs build \
  --park-name "Alton Towers Resort" \
  --osm data/alton.overpass.json \
  --bbox SOUTH,WEST,NORTH,EAST \
  --planning data/planning-manifest.json \
  --elevation ea-lidar \
  --buildings shells \
  --accuracy-mode plausible \
  --out out/alton-towers
```

The **v0.11.3 terrain slope and terrain-detail logic is intentionally retained**. Planning features do not alter DTM terrain unless a future explicit earthworks/contour evidence layer is introduced.


## v0.11.1 appearance and vegetation upgrade

This release adds material-aware three-block path palettes and deterministic paving patterns, rights-gated aerial terrain texturing, and dense reconstruction for woodland, tree rows, scrub, bushes and hedges, including rights-cleared aerial-canopy gap filling. Source observations remain auditable: aerial appearance is compiled only from a georeferenced orthophoto with declared provenance and reuse rights, while density-derived vegetation is labelled separately from surveyed trees.

Example Alton Towers benchmark build:

```bash
TPMAP_CONTACT="your-email-or-project-url" npm run build:alton:benchmark
```

To enable aerial path colour and terrain detail, add a cropped orthophoto and its provenance:

```bash
node src/cli.mjs build \
  --park-name "Alton Towers Resort" \
  --contact "your-email-or-project-url" \
  --accept-nominatim-policy \
  --elevation ea-lidar \
  --orthophoto data/alton-towers.tif \
  --orthophoto-source "Provider or survey name" \
  --orthophoto-license "Reuse licence" \
  --orthophoto-date "YYYY-MM-DD" \
  --orthophoto-mode evidence \
  --path-discovery-mode evidence \
  --aerial-terrain-mode evidence \
  --buildings markers \
  --accuracy-mode plausible \
  --out out/alton-towers-benchmark
```

ThemePark Map compiles bounded public geospatial data into a complete Minecraft Bedrock world at a fixed horizontal scale of **1 block = 1 metre**.

The primary output is an importable `.mcworld` with its chunks already built. Terrain foundations, elevation, water, evidence-driven path surfaces, dirt trails, mapped rock/cliff detail, roads, measured bridge decks, dimensioned trees, building-footprint markings, named two-sided signs, barriers, and evidence-coloured 3D ride geometry are stored directly in Bedrock LevelDB. No behavior pack or in-game build command is required.

OpenStreetMap multipolygon members are assembled into complete parts before rasterization. Inner rings remain real holes, so islands are not filled as lake, buildings are not paved over by pedestrian areas, and courtyard footprints remain open.

Each build also produces:

- source-preserving GeoJSON;
- an evidence manifest and human-readable accuracy report;
- an SVG/HTML plan preview;
- a deterministic block-palette report;
- a universal fidelity manifest with path-network, surface, tree, bridge, and active-source capability evidence;
- orthophoto path-edge observations and QA GeoJSON when licensed imagery is supplied;
- recovered walkable-area polygons, junction graph evidence, and QA GeoJSON when topology recovery is enabled;
- source-fusion and terrain-detail manifests identifying every accepted/withheld non-OSM feature and every natural-surface/rock observation;
- `planning-fusion.json` with planning application counts, edit decisions, automatic/explicit matches and authority policy;
- `planning-material-palettes.json` with the resolved architect/planning material schedules;
- a per-ride 3D evidence file with vertical/banking coverage, confidence, sources, and every sampled point;
- a world manifest with chunk bounds, spawn, format versions, SHA-256, and validation result;
- an optional legacy `.mcaddon` runtime builder for placing the same map into another world.

## What “1:1” means

The unit conversion is exact: one source metre becomes one Minecraft block horizontally and vertically. That does **not** make incomplete public data survey-grade. When Environment Agency LiDAR is selected, coordinates are transformed with the official OSTN15 grid rather than an approximate datum shift.

OpenStreetMap can provide excellent footprints, paths, water, land use, amenities, and some ride geometry, but it does not guarantee every façade, interior, tree, roof shape, building height, or coaster elevation/banking profile. The compiler preserves that distinction:

- `verified` mode uses mapped values and visible markers for missing critical 3D detail;
- `plausible` mode permits clearly reported estimates;
- `--strict` writes the evidence package, then refuses to create Minecraft outputs while critical evidence gaps remain.

The numeric confidence score remains useful for comparing builds, but the displayed letter grade is capped at B whenever any critical evidence gap remains. This prevents strong terrain and plan coverage from presenting a missing ride-height or banking profile as a grade-A replica.

No public-data tool can honestly guarantee “all detail” for every park. This one guarantees the scale, traceability, deterministic compilation, and refusal to hide evidence gaps.

## Universal high-fidelity evidence

The compiler has no park-name rules. Its common evidence model works at any park and accepts standard OSM tags or equivalent properties in portable GeoJSON overrides:

| Feature | Universal observations used |
|---|---|
| Guest, queue, and service paths | `highway`, `footway`, `queue`, `access`, `service`, `width`, `est_width` |
| Surface appearance | `surface`, `material`, `surface:colour`, `surface:pattern`, `paving_stones:pattern` |
| Bridges | `bridge`, `bridge:structure`, `bridge:deck:ele`, `bridge:clearance`, `covered`, plus DTM/DSM when available |
| Ride tunnels and supports | `tunnel`, `location=underground`, `layer`, profiled absolute elevation, DTM, optional clearance/support overrides |
| Individual trees and rows | `natural=tree`, `natural=tree_row`, `height`, `diameter_crown`, `leaf_type`, `leaf_cycle`, `species`, `tree_spacing_m`, `tree_count` |
| Natural paths and terrain detail | `surface=ground|dirt|earth|mud|compacted|gravel`, `natural=rock|stone|boulder|cliff`, `geological=outcrop|boulder`, `natural=bare_rock|scree|shingle`, dimensions where available |

Observed path colours are matched to the nearest supported Bedrock full block in CIELAB colour space. Explicit patterns compile deterministically as herringbone, running bond, checker, grid, stripes, mixed, or solid. If appearance is absent, verified mode uses orange blocks to mark “geometry known, appearance unknown”; it does not silently invent paving.

Path width follows a separate evidence hierarchy. A mapped pedestrian polygon is rasterized as its exact footprint. Linear routes use observed `width` or `width:carriageway` first, then accepted orthophoto edges, `est_width`, lane-derived width, and finally a disclosed universal class prior. An image-derived route is emitted as a variable-width corridor rather than one scalar buffer; canopy and coverage gaps keep only the mapped one-block centreline. For example, an untagged guest `footway` without image evidence compiles at a nominal 3 m with a recorded 2–5 m uncertainty range; an untagged queue compiles at 2 m. The fixed rasterizer also supports true even-width 2/4/6-block bands. Use `--path-width-mode source-only` to disable priors and retain one-block unknown-width markers.

Mapped point trees become full tree models only when height is tagged or measurable from DSM-minus-DTM. A crown diameter is used when present; otherwise the crown is explicitly counted as archetype inference. Tree rows require observed spacing/count, except in `plausible` mode. Broad canopy polygons are never turned into random individual trees in verified mode.

A mapped bridge is removed from the terrain surface and compiled as a separate deck. Explicit or DSM-measured deck height enables material-matched decking, rails, and grounded supports. Without vertical evidence, verified mode emits an orange plan marker and raises a critical `BRIDGE_VERTICAL_GEOMETRY_PARTIAL` gap instead of constructing a false bridge.

Ride tracks are classified against the same DTM used to build the world. Every replacement 3D profile receives a bidirectional metre-space alignment check against the source plan, with deviations above 3 m promoted to a critical review gap. Source-tagged underground spans with usable vertical evidence excavate a rounded clearance corridor, lining, and portals after terrain/footprint generation and before the evidence-coloured track is written. In `--ride-terrain-mode inferred`, hidden gaps inside an explicitly tagged tunnel receive DTM-constrained yellow height inference; the original verified coverage is not relabelled. Elevated profiled track receives DTM-grounded A-frame supports at a disclosed spacing prior, while mapped paths and roads are excluded from support footings. Use `evidence` to disable hidden-height and support inference, or `off` to retain the earlier centreline-only output.

`fidelity.json` reports length-weighted path width/material/colour/pattern coverage, source-relative guest-network components and dangling endpoints, tree dimension coverage, bridge vertical coverage, and the exact capability of the source set used for that build. “Complete” means complete relative to the fused source lines: obscured, private, temporary, or newly built paths still require imagery or verified observations.

Orthophoto processing is deliberately evidence-seeded. Mapped path centrelines define bounded cross-sections for width and appearance. When `--path-discovery-mode` is enabled, accepted mapped-path appearance can also expand through connected image-visible hardscape, producing walkable polygons and a medial graph of branches, connectors, extensions, and junctions. The detector masks mapped buildings, water, and vegetation; rejects small, isolated, weak-confidence, steep, or bridge-requiring candidates; and never claims that imagery proves access rights. It therefore improves incomplete topology without claiming to discover every unmapped or canopy-obscured route. Explicit tags and verified survey overrides always outrank image classifications.

## Requirements

- Node.js 20 or newer (Node.js 24 is tested)
- Minecraft Bedrock 1.21.120 or newer for the direct world format
- Internet access for live public-source builds, or an offline Overpass JSON snapshot

The native Bedrock LevelDB dependency provides prebuilt binaries for common platforms. Run `npm run doctor` after installation.

## Install and test

```bash
npm install
npm test
npm run doctor
```

Build the included offline fixture:

```bash
npm run build:fixture
```

The main result is:

```text
out/fixture/fixture-park_1to1.mcworld
```

The test suite does more than check the ZIP extension. It reopens the generated LevelDB, parses the stored chunk version, height/biome data, block palettes, and every named sign entity, then uses a second independent pure-JavaScript reader to scan the finished `.mcworld` and decode both the sign block and its front/back text.

## Build a park

### Live public sources

```bash
node src/cli.mjs build \
  --park-name "Alton Towers" \
  --contact "your-email-or-project-url" \
  --accept-nominatim-policy \
  --elevation ea-lidar \
  --out out/alton-towers
```

This performs one cached place lookup, one bounded Overpass request, bounded Environment Agency WCS requests for 1 m DTM/DSM GeoTIFFs, and a bounded survey-index WFS request. It does not scrape websites or download public map tiles. `ea-lidar` applies to England; use `open-meteo` or local GeoTIFFs elsewhere.

### Fuse non-OSM public map data

The base map no longer has to come from OSM alone. Two repeatable inputs are available:

```bash
node src/cli.mjs build \
  --park-name "Park Name" \
  --osm data/park.overpass.json \
  --bbox SOUTH,WEST,NORTH,EAST \
  --overture data/overture-segments.geojson \
  --public-data data/park-open-gis.geojson \
  --out out/park-name
```

`--overture` accepts bounded Overture GeoJSON for transportation, buildings, base land/water, or places. Transportation segments are normalized from Overture `class`, `road_surface`, and global `width_rules`. Because Overture Transportation is primarily OSM-derived and then enhanced by other providers, it is treated conservatively as gap fill: routes overlapping the base map are withheld, partially overlapping routes are sent to review, and only clearly novel geometry is compiled. The tolerance is controlled by `--source-fusion-tolerance-m`.

`--public-data` accepts any WGS84 GeoJSON FeatureCollection from a park open-data portal, local authority, government survey, planning dataset, or rights-cleared extraction pipeline. Each feature or collection must provide `source_name`, `source_url`, and `license`; `checked_at`, `accuracy_m`, and `verified` are retained when supplied. Use `replaces=osm:way:...` only when that source is intended to supersede a specific feature. See `examples/public-terrain-observations.geojson`.

The output `source-fusion.json` records file hashes, accepted features, duplicates, partial overlaps, replacements, providers, and the merge policy. Overture is useful additional coverage, but it is not counted as independent corroboration of an OSM-derived feature.

### Fuse planning applications and architect drawings

Planning is deliberately separate from generic `--public-data`. Use `--planning` for higher-authority planning evidence:

```bash
node src/cli.mjs build \
  --park-name "Park Name" \
  --osm data/park.overpass.json \
  --bbox SOUTH,WEST,NORTH,EAST \
  --planning data/planning-manifest.json \
  --max-planning-applications 680 \
  --planning-match-tolerance-m 8 \
  --elevation ea-lidar \
  --buildings shells \
  --out out/park-name
```

A planning input may be a WGS84 GeoJSON FeatureCollection or a manifest containing up to 680 applications by default. Each observation can use `operation=add|replace|delete|retag|auto`. Explicit `target=osm:way:...` is preferred when the extraction pipeline can retain a source correspondence; otherwise `auto` uses compatible feature type, geometry overlap, shape distance, centroid distance and name agreement, and refuses ambiguous matches.

Architectural material schedules can define codes such as `P01`, `B01`, and `R01` and map them to built-in or custom weighted block palettes. The resolved material is attached to the planning feature before appearance/fidelity analysis, so explicit planning materials outrank orthophoto classification.

LiDAR roof sampling happens after planning fusion. This means a proposed/corrected building footprint can replace stale OSM geometry first, then DSM roof elevations are sampled inside that final footprint. The declared planning height can remain intact while the actual roof surface still comes from LiDAR.

### Add a 3D coaster profile

There are two evidence-preserving routes. A verified georeferenced centreline is preferred:

```bash
node src/cli.mjs build \
  --park-name "Park Name" \
  --elevation ea-lidar \
  --ride-profile survey/verified-rides.geojson \
  --ride-profile-mode profile \
  --out out/park-name
```

Alternatively, fit a vertical profile from a classified Environment Agency National LiDAR Programme LAS/LAZ tile. Download the point-cloud tile from the official [Survey Data portal](https://environment.data.gov.uk/survey), retain its original filename and licence metadata, then run:

```bash
node src/cli.mjs build \
  --park-name "Park Name" \
  --elevation ea-lidar \
  --ride-point-cloud survey/SK0540_point_cloud.laz \
  --ride-profile-mode lidar \
  --out out/park-name
```

The fitter searches only a narrow corridor around the mapped OSM track, clusters returns by height, rejects implausible jumps with a continuity constraint, and interpolates only short bounded gaps. It does not claim banking from a single-rail/centreline fit and does not invent missing spans. Use `hybrid` to let a supplied verified profile take precedence while LiDAR fills otherwise unprofiled ride features.

Direct profile files are GeoJSON `LineString`/`MultiLineString` features with `[longitude, latitude, elevation]` coordinates. Each feature must declare `elevation_datum`, `evidence`, and source provenance; optional `evidence_by_vertex`, `confidence_by_vertex`, and `banking_deg` arrays preserve segment-level differences. See `examples/ride-profile.geojson`.

### Add licensed orthophoto path evidence

Supply one or more cropped, georeferenced RGB GeoTIFFs at sub-metre ground resolution:

```bash
node src/cli.mjs build \
  --park-name "Park Name" \
  --osm data/park.overpass.json \
  --bbox SOUTH,WEST,NORTH,EAST \
  --orthophoto imagery/park-rgb-025m.tif \
  --orthophoto-source "Provider and collection name" \
  --orthophoto-source-url "https://catalogue.example/dataset-record" \
  --orthophoto-license "OGL-3.0" \
  --orthophoto-date 2025-06-18 \
  --orthophoto-mode evidence \
  --path-discovery-mode evidence \
  --path-terrain-mode evidence \
  --out out/park-name
```

The raster must contain at least three colour bands and valid georeferencing. Embedded EPSG:4326, EPSG:3857, EPSG:27700, and WGS84 UTM CRSs are supported; use `--orthophoto-crs` and `--orthophoto-proj4` for another projected CRS. Multiple files form a resolution-ranked mosaic. Crop large rasters to the bounded park area before building.

`evidence` mode requires an explicit provider and reuse licence and may affect blocks. `assist` mode analyzes imagery and writes QA evidence but never changes width or appearance in the Minecraft output. This is useful while checking alignment, licensing, capture date, shadows, and canopy. ECW/JP2 or web-service imagery must first be exported to a rights-compliant RGB GeoTIFF; the tool does not bypass access controls or tile-service terms.

Path discovery is independently gated. `--path-discovery-mode qa` writes candidate polygons and graph edges without changing the normalized park or world. `evidence` may compile only connected components that pass provenance, confidence, novelty, terrain-grade, and water-crossing gates. `--path-terrain-mode evidence` leaves the source DTM unchanged; `conform` performs a path-only median adjustment bounded by `--path-terrain-max-cut-fill-m` and reports cut/fill volumes. Neither mode invents stairs, retaining walls, or bridge decks.

### Natural paths, rocks, and landform detail

Natural-surface routes use the same width hierarchy as paved paths, but their source material selects dirt/coarse-dirt, gravel, or mixed compacted palettes. Route-seeded sub-metre orthophotos may propose an earth material only when the warm-brown spectral candidate clears the material-confidence gate; arbitrary brown pixels are never promoted to paths.

Mapped `rock`, `stone`, or `boulder` points are placed at their exact source position and DTM height. A point with `height_m` and `diameter_m` becomes a bounded terrain-conforming model; a point without dimensions remains a one-block position marker in `evidence` mode. Mapped cliff/outcrop lines become spaced plan markers, while bare-rock, scree, shingle, quarry, and outcrop polygons receive a stone surface. Rock output is excluded from buildings, structures, water, attraction points, paths, rails, and ride corridors.

`--terrain-detail-mode plausible` additionally distributes deterministic small clusters inside an already mapped rock-surface polygon. These are explicitly counted as inference and never claim exact boulder locations. `--terrain-rock-density-per-100m2`, `--terrain-rock-min-spacing-m`, `--terrain-cliff-marker-spacing-m`, and `--max-terrain-rocks` bound the output. Use `evidence` for exact source positions/surfaces only or `off` to retain evidence without emitting vertical detail.

For parks in England, the optional catalogue helper can screen a downloaded Environment Agency Vertical Aerial Photography metadata ZIP before any tile is sourced:

```bash
npm run check:ea-aerial -- \
  --index vertical_aerial_metadata.zip \
  --bbox SOUTH,WEST,NORTH,EAST
```

It hashes the exact catalogue snapshot, scans every GeoJSON index feature, and returns intersecting tile metadata or an explicit no-coverage result. It is a discovery helper only; it does not download imagery or relax the compiler's licence gate.

### Local 1 m GeoTIFF terrain and surface data

```bash
node src/cli.mjs build \
  --park-name "Park Name" \
  --osm data/park.overpass.json \
  --bbox SOUTH,WEST,NORTH,EAST \
  --elevation geotiff \
  --dtm survey/dtm-1m.tif \
  --dsm survey/dsm-1m.tif \
  --out out/park-name
```

The DTM and optional DSM must be aligned EPSG:27700 GeoTIFFs. The DTM drives bare-earth terrain. Where coverage is sufficient, DSM-minus-DTM fills otherwise unknown building-height evidence with a robust measured value. Default `--buildings markers` output intentionally uses only ground outlines and named signs; `--buildings shells` opts into the earlier full-shell compiler and its per-cell DSM roof surface. Existing height tags and survey overrides are never overwritten; material disagreements are listed in the evidence report. Use `--no-dsm` when only terrain is wanted.

### Reproducible offline build

```bash
node src/cli.mjs build \
  --park-name "Park Name" \
  --osm data/park.overpass.json \
  --bbox SOUTH,WEST,NORTH,EAST \
  --elevation none \
  --out out/park-name
```

An archived Overpass response makes the exact source snapshot reviewable and repeatable.

### Verified overrides

Use licensed survey, LiDAR-derived, or manually verified GeoJSON to replace incomplete public features:

```bash
node src/cli.mjs build \
  --park-name "Park Name" \
  --osm data/park.overpass.json \
  --bbox SOUTH,WEST,NORTH,EAST \
  --override survey/buildings.geojson \
  --override survey/rides.geojson \
  --strict
```

An override should record `verified`, `checked_at`, `source_name`, `source_url`, and `license`. Set `replaces` to an existing feature ID such as `osm:way:123456` to supersede it. See `examples/verified-override.geojson`.

The same portable override route supplies high-fidelity observations from any licensed orthophoto, canopy, LiDAR, survey, or local open-data pipeline. Use `kind=path|road|vegetation`, keep WGS84 geometry, record provenance, and add the universal fields from the table above. This separates source discovery/extraction from deterministic Minecraft compilation and avoids hard-coding a national dataset into the core.

## Direct world options

```text
--buildings markers|shells Ground outlines + named signs (default), or legacy 3D shells
--path-width-mode inferred|source-only
                            Disclosed route-class priors (default), or one-block unknown-width markers
--orthophoto FILE           Repeatable georeferenced RGB GeoTIFF path evidence
--orthophoto-mode MODE      evidence compiles licensed observations; assist is QA-only
--orthophoto-max-gsd-m 1    Reject imagery too coarse for path-edge measurement
--path-discovery-mode MODE  evidence compiles gated connected hardscape; qa never mutates the world
--path-terrain-mode MODE    conform uses bounded DTM smoothing; evidence leaves terrain unchanged
--overture FILE             Repeatable Overture GeoJSON; conservative non-overlapping gap fill
--public-data FILE          Repeatable provenance-complete public/park GIS GeoJSON
--terrain-detail-mode MODE  evidence, plausible polygon clusters, or off
--max-terrain-rocks 2000    Safety cap for vertical rock models/markers
--ride-terrain-mode inferred|evidence|off
                            Excavated tunnels + inferred supports, evidenced tunnel portions only, or centreline only
--ride-tunnel-width-m 7    Generic vehicle-clearance width; portable profile tags can override it
--ride-support-spacing-m 6 Disclosed generic support-frame spacing prior
--palette realistic|clean   Textured deterministic palette or literal source blocks
--world-margin 32           Completed terrain around the mapped boundary
--base-y 64                 Bedrock Y level for the public elevation datum
--seed INTEGER              Reproducible world and texture seed
--max-world-chunks 12000    Direct-world disk/CPU safety gate
--no-world                  Skip the direct .mcworld output
```

The 3D ride controls are listed by `node src/cli.mjs --help`. Raw LAZ decoding is intentionally bounded by `--max-point-cloud-mb`; `--point-cloud-skip` can reduce memory use, while cropping a large tile to the park is more accurate and efficient.

`realistic` texturing uses coordinate-hashed weighted variants, so rerunning with the same input and `--seed` produces the same material pattern. It mixes compatible full blocks for grass, dirt, stone, gravel paths, paved roads, and sand; shell mode additionally uses brick, timber, masonry, and roof variants. Water, fences, rails, supports, footprint outlines, and signs remain unambiguous.

The prebuilt region includes a solid bedrock/stone/dirt foundation and a terrain margin. Unmapped neighboring chunks use the void generator, preventing Minecraft from adding unrelated procedural terrain through the park boundary.

Advanced compatibility controls `--chunk-version` and `--block-data-version` are available for experts; the defaults target current Bedrock storage and are the tested values.

## Import into Minecraft

1. Copy or open the generated `*_1to1.mcworld` on a device with Minecraft Bedrock.
2. Let Minecraft import it.
3. Open the newly imported world. It starts in Creative mode on the mapped path nearest the highest-ranked public main entrance when one exists, otherwise at the nearest park cell to the map origin.

The world is self-contained. You do not need to activate a pack or run commands.

Near spawn, seven evidence boards explain the map grade, exact scale, track colours, tunnel/support inference, unknown path-surface markers, terrain-detail evidence/inference, and the distinction between geometry evidence and live park information. Each named mapped ride also gets a nearby sign showing its verified vertical coverage, profile confidence, banking coverage, and source year where available. These signs report uncertainty; they are not safety, accessibility, queue-time, or operational-status information.

The optional `*_1to1_builder.mcaddon` remains useful when you deliberately want to place the park into an existing world. Activate it in a backed-up world, then use `/scriptevent tpmap:arm` followed by `/scriptevent tpmap:build`.

## How features become blocks

| Source feature | Bedrock result |
|---|---|
| DTM/DEM elevation | One-block-per-metre terrain surface over a solid foundation |
| Paths and roads | Width-aware mapped lines plus confidence-gated image-visible walkable polygons and junction evidence; observed material, colour-matched palette, and deterministic pattern; orange when appearance is unknown |
| Dirt/ground paths | Width-aware natural-material palette from tags, public observations, or accepted route-seeded imagery evidence |
| Rocks, cliffs, and rock surfaces | Exact DTM-conforming dimensioned models or position/line markers; stone polygon surface; optional explicitly inferred clusters only inside mapped rock polygons |
| Bridges | Separate height-evidenced deck, rails, supports, and optional covered roof; orange plan marker when deck height is unknown |
| Water polygons | Level water blocks over terrain |
| Building/structure footprints | Yellow ground outline, including inner boundaries; exact public name on a two-sided waxed sign placed from a mapped entrance or nearest guest path. No invented label for unnamed footprints |
| Barriers and rails | Fence, wall, iron, or support geometry |
| Ride tracks | Evidence-coloured 3D centreline; source-tagged/profile-detected underground spans excavate terrain and portals; elevated spans can receive DTM-grounded inferred supports. Orange = missing height; yellow = inference |
| Trees/vegetation | Dimensioned mapped trees from tagged/DSM height and crown evidence; mapped position marker when dimensions are unknown |
| Entrances/amenities | Color-coded detail markers; `entrance=main` has first spawn preference |

Use `--buildings shells` only when a 3D shell is wanted; it restores walls and roofs at tagged/override height and measured per-cell DSM roof surfaces where available.

## Output files

| File | Purpose |
|---|---|
| `*_1to1.mcworld` | Importable world with prebuilt LevelDB chunks |
| `world-manifest.json` | World format, bounds, spawn, SHA-256, and round-trip validation |
| `block-palette.json` | Weighted texturing rules and every emitted block name |
| `building-labels.json` | Every public building/structure name, displayed sign text, source ID, and world coordinates |
| `ride-profiles.json` | Per-ride 3D samples, evidence class, source hashes, vertical/banking coverage, and confidence |
| `orthophoto-evidence.json` | Path cross-sections, accepted widths/appearance, confidence, rejections, hashes, and licence |
| `orthophoto-qa.geojson` | Review layer containing accepted path envelopes and high-confidence land-cover candidates |
| `path-topology-evidence.json` | Connected walkable components, medial graph, confidence, topology class, DTM grades, provenance, and rejection reasons |
| `path-topology-qa.geojson` | Reviewable recovered polygons and graph edges, including candidates forbidden from compilation |
| `terrain-detail-evidence.json` | Dirt-path lengths/materials plus mapped rock points, dimensions, cliffs, surfaces, providers, and inference policy |
| `source-fusion.json` | Non-OSM inputs, hashes, providers, accepted features, withheld overlaps, replacements, and precedence policy |
| `*.geojson` | Normalized geometry and feature provenance |
| `evidence.json` | Source acquisition and machine-readable confidence assessment |
| `fidelity.json` | Universal path, surface, tree, bridge, and source-capability evidence |
| `ACCURACY_REPORT.md` | Human review of coverage, estimates, and missing data |
| `preview.svg`, `preview.html` | Plan-view inspection before Minecraft import |
| `*_1to1_builder.mcaddon` | Optional in-game runtime builder |

## Public data and licensing

Default sources are:

- OpenStreetMap/Overpass for boundaries, buildings, guest paths, land, water, amenities, attraction areas, and mapped roller-coaster plan geometry;
- Nominatim for a user-triggered park-name lookup only;
- Environment Agency National LiDAR Programme 1 m DTM/DSM and survey index for bounded builds in England;
- optional user-supplied Environment Agency National LiDAR Programme point-cloud tiles for physical XYZ returns around ride tracks;
- optional user-supplied open or licensed georeferenced RGB orthophotos for visible path edges and appearance;
- optional bounded Overture GeoJSON for conservative route/base/building gap fill;
- optional provenance-complete public park GIS, government survey, planning, geology, tree, and land-cover observations in portable GeoJSON;
- Open-Meteo elevation (Copernicus DEM GLO-90) only after explicit terms acceptance.

OpenStreetMap-derived output requires attribution and may carry ODbL share-alike obligations. The software is MIT licensed; generated data retains the licenses of its sources. For commercial Open-Meteo access, use the appropriate customer endpoint and prefer `TPMAP_OPEN_METEO_API_KEY` over putting a key in shell history.

Policies and documentation:

- https://www.openstreetmap.org/copyright
- https://operations.osmfoundation.org/policies/nominatim/
- https://wiki.openstreetmap.org/wiki/Overpass_API
- https://environment.data.gov.uk/dataset/2e8d0733-4f43-48b4-9e51-631c25d1b0a9
- https://www.ordnancesurvey.co.uk/geodesy-positioning/coordinate-transformations/resources
- https://open-meteo.com/en/docs/elevation-api
- https://docs.overturemaps.org/getting-data/
- https://docs.overturemaps.org/guides/transportation/
- https://docs.openaerialmap.org/api/api/
- https://esa-worldcover.org/en/data-access
- https://stacspec.org/en/about/stac-spec/

## What a defensible full replica still needs

For a release-grade reconstruction, add sources such as:

- classified LiDAR point clouds where narrow ride/support geometry must be separated from vegetation;
- surveyed/GPS control points;
- verified building heights and roof geometry;
- park-authorized or manufacturer 3D ride centrelines and banking;
- licensed façade/interior measurements;
- a dated manual review of recent park changes.

The compiler is designed to accept those verified overrides without pretending public gaps are known. Public LiDAR is excellent vertical evidence, but occlusion, vegetation, support steel, classification errors, survey date, and later ride alterations prevent it from being a guaranteed engineering centreline. Planning drawings can validate layout and selected dimensions; only a surveyed or manufacturer-authorized model can resolve full rail separation, roll, banking, transitions, and hidden/tunnel geometry defensibly.

## Development

```bash
npm test
node --check src/cli.mjs
npm audit
```

Run `node src/cli.mjs --help` for all source, accuracy, safety, direct-world, and optional add-on controls.

## Path Geometry Phase 1 (v0.11.3)

The compiler now includes a conservative mapped-path repair stage before orthophoto analysis. In plausible builds it may close short source-relative endpoint gaps when both routes are semantically compatible and the connector remains inside the park without crossing mapped buildings or water. Verified builds should use QA mode.

```bash
node src/cli.mjs build \
  --park-name "Alton Towers Resort" \
  --bbox 52.9810,-1.8970,52.9960,-1.8690 \
  --path-geometry-mode repair \
  --path-snap-tolerance-m 3 \
  --path-snap-min-confidence 0.70 \
  --path-edge-mode evidence
```

Outputs include `path-geometry-evidence.json` and `path-geometry-qa.geojson`. Explicit `area:highway` polygons are compiled as path/road areas, tagged start/end widths are rasterized as variable-width corridors, and explicitly mapped kerbs are rendered as one-block interior path edges.
