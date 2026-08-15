# Planning revision and current-state authority

Voxel Mapper treats planning drawings as evidence with two independent clocks:

1. **Document revision state** — which PDF/drawing revision is the latest issued document.
2. **Physical current state** — which geometry is proven to exist in the real world now.

Those are deliberately not the same decision.

## Core rule

A newer proposed, approved, tender or for-construction drawing may supersede an older document revision, but it **must not** erase an older as-built/current observation until implementation evidence shows the newer design was actually built.

Example:

- Drawing TP-100 Rev A — `AS BUILT`
- Drawing TP-100 Rev B — `FOR PLANNING`

Rev B is the latest document revision. Rev A remains the physical-current geometry authority until reliable evidence proves Rev B was implemented.

## Inputs

The resolver consumes only evidence from the same bbox planning run:

- `planning-registered-evidence.json` from the precision georegistration gate;
- `planning-document-catalog.json` from content-addressed document acquisition;
- the immutable planning application lifecycle snapshot embedded in `planning-document-queue.json` at discovery time.

The lifecycle snapshot prevents a later mutable planning-API response from silently changing the interpretation of an already-captured document set.

## Revision evidence

Strongest to weakest:

1. content-addressed `previousContentHashes` chains from the same downloaded resource;
2. directly comparable title-block revision identifiers, for example `A < B < C`, `01 < 02`, or `P01 < P02`;
3. otherwise no ordering is guessed.

Revision schemes are compared only when structurally compatible. `P03` versus `C01`, for example, is deliberately treated as ambiguous rather than assuming that one stage is newer.

## Lifecycle evidence

High-confidence current-state evidence includes title-block states such as:

- `AS BUILT`
- `RECORD`
- explicit current/existing/implemented/built states

Non-current evidence includes:

- proposed / planning / preliminary / pending;
- approved / granted / consent — approval alone does not prove construction;
- tender / for-construction — delivery intent does not prove completion;
- refused / rejected / withdrawn / cancelled;
- demolished / removed;
- superseded / obsolete.

Survey documents can provide useful current observations, but they do not cross the default world-authority confidence gate without stronger evidence.

## Authority outputs

The workflow produces three artifacts:

### `planning-revision-resolution.json`

Full QA report with lineages, revision decisions, lifecycle state, conflicts and selected physical-current pages.

### `planning-current-state-evidence.json`

All spatially registered planning evidence annotated with temporal/revision decisions. Proposed, refused, superseded and ambiguous evidence is retained for diagnostics and later comparison.

### `planning-current-authority-evidence.json`

Strict allow-list containing only entries with `worldGeometryAuthority: true` after both spatial and temporal gates. This is the artifact intended for the next per-attribute fusion stage.

## Safety boundary

The resolver does not modify terrain, slope generation, chunk layout or world writing. It only decides which planning observations are eligible to become current-world evidence.

If revision or lifecycle evidence is ambiguous, authority is withheld. Missing or uncertain planning data reduces fidelity instead of fabricating certainty.
