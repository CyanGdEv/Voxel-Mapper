# ThemePark Map v0.10.0 — path topology recovery

Released 2026-08-02.

## Outcome

v0.10 can recover a connected, image-visible walkable area that is absent from the mapped route source, turn it into a path polygon and medial graph, and compile it into a 1:1 Bedrock world only when the imagery and confidence gates permit it.

The synthetic proof image contains an intentionally unmapped 60 m × 4 m branch attached to a mapped avenue. The build recovered:

- one accepted connected component;
- one 57 m extension edge;
- one 216 m² novel path polygon;
- the observed `#3a3c3e` asphalt appearance;
- complete imagery provider, licence, capture date, resolution, and raster hash provenance.

The proof `.mcworld` passed an independent pure-JavaScript scan of all 288 chunks and 1,440 subchunks.

## Evidence and safety model

The detector uses accepted mapped-path colours as CIELAB appearance prototypes. It combines colour distance, local texture, vegetation rejection, connected components, polygonization, and a Zhang–Suen medial skeleton. Existing route geometry remains the topology anchor.

Mapped buildings, water, and vegetation are exclusion masks. Small isolated regions and mapped-edge slivers are removed. Graph edges receive connector/extension classification, confidence, novelty, DTM grade, and a rejection reason.

`--path-discovery-mode qa` never mutates normalized geometry or blocks. `evidence` additionally requires provenance-complete evidence-mode imagery. Steep candidates and candidates requiring bridge structure remain review-only.

Recovered polygons follow the world DTM. `--path-terrain-mode evidence` leaves source heights unchanged. `conform` applies a two-pass path-only median filter, with mapped routes as fixed anchors and a hard per-cell source-relative bound set by `--path-terrain-max-cut-fill-m`. Cut/fill cells and volumes are written to the world manifest.

## Alton Towers build

The v0.10 Alton Towers world retains the previous bounded OSM snapshot, 1 m DTM/DSM, portable ride profiles, terrain-aware tunnels/supports, path-width priors, tree models, bridge evidence, building footprint markings, and named signs.

No reusable, georeferenced Alton Towers orthophoto is present in the supplied evidence set. Path recovery is therefore recorded as inactive, with zero recovered geometry. This is intentional: the compiler does not infer missing paths from the park name or from an ungeoreferenced screenshot.

The Alton world passed independent validation of all 9,504 chunks and 69,207 subchunks. It contains 245 marked building footprints, 84 public-name building signs, six mapped ride-tunnel features, 7,985 excavated tunnel blocks, and 289 explicitly inferred DTM-grounded support frames.

## New outputs

- `path-topology-evidence.json`: component, graph, terrain, provenance, confidence, and rejection evidence.
- `path-topology-qa.geojson`: reviewable component polygons and graph edges, including QA-only candidates.
- `world-manifest.json → fidelityOutput.pathTopology`: compiled recovery summary.
- `world-manifest.json → fidelityOutput.pathTerrain`: source-relative terrain treatment and cut/fill totals.

## Important limits

This release does not prove access rights or detect paths hidden under canopy. It does not turn an image-only water crossing into a bridge, nor a steep hardscape region into stairs or surveyed earthworks. Radiometrically similar roofs, yards, temporary paving, shadows, or vehicles can still require review. High-fidelity use should inspect the QA layer before enabling evidence mode.

For Alton Towers specifically, the next material plan-accuracy improvement requires a rights-cleared, sub-metre, georeferenced RGB orthophoto with an explicit reuse licence and capture date.
