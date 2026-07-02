-- 004_document_ingest.sql
--
-- Persistent DocumentIngestStore backing tables (Phase 2 durability).
--
-- Two tables:
--   * document_blobs        — blob METADATA + the content-addressing index
--                             (contentHash -> cid). The blob BYTES live in
--                             GCS; this table is the restart-durable dedup
--                             index so re-ingesting the same content resolves
--                             to the same CID even across process restarts.
--   * document_ingest_atoms — the minted document-derived atoms, keyed by
--                             atom DID. The full atom is stored as jsonb in
--                             atom_json; projected columns support lookups.
--
-- The source BLOB record is ALWAYS access_policy = 'tenant-private' (the
-- licensed/private document stays gated regardless of extracted-atom policy).
--
-- Idempotent (CREATE TABLE IF NOT EXISTS, ON CONFLICT DO NOTHING). Safe to
-- re-run. Records itself into schema_migrations following the existing
-- convention (filename primary key + applied_at default now()).

CREATE TABLE IF NOT EXISTS document_blobs (
  cid            text PRIMARY KEY,
  content_hash   text NOT NULL UNIQUE,
  content_type   text,
  size           integer,
  tenant         text,
  access_policy  text NOT NULL DEFAULT 'tenant-private',
  created_at     timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_ingest_atoms (
  atom_did             text PRIMARY KEY,
  entity_type          text NOT NULL,
  entity_id            text NOT NULL,
  jurisdiction_tenant  text,
  source_document_cid  text NOT NULL,
  access_policy        text NOT NULL,
  storage_relation     text NOT NULL,
  verification_status  text,
  confidence_value     real,
  atom_json            jsonb NOT NULL,
  created_at           timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_ingest_atoms_source_document_cid
  ON document_ingest_atoms (source_document_cid);

INSERT INTO schema_migrations (filename)
VALUES ('004_document_ingest.sql')
ON CONFLICT DO NOTHING;
