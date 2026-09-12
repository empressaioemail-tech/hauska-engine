-- 015_atoms_writer_lease_history.sql
--
-- Append-only lease history (OPS-19 F-02 / OPS-23 P-173, from the P-171
-- audit's LOGGING GAP #1). atoms_writer_lease_v2 and atoms_bulk_writer_lease
-- stay exactly as they are today -- live mutexes, keyed for correctness, not
-- for memory. This table is the memory: one row per lease TAKE, carrying its
-- own release outcome once that lease ends.
--
-- Row lifecycle (single-row design, not two-row):
--   1. takeScopedLease INSERTs a row: taken_at set, released_at/released_by/
--      release_reason all NULL. This is the ONLY insert path.
--   2. Exactly one of two things closes that same row, ever:
--      a. releaseScopedLease UPDATEs released_at/released_by/release_reason
--         ('normal' or 'killed') on the row matching its holder_token.
--      b. A later takeScopedLease call that steals an expired scope (the
--         existing atoms_writer_lease_v2 ON CONFLICT ... WHERE expires <=
--         now() path) UPDATEs the prior open row for that (scope_type,
--         scope_id) with release_reason='expired' before inserting the new
--         holder's own row.
--   3. Nothing ever DELETEs a row, and nothing UPDATEs a row a second time.
--      Both are refused by trigger, not by convention -- see
--      atoms_writer_lease_history_guard below. Proven by violation in
--      packages/storage/src/__tests__/atoms-writer-lease-history.integration.test.ts
--      and by a live psql DELETE attempt recorded in this lane's close.
--
-- Enforcement is a TRIGGER, not a role grant: this repo's migrations and its
-- application writes share one Postgres role via one DATABASE_URL (see
-- packages/storage/scripts/apply-migration.mjs and every writer script under
-- packages/engine-core/scripts) -- there is no separate low-privilege
-- "writer" role to revoke UPDATE/DELETE from without also blocking the one
-- permitted release-UPDATE. A trigger enforces the narrow legal path
-- (append, then release exactly once) regardless of which role issues the
-- SQL; only a role holding ALTER TABLE (the table owner) could disable the
-- trigger, which is a schema change, not a data write, and is the same
-- caveat every trigger-based guardrail in Postgres carries.
--
-- No FOREIGN KEY to atoms_writer_lease_v2 (that row may already be gone by
-- the time this row is read) and none to the Factory runs table (lives in a
-- different database, same reasoning as migration 011).
--
-- Idempotent. Records itself into schema_migrations.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS atoms_writer_lease_history (
  id              bigserial PRIMARY KEY,
  scope_type      text NOT NULL CHECK (scope_type IN ('write', 'heavy-scan')),
  scope_id        text NOT NULL,
  holder_token    uuid NOT NULL,
  holder_label    text NOT NULL,
  run_id          text NOT NULL,
  taken_at        timestamptz NOT NULL,
  released_at     timestamptz NULL,
  released_by     text NULL,
  release_reason  text NULL CHECK (release_reason IN ('normal', 'expired', 'killed')),
  CONSTRAINT atoms_writer_lease_history_release_pair CHECK (
    (released_at IS NULL AND released_by IS NULL AND release_reason IS NULL)
    OR (released_at IS NOT NULL AND released_by IS NOT NULL AND release_reason IS NOT NULL)
  )
);

-- One open (released_at IS NULL) row per scope at a time -- this is what
-- lets a steal find "the" prior row to close without a holder_token, and it
-- mirrors atoms_writer_lease_v2's own (scope_type, scope_id) primary key.
CREATE UNIQUE INDEX IF NOT EXISTS atoms_writer_lease_history_one_open_per_scope
  ON atoms_writer_lease_history (scope_type, scope_id)
  WHERE released_at IS NULL;

-- holder_token is unique per take (randomUUID()); this is what the release
-- path matches on, same as atoms_writer_lease_v2.holder_token today.
CREATE UNIQUE INDEX IF NOT EXISTS atoms_writer_lease_history_holder_token
  ON atoms_writer_lease_history (holder_token);

-- The audit access pattern this table exists for: "who held this run_id."
CREATE INDEX IF NOT EXISTS atoms_writer_lease_history_run_id
  ON atoms_writer_lease_history (run_id);

-- The audit access pattern this table exists for: "who held this scope in
-- this window."
CREATE INDEX IF NOT EXISTS atoms_writer_lease_history_scope_window
  ON atoms_writer_lease_history (scope_type, scope_id, taken_at);

CREATE OR REPLACE FUNCTION atoms_writer_lease_history_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'atoms_writer_lease_history is append-only: DELETE refused (id=%, run_id=%)',
      OLD.id, OLD.run_id
      USING ERRCODE = 'PT173';
  END IF;

  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'atoms_writer_lease_history is append-only: TRUNCATE refused'
      USING ERRCODE = 'PT173';
  END IF;

  -- TG_OP = 'UPDATE' from here down. Exactly one legal shape: a row with no
  -- release yet (OLD.released_at IS NULL) may have released_at,
  -- released_by, release_reason set (and only those columns) -- once.
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION
      'atoms_writer_lease_history is append-only: row % (run_id=%) was already released at %, no further UPDATE',
      OLD.id, OLD.run_id, OLD.released_at
      USING ERRCODE = 'PT173';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.scope_type IS DISTINCT FROM OLD.scope_type
     OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
     OR NEW.holder_token IS DISTINCT FROM OLD.holder_token
     OR NEW.holder_label IS DISTINCT FROM OLD.holder_label
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.taken_at IS DISTINCT FROM OLD.taken_at
  THEN
    RAISE EXCEPTION
      'atoms_writer_lease_history is append-only: only released_at/released_by/release_reason may be set on row % (run_id=%), and only once',
      OLD.id, OLD.run_id
      USING ERRCODE = 'PT173';
  END IF;

  IF NEW.released_at IS NULL OR NEW.released_by IS NULL OR NEW.release_reason IS NULL THEN
    RAISE EXCEPTION
      'atoms_writer_lease_history release UPDATE must set released_at, released_by and release_reason together (row %, run_id=%)',
      OLD.id, OLD.run_id
      USING ERRCODE = 'PT173';
  END IF;

  RETURN NEW;
END;
$guard$;

DROP TRIGGER IF EXISTS atoms_writer_lease_history_no_delete ON atoms_writer_lease_history;
CREATE TRIGGER atoms_writer_lease_history_no_delete
  BEFORE DELETE ON atoms_writer_lease_history
  FOR EACH ROW EXECUTE FUNCTION atoms_writer_lease_history_guard();

DROP TRIGGER IF EXISTS atoms_writer_lease_history_no_truncate ON atoms_writer_lease_history;
CREATE TRIGGER atoms_writer_lease_history_no_truncate
  BEFORE TRUNCATE ON atoms_writer_lease_history
  FOR EACH STATEMENT EXECUTE FUNCTION atoms_writer_lease_history_guard();

DROP TRIGGER IF EXISTS atoms_writer_lease_history_guarded_update ON atoms_writer_lease_history;
CREATE TRIGGER atoms_writer_lease_history_guarded_update
  BEFORE UPDATE ON atoms_writer_lease_history
  FOR EACH ROW EXECUTE FUNCTION atoms_writer_lease_history_guard();

INSERT INTO schema_migrations (filename)
VALUES ('015_atoms_writer_lease_history.sql')
ON CONFLICT (filename) DO NOTHING;
