# Planning precision georegistration

Voxel Mapper treats a planning drawing as **document-space evidence** until a spatial registration passes explicit quality gates. A visually convincing overlay is not sufficient.

## Coordinate systems

Planning extraction emits PDF user-space points. Every document page has an independent coordinate system, even when two pages have the same scale or page number. Georegistration therefore runs per `contentHash + pageNumber` and never shares a transform across pages.

Accepted registrations are transformed into Voxel Mapper's local metric coordinate system. They become **spatially eligible evidence**, not automatically authoritative current-world geometry.

## Registration models

The default model is a 2D similarity transform (translation, rotation and uniform scale). Affine fitting is available for drawings with mild, measurable paper/image distortion, but it is rejected when anisotropy or shear exceed configured limits.

The robust solver uses multiple control-point hypotheses, rejects outliers, refits on inliers and reports residuals for every control point.

## Automatic control points

Automatic seed control points are generated conservatively by matching closed planning vectors to compatible mapped polygon features in the bbox-scoped OSM reference. Shape hypotheses are independent of translation/rotation/scale and handle ambiguous near-diameter pairs such as the two equal diagonals of a rectangle.

Automatic matches are only seeds. They do not grant authority by themselves; the complete registration must still pass the same residual and scale gates.

## Default quality gates

- inlier threshold: 1.5 m
- maximum registration RMSE: 1.25 m
- maximum inlier residual: 3.5 m
- minimum inliers: 3
- maximum title-block scale relative error: 22%
- maximum affine anisotropy: 8%
- maximum affine shear: 8%
- reflections and degenerate transforms: rejected

Drawing title-block scale is used as a real consistency check when available, not merely recorded as metadata.

## Authority boundary

A passed spatial registration sets:

- `coordinateSpace: local-world-metres`
- `spatialAuthorityEligible: true`
- `worldGeometryReady: true`
- `worldGeometryAuthority: false`
- `temporalResolutionRequired: true`

This is deliberate. For example, an accurately aligned approved/proposed plan still cannot replace the current park until temporal/current-state resolution and per-attribute evidence fusion determine that it represents the built/current state.

## GitHub Actions handoff

The planning-document workflow now continues from vector extraction into a `georegister` job:

1. download merged planning vector evidence;
2. acquire/cache a current bbox-scoped OSM spatial reference;
3. normalize the reference into Voxel Mapper local metres;
4. solve each planning page independently;
5. write `planning-georegistration.json` with QA metrics and rejected pages;
6. write `planning-registered-evidence.json` containing only evidence from pages that pass the spatial gate.

If the live OSM reference cannot be acquired, the workflow degrades to an explicit `unregistered` result instead of failing the entire bbox evidence build. The extracted planning evidence remains available for a later retry.
