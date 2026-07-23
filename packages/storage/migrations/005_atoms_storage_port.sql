-- 005_atoms_storage_port.sql
--
-- Postgres-backed StoragePort index tables (Phase 1a Gate A).
--
-- Tables:
--   * atoms               — code-corpus atom instances (jsonb body + index columns)
--   * atom_links          — cross-reference + composition graph edges
--   * jurisdiction_status — per-jurisdiction quality bar snapshots
--
-- Idempotent (CREATE TABLE IF NOT EXISTS, ON CONFLICT DO NOTHING). Safe to
-- re-run. Records itself into schema_migrations following the existing
-- convention (filename primary key + applied_at default now()).

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS atoms (
  atom_did             text PRIMARY KEY,
  cid                  text NOT NULL,
  content_hash         text NOT NULL,
  entity_type          text NOT NULL,
  entity_id            text NOT NULL,
  jurisdiction_tenant  text NOT NULL,
  section_number       text,
  subsection_path      text,
  source_adapter       text NOT NULL,
  source_url           text NOT NULL,
  fetched_at           timestamptz NOT NULL,
  body                 jsonb NOT NULL,
  access_policy        text NOT NULL DEFAULT 'public-free',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS atoms_entity_type_idx
  ON atoms (entity_type);

CREATE INDEX IF NOT EXISTS atoms_jurisdiction_idx
  ON atoms (jurisdiction_tenant);

CREATE INDEX IF NOT EXISTS atoms_section_number_idx
  ON atoms (jurisdiction_tenant, section_number);

CREATE UNIQUE INDEX IF NOT EXISTS atoms_entity_composite_unique
  ON atoms (entity_type, entity_id);

CREATE TABLE IF NOT EXISTS atom_links (
  from_atom_did  text NOT NULL,
  to_atom_did    text NOT NULL,
  link_type      text NOT NULL,
  context        text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_atom_did, to_atom_did, link_type)
);

CREATE INDEX IF NOT EXISTS atom_links_from_idx
  ON atom_links (from_atom_did);

CREATE INDEX IF NOT EXISTS atom_links_to_idx
  ON atom_links (to_atom_did);

CREATE INDEX IF NOT EXISTS atom_links_type_idx
  ON atom_links (link_type);

CREATE TABLE IF NOT EXISTS jurisdiction_status (
  jurisdiction_tenant   text PRIMARY KEY,
  jurisdiction_name     text NOT NULL,
  current_edition_did   text,
  quality_bar           text NOT NULL DEFAULT 'not-evaluated',
  top3_score            real,
  section_num_score     real,
  cross_ref_score       real,
  atom_count            integer NOT NULL DEFAULT 0,
  last_refreshed_at     timestamptz,
  drift_status          text NOT NULL DEFAULT 'clean',
  access_policy         text NOT NULL DEFAULT 'public-free'
);

INSERT INTO schema_migrations (filename)
VALUES ('005_atoms_storage_port.sql')
ON CONFLICT DO NOTHING;
