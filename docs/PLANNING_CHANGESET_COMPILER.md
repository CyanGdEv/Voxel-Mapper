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

Surface paint requires an authoritative, spatially associated material label. If the exact material is not yet supported by the surface renderer, the paint operation is retained in QA as `deferred-renderer-palette` rather than substituted with an incorrect block.

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
