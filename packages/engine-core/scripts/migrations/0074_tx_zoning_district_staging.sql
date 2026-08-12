-- Factory 1.5 zoning district staging (feat/h1-f15-zoning-staging).
--
-- City-scoped municipal zoning polygons acquired ahead of any atoms write.
-- Mirror of 0072_tx_special_district.sql conventions (PK + bbox + provenance)
-- with cityKey grain, layer_role (CP1-F2), geometry_grain (CP1-F3), and
-- source_tier_satisfied NOT NULL / non-empty guard (CP1-F4).
--
-- Loaded by stage-tx-zoning-district.mjs (REPLACE per city_key).
-- Drained later by Factory 2 zoning writer via drain-tx-zoning-district-staging.mjs.
-- This table lives in neondb ONLY — never hauska_mcp / atoms.

CREATE TABLE IF NOT EXISTS "tx_zoning_district_staging" (
  "staging_row_id" text NOT NULL,
  "city_key" text NOT NULL,
  "city_geo_id" text NOT NULL,
  "city_name" text NOT NULL,
  "parent_county_fips" text NOT NULL,
  "district_code" text NOT NULL,
  "district_name" text,
  "geometry" jsonb NOT NULL,
  "geometry_crs" text NOT NULL,
  "is_overlay" boolean NOT NULL DEFAULT false,
  "is_base_district" boolean NOT NULL DEFAULT true,
  "layer_role" text NOT NULL,
  "geometry_grain" text NOT NULL,
  "source_url" text NOT NULL,
  "source_layer_id" text NOT NULL,
  "fetched_at" timestamp with time zone NOT NULL,
  "source_tiers" jsonb NOT NULL,
  "source_tier_satisfied" jsonb NOT NULL,
  "source_vintage" text NOT NULL,
  "source_citation" text NOT NULL,
  "passthrough_attributes" jsonb NOT NULL,
  "west_lng" double precision NOT NULL,
  "south_lat" double precision NOT NULL,
  "east_lng" double precision NOT NULL,
  "north_lat" double precision NOT NULL,
  "code_field_raw" text,
  "code_domain_map_applied" boolean NOT NULL DEFAULT false,
  "layer_where" text NOT NULL DEFAULT '1=1',
  "object_id" text NOT NULL,
  "ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tx_zoning_district_staging_pk" PRIMARY KEY ("staging_row_id"),
  CONSTRAINT "tx_zoning_district_staging_layer_role_chk"
    CHECK ("layer_role" IN ('base', 'overlay', 'unknown')),
  CONSTRAINT "tx_zoning_district_staging_geometry_grain_chk"
    CHECK ("geometry_grain" IN ('parcel-joined', 'district-polygon')),
  CONSTRAINT "tx_zoning_district_staging_tier_satisfied_chk"
    CHECK (
      jsonb_typeof("source_tier_satisfied") = 'array'
      AND jsonb_array_length("source_tier_satisfied") > 0
    )
);

CREATE INDEX IF NOT EXISTS "tx_zoning_district_staging_bbox_idx"
  ON "tx_zoning_district_staging" ("west_lng", "south_lat", "east_lng", "north_lat");

CREATE INDEX IF NOT EXISTS "tx_zoning_district_staging_city_idx"
  ON "tx_zoning_district_staging" ("city_key");

CREATE INDEX IF NOT EXISTS "tx_zoning_district_staging_county_idx"
  ON "tx_zoning_district_staging" ("parent_county_fips");

CREATE INDEX IF NOT EXISTS "tx_zoning_district_staging_district_idx"
  ON "tx_zoning_district_staging" ("city_key", "district_code");
