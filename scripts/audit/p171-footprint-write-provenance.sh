#!/usr/bin/env bash
# P-171 -- building-footprint atom write provenance audit.
#
# Read-only reproduction of every query this audit ran to determine who/what wrote
# the 2026-09-07 building-footprint atoms for 48021 (Bastrop) and 48453 (Travis).
# No --apply, no writes, no deploys anywhere in this script. Safe to re-run any time.
#
# Findings are recorded in
# _inbox/2026-09-12_p171-provenance_close.json (doc_repo); this script only
# reproduces the reads that back them.
#
# P-173 (2026-09-12): sections 7 and 8 added. The P-171 lane's own worktree
# (hauska-engine-p171-provenance, branch audit/p171-footprint-write-provenance)
# never committed this file -- its close says so explicitly ("Not committed").
# This copy was brought into the P-173 worktree fresh from origin/main because
# there was nothing to `git merge` from; when the P-171 branch/PR lands, the
# two copies should be reconciled to one canonical file rather than left as
# two near-duplicates (reported here per "do not fix a naming mismatch by
# renaming" -- this is the same caution applied to a duplication instead).
set -euo pipefail

ATOMS_URL="$(gcloud secrets versions access latest --secret=ATOMS_DATABASE_URL --project=hauska-prod-497015 2>/dev/null)"
FACTORY_URL="$(gcloud secrets versions access latest --secret=FACTORY_DATABASE_URL --project=hauska-prod-497015 2>/dev/null)"

echo "### 1. Atoms store: createdAt distribution, both counties (id-range join, never LIKE)"
psql "$ATOMS_URL" -c "
  SELECT date_trunc('hour', created_at) AS hr, count(*), min(created_at), max(created_at)
  FROM atoms
  WHERE entity_type='building-footprint' AND entity_id >= '48021:' AND entity_id < '48022:'
  GROUP BY 1 ORDER BY 1;"

psql "$ATOMS_URL" -c "
  SELECT date_trunc('hour', created_at) AS hr, count(*), min(created_at), max(created_at)
  FROM atoms
  WHERE entity_type='building-footprint' AND entity_id >= '48453:' AND entity_id < '48454:'
  GROUP BY 1 ORDER BY 1;"

echo "### 1b. Sanity vs the P-158 close doc's cited counts"
psql "$ATOMS_URL" -c "
  SELECT '48021' cnty, count(*) total,
         count(*) FILTER (WHERE body ? 'absence') absent,
         count(*) FILTER (WHERE NOT (body ? 'absence')) present
  FROM atoms WHERE entity_type='building-footprint' AND entity_id >= '48021:' AND entity_id < '48022:'
  UNION ALL
  SELECT '48453', count(*),
         count(*) FILTER (WHERE body ? 'absence'),
         count(*) FILTER (WHERE NOT (body ? 'absence'))
  FROM atoms WHERE entity_type='building-footprint' AND entity_id >= '48453:' AND entity_id < '48454:';"

echo "### 1c. Full body of one sample atom per county -- checks for a writer-identity field"
echo "    (expect: no writtenBy / runId / leaseId anywhere; sourceAdapter names the DATA"
echo "    source, ml-global-building-footprints-v1, never the operator/session identity)"
psql "$ATOMS_URL" -c "
  SELECT atom_did, entity_id, source_adapter, source_url, fetched_at, created_at, body
  FROM atoms WHERE entity_type='building-footprint' AND entity_id >= '48021:' AND entity_id < '48022:'
  LIMIT 1;"

echo "### 2. atoms_writer_lease_v2 / atoms_bulk_writer_lease -- live mutexes, not a log"
echo "    (expect: both empty right now; releaseScopedLease DELETEs the row on release,"
echo "    so this table cannot answer 'who held this on 2026-09-07' once released)"
psql "$ATOMS_URL" -c "\d atoms_writer_lease_v2"
psql "$ATOMS_URL" -c "SELECT * FROM atoms_writer_lease_v2;"
psql "$ATOMS_URL" -c "SELECT * FROM atoms_bulk_writer_lease;"

echo "### 3. Factory runs table -- the atom write's own run-id contract says it should"
echo "    correspond to a row here (see step 6). Check the window and any footprint match."
psql "$FACTORY_URL" -c "
  SELECT id, started_at, scope, phase, target, status FROM runs
  WHERE started_at BETWEEN '2026-09-06' AND '2026-09-08' ORDER BY started_at;"

psql "$FACTORY_URL" -c "
  SELECT id, started_at, scope, phase, target, status FROM runs
  WHERE scope::text ILIKE '%footprint%' OR target ILIKE '%footprint%' ORDER BY started_at;"

echo "### 4. Cloud Logging: Cloud Run Job executions on 2026-09-07, both projects,"
echo "    plus a literal-string search for the writer script name (30-day freshness)"
gcloud logging read 'resource.type="cloud_run_job" AND timestamp>="2026-09-07T00:00:00Z" AND timestamp<="2026-09-08T00:00:00Z"' \
  --project=hauska-prod-497015 --limit=300 --format="value(labels.\"run.googleapis.com/execution_name\")" | sort -u

gcloud logging read 'textPayload:"write-building-footprint-county" OR jsonPayload.message:"write-building-footprint-county"' \
  --project=hauska-prod-497015 --freshness=30d --limit=20 --format=json

gcloud logging read 'textPayload:"write-building-footprint-county" OR jsonPayload.message:"write-building-footprint-county"' \
  --project=legacy-design-tools-prod --freshness=30d --limit=20 --format=json

echo "### 5. Git log: commits touching the writer in the window, and the two"
echo "    remediation PRs the program-scope decision doc says unblocked this run"
git log --since=2026-09-06 --until=2026-09-08 --all --oneline \
  -- packages/engine-core/scripts/write-building-footprint-county.mjs packages/engine-core/src/building-footprint/

git log --since=2026-09-06 --until=2026-09-08 --all --oneline --grep="footprint" -i

git show -s --format="%H %ai %an <%ae>" aa05755   # PR #391, migration reconciliation
git show -s --format="%H %ai %an <%ae>" 654dedd   # PR #392, roster-query perf + touch-rate

echo "### 6. The writer's own run-id contract (grep, not a live query)"
echo "    APPLY_LEASE_MESSAGE says --run-id must be 'a Factory runs row'; check whether"
echo "    the code actually validates that, versus just checking the flag is non-empty."
grep -n "APPLY_LEASE_MESSAGE\|refuseApplyWithoutRunId" packages/engine-core/scripts/writer-apply-lease.mjs
grep -n "DELETE FROM atoms_writer_lease_v2" packages/storage/src/atoms-writer-lease.ts

echo "### 7. P-173: atoms_writer_lease_history — by run_id"
echo "    A row here means SOME take/release cycle happened for that run_id, with a"
echo "    real released_at (or release_reason='expired' if it was stolen, never released"
echo "    by its own holder). A write whose run_id predates migration 015's own"
echo "    applied_at in schema_migrations has NO history row by construction -- that is"
echo "    the pre-existing gap this table closes going forward, not a bug in the table."
echo "    Usage: RUN_ID=<id> bash scripts/audit/p171-footprint-write-provenance.sh"
if [ -n "${RUN_ID:-}" ]; then
  psql "$ATOMS_URL" -c "
    SELECT scope_type, scope_id, holder_token, holder_label, run_id,
           taken_at, released_at, released_by, release_reason
      FROM atoms_writer_lease_history
     WHERE run_id = '${RUN_ID}';"
else
  echo "    (RUN_ID not set -- skipping the by-run_id query; showing migration applied_at instead)"
  psql "$ATOMS_URL" -c "SELECT filename, applied_at FROM schema_migrations WHERE filename = '015_atoms_writer_lease_history.sql';"
fi

echo "### 8. P-173: atoms_writer_lease_history — by scope and window"
echo "    Answers 'who held entity_type X in county Y between T1 and T2' without"
echo "    needing a run_id up front. Usage: SCOPE_TYPE / SCOPE_ID / WINDOW_START /"
echo "    WINDOW_END env vars, e.g. SCOPE_TYPE=write SCOPE_ID=building-footprint:48021"
echo "    WINDOW_START=2026-09-06 WINDOW_END=2026-09-08."
if [ -n "${SCOPE_ID:-}" ]; then
  psql "$ATOMS_URL" -c "
    SELECT scope_type, scope_id, holder_label, run_id, taken_at, released_at, release_reason
      FROM atoms_writer_lease_history
     WHERE scope_type = '${SCOPE_TYPE:-write}'
       AND scope_id = '${SCOPE_ID}'
       AND taken_at BETWEEN '${WINDOW_START:-1970-01-01}' AND '${WINDOW_END:-2999-01-01}'
     ORDER BY taken_at;"
else
  echo "    (SCOPE_ID not set -- skipping the scope+window query)"
fi

cat <<'EOF'

### Cross-reference (manual step, not a query): compare the atoms' own created_at
### windows above against the run-ids recorded by a third, independent lane in
### _inbox/2026-09-07_ctx-wrapup-factory_throughput-remeasurement_close.json
### (doc_repo), which passively timed "cente-67's real ... building-footprint --apply"
### runs via pg_stat_user_tables.n_tup_ins:
###   48309 McLennan   bfoot-apply-48309-2026-09-07T033437Z   165s insert burst
###   48491 Williamson  bfoot-apply-48491-2026-09-07T034546Z   416s insert burst
###   48021 Bastrop     bfoot-apply-48021-2026-09-07T061302Z   105s insert burst
###   48453 Travis      (run-id not captured by that lane; this audit's step 1
###                      supplies the missing window directly: 05:57:06.77-06:06:03.67 UTC)
### Bastrop's independently-reported 105s burst starting ~06:13:02 is consistent with
### this audit's own measured 06:16:36.9-06:18:18.1 write window (the gap is the
### pre-write geometry/join phase the other lane's own note describes).
###
### P-173 note: none of the four run-ids above (bfoot-apply-*) will return a row from
### step 7 -- they predate migration 015 by five days. This is the exact gap the P-171
### audit could not close and P-173 exists to prevent recurring, not a retroactive fix
### for this specific write.
EOF
