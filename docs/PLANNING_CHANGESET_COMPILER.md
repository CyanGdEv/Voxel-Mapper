# Planning Change-Set Compiler

This document defines the next Voxel Mapper layer after OSM/planning reconciliation.

## Goal

Convert verified-current, georegistered planning evidence into semantic site features and infer the canonical edit needed against the OSM-derived base map.

The compiler must remain park-agnostic. It may use OSM names, geometry and topology as spatial/search anchors, but it must not hardcode park, ride, council or application identifiers.

## Semantic feature classes

The initial compiler targets:

- building
- structure
- path
- road
- ride_track
- ride_support
- barrier
- water
- vegetation
- terrain_detail

## Change operations

For every authoritative planning feature, the compiler emits one of:

- `add` — no sufficiently similar lower-authority canonical feature exists.
- `replace` — one unambiguous lower-authority feature represents the same real object but planning geometry is authoritative.
- `delete` — explicit, current demolition/removal evidence targets an existing lower-authority feature.
- `retain` — planning corroborates the existing canonical feature closely enough that no topology mutation is needed.
- `review` — semantic identity or spatial match is ambiguous, so generation fails closed and preserves the existing map.

## Safety gates

Topology-changing operations require georegistered evidence whose temporal resolver has marked it as current world authority. Planning approval by itself is never implementation evidence.

Deletion additionally requires explicit demolition/removal semantics and high-confidence current-state evidence. Higher-authority surveyed/manual overrides cannot be mutated by this compiler.

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
