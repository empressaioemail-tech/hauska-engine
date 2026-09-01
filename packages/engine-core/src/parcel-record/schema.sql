-- Parcel record durable template schema (hauska-engine parcel-record module).
-- Apply to the Factory program store (or any Postgres holding parcel rows).
-- One row per parcel; one row per (parcel, rail) cell; companion side tables.

CREATE TABLE IF NOT EXISTS parcel_record (
  place_key text PRIMARY KEY,
  county_fips text NOT NULL,
  prop_id text NOT NULL,
  incorporated boolean,
  instantiated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT parcel_record_place_key_shape CHECK (place_key = county_fips || ':' || prop_id)
);

CREATE INDEX IF NOT EXISTS parcel_record_county_fips_idx ON parcel_record (county_fips);

CREATE TABLE IF NOT EXISTS parcel_record_cell (
  place_key text NOT NULL REFERENCES parcel_record (place_key) ON DELETE CASCADE,
  rail_key text NOT NULL,
  cell_state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (place_key, rail_key),
  CONSTRAINT parcel_record_cell_state_kind CHECK (
    cell_state ? 'kind'
    AND cell_state->>'kind' IN (
      'value',
      'absent-verified',
      'not-applicable',
      'refused',
      'unaccounted'
    )
  )
);

CREATE INDEX IF NOT EXISTS parcel_record_cell_rail_idx ON parcel_record_cell (rail_key);
CREATE INDEX IF NOT EXISTS parcel_record_cell_unaccounted_idx ON parcel_record_cell (place_key)
  WHERE cell_state->>'kind' = 'unaccounted';

-- Companion row stores (pattern: rail_key discriminates payload shape at ingest)

CREATE TABLE IF NOT EXISTS parcel_record_companion_row (
  id bigserial PRIMARY KEY,
  place_key text NOT NULL REFERENCES parcel_record (place_key) ON DELETE CASCADE,
  rail_key text NOT NULL,
  row_index int NOT NULL,
  payload jsonb NOT NULL,
  source text NOT NULL,
  vintage text NOT NULL,
  UNIQUE (place_key, rail_key, row_index)
);

CREATE INDEX IF NOT EXISTS parcel_record_companion_place_rail_idx
  ON parcel_record_companion_row (place_key, rail_key);

-- County-rail ledger disposition (doc comment only):
-- legacy-design-tools public.county_facet_coverage / county_rail remain the
-- county×rail coverage manifest until consumers repoint. This schema is the
-- parcel×rail authoritative gate for publish.
