# Voxel Mapper planning-authority fusion architecture

## Goal

Voxel Mapper keeps the proven v0.11.3 terrain/elevation/tree/path pipeline, but changes horizontal feature authority from an additive-source model to a deterministic edit stack suitable for local-authority planning applications and architect drawings.

The core rule is:

> **OSM establishes the base reference geometry. Planning evidence may add, reshape, replace, retag, or delete lower-authority geometry. LiDAR then enriches the final fused geometry vertically.**

This separates **where a feature is** from **what its vertical form is** and prevents stale OSM geometry from winning over a planning drawing.

## Authority stack

| Rank | Layer | Geometry behaviour |
|---:|---|---|
| 400 | Verified manual/survey override | Final explicit correction |
| 300 | Planning application / architect drawing | May replace/delete/edit lower layers |
| 100 | OSM base geometry | Initial park plan and reference frame |
| <=100 | Public/Overture gap evidence | Gap fill / secondary observation only |

Planning features are marked `authority.geometryLocked=true`. Lower-authority path-gap repair is not allowed to bend or splice them.

## Processing order

1. Acquire OSM, terrain DTM, DSM/LiDAR and existing optional sources.
2. Normalize OSM into metre-space around the park centre.
3. Apply existing conservative public/Overture gap fusion.
4. Load planning manifests, up to **680 applications by default**.
5. Normalize architect-drawing observations into the same WGS84 + local metre-space representation.
6. Apply planning edit operations:
   - `add`
   - `replace`
   - `delete`
   - `retag`
   - `auto` (replace a unique compatible nearby lower-authority feature, otherwise add)
7. Apply final manual verified overrides.
8. Sample LiDAR DSM/DTM against the **resulting final building footprints**.
9. Run the unchanged terrain/path/tree/ride compilation pipeline.
10. Emit planning-fusion and material-palette evidence manifests alongside the normal build evidence.

## Planning manifest

`--planning FILE` is repeatable. A file can be either:

- a WGS84 GeoJSON `FeatureCollection`; or
- a JSON manifest with an `applications` array.

An application can contain inline `features`, external `feature_files` / `geometry_files`, and `drawings`. A drawing can contain inline GeoJSON or point at an extracted GeoJSON file. This keeps PDF/image extraction separate from geometry authority: OCR/vector/PDF extraction can improve independently without changing the fusion engine.

Example:

```json
{
  "materials": [
    { "code": "P01", "name": "Red tarmac", "role": "surface", "palette": "red_tarmac" },
    { "code": "B01", "name": "Brick", "role": "wall", "palette": "brick" },
    { "code": "R01", "name": "Slate", "role": "roof", "palette": "slate_roof" }
  ],
  "applications": [
    {
      "reference": "APP/2026/001",
      "source_url": "https://planning.example/application/APP-2026-001",
      "license": "public-record",
      "drawings": [
        {
          "id": "A-100",
          "title": "Proposed site plan",
          "revision": "C",
          "file": "planning/APP-2026-001/A-100.geojson"
        }
      ]
    }
  ]
}
```

## Geometry edits

A normalized planning feature can explicitly target a source feature:

```json
{
  "type": "Feature",
  "properties": {
    "operation": "replace",
    "target": "osm:way:123456",
    "kind": "path",
    "surface_material_code": "P01"
  },
  "geometry": { "type": "LineString", "coordinates": [] }
}
```

If `operation=auto` (the default), Voxel Mapper compares only compatible lower-authority feature families. It scores geometry overlap, metre-space shape distance, centroid distance and name agreement. A unique candidate above the configured threshold is replaced. Ambiguous candidates are not silently changed.

Useful controls:

- `--max-planning-applications 680`
- `--planning-match-tolerance-m 8`
- `--planning-min-match-score 0.64`

Deletion is intentionally stricter than replacement when no explicit target is provided.

## LiDAR building roofs

The baseline already sampled DSM-minus-DTM for building height, but tagged/planning heights caused the renderer to stop using the LiDAR roof surface. The new rule separates these two concepts:

- planning/OSM height may remain the declared building-height evidence;
- DSM is still attached as `feature.roof.source=lidar-dsm-surface` whenever coverage is sufficient;
- shell compilation samples the DSM per interior 1 m cell to reproduce stepped roof elevation;
- sampling occurs after planning geometry fusion, so stale OSM footprints do not control roof sampling.

The terrain DTM and slope logic are not modified by planning fusion.

## Material schedules and Minecraft palettes

Planning material schedules are normalized by `src/lib/material-palettes.mjs`. A material can reference a built-in palette or provide explicit Minecraft blocks and weights.

Roles are independent:

- `surface`
- `wall`
- `roof`
- `floor`
- `barrier`

Built-ins currently cover common theme-park planning materials including weathered/fresh/light asphalt, red tarmac, beige/grey resin-bound surfacing, concrete, old concrete, brick, stone, timber, gravel, slate/clay/metal roofs, glass, grass and earth.

Planning material evidence outranks orthophoto classification for the feature it applies to. This prevents an image classifier from replacing an explicit architect material schedule.

## Terrain invariant

This architecture deliberately does **not** rewrite the baseline terrain slope pipeline. DTM sampling, terrain interpolation, cut/fill behaviour, steep terrain and existing terrain-detail logic stay on the v0.11.3 implementation. Planning geometry is an overlay authority, not an implicit earthworks instruction.

A future earthworks phase should require explicit proposed-contour / spot-level evidence instead of deriving terrain edits from building/path plans.
