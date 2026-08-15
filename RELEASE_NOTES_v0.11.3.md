# ThemePark Map v0.11.3 — Path Geometry Phase 1

## Added

- Conservative source-relative path endpoint repair with QA-only and compiled modes.
- Fixed-boundary and building/water crossing gates for repaired connectors.
- `area:highway` acquisition and polygon normalization for mapped plazas and pedestrian areas.
- Better guest, queue, and service-route classification.
- Tagged variable-width path profiles using start/end width evidence.
- Explicit kerb and path-edge palette generation and one-block edge rendering.
- `path-geometry-evidence.json` and `path-geometry-qa.geojson` outputs.
- Path geometry and edge statistics in the Bedrock world manifest and accuracy report.

## New CLI options

- `--path-geometry-mode repair|qa|off`
- `--path-snap-tolerance-m`
- `--path-snap-min-confidence`
- `--path-edge-mode evidence|off`

## Safety and evidence rules

- Repairs only connect a dangling mapped endpoint to another compatible mapped route segment.
- Repairs crossing mapped buildings or water are rejected.
- Queue routes never auto-connect to normal guest paths.
- Service and guest routes are kept separate.
- Verified builds default to QA-only; plausible builds can compile confidence-gated repairs.
- Kerbs are rendered only from explicit edge/kerb evidence.
