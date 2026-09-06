-- Statewide Texas RRC well + pipeline staging store (P2-3).
--
-- Layer-first P2-3: Texas Railroad Commission Public Viewer wells (layer 1),
-- pipelines (layer 13), and orphan-well API join (layer 2). Whole layers
-- ingested once; county writers read the store, not live REST.
--
-- Loaded by ingest-tx-rrc-staging.mjs. Replace semantics: DELETE all rows per
-- table, then batch insert with ON CONFLICT DO UPDATE.
--
-- RECONCILIATION NOTE (2026-09-06): both tables have been live in production
-- since P2-3 shipped, but their creating migration only ever existed on the
-- unmerged branch feat/p2-3-rrc-staging-tables (as 0073_tx_rrc_staging.sql)
-- and never landed on main -- main's own migration history could not
-- explain two tables its own shipped code (fetch-wells-staged.ts and
-- others) directly queries. Re-authored here under a fresh, non-colliding
-- number with the identical base schema already live.
--
-- The original branch's comment claimed "PostGIS is NOT available on
-- deployment Neon" -- that was true when written but is stale: PostGIS 3.5.0
-- is confirmed enabled on this Neon project as of 2026-09-06 (the same
-- extension tx_building_footprint's geom column already relies on).
-- tx_rrc_pipeline already carries a live geom column + GiST index in
-- production (added by an undetermined follow-up step, not this original
-- migration) -- reconciled here under the same PostGIS-availability-checked,
-- gracefully-degrading pattern apply-tx-building-footprint-migration.mjs
-- established, rather than assumed unconditionally. tx_rrc_well has no geom
-- column live and none is added here; wells are point geometry served fine
-- by the existing bbox btree index, and adding one wasn't part of what
-- shipped.
--
-- CREATE TABLE/INDEX IF NOT EXISTS makes the base DDL below a confirmed
-- no-op against the already-live tables. The PostGIS-conditional geom
-- column for tx_rrc_pipeline is applied by
-- apply-tx-rrc-staging-migration.mjs, not by this file, matching the
-- building-footprint precedent -- this file alone is deliberately safe to
-- run even where PostGIS is unavailable.

CREATE TABLE IF NOT EXISTS "tx_rrc_well" (
  "well_row_id" text NOT NULL,
  "uniqid" integer,
  "api" text,
  "gis_api5" text,
  "gis_well_number" text,
  "symnum" integer,
  "gis_symbol_description" text,
  "reliab" text,
  "gis_location_source" text,
  "lng" double precision NOT NULL,
  "lat" double precision NOT NULL,
  "geometry" jsonb NOT NULL,
  "west_lng" double precision NOT NULL,
  "south_lat" double precision NOT NULL,
  "east_lng" double precision NOT NULL,
  "north_lat" double precision NOT NULL,
  "county_fips" text,
  "is_orphan" boolean NOT NULL DEFAULT false,
  "well_status" text NOT NULL,
  "source" text NOT NULL,
  "source_vintage" text NOT NULL,
  "source_citation" text NOT NULL,
  "ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tx_rrc_well_well_row_id_pk" PRIMARY KEY ("well_row_id")
);

CREATE TABLE IF NOT EXISTS "tx_rrc_pipeline" (
  "pipeline_row_id" text NOT NULL,
  "p5_num" text,
  "t4permit" text,
  "operator" text,
  "system_name" text,
  "commodity" text,
  "commodity_description" text,
  "system_type" text,
  "status" text,
  "diameter" double precision,
  "interstate" text,
  "county_fips" text NOT NULL,
  "county_name" text,
  "geometry" jsonb NOT NULL,
  "west_lng" double precision NOT NULL,
  "south_lat" double precision NOT NULL,
  "east_lng" double precision NOT NULL,
  "north_lat" double precision NOT NULL,
  "source" text NOT NULL,
  "source_vintage" text NOT NULL,
  "source_citation" text NOT NULL,
  "ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tx_rrc_pipeline_pipeline_row_id_pk" PRIMARY KEY ("pipeline_row_id")
);

CREATE INDEX IF NOT EXISTS "tx_rrc_well_county_idx"
  ON "tx_rrc_well" ("county_fips");

CREATE INDEX IF NOT EXISTS "tx_rrc_well_bbox_idx"
  ON "tx_rrc_well" ("west_lng", "south_lat", "east_lng", "north_lat");

CREATE INDEX IF NOT EXISTS "tx_rrc_pipeline_county_idx"
  ON "tx_rrc_pipeline" ("county_fips");

CREATE INDEX IF NOT EXISTS "tx_rrc_pipeline_bbox_idx"
  ON "tx_rrc_pipeline" ("west_lng", "south_lat", "east_lng", "north_lat");

CREATE INDEX IF NOT EXISTS "tx_rrc_pipeline_dedupe_idx"
  ON "tx_rrc_pipeline" ("p5_num", "t4permit");
