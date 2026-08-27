-- 011_atoms_writer_lease_v2.sql
--
-- Scoped atoms writer lease (OPS-19 F-02 / P-83). Additive. v1 table
-- atoms_bulk_writer_lease stays until a later retirement migration after
-- takeWriterLease has refused in production for one cycle.
--
-- No FOREIGN KEY to a run table: the Factory run ledger lives in a
-- different database. run_id is recorded as text so a write cannot start
-- without naming the Factory row that authorized it.
--
-- Idempotent. Records itself into schema_migrations.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS atoms_writer_lease_v2 (
  scope_type    text NOT NULL CHECK (scope_type IN ('write', 'heavy-scan')),
  scope_id      text NOT NULL,
  holder_token  uuid NOT NULL,
  holder_label  text NOT NULL,
  run_id        text NOT NULL,
  taken_at      timestamptz NOT NULL,
  heartbeat     timestamptz NOT NULL,
  expires       timestamptz NOT NULL,
  stolen_from   text NULL,
  PRIMARY KEY (scope_type, scope_id)
);

INSERT INTO schema_migrations (filename)
VALUES ('011_atoms_writer_lease_v2.sql')
ON CONFLICT (filename) DO NOTHING;
