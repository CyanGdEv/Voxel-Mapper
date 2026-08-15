# Changelog

## 0.11.1 — Aerial appearance and dense vegetation

- Added three-block, material-aware path palettes selected by perceptual colour distance.
- Added deterministic herringbone, running-bond, slab, grid, stripe, mosaic, speckled and organic surface patterns.
- Added rights-gated aerial terrain classification for grass, dry grass, woodland floor, soil/mulch, gravel/rock and sand.
- Added terrain palette texturing before mapped feature overlays, preserving paths, buildings, water and other authoritative geometry.
- Added woodland, forest, orchard, scrub, shrub, hedge and tree-row source classification across OSM, Overture and portable public-data inputs.
- Added density-derived tree and shrub placement with spacing, exclusion, canopy-colour palettes and DSM-minus-DTM height evidence.
- Added rights-cleared aerial-canopy gap filling outside mapped vegetation extents, with confidence, density, access-surface and model-limit gates.
- Added continuous hedge volumes and denser tree-line generation.
- Added command-line controls for aerial terrain confidence/grid size and vegetation density/safety limits.
- Added focused regression tests for path palettes, aerial classes and dense vegetation compilation.
- Lazy-loaded COPC point-cloud support so non-point-cloud tests do not require the optional decoder at module startup.

## 0.11.0

- Adds first-class, repeatable `--overture` GeoJSON ingestion for transportation, buildings, base land/water, and places, including Overture road surface and global width-rule normalization.
- Uses a conservative Overture merge policy: clear OSM duplicates and partial overlaps are withheld; only non-overlapping gap geometry is compiled and every decision is reported.
- Adds repeatable `--public-data` WGS84 GeoJSON ingestion with mandatory provider, catalogue URL, and licence metadata plus retained dates, accuracy, hashes, verification, and explicit replacement targets.
- Adds natural-surface path evidence and dirt/coarse-dirt/gravel palettes from mapped tags, public observations, and confidence-gated route-seeded orthophoto material candidates.
- Adds mapped rock, stone, boulder, cliff, outcrop, bare-rock, scree, shingle, and quarry normalization with DTM-conforming compilation.
- Keeps undimensioned mapped rocks as position markers in evidence mode; dimensioned points receive bounded models, cliffs receive exact plan markers, and rock polygons receive surface texture.
- Adds an explicit plausible mode for deterministic small clusters only inside mapped rock-surface polygons, with density, spacing, cliff spacing, collision masks, and model safety caps.
- Adds `source-fusion.json`, `terrain-detail-evidence.json`, world-manifest terrain metrics, source/provider breakdowns, CLI documentation, example public terrain observations, and regression coverage.

## 0.10.0

- Adds conservative orthophoto walkable-surface segmentation seeded by accepted mapped-path appearance, using CIELAB colour distance, local texture, vegetation rejection, and mapped building/water/vegetation exclusion masks.
- Polygonizes connected image-visible hardscape and extracts a medial path graph with junctions, connector/extension classification, novel-area measurement, and per-edge confidence.
- Fuses only provenance-complete evidence-mode components into the world; QA mode emits the same candidates and rejection reasons without mutating normalized geometry or blocks.
- Assesses recovered edges against the DTM, labels ramp candidates, and prevents steep or water-crossing candidates from becoming unsupported stairs, earthworks, or bridges.
- Adds optional bounded path-terrain conformance with source-relative cut/fill limits and manifest volumes; evidence mode leaves the source DTM unchanged.
- Adds `path-topology-evidence.json`, `path-topology-qa.geojson`, world-manifest metrics, accuracy gaps, CLI controls, synthetic unmapped-branch regression coverage, and a terrain cut/fill bound regression.

## 0.9.0

- Adds a universal local orthophoto adapter for repeated georeferenced RGB GeoTIFF inputs, including WGS84, Web Mercator, British National Grid, WGS84 UTM, and caller-registered projected CRS support.
- Reconstructs path envelopes from mapped route seeds using bidirectional CIELAB cross-section edges, robust variable-width statistics, image-resolution and visibility gates, and vegetation/imagery-gap rejection.
- Rasterizes accepted variable-width corridor polygons at one block per metre while retaining a one-block mapped centreline through canopy or coverage gaps instead of inventing unsupported width.
- Adds shadow-rejected sRGB path colour observations plus confidence-gated material and visible surface-uniformity classifications; explicit mapped/surveyed values always take precedence.
- Requires an explicit imagery provider and reuse licence before observations may influence a world. `assist` mode is QA-only for exploratory or incompletely documented imagery.
- Adds orthophoto hashes, capture metadata, source-relative coverage, rejection reasons, land-cover candidates, QA GeoJSON, machine-readable evidence, accuracy-report caveats, and world-manifest metrics.
- Adds regression coverage for six-metre image-visible paths, colour recovery, `.mcworld` validation, evidence precedence, and licensing gates.

## 0.8.0

- Preserves OSM tunnel, layer, covered, location, and bridge semantics when a portable 3D profile replaces the original ride-track feature.
- Measures every replacement profile bidirectionally against its source plan in local metres and raises a critical review gap above 3 m deviation.
- Adds terrain-aware ride-section compilation with source-tagged tunnel classification and verified profile-versus-DTM underground detection.
- Excavates a configurable vehicle-clearance corridor through the generated terrain, adds a separate lining and portal frames, and writes the evidence-coloured track after excavation so terrain cannot refill it.
- Fills hidden elevations only for explicitly tunnel-tagged gaps in `--ride-terrain-mode inferred`; these blocks remain yellow and are reported separately from measured/interpolated profile coverage.
- Adds DTM-grounded A-frame support generation at a configurable 6 m prior, with support height, slope, tunnel, and terrain collision guards.
- Adds `--ride-terrain-mode inferred|evidence|off` plus tunnel-clearance, cover, support-spacing, and minimum-support-height controls.
- Adds per-feature tunnel/support evidence, excavation/lining/portal/support metrics, a sixth in-world `RIDE STRUCTURES` disclosure board, manifest invariants, and independent world-palette validation.

## 0.7.1

- Fixed the rasterizer so measured 2, 4, and 6 metre paths produce true even-width block bands instead of collapsing or rounding down to a one-block centreline.
- Added a universal path-width hierarchy: mapped area footprints, observed `width`, `est_width`, carriageway width, lane-derived width, then disclosed route/access-class priors.
- Guest footways now default to a 3 m nominal band (2–5 m evidence range), guest paths to 2.5 m, pedestrian centrelines to 6 m, queues to 2 m, and service/local roads to class-appropriate widths when no observation exists.
- Added `--path-width-mode source-only` for users who prefer one-block unknown-width evidence markers over inferred bands.
- Separates observed width coverage, inferred width coverage, compiled width coverage, nominal range, confidence, and provenance in `fidelity.json` and the accuracy report.
- Stops buffering polygonal pedestrian areas a second time around their boundary; their mapped footprint is now the exact raster source.

## 0.7.0

- Replaced park-specific accuracy assumptions with a universal capability-fusion model for paths, surfaces, trees, and bridges.
- Added length-weighted path width, material, colour, and explicit laying-pattern coverage plus source-relative network components and dangling-end validation.
- Added observed-colour-to-Bedrock matching in CIELAB space and deterministic solid, mixed, checker, grid, stripe, running-bond, and herringbone block patterns.
- Unknown path appearance now uses a visible orange fallback in verified mode instead of silently claiming gravel or concrete.
- Added dimensioned broadleaf/conifer tree models from mapped positions plus tagged or DSM-measured height and crown evidence; position-only data remains a marker.
- Added real bridge decks, side rails, supports, and covered roofs where deck height is explicit or measured; height-unknown bridges remain orange plan markers in verified mode.
- Added `fidelity.json`, a per-run source-capability matrix, portable per-feature provenance, new world-manifest metrics, and strict bridge-elevation evidence gates.
- Removed the remaining Alton-specific entrance-name heuristic and added universal regression fixtures for path appearance, trees, and bridges.

## 0.6.0

- Added versioned GeoJSON 3D ride-profile input with required elevation datum, evidence class, and provenance.
- Added bounded LAS/LAZ decoding and an OSM-corridor fitter for classified EPSG:27700 point clouds.
- Added height clustering, continuity-constrained candidate selection, confidence thresholds, and short-gap interpolation without inventing banking.
- Rasterizes ride profiles as true 3D voxel lines and keeps unverified spans as orange terrain-level plan markers.
- Colours every 3D segment by evidence tier: survey/CAD, planning drawing, LiDAR, interpolation, or inference.
- Places map evidence boards near spawn and a coverage/confidence/banking sign near each named ride.
- Caps the displayed map grade at B while any critical evidence gap remains, while retaining the uncapped numeric score for comparisons.
- Adds `ride-profiles.json`, ride evidence in the world manifest, source hashes, coverage statistics, and new critical-gap checks.
- Adds regression tests for direct profiles, point-cloud continuity, outlier rejection, evidence-coloured blocks, and player-readable signs.

## 0.5.0

- Correctly stitches split OpenStreetMap multipolygon members into closed outer and inner rings.
- Preserves courtyard, island, plaza, woodland, pool, and lake holes during surface and footprint rasterization.
- Uses area-weighted polygon and length-weighted line centroids instead of averaging raw vertices.
- Associates mapped entrance nodes with the nearest public building footprint and places labels from that evidence.
- Places remaining building labels nearest mapped guest paths while preferring cells that do not obstruct a path.
- Selects world spawn from the highest-ranked mapped main entrance and nearest mapped guest path.
- Records bridge, tunnel, and layer classifications without misinterpreting OSM layer order as measured height.
- Adds topology, sign-placement, and spawn provenance to the evidence and world manifests.
- Adds regression coverage for split multipolygons, inner holes, and entrance-guided labels.

## 0.4.0

- Changed the default building output to terrain-level yellow footprint outlines instead of 3D shells.
- Added one native, two-sided, waxed Bedrock sign for every named building or structure footprint.
- Added safe four-line name wrapping, formatting-code stripping, collision avoidance, and solid sign plinths.
- Added direct LevelDB block-entity serialization and all-sign round-trip validation.
- Added matching sign placement/text behavior to the optional runtime add-on.
- Preserved the former 3D building compiler behind `--buildings shells`.
- Added independent finished-world tests that decode the standing-sign block and its stored front/back text.

## 0.3.0

- Added bounded Environment Agency National LiDAR Programme 1 m DTM/DSM acquisition through WCS and survey-date provenance through WFS.
- Added local aligned EPSG:27700 GeoTIFF DTM/DSM input.
- Added exact WGS84/ETRS89-to-British-National-Grid alignment using the official OSTN15 transformation grid.
- Added robust DSM-minus-DTM height evidence for otherwise untagged building footprints.
- Added per-cell measured DSM roof surfaces while retaining tagged/override heights and reporting material conflicts.
- Added GeoTIFF sampling, LiDAR-height, and prior direct-world regression tests.
- Updated confidence scoring and reports to distinguish tagged, LiDAR-measured, missing, and conflicting vertical evidence.

## 0.2.0

- Added complete `.mcworld` output with prebuilt Bedrock LevelDB chunks.
- Added solid terrain foundations, a configurable finished terrain margin, and void generation outside the compiled region.
- Added direct subchunk serialization for terrain, water, paths, roads, building shells/roofs, barriers, ride geometry, vegetation, and markers.
- Added deterministic `realistic` and literal `clean` block-palette profiles.
- Added entrance-aware world spawn, `level.dat`, height maps, 3D biome records, chunk version/finalization records, and archive manifests.
- Added writer round-trip validation and independent finished-world scanning/block decoding in the test suite.
- Retained the runtime `.mcaddon` builder as an optional secondary output.
- Updated native dependency checks and removed known dependency audit findings.

## 0.1.0

- Initial evidence-first OpenStreetMap/Overpass, optional elevation, GeoJSON override, 1 m raster, preview, confidence report, and runtime Bedrock add-on compiler.

## 0.11.3

- Added conservative mapped path-gap repair and QA outputs.
- Added `area:highway` plaza support.
- Added variable-width tagged path rasterization.
- Added explicit kerb/path-edge rendering.
- Improved guest/service/queue route classification and path evidence metrics.

## 0.12.0

- Rebased Voxel Mapper on the v0.11.3 high-fidelity source baseline.
- Added planning application / architect drawing authority fusion with a 680-application default cap.
- Added explicit and automatic geometry replace/delete/retag/add operations.
- Added planning material schedule palettes and planning-authoritative path appearance.
- Changed LiDAR roof handling so DSM roof geometry is retained even when building height comes from a tagged/planning source.
- Defaulted building compilation to 3D shells so LiDAR roof evidence is represented.
- Preserved the existing terrain slope/DTM logic.
