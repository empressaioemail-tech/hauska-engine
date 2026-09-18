-- 018_envelope_outcome_movement_journal.sql
--
-- P-342 — the DURABLE RECORD of every atom P-263's envelope-outcome apply moves,
-- written BEFORE the write commits, and the reversal path built on it.
--
-- WHY A TABLE AND NOT A FILE. The dispatch requires three things of the record at
-- once: (1) per atom, its id, its before-state and its after-state; (2) it is
-- written BEFORE the write commits, and if the record cannot be written the write
-- does not run; (3) a county's apply can be REVERSED from it. A file outside the
-- transaction cannot give (2) — a crash between the file write and the commit
-- leaves either a record of a change that never landed or a change with no record.
-- So the journal row is INSERTed in the SAME transaction as the UPDATE, and the
-- UPDATE cannot commit without it. That is the same shape as
-- atoms_writer_lease_history (015): append-only, enforced by trigger, not by
-- convention.
--
-- BEFORE_STATE IS THE WHOLE BODY, not a diff: the reversal replays it verbatim, so
-- a reversal is `body = before_body, content_hash = before_content_hash` and
-- nothing has to be recomputed from a description of what changed. `before_body`
-- and `before_content_hash` are captured by the apply's own SELECT, in the same
-- read the classification came from.
--
-- APPEND-ONLY, WITH ONE LEGAL UPDATE: a row may be marked reversed exactly once
-- (reversed_at / reversed_by_run_id), never edited, never deleted. A second
-- reversal of the same atom is refused by the primary key on (run_id, atom_did)
-- plus the guard below, so a re-run cannot double-apply a reversal.
--
-- No FOREIGN KEY to `atoms` (a later rewarm may replace the row; the journal is
-- the historical record of what THIS run touched, and must outlive the atom's
-- current revision) and none to the Factory runs table (different database,
-- same reasoning as migration 011).
--
-- Idempotent. Records itself into schema_migrations.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS envelope_outcome_movement_journal (
  id                    bigserial PRIMARY KEY,
  run_id                text NOT NULL,
  county_fips           text NOT NULL CHECK (county_fips ~ '^[0-9]{5}$'),
  atom_did              text NOT NULL,
  bucket                text NOT NULL CHECK (bucket IN ('unzoned', 'no-district', 'tier1StatusAssertion')),
  movement              text NOT NULL CHECK (movement IN ('toNotApplicable', 'toPendingDerivation')),
  applied_at            timestamptz NOT NULL DEFAULT now(),
  before_body           jsonb NOT NULL,
  before_content_hash   text NOT NULL,
  after_body            jsonb NOT NULL,
  after_content_hash    text NOT NULL,
  reversed_at           timestamptz NULL,
  reversed_by_run_id    text NULL,
  CONSTRAINT envelope_outcome_movement_journal_reversal_pair CHECK (
    (reversed_at IS NULL AND reversed_by_run_id IS NULL)
    OR (reversed_at IS NOT NULL AND reversed_by_run_id IS NOT NULL)
  )
);

-- One change per atom per run. A re-run of the same run_id cannot double-record,
-- and cannot double-apply: the apply's INSERT ... ON CONFLICT DO NOTHING plus a
-- row count check is what refuses it.
CREATE UNIQUE INDEX IF NOT EXISTS envelope_outcome_movement_journal_run_atom
  ON envelope_outcome_movement_journal (run_id, atom_did);

-- The reversal access pattern: "everything run R moved, not yet reversed."
CREATE INDEX IF NOT EXISTS envelope_outcome_movement_journal_open_reversal
  ON envelope_outcome_movement_journal (run_id, county_fips)
  WHERE reversed_at IS NULL;

-- The audit access pattern: "what has this county ever had moved."
CREATE INDEX IF NOT EXISTS envelope_outcome_movement_journal_county
  ON envelope_outcome_movement_journal (county_fips, applied_at);

CREATE OR REPLACE FUNCTION envelope_outcome_movement_journal_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'envelope_outcome_movement_journal is append-only: DELETE refused (id=%, run_id=%)',
      OLD.id, OLD.run_id
      USING ERRCODE = 'PT342';
  END IF;

  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'envelope_outcome_movement_journal is append-only: TRUNCATE refused'
      USING ERRCODE = 'PT342';
  END IF;

  -- TG_OP = 'UPDATE'. Exactly one legal shape: a row not yet reversed may have
  -- reversed_at and reversed_by_run_id set, and only those columns -- once.
  IF OLD.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION
      'envelope_outcome_movement_journal: row % (run_id=%, atom_did=%) was already reversed at %',
      OLD.id, OLD.run_id, OLD.atom_did, OLD.reversed_at
      USING ERRCODE = 'PT342';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.county_fips IS DISTINCT FROM OLD.county_fips
     OR NEW.atom_did IS DISTINCT FROM OLD.atom_did
     OR NEW.bucket IS DISTINCT FROM OLD.bucket
     OR NEW.movement IS DISTINCT FROM OLD.movement
     OR NEW.applied_at IS DISTINCT FROM OLD.applied_at
     OR NEW.before_body IS DISTINCT FROM OLD.before_body
     OR NEW.before_content_hash IS DISTINCT FROM OLD.before_content_hash
     OR NEW.after_body IS DISTINCT FROM OLD.after_body
     OR NEW.after_content_hash IS DISTINCT FROM OLD.after_content_hash
  THEN
    RAISE EXCEPTION
      'envelope_outcome_movement_journal is append-only: only reversed_at/reversed_by_run_id may be set on row % (run_id=%)',
      OLD.id, OLD.run_id
      USING ERRCODE = 'PT342';
  END IF;

  IF NEW.reversed_at IS NULL OR NEW.reversed_by_run_id IS NULL THEN
    RAISE EXCEPTION
      'envelope_outcome_movement_journal reversal UPDATE must set reversed_at and reversed_by_run_id together (row %, run_id=%)',
      OLD.id, OLD.run_id
      USING ERRCODE = 'PT342';
  END IF;

  RETURN NEW;
END;
$guard$;

DROP TRIGGER IF EXISTS envelope_outcome_movement_journal_no_delete ON envelope_outcome_movement_journal;
CREATE TRIGGER envelope_outcome_movement_journal_no_delete
  BEFORE DELETE ON envelope_outcome_movement_journal
  FOR EACH ROW EXECUTE FUNCTION envelope_outcome_movement_journal_guard();

DROP TRIGGER IF EXISTS envelope_outcome_movement_journal_no_truncate ON envelope_outcome_movement_journal;
CREATE TRIGGER envelope_outcome_movement_journal_no_truncate
  BEFORE TRUNCATE ON envelope_outcome_movement_journal
  FOR EACH STATEMENT EXECUTE FUNCTION envelope_outcome_movement_journal_guard();

DROP TRIGGER IF EXISTS envelope_outcome_movement_journal_guarded_update ON envelope_outcome_movement_journal;
CREATE TRIGGER envelope_outcome_movement_journal_guarded_update
  BEFORE UPDATE ON envelope_outcome_movement_journal
  FOR EACH ROW EXECUTE FUNCTION envelope_outcome_movement_journal_guard();

INSERT INTO schema_migrations (filename)
VALUES ('018_envelope_outcome_movement_journal.sql')
ON CONFLICT (filename) DO NOTHING;
