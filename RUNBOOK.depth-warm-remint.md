# RUNBOOK — depth-warm per-parcel RE-MINT (`hauska-engine-depth-warm-remint`)

P-186 / OPS-23 wave 6, plan row P-154. The instrument is
`cloudbuild.depth-warm-remint.yaml`; the code is
`packages/engine-core/scripts/depth-warm-city-batch.mjs` (the `--parcel` arm) plus
the preview renderer `packages/engine-core/src/depth-warm/remint-preview.ts`.

This runbook is for the BOUNDED per-parcel form ONLY. It is **not** the
county/city-cohort form — that is `doc_repo/90_runbooks/factory_2_jurisdiction_depth.md`,
whose verbatim GATED command carries `--city-cohort --force-overwrite` and
re-warms a whole cohort (Elgin precedent: 3,762 parcels) while rewriting stored
envelope geometry across it. The cohort form was REJECTED for this work, and
`--force-overwrite` must never appear in a command from this runbook.

**This runbook has never been executed.** No deploy, no execution, no atom
write was performed when the wrapper was authored. The first execution is a
separate operator gate.

---

## What a run of this job actually mutates

One parcel's `setback-rule` atom (and its `buildable-envelope` atom) in the
**atoms store**, by IN PLACE UPSERT:

```
INSERT INTO atoms (...) VALUES (...)
ON CONFLICT (atom_did) DO UPDATE SET body = EXCLUDED.body, fetched_at = ..., updated_at = ...
```

(`pg-storage.ts` — `writePropertyAtom`). There is **no version row and no history
table for property atoms**, so the pre-image is the only rollback artifact that
can exist, and it only exists if you capture it before the write. That is step 1.

Secondary mutation, and it matters for what a half-finished run looks like:
`promoteDepthWarmToStorage` persists **boundary-edge atoms BEFORE** the property
atoms. So the write order inside one apply execution is:

1. boundary-edge atoms (persisted, verified with retry)
2. `setback-rule` / `buildable-envelope` property atoms
3. read-back verify (`verifyPass`)

A kill between (1) and (2) leaves a HALF-PROMOTED parcel: new boundary edges,
old setback-rule. `--max-retries=0` means nothing retries it. See Dangers.

---

## Step 1 — Rollback capture (READ-ONLY, mandatory, before anything else)

Nothing is written in this step. This is the only rollback artifact in existence.

Connect read-only to the **atoms store** and capture the live row verbatim:

```sql
SELECT atom_did, entity_id, content_hash, fetched_at, updated_at, body
  FROM atoms
 WHERE entity_type = 'setback-rule'
   AND (entity_id = '<nodeId>' OR entity_id LIKE '<nodeId>:%')
   AND COALESCE(body->>'status','active') = 'active';
```

```sql
SELECT atom_did, entity_id, content_hash, fetched_at, updated_at, body
  FROM atoms
 WHERE entity_type = 'buildable-envelope'
   AND (entity_id = '<nodeId>' OR entity_id LIKE '<nodeId>:%')
   AND COALESCE(body->>'status','active') = 'active';
```

For `48021:34049` the nodeId is `48021:34049` and the `LIKE '<nodeId>:%'` arm
covers the suffixed variants (`<nodeId>:buildable-envelope` and friends).

Then:

- Save BOTH result sets to a dated file outside the repo. This file IS the
  rollback. Treat its loss as the loss of the rollback.
- **Record the `content_hash` of each captured row.** After the apply leg, the
  same query must show a DIFFERENT `content_hash` when something was rewritten,
  or the SAME one when the re-mint was a no-op (see step 3/5). This is the
  before/after discriminator, and it is a stored hash — do NOT compare it
  against a number printed by the dry leg (see step 3).
- Note the count. `0 rows` means there is no atom to re-mint and therefore
  nothing to roll back: the apply leg would INSERT a brand new atom, which is a
  different act from a re-mint and needs its own decision.

---

## Step 2 — In-flight preflight (the ONLY mutual exclusion there is)

`writePropertyAtom` takes **NO lease**. Unlike `writePropertyAtomsBatch` (which
throws `LeaseRequiredError` without a `HeldLease`), the singular write path this
job uses gets no exclusion from the storage layer. The last writer wins silently.

Before the apply execution, establish that nothing else is writing these atoms:

```bash
gcloud run jobs executions list \
  --job=hauska-engine-depth-warm-remint \
  --project=hauska-prod-497015 --region=us-east4 --limit=5

gcloud run jobs executions list \
  --job=hauska-engine-atoms-writer \
  --project=hauska-prod-497015 --region=us-east4 --limit=5

gcloud run jobs executions list \
  --job=hauska-engine-footprint-retag \
  --project=hauska-prod-497015 --region=us-east4 --limit=5
```

- Any RUNNING execution of any of these = **STOP**, wait, re-check.
- Confirm no depth-warm cohort run (`hauska-engine-depth-warm*`) is in flight
  with `--city-cohort --force-overwrite` over this parcel's jurisdiction.
- The atoms store has **no confirmed scheduled writer** (the two known cron jobs,
  `factory-conformant-reap` `*/10 * * * *` and
  `factory-publish-gate-sched-hourly` `0 * * * *`, run on the FACTORY store), so
  the risk is a concurrent *human/agent* execution, not a cron. That is worse,
  not better: an unlisted seat run is invisible to this preflight. If you cannot
  establish that no other lane is re-minting the same parcel, write that down and
  do not run.

What this write would collide with, stated plainly: any other writer of
`setback-rule` atoms for the same `entity_id` — the cohort arm of this same
runner (different cohort, overlapping parcels), a future per-parcel run of a
different lane, and any in-place fix-up script addressing the same rows. All of
them lose-or-win silently; nothing raises.

---

## Step 3 — Dry leg (writes nothing; do this first, every time)

Runs the exact emit path and prints/produces the bodies `--promote` would
upsert, without writing.

```bash
gcloud run jobs execute hauska-engine-depth-warm-remint \
  --project=hauska-prod-497015 --region=us-east4 --wait \
  --args=--row-id=Bastrop,--parcel=48021:34049,--dry-run,--remint-preview
```

The job's baked default `--args` is this dry leg (`--dry-run --remint-preview`
with a default row/parcel), so a bare execute is also the dry leg — the apply
leg can only be reached by an explicit `--args` override in step 4.

Read the `depth-warm.remint-preview.doc` output. Per emitted atom you get the
entity identity, `contentHash`, and the whole body. For the `setback-rule` atom
the payload is summarised by three booleans that mean different things:

| Observation | Meaning | What to do |
| --- | --- | --- |
| `conflictPresent: true` | The A-148 (`shape: "stale-numeric-columns"`) or R-1 (`shape: "second-source"`) detector fired. `secondSource.conflict` is in the body, and the conflict sentence the surfaces print survives the re-mint. | Proceed to step 4. |
| `conflictPresent: false`, `secondSourcePresent: true` | **SUCCESSFUL NO-OP FOR THE PURPOSE OF THE RE-MINT.** The A-148 detector did not fire for this parcel on this day. The apply leg will exit 0 and increase its `promoted` count, and nothing about the disclosure changes. This is not a failure and it is not a success — it means the thing you were re-minting for is not detectable right now (upstream layer refresh? text/numeric agreement?). | Do NOT run step 4 for the disclosure reason. Investigate why the predicate does not fire, or decide explicitly that the prose-only body is the intended end state. |
| `secondSourcePresent: false` | The emitted body carries NO `secondSource` at all. Because the write is `DO UPDATE SET body = EXCLUDED.body`, step 4 would **DELETE** whatever `secondSource` the live row carries today — i.e. it would delete the pre-A-148 prose confession the surfaces currently print. This is a REGRESSION, not a no-op. | **STOP.** Do not run step 4. |
| `previews: []` with a reason string | Nothing would be written, and the string says why (empty `--parcel` cohort / warm-gate decline / verify did not pass). | Read the reason; fix the input or stop. |

Two honest caveats about the dry leg:

1. **Its `contentHash` is not the hash the apply leg will store.** Both
   `emitSetbackRule` and `emitBuildableEnvelope` stamp `extractedAt`/`fetchedAt`
   at emit time, and the hash is derived from them. Compare the STORED
   `content_hash` before/after (step 1 vs step 5). Never compare a preview hash
   to a stored hash — they are guaranteed to differ even when the body is
   identical in substance.
2. **It is the same mechanism, one execution earlier.** The dry leg reads the
   same live layer-23 record through the same adapter, so the detector's verdict
   is as fresh as the dry run's wall clock. A layer refresh between step 3 and
   step 4 changes the verdict; steps 3 and 4 should be run back to back.

The dry leg cannot be combined with `--promote`: the runner refuses that
combination (`FATAL: --remint-preview is a dry-leg flag and must not be combined
with --promote`) and refuses to preview a cohort (`FATAL: --remint-preview
requires --parcel=<nodeId>`).

---

## Step 4 — Apply leg (GATED: this writes)

Only after step 1 (capture), step 2 (preflight) and step 3 (`conflictPresent:
true`).

```bash
gcloud run jobs execute hauska-engine-depth-warm-remint \
  --project=hauska-prod-497015 --region=us-east4 --wait \
  --args=--row-id=Bastrop,--parcel=48021:34049,--promote
```

`--promote` is an explicit override of the baked dry-leg args, which is the
point: the write is never the default action. `PROPERTY_ATOM_PATH=1` is set on
the job itself (`cloudbuild.depth-warm-remint.yaml`), so no execution has to
supply it — and, importantly, an execution cannot forget it. Without it,
`writePropertyAtomIfEnabled` returns `null` and the run exits 0 having written
nothing while reporting a `promoted` count (see step 6, test direction (a)).

The run is `--tasks=1 --parallelism=1 --max-retries=0 --task-timeout=3600`.
`max-retries=0` is deliberate: a retry after a partial write re-runs an
already-partial promotion. `task-timeout=3600` is a hang bound, not a budget; a
single parcel's emit path also pages the jurisdiction's whole layer-23 feature
index, which is the dominant cost and is the same acquisition a cohort run does
up front.

---

## Step 5 — Post-check (READ-ONLY)

Re-run the step 1 queries and compare `content_hash` per row:

- `content_hash` changed AND the body carries `secondSource.conflict` → the
  re-mint landed as intended.
- `content_hash` changed but `conflict` is absent → you wrote a payload with no
  conflict. Whatever the previous body confided is now whatever the new body
  confides; check that `secondSource` is still present, because an absent
  `secondSource` means you deleted the prose confession.
- `content_hash` UNCHANGED → the write did not happen (upsert matched a
  different key? run failed silently?). Investigate before assuming success.
- Row absent that was present → unexpected; use the step 1 artifact.

Then check the surfaces that print the sentence (`setbackConflictNote` via
`@empressaio/atom-contract`) for the parcel, to confirm the operator-visible text
is what the preview said it would be.

---

## Rollback

There is no rollback target and no history to restore from. The only reversal is
to write the step 1 captured `body` back:

```sql
UPDATE atoms
   SET body = '<the exact body JSON captured in step 1>'::jsonb,
       content_hash = '<the captured content_hash>',
       updated_at = NOW()
 WHERE atom_did = '<the captured atom_did>';
```

Honest limitations of that reversal, all of which are reasons step 1 is not
optional:

- It restores ONE row from ONE capture. If step 1 was skipped, the pre-image is
  gone and there is no reversal at all.
- It is itself an unversioned in-place write with no lease, no gate and no dry
  leg — there is no Cloud Run Job that restores a property atom. Running it is
  a break-glass act that P-169's laptop freeze does not cover, because nothing
  in code stops a laptop from writing this table when `PROPERTY_ATOM_PATH=1` is
  set. Prefer `gcloud run jobs execute hauska-engine-atoms-writer ...` if that
  job's writer covers the row; otherwise flag the manual UPDATE as break-glass in
  the same channel where you announced the re-mint.
- It does not undo the boundary-edge atoms written in phase 1 of the apply leg.
  Capture those rows too if the parcel's edges may have moved.
- The restored `content_hash` will match the captured one, so a later reader
  cannot tell the rollback happened. Say so where you record the run.

---

## Dangers (read before the first execution)

1. **Partial promotion.** Boundary-edge atoms are persisted before the
   property atoms. A timeout, OOM, or cancellation between them leaves new edges
   with the old setback-rule, and `max-retries=0` will not repair it. The
   post-check queries in step 1/5 cover `setback-rule` and
   `buildable-envelope`; also capture the boundary-edge rows if the parcel's
   geometry was in question.
2. **Silent success with zero effect.** Two independent ways: `PROPERTY_ATOM_PATH`
   unset (run exits 0, writes nothing) and the A-148 detector not firing (run
   exits 0, writes a body whose disclosure is unchanged). Only the step 3 dry leg
   and the step 5 `content_hash` diff distinguish these from a real re-mint. The
   job sets `PROPERTY_ATOM_PATH=1` so the first cannot occur through the job; it
   still occurs for any hand-run.
3. **Deleting the prose confession.** Because the write replaces `body`
   wholesale, an emit with no `secondSource` deletes the pre-A-148 prose that the
   surfaces print. `@empressaio/setback-corpus@1.2.0` contains ZERO occurrences of
   `second_source`, so a corpus/snapshot-derived emit cannot carry it. Only the
   LIVE-record path (what this job runs) can.
4. **No mutual exclusion.** See step 2. Nothing in the storage layer refuses a
   concurrent writer; the preflight is a human check and can be wrong.
5. **`--force-overwrite` is not in this runbook and must not be added.** That
   flag belongs to the cohort arm and rewrites stored envelope geometry.
6. **This job's step 4 is the only write.** If you find yourself reaching for
   `gcloud run jobs update` on the live template, or editing the YAML to change a
   run's row/parcel, stop: execution-time values are `--args` overrides.

---

## Submitting the build (deploy is a SEPARATE operator gate)

```bash
# from the repo root, on the branch that carries this file
gcloud builds submit --project=hauska-prod-497015 \
  --config=cloudbuild.depth-warm-remint.yaml \
  --substitutions=_REGION=us-east4,_ROW_ID=Bastrop,_PARCEL=48021:34049
```

The build deploys `hauska-engine-depth-warm-remint` with the DRY LEG as its
baked args. Deploying the job is not part of authoring the wrapper; the planner
requests that gate separately.
