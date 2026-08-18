# Ride and plaza production acceptance

A generated `.mcworld` is not a successful production build merely because Bedrock serialization and chunk validation succeed.

The production acceptance workflow now has a separate ride/access reconstruction gate. It fails when a park contains named rides but the output remains 2D-only, when authoritative ride structures are not reconstructed/rendered, or when planning-derived path/road surface materials win authority but do not become rendered world surface cells.

## Ride requirements

For parks with named ride evidence:

- at least one `ride_track` feature must carry a real 3D profile;
- no named ride may remain `2d-only`;
- each named ride must have at least 90% vertical-profile coverage;
- aggregate ride vertical coverage must be at least 90%;
- authoritative 3D ride structures must be reconstructed and rendered.

The gate reads the normal `evidence.json` ride-profile and ride-structure artifacts. It does not use park-specific coordinates or hardcoded ride names.

## Planning access and plaza requirements

When planning applications are present:

- final planning authority must apply path/road geometry changes;
- if path/road material attributes win planning authority, planning surface rendering must produce non-zero rendered features and world cell writes;
- parks containing named rides must have planning ride geometry reach final authority.

This prevents a run from reporting planning success when path/plaza material evidence is resolved but never materialized into the world.

## Safety

The gate does not weaken planning currentness, certified-target, ambiguity, terrain-geometry, or terrain-elevation protections. It only changes whether the finished generation is accepted as production quality.
