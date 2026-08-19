# Statewide three-layer audit

The serving sweep next door answers ONE question: what does Smart Site SERVE a human.
This answers the two questions either side of it and reports all three together.

```
WRITTEN   atoms actually in the store            hauska_mcp.atoms
SCORED    the county_facet_coverage ledger cells cortex neondb + GET /api/county-ledger
SERVED    what Smart Site actually shows a human the SS-W5 serving sweep
```

All three disagree independently, and the disagreements ARE the defect list. The order of
the disagreement is the cost of the fix:

| class | remediation |
|---|---|
| `unwritten` | acquire and ingest |
| `written-unscored` | run a scorer — and if `scorer-absent`, BUILD one, because a recompute cannot move it |
| `written-unserved` | fix a merge or an adapter, or add a field if there is no served slot |
| `out-of-reach` | nothing; this is not a gap |
| `not-measured` | look; never read it as a zero |

## Running it

```
node --import tsx packages/retrieval/scripts/three-layer-audit.mjs \
  --out artifacts/three-layer-audit \
  --served-dir <serving-sweep output dir>
```

`ATOMS_DATABASE_URL` and `CORTEX_DATABASE_URL` are required. The run is READ ONLY: it
issues no INSERT, UPDATE, DELETE or DDL and takes no atoms writer slot.

The WRITTEN scan is cached to `<out>/written_by_family.json` with the instant it was taken.
`--written-from <file>` replays it so the audit can be regenerated against a longer serving
sweep without repaying the scan. A replay is a replay: the cache's `scannedAt` travels into
the artifact, so a reader always knows how old the written layer is. That is the same
discipline the ledger's `computedAt` gets, applied to our own number.

## What gates the run

`verifyCountyKey` runs FIRST and THROWS on any disagreement. The county key is
`split_part(entity_id, ':', 1)`, which is a RECONSTRUCTION, and the standing rule is that
entityId shapes are not uniform across writers. `parcel-node` carries a `countyFips` body
field with its own partial index, so the two derivations are compared directly. If they
ever disagree, every WRITTEN figure in the artifact is wrong, and the run stops rather than
footnoting it.

## What it does NOT measure

Whether a written atom is CORRECT. A county can be present on all three layers and hold
wrong data. This instrument measures existence, scoring and serving, and nothing else.
