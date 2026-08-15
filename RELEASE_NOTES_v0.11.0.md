# ThemePark Map v0.11.0 — source-fused terrain detail

Released 2026-08-02.

## Outcome

v0.11 adds natural terrain detail without pretending that OSM is the only available source. Dirt and compacted paths use material-appropriate palettes, while mapped rocks, boulders, cliffs, outcrops, and rock-surface polygons now affect the Bedrock world at the same one-metre grid and DTM used by the rest of the park.

The map core can now ingest bounded Overture GeoJSON and provenance-complete public/park GIS GeoJSON alongside OSM, orthophotos, DTM/DSM, ride profiles, and point clouds.

## Source-fusion safeguards

Overture Transportation is primarily OSM-derived, so it is not counted as independent corroboration. The adapter compares routes in local metres and:

- withholds clear duplicates;
- withholds partially overlapping lines rather than creating doubled half-routes;
- compiles only clearly non-overlapping gap geometry;
- retains Overture release, upstream-source, licence, file, and hash metadata.

`--public-data` is intended for independent public park GIS, local-authority, planning, geology, tree, or field-survey observations. Provider, source URL, and reuse licence are mandatory. A feature supersedes another only through an explicit `replaces` identifier.

## Terrain compilation

Evidence mode compiles observed geometry only:

- ground, dirt, earth, mud, compacted, fine-gravel, and gravel paths use corresponding deterministic palettes;
- dimensioned rock/boulder points become bounded DTM-conforming models;
- undimensioned points stay one-block position markers;
- cliff/outcrop lines become source-position plan markers;
- bare-rock, scree, shingle, quarry, and outcrop polygons receive a stone surface.

Plausible mode may also distribute deterministic small clusters inside an already mapped rock polygon. Their locations are explicitly labelled inference. Collision masks protect buildings, structures, water, attraction points, paths, rails, and ride corridors, and a global safety cap bounds vertical models.

## Non-OSM public sources

The supported source family now includes:

- Overture Maps bounded GeoJSON for normalized, conservative gap fill;
- public park/local-authority/government GeoJSON with feature-level provenance;
- OpenAerialMap or other rights-cleared COG/GeoTIFF imagery through the existing orthophoto adapter;
- Environment Agency or local DTM/DSM LiDAR terrain;
- global DEM where finer elevation is unavailable;
- ESA WorldCover/STAC-derived observations after conversion to provenance-complete GeoJSON (coarse cover only, never exact path or boulder geometry).

## New evidence

- `source-fusion.json` records every non-OSM input, hash, provider, accepted feature, withheld overlap, replacement, and precedence rule.
- `terrain-detail-evidence.json` records natural-path material/length plus rock points, dimensions, cliffs, polygon area, source providers, and inference policy.
- `world-manifest.json` records terrain-detail mode, models, position markers, cliff blocks, inferred clusters, and total rock blocks.
- A seventh player-readable evidence board states whether rocks are mapped-only, inferred inside mapped polygons, or disabled, and makes clear that terrain detail is not random scenery.

Public data still cannot guarantee every real detail. v0.11 improves fidelity where evidence exists and makes the remaining absence visible instead of filling it with undocumented scenery.

## Validated builds

The synthetic source-fusion proof accepted five non-OSM features, withheld one duplicate Overture route, compiled two natural-surface paths, one dimensioned boulder, one cliff line, and one bare-rock polygon, and emitted 218 rock blocks across 21 models/markers plus 23 cliff marker blocks. Its 288 chunks and 1,440 subchunks passed an independent pure-JavaScript scan.

The Alton Towers build retains the archived bounded OSM plan, non-OSM 1 m DTM/DSM, and portable 3D ride evidence. It now identifies four mapped compacted routes totalling 351.3 m and compiles their gravel/coarse-dirt texture. No mapped rock, cliff, or rock-surface evidence exists in that source snapshot, so the Alton world intentionally emits zero decorative rocks. All 9,504 chunks, 69,207 subchunks, 102 native signs, tunnel/support palette evidence, and building labels passed independent validation.
