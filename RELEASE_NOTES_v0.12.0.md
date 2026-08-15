# Voxel Mapper v0.12.0 — planning authority architecture

This release rebases Voxel Mapper on the v0.11.3 high-fidelity terrain/tree/path compiler and introduces a first-class planning-authority layer.

## New

- OSM remains the base geometry/reference layer.
- Planning applications and architect-drawing extractions can add, replace, retag and delete lower-authority geometry.
- Automatic planning/OSM spatial matching is conservative and refuses ambiguous matches.
- Default planning safety cap is 680 applications per build.
- Planning geometry is locked against lower-authority path-gap repair.
- LiDAR roof surfaces are sampled from the final planning-adjusted building footprint even when a planning/OSM height tag already exists.
- 3D building shells are now the default building output mode so LiDAR roof evidence is actually represented in generated worlds.
- Planning material schedules resolve into role-specific Minecraft palettes for surfaces, walls, roofs, floors and barriers.
- Built-in palettes cover common theme-park planning materials including multiple asphalt/tarmac types, resin-bound surfacing, concrete, brick, stone, timber and roof finishes.
- `planning-fusion.json` and `planning-material-palettes.json` are emitted with every build.
- GitHub Actions CI and a manual world-build workflow are included.

## Preserved baseline behaviour

Terrain DTM sampling, slope logic, terrain detail, tree generation, OSM geometry normalization, path width logic, ride evidence, Bedrock chunk compilation and world validation are retained from v0.11.3 unless explicitly noted above.
