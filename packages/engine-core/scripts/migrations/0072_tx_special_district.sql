-- Statewide TCEQ water-district polygon store (feat/special-district-fact).
--
-- Layer-first W4: Texas special-district boundaries acquired once from
-- TCEQ Public/WaterDistricts MapServer/0 (2,796 polygons statewide).
-- Whole layer ingested — districtType is an atom body field, not an ingest filter.
--
-- Loaded by ingest-tx-special-districts.mjs. Replace semantics: DELETE all
-- rows, then batch insert with ON CONFLICT DO UPDATE.

CREATE TABLE IF NOT EXISTS "tx_special_district" (
  "district_row_id" text NOT NULL,
  "district_id" text NOT NULL,
  "district_name" text NOT NULL,
  "district_type" text NOT NULL,
  "county_fips" text NOT NULL,
  "status" text,
  "geometry" jsonb NOT NULL,
  "west_lng" double precision NOT NULL,
  "south_lat" double precision NOT NULL,
  "east_lng" double precision NOT NULL,
  "north_lat" double precision NOT NULL,
  "source" text NOT NULL,
  "source_vintage" text NOT NULL,
  "source_citation" text NOT NULL,
  "ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tx_special_district_district_row_id_pk" PRIMARY KEY ("district_row_id")
);

CREATE INDEX IF NOT EXISTS "tx_special_district_bbox_idx"
  ON "tx_special_district" ("west_lng", "south_lat", "east_lng", "north_lat");

CREATE INDEX IF NOT EXISTS "tx_special_district_county_idx"
  ON "tx_special_district" ("county_fips");

CREATE INDEX IF NOT EXISTS "tx_special_district_type_idx"
  ON "tx_special_district" ("district_type");
