-- Statewide Texas RRC well + pipeline staging store (feat/p2-3-rrc-staging-tables).
--
-- Layer-first P2-3: Texas Railroad Commission Public Viewer wells (layer 1),
-- pipelines (layer 13), and orphan-well API join (layer 2). Whole layers
-- ingested once; county writers read the store, not live REST.
--
-- PostGIS is NOT available on deployment Neon (PostGIS_Version fails). Geometry
-- is stored as jsonb GeoJSON with west_lng/south_lat/east_lng/north_lat bbox
-- columns and btree indexes — NOT PostGIS GiST.
--
-- Loaded by ingest-tx-rrc-staging.mjs. Replace semantics: DELETE all rows per
-- table, then batch insert with ON CONFLICT DO UPDATE.

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
