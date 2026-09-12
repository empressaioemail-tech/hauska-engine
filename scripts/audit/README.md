# scripts/audit/

Read-only reproduction scripts for write-provenance audits. Nothing here takes `--apply`,
issues a write, or triggers a deploy; every script is safe to re-run at any time and is meant
to be re-run, not archived.

## p171-footprint-write-provenance.sh

Built for P-171 (naming the writer behind the 2026-09-07 building-footprint atom write for
Bastrop/Travis when `atoms_writer_lease_v2` had already been released and deleted by the time
anyone asked). Extended by P-173 with two more sections once a real history table existed to
query.

### atoms_writer_lease_history (P-173)

`atoms_writer_lease_v2` and `atoms_bulk_writer_lease` are live mutexes: exactly one row per
in-progress lease, deleted the moment it releases. They answer "who holds this right now,"
never "who held this an hour ago." `atoms_writer_lease_history` is the append-only companion —
written by the same `takeScopedLease` / `releaseScopedLease` functions
(`packages/storage/src/atoms-writer-lease.ts`), one row per take, closed exactly once by
whichever comes first: an explicit release, or a later take stealing an expired scope.

Two query shapes, both in the script (section 7 and 8):

- **By run_id** — `RUN_ID=<id> bash scripts/audit/p171-footprint-write-provenance.sh`. Direct
  lookup: which scope, which holder, when taken, when released, and why (`release_reason`:
  `normal`, `expired`, or `killed`).
- **By scope and window** — `SCOPE_TYPE=write SCOPE_ID=<entity_type>:<county_fips>
  WINDOW_START=<date> WINDOW_END=<date> bash scripts/audit/p171-footprint-write-provenance.sh`.
  Answers "who held this scope in this window" without needing a run_id up front — the P-171
  audit's own original question, now answerable directly instead of by cross-referencing three
  other systems.

**A write before this table's creation has no history row, by construction.** Migration
`015_atoms_writer_lease_history.sql`'s own `applied_at` (readable via `SELECT filename,
applied_at FROM schema_migrations WHERE filename = '015_atoms_writer_lease_history.sql'`, which
section 7 falls back to printing when `RUN_ID` is unset) is the line: any take before that
timestamp — including every run-id P-171 investigated (`bfoot-apply-*`, 2026-09-07) — predates
the table entirely and will never produce a row here, no matter how the query is shaped. This is
not a bug in the table or the query; it is the honest boundary of what an append-only log
started on a given date can know about the past. The fix for THAT gap was the P-171 audit's own
break-glass row, drafted for the operator/integration seat to file
(`_inbox/2026-09-12_p171-provenance_close.json#breakGlassRowDraft`); this table's job is making
sure the next unattributed write never needs one.

### Append-only enforcement

The table refuses `DELETE` and refuses any `UPDATE` except the one narrow shape a release makes
(setting `released_at`/`released_by`/`release_reason` together, exactly once, on a row that has
not been released yet) — enforced by a Postgres trigger
(`atoms_writer_lease_history_guard`, in migration `015_atoms_writer_lease_history.sql`), not by
a distinct database role, because this repo's migrations and its application writes share one
Postgres role via one `DATABASE_URL`. Proven by violation:
`packages/storage/src/__tests__/atoms-writer-lease-history.integration.test.ts` (gated on
`LEASE_HISTORY_IT_DATABASE_URL`, a local disposable Postgres — never a Neon host, see the file's
own guard) attempts both a `DELETE` and a second `UPDATE` on an already-released row and asserts
both are refused. The P-173 close also carries a live run of the same two attempts against the
STAGING atoms store, pasted verbatim, since this package's `vitest run` has no Postgres wired
into this repo's CI today.
