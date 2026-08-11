-- Statewide Microsoft ML building-footprint polygon store (P2-4).
--
-- Layer-first: Texas ML footprints acquired once from GlobalMLBuildingFootprints
-- Texas.geojson.zip (~10.7M polygons). Loaded by ingest-tx-building-footprints.mjs.
-- Replace semantics: DELETE all rows, then batch insert with ON CONFLICT DO UPDATE.
--
-- Optional PostGIS geom column + GiST index are added by apply-tx-building-footprint-migration.mjs
-- when the extension is available on the host (Neon).

CREATE TABLE IF NOT EXISTS "tx_building_footprint" (
  "footprint_row_id" text NOT NULL,
  "footprint_id" text NOT NULL,
  "geometry" jsonb NOT NULL,
  "west_lng" double precision NOT NULL,
  "south_lat" double precision NOT NULL,
  "east_lng" double precision NOT NULL,
  "north_lat" double precision NOT NULL,
  "county_fips" text NOT NULL,
  "source" text NOT NULL,
  "source_tier" text NOT NULL DEFAULT 'ml-derived',
  "source_vintage" text NOT NULL,
  "source_citation" text NOT NULL,
  "ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tx_building_footprint_footprint_row_id_pk" PRIMARY KEY ("footprint_row_id")
);

CREATE INDEX IF NOT EXISTS "tx_building_footprint_county_idx"
  ON "tx_building_footprint" ("county_fips");

CREATE INDEX IF NOT EXISTS "tx_building_footprint_bbox_idx"
  ON "tx_building_footprint" ("west_lng", "south_lat", "east_lng", "north_lat");
