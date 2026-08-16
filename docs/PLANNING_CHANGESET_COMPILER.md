# Planning Change-Set Compiler

This document defines the next Voxel Mapper layer after OSM/planning reconciliation.

## Goal

Convert verified-current, georegistered planning evidence into semantic site features and infer the canonical edit needed against the OSM-derived base map.

The compiler must remain park-agnostic. It may use OSM names, geometry and topology as spatial/search anchors, but it must not hardcode park, ride, council or application identifiers.

## Semantic feature classes

The topology compiler targets:

- building
- structure
- path
- road
- ride_track
- ride_support
- barrier
- water
- vegetation

Ground/terrain areas are represented separately as `surface` paint masks. `terrain`, `terrain_detail`, `landform`, grading and ground elevation are never planning topology targets.

## Terrain invariants

Terrain geometry is immutable after the authoritative terrain source (DTM/LiDAR) has been sampled.

Planning data may:

- paint a verified polygon with a surface/material;
- change path/road/building/ride/structure geometry above the terrain;
- provide building/structure heights and ride vertical-profile evidence.

Planning data may not:

- raise or lower terrain;
- flatten terrain;
- perform cut/fill or grading;
- deform slopes;
- replace DTM/LiDAR ground elevation;
- convert a landscape polygon into a terrain geometry edit.

A terrain/landform mutation request is emitted as `review` with `terrain-geometry-immutable`, never materialized. Legacy path-terrain conform mode is forced to evidence-only by the main compiler pipeline so the generated terrain elevation raster remains unchanged.

The planning surface renderer runs only after the immutable 1 m terrain compilation exists. It indexes the already-compiled phase-1 top-surface blocks and may overwrite a block only at that exact existing Y. It never samples a new height, creates a missing terrain cell, or emits a vertical fill/cut. This makes paint masks follow the existing terrain slope exactly.

## Change operations

For every authoritative planning feature, the compiler emits one of:

- `add` — no sufficiently similar lower-authority canonical feature exists.
- `replace` — one unambiguous lower-authority feature represents the same real object but planning geometry is authoritative.
- `delete` — explicit, current demolition/removal evidence targets an existing lower-authority feature.
- `retain` — planning corroborates the existing canonical feature closely enough that no topology mutation is needed.
- `paint` — verified area/material evidence changes only the top-block surface; terrain elevation/shape is untouched.
- `review` — semantic identity or spatial match is ambiguous, so generation fails closed and preserves the existing map.

## Safety gates

Topology-changing operations require georegistered evidence whose temporal resolver has marked it as current world authority. Planning approval by itself is never implementation evidence.

Deletion additionally requires explicit demolition/removal semantics and high-confidence current-state evidence. Higher-authority surveyed/manual overrides cannot be mutated by this compiler.

Surface paint requires an authoritative, spatially associated material label. The ground renderer accepts only explicitly ground-safe material palettes; roof, glazing and cladding materials fail closed rather than being painted onto terrain.

## Planning surface palettes

The current weighted ground palettes include:

- weathered asphalt
- fresh black asphalt
- light asphalt
- red tarmac
- resin-bound beige
- resin-bound grey
- concrete
- old concrete
- paving stones / paving slabs / block paving aliases
- brick
- stone
- timber
- gravel
- sand
- grass
- earth/soil

Weighted palettes retain all configured Minecraft blocks. Five-entry resin and paving palettes are not truncated to three blocks. Deterministic coordinate hashing preserves repeatable speckled/mixed/organic material variation across runs.

If a current planning material is not in the ground-safe palette registry, it remains explicit QA evidence and is deferred instead of being substituted with an inaccurate block.

## Semantic inference

Feature type is inferred from multiple independent signals rather than a single label:

1. normalized extractor semantic/classification;
2. drawing/document class;
3. nearby planning text/labels when available;
4. geometry type and dimensions;
5. matching OSM feature kind/name where an unambiguous candidate exists.

Weak or conflicting signals emit `review` rather than guessing.

## Provenance

Each emitted change records the planning document hash/page, semantic evidence, temporal authority, match score, target feature (if any), operation confidence and decision reason. The resulting change-set is written as a standalone QA artifact before world reconstruction.

`planning-surface-paint.json` also records the final render result, material palette, block weights, painted cell count, operation count and explicit `terrainGeometryChanged: false` / `terrainElevationChanged: false` evidence for every rendered planning area.
