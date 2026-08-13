-- 009_atoms_bulk_writer_lease.sql
--
-- Database-enforced atoms bulk-writer lease (OPS-16 A-012 ruling 0).
-- Single-row table: exactly one live custodian of writePropertyAtomsBatch.
-- The batch path heartbeats this row and FAILS CLOSED without a live match.
--
-- Idempotent. Records itself into schema_migrations.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS atoms_bulk_writer_lease (
  lock_id    smallint PRIMARY KEY CHECK (lock_id = 1),
  holder     text NOT NULL,
  taken_at   timestamptz NOT NULL,
  heartbeat  timestamptz NOT NULL,
  expires    timestamptz NOT NULL
);

INSERT INTO schema_migrations (filename)
VALUES ('009_atoms_bulk_writer_lease.sql')
ON CONFLICT (filename) DO NOTHING;
