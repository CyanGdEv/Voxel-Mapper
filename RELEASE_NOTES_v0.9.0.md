# ThemePark Map 0.9.0 — orthophoto path evidence

Version 0.9.0 adds a universal, evidence-gated path reconstruction layer for georeferenced RGB orthophotos. It improves parks only where a suitable image is actually supplied; it does not manufacture Alton Towers detail from unrelated imagery.

## Implemented

- Repeated local RGB GeoTIFF inputs with resolution-ranked mosaic sampling.
- Embedded WGS84, Web Mercator, British National Grid, and WGS84 UTM support, plus caller-supplied CRS/Proj4 definitions.
- Mapped-route-seeded, bidirectional CIELAB path-edge detection.
- Variable-width corridor rasterization at one block per metre.
- Vegetation, coverage-gap, implausible-width, weak-edge, resolution, and confidence rejection.
- Shadow-rejected sRGB colour observation.
- Independently confidence-gated material and visible surface-uniformity classification.
- Explicit evidence hierarchy: surveyed/mapped width, licensed orthophoto edge, tagged estimate, lane derivation, then disclosed class prior.
- QA-only `assist` mode; only provenance-complete `evidence` mode can alter Minecraft blocks.
- Source provider, URL, licence, capture date, GSD, CRS, file SHA-256, confidence, cross-sections, and rejection reasons in output evidence.
- QA-only land-cover candidates that never overwrite mapped land or water.
- A reproducible Environment Agency aerial-catalogue intersection checker for English parks.

## Demonstrated result

The included synthetic 0.5 m/pixel proof fixture contains a six-metre dark neutral path whose map tags deliberately omit width and surface appearance. The compiler recovered:

- width: 6.0 m;
- accepted cross-sections: 78/78;
- path confidence: 0.943;
- colour: `#3a3c3e`, colour confidence 0.96;
- material: asphalt, candidate confidence 0.84;
- visible pattern class: solid, confidence 0.91.

The demonstration is synthetic regression evidence, not a claim about a real park.

## Alton Towers result

The official Environment Agency Vertical Aerial Photography catalogue snapshot was checked against the bounded Alton Towers area. The reproducible check scanned 96 GeoJSON indexes and 73,198 tile features and found no intersecting tile. The v0.9 Alton world therefore retains the v0.8 physical geometry and adds truthful imagery capability/absence evidence; it reports zero orthophoto-derived path segments.

A licensed Alton orthophoto may now be supplied without further core compiler changes. Until then, the remaining Alton path-width, colour, pattern, and topology gaps must remain explicit.

## Verification

- 20 automated tests pass.
- The synthetic orthophoto proof world passed compiler round-trip validation.
- The Alton world passed compiler validation and an independent pure-JavaScript LevelDB scan: 9,504/9,504 chunks decoded, 69,207 subchunks scanned, 101 native sign entities decoded, 84 public building labels matched, and tunnel/support palette invariants passed.

## Current limits

- The image extractor refines routes already present in the topology source; it does not yet discover arbitrary unmapped paths.
- Canopy, deep shadow, temporary objects, stale captures, compression, or weak contrast may hide path edges.
- Spectral appearance alone cannot prove engineering material composition or a fine paving layout. Unknowns stay unknown.
- Remote STAC/OGC catalogue discovery and tiled source acquisition are not yet part of the universal core.
- Complete ride banking, exact support schedules, and hidden track geometry still require survey, manufacturer, or park-authorized data.
