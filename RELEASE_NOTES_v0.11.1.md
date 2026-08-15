# ThemePark Map v0.11.1 — Aerial Appearance and Dense Vegetation

Version 0.11.1 keeps the proven v0.11 world/compiler architecture and improves only the visible surface and vegetation reconstruction layers.

## Path appearance

Mapped or orthophoto-observed path colour is matched against an expanded Bedrock block colour catalogue in CIELAB space. Material compatibility and texture are included in ranking so a red paving-stone path prefers brick/terracotta families rather than a visually close but physically implausible block. Each style can use a three-block weighted palette.

Supported deterministic patterns include herringbone, running bond, slabs, grid, stripes, mosaic, checker, speckled and organic mixes. Pattern scale and direction can come from source tags.

## Aerial terrain detail

A rights-cleared georeferenced RGB orthophoto can now classify and compile natural ground appearance across the park. Supported compilation classes are grass, dry grass, woodland floor, soil/mulch, gravel/rock and sand. Water, roofs, neutral hardscape and shadow remain QA-only to avoid overwriting authoritative geometry.

Aerial terrain is painted before mapped feature overlays, so paths, roads, buildings, water and rides remain authoritative. Evidence mode requires explicit imagery source and licence metadata.

## Vegetation reconstruction

The compiler now recognises point trees, tree rows, forests/woodland, orchards, scrub/shrub polygons and hedges from OSM, Overture and portable GeoJSON. Polygon vegetation is compiled as deterministic density-derived models with minimum spacing and path/building exclusions. Aerial canopy evidence adjusts density and leaf palette, while DTM/DSM pairs provide measured height where available.

Dense tree lines use configurable spacing. Hedges compile as continuous low vegetation volumes; scrub compiles as irregular bush models rather than miniature trees. Where rights-cleared aerial imagery shows high-confidence dense canopy outside mapped vegetation polygons, the compiler can fill those unmapped cover gaps with deterministic density-derived trees. All inferred density and height decisions are reported separately from surveyed evidence.

## New controls

```text
--aerial-terrain-mode evidence|qa|off
--aerial-terrain-grid-m N
--aerial-terrain-min-confidence N
--tree-density-per-100m2 N
--shrub-density-per-100m2 N
--tree-line-spacing-m N
--vegetation-min-spacing-m N
--max-vegetation-models N
```

## Alton Towers benchmark defaults

The cloud benchmark uses building markers, EA LiDAR where available, plausible terrain detail, 2.8 trees per 100 m² of mapped woodland, 16 shrub models per 100 m² of scrub, 3 m tree-line spacing and a 30,000-model vegetation safety limit. Aerial texture/path-colour extraction activates only when a georeferenced, rights-cleared orthophoto is supplied.
