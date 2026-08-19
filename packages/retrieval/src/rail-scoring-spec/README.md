# Measurement specs for the six unscored rails

Lane SS-W14, OPS-16 amendment A-020, PLAN-ROW P-47. Written 2026-08-19.

## What this is

hauska-engine ships twelve county writers. legacy-design-tools ships three
scorer CLIs. Nobody ever wrote down what scoring a rail means, so six of the
fourteen rails carry **zero rows** in `county_facet_coverage` and are
permanently `not-yet` on the console no matter what the store holds.

Verified 2026-08-19 against cortex `county_facet_coverage`, grouped by facet:

```
cad|254|254        envelope|19|19     flood|177|177
geometry|254|254   land-use|19|19     landuse|254|254
mud|254|254        owner|254|254      zoning|254|254
(9 rows)
```

Nine facet values. `roads`, `footprint`, `easement`, `rrc-wells`,
`rrc-pipelines` and `rail-corridor` are none of them. That is 1,524 of 3,556
cells, 42.9% of the manifest grid, with 35,159,990 atom rows behind it. A
ledger recompute moves none of them, because there is no row to recompute.

**This directory does not score anything.** It is the contract a scorer plugs
into. Lane SS-W12 is building the scorer capability; this is what it should be
told to compute.

## The three states

Every rail distinguishes three things, and conflating the last two is the
defect the honest-absence work exists to prevent.

| state | meaning | remediation |
|---|---|---|
| covered | a positive determination that the thing IS there | none |
| established-absence | a positive determination that the thing is NOT there | none |
| not-yet | no determination was made | run the writer |

An empty result is never an absence. Every absence carries a basis or it is
not an absence.

## The two ceilings

`mud` scored 209/186, over 100%, because absences were counted inside the
acquisition fraction. They are different sets.

**Acquisition ceiling.** Counties where the source HAS features. Bounds
`satisfied-present` only.

**Determination ceiling.** Counties where a determination can be made at all,
including a negative one. Bounds `satisfied-present` plus `satisfied-absent`,
and is what a coverage denominator may use.

`easement` is the clearest case: two counties have an easement data source and
all 254 can be honestly determined to have none published. Bounding easement
absences by its acquisition reach would delete 252 honest cells.

**A ceiling is a SET of county FIPS, never a count.** SS-W9 had to call two
`rail-corridor` cells out-of-reach when at most one could be, purely because
the live capability probe returns a number and no instrument could say which
counties it meant.

## The denominator, and how it was established

For every parcel-keyed depth rail the county figure is

```
(determinations that JOIN a parcel-node) / (parcel-node atoms in the county)
```

with the `geometryLoaded=false` subcount published beside it as a measured
exclusion class and never subtracted from it.

It travels with a second measured figure, the **writer-reach** denominator:
`count(DISTINCT normalizeForJoin(prop_id))` over `txgio_parcel` rows for the
county whose `prop_id` is non-null, non-blank, not all-zero and matches
`^[A-Za-z0-9._-]+$` after leading-zero strip. That is `isUsablePropId` plus
`normalizeForJoin` from `packages/atoms/src/fact-writer-ids.ts` expressed in
SQL, and it is the set the depth writers actually iterate.

Five counties were measured and the writer-reach denominator matched the
determination count **exactly** in every one:

| county | usable prop_ids | parcel-node atoms | rrc-pipeline-fact |
|---|---|---|---|
| 48201 Harris | 1,523,640 | 1,523,640 | 1,523,640 |
| 48001 Anderson | 31,676 | 31,676 | 31,676 |
| 48497 Wise | 48,428 | 48,428 | 48,428 |
| 48021 Bastrop | 62,256 | 62,398 | 62,256 |
| 48103 Crane | 5,567 | 5,805 | 5,567 |

Where the two disagree, the gap is entirely `geometryLoaded=false` parcel-node
atoms carrying synthetic `_feature-stratmap25-...` keys, minted for txgio
features with no usable prop_id. Crane holds 252 of them and Bastrop 552.
Scoring against geometry-true nodes only reproduces the `mud` defect at parcel
scale: Crane has 5,567 determinations against 5,553 geometry-true nodes, which
is 100.25%.

`county_manifest.parcel_count_est` was **rejected** as a denominator. It
diverges from the parcel-node count by more than 20% in 19 of 253 counties and
by 184% on Harris, while the statewide sums agree to within 2.7%, which is
exactly how a bad per-county denominator hides.

## The six rails

### roads, NOT SCORABLE as a percentage today

Unit is the **OSM way**, not the parcel. `road-node` entity ids are
`<fips>:road:<osmWayId>` and `PARCEL_KEYED_PROPERTY_ENTITY_TYPES` explicitly
excludes `road-node`. The only per-parcel road relation in the store is
`property-boundary-edge`, which is not a rail and exists in exactly one county:
26,846 edges over 3,732 parcels, all Bastrop.

The denominator, ways the pinned Geofabrik PBF yields inside the county
boundary after the taxonomy filter, is **persisted nowhere**. It lives only in
a writer run's optional `--out` summary. Cortex holds no road table of any
kind. There is also no absence shape, so a county with no queryable roads is
indistinguishable from a county never attempted.

Roads can be scored today as a **binary presence** rail and must never be
published as a percentage. To score it properly, persist a per-county
extraction census carrying at least `(county_fips, pbf_md5, ways_extracted,
extracted_at)`, and add a county-coverage absence atom.

The family is also heterogeneous. Bastrop's 36,802 road-nodes come from five
adapters, not one, and 9,530 of them carry a NULL `isPedestrianWay` because
they predate the field. Any roads score must name which adapter set it counted.

Ceiling: 254. `tx_county_boundary` holds 254 rows. The live ledger publishes
null with basis "no capability probe defined for this rail", which is honest
about having no probe and must not be read as a zero.

### footprint, scorable

Unit is the parcel. Covered is a `building-footprint` atom with no `absence`
key in the body. Established-absence is `absence.kind = 'no-footprint-feature'`
with a reason naming the join threshold.

**Present and absent collide on the same entity id suffix.** Verified in Wise
48497: `:footprint:primary` splits 24,629 rows carrying an absence body against
23,799 without. An index-only prefix scan would count all 48,428 as covered.
The scorer must touch the heap.

A second hazard: `no-footprint-feature` is the kind for BOTH "the join ran and
found nothing" and "the parcel had no usable ring to join with". Only the
free-text reason distinguishes them. All 24,629 Wise absences are the real
determination, but the kind should be split.

Ceiling: 254, and the hardcode is right for the wrong reason. `tx_building_footprint`
holds 10,674,975 footprints over 254 distinct `county_fips`, **including the
metros**: Harris 895,154, Dallas 656,706, Travis 73,394, Bastrop 65,974. Those
counties hold zero footprint atoms, so the gap is the O(fp x parcels) join, not
staging and not reach. Replace the hardcode with the same `DISTINCT county_fips`
probe the `mud` rail already uses.

### easement, NOT SCORABLE today because there is nothing to score

Unit is **hybrid**. For 252 of 254 counties the rail resolves at COUNTY
granularity: one county-coverage absence atom carrying the sources probed. The
planner says so explicitly: "Unincorporated parcels rely on this at serve time,
not millions of per-parcel sentinels." Only two present-data routes exist in the
entire table, McLennan 48309 at county scope and Bastrop 48021 at city-limits
scope, and in those the unit is the parcel.

Reporting one blended percentage for this rail is a category error. Two
denominators, never merged.

The family holds **zero atoms**, verified in 0.49 seconds, and
`write-utility-easement-county.mjs` has never been run. Easement is the one
rail of the six whose 254 `not-yet` cells are entirely honest. Unlike roads the
spec is complete and a scorer is buildable now; it will simply return 254
`not-yet` cells until the writer runs. Running the honest-absence path across
254 counties writes 254 atoms and makes the whole rail `satisfied-absent` at
county granularity, which is a real and very cheap coverage gain. That is a
writer decision, not a scorer one.

Three declarations disagree about this rail. The LDT binding says no writer
exists; the live `county_rail` row says `has_writer = true` with a `notes` field
reading "No writer yet."; hauska-engine ships the writer.

### rrc-wells, scorable, and its published ceiling is wrong

Unit is the parcel. This is the **only** one of the six whose covered-versus-absent
split is readable from the entity id: absences end `:none`.

One atom is one (parcel, well) association. A single well within the 152 m
proximity radius of eight parcels produces eight atoms. Atom rows are neither
wells nor parcels, and quoting the row count as a well count is the easiest
error this rail offers.

**The published ceiling of 1 is a hardcode citing a retired adapter.**
`STATIC_RAIL_CAPABILITIES` in `railCoverageCapability.ts` sets
`maxCountiesReachable: 1` citing `lib/adapters/src/federal/texas-rrc.ts`, the
Harris ArcGIS mirror. The live writer **refuses to run** against that host:
`write-well-fact-county.mjs` aborts with "REFUSING TO RUN: well-fact source
still points at Harris mirror (gis.hctx.net)". The real source is staged
`tx_rrc_well`, whose own module header reads "NEVER use the Harris County
ArcGIS mirror for apply, it holds ~0.92% of TX".

Verified 2026-08-19: `tx_rrc_well` holds **1,396,049 wells over 254 distinct
county_fips**, plus 1,556 rows with a NULL county_fips still reachable by
lng/lat bbox. Harris 48201 holds 12,850 of them, which is 0.92%, matching the
code comment and matching the standing memory's "12,796 features, extent is one
county" to within 0.4%. The memory measured the mirror. The mirror is not the
source.

**Re-derived ceiling: 254, not 1.** Applying the published ceiling would
manufacture 173 false out-of-reach cells against counties that are already
written.

Crane 48103 measured live: 60,396 rows, 1,839 of them `:none`, across 5,567
parcels. That is 100.00% of the writer-reach denominator and 95.90% of the
5,805-atom parcel-node roster, and the 238-parcel gap is entirely
`geometryLoaded=false` nodes. Harris holds zero well atoms against 12,850
staged wells.

### rrc-pipelines, scorable, and its absence is not an absence

Unit is the parcel, one atom per parcel, entity id is the bare `parcelNodeId`.

**This rail has no absence atom in its normal path.** A parcel with no pipeline
inside the buffer gets a PRESENT atom with `nearPipeline = false`, by explicit
design. Both flag values are determinations and both count as covered. A scorer
keying on the body's `absence` field will find none and conclude the rail is
unscored.

The one typed absence it does emit, `absence.kind = 'no-pipeline-coverage'`,
fires **only when the source read failed**. Its name says the county has no
pipeline coverage; its meaning is that `tx_rrc_pipeline` could not be read. A
scorer that counts it as an established absence converts an outage into a
finding about the world, for every parcel in the county at once. Measured across
eight counties: zero typed absences of any kind, so it has not fired in the
sample. The kind should be renamed to say what it means.

Bastrop measured 62,256 atoms over 62,256 parcels with zero orphans, exactly
the usable-prop_id count. Harris measured 1,523,640 over 1,523,640, which is
100.00% on both denominators.

Ceiling: acquisition 254 (`tx_rrc_pipeline` holds 491,178 segments over 254
distinct `county_fips`, zero NULLs), determination 253 (bounded by the parcel
roster).

### rail-corridor, scorable

Structurally identical to `rrc-pipelines`: outside the buffer is a present atom
with `nearRailCorridor = false`, and an empty corridor index after a successful
fetch is the same, not mass absence. `no-rail-coverage` and `no-parcel-geometry`
are both input failures wearing absence names.

This is the one rail of the six whose ledger ceiling IS a live probe, and it
probes the parcel side, so 253 is the right number for the determination
ceiling. It is the wrong SHAPE. The rail is written in 252 counties against a
ceiling of 253, and because the probe returns a count rather than a set, two
cells were classified out-of-reach when at most one can be.

Cortex holds no `tx_narn_rail` table, so unlike wells and pipelines this rail's
acquisition ceiling cannot be probed from the database and must be declared
from the NTAD source's own extent.

## Rails that cannot be scored today

| rail | why |
|---|---|
| roads | denominator persisted nowhere; no absence shape; multi-adapter family |
| easement | family holds zero atoms; writer has never run in any county |

Both are findings, not blockers worked around. The other four can be scored the
moment a scorer exists.

## How to use this

```ts
import {
  RAIL_SCORING_SPEC_BY_KEY,
  determinationCeilingSet,
  scoreCell,
  isPublishable,
} from "@hauska-engine/retrieval/rail-scoring-spec";
```

`scoreCell` is pure. It opens no database and issues no query: measuring is the
scorer's job, and the arithmetic plus the guards are the contract. Every guard
returns a violation string rather than throwing, so a run over 254 counties
reports every bad cell instead of dying on the first, and a caller that ignores
`guardViolations` has made a visible choice.

The guards, each traced to something that already cost somebody: `over-100`,
`orphan-determination`, `absence-without-basis`, `negative-input`,
`unscorable-rail`, plus the two ceiling-membership checks. All seven were
proven able to fire, and three were additionally mutation-tested on the real
exit code: breaking the over-100 threshold, the unmeasured-is-not-zero branch
and the unscorable-rail branch each turned the suite red, and reverting each
turned it green again at exit 0.
