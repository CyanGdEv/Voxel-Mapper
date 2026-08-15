# Current planning authority → per-attribute reconstruction fusion

This stage connects the strict current-state planning artifact produced by the planning revision resolver to Voxel Mapper's per-attribute Evidence Graph and, only after an attribute wins, to the Minecraft reconstruction model.

## Input contract

The only accepted planning input is the authority-only artifact produced after:

1. planning application discovery;
2. document acquisition and content-addressed caching;
3. vector/text extraction;
4. page-scoped georegistration;
5. revision/supersession resolution;
6. physical current-state resolution.

Every accepted entry must explicitly contain both:

- `worldGeometryAuthority: true`; and
- `planningTemporal.state: "current"`.

A missing temporal state is rejected. Proposed, approved-but-unbuilt, tender, for-construction, refused, withdrawn, demolished, superseded and ambiguous evidence is never inferred to be current by this stage.

## Three-stage fusion boundary

### 1. Association

`integratePlanningAuthorityEvidence()` works entirely in the existing local-metre coordinate system.

Geometry candidates are associated only with semantically compatible reconstructed features. Matching considers spatial overlap, centroid displacement, scale similarity and geometry family. Near-tie matches fail closed.

Positioned text observations such as materials and levels are attached only when one compatible feature uniquely contains or is sufficiently close to the observation. A near-distance tie also fails closed.

This stage adds `planningAuthorityCandidates` but does **not** change the world model.

### 2. Evidence Graph ranking

`fusePlanningAuthorityIntoEvidenceGraph()` inserts the associated planning candidate into the feature's existing attribute evidence pool and uses the same weighted scoring model as the Evidence Graph:

- 34% authority;
- 24% directness;
- 15% confidence;
- 10% recency;
- 10% resolution;
- 7% temporal certainty.

Current planning evidence is high authority, but a stronger manually surveyed/verified override can still win. Losing OSM, LiDAR and other evidence remains in the graph as alternatives/provenance.

### 3. Materialization

`applyPlanningAuthorityWinners()` is the first stage allowed to mutate the reconstruction model, and only when the Evidence Graph winner for that attribute has `authorityLayer: planning-current-authority`.

Safe materialized attributes in this slice are:

- plan geometry;
- building/structure height derived from compatible same-page base/top levels;
- ground elevation from registered level observations;
- explicit width when the authority geometry supplies it;
- material role and Minecraft material palette.

Roof-plane geometry is deliberately not materialized by this stage. LiDAR roof surfaces are preserved until a dedicated multi-drawing/roof reconstruction stage can compare compatible roof evidence correctly.

## Vertical evidence rules

Base-level observations include FFL, SSL, AOD, ground level, GL, BOW and bottom-of-wall labels.

For buildings/structures, height is derived only when a base level and a top level such as ridge, eaves, TOW or top-of-wall occur in the same planning page lineage. Implausible differences are rejected rather than applied.

## World-generation integration

The runtime build sequence is now:

```text
normal public-source reconstruction
→ ride/fidelity enrichment
→ current-planning authority association
→ normal Evidence Graph
→ planning candidate re-ranking
→ winning-attribute materialization
→ accuracy assessment
→ 1 m raster / Bedrock compilation
```

This order is intentional: the Evidence Graph sees both the pre-existing evidence and current planning evidence before any winner changes the world.

`planning-authority-fusion.json` records association, graph-ranking and materialization summaries for QA.

## Developer input

The runtime currently accepts an upstream artifact through:

```text
--planning-authority-evidence planning-current-authority-evidence.json
```

Matching thresholds are developer diagnostics, not intended player inputs:

- `--planning-authority-min-match-score`
- `--planning-authority-ambiguity-gap`
- `--planning-authority-point-tolerance-m`
- `--planning-authority-point-ambiguity-m`

The final product contract remains bbox-only. A later orchestration step should pass the planning authority artifact automatically from the planning workflow into world generation.

## Safety boundaries

This slice does not rewrite:

- terrain interpolation;
- slope/rock generation;
- chunk roster construction;
- Bedrock world writing;
- LiDAR roof reconstruction.

Ambiguous or missing planning evidence therefore reduces planning fidelity instead of fabricating geometry or causing the bbox build to fail.
