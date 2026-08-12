-- 0073_tx_fema_nfhl_flood_zone_geom.sql
-- Adds a PostGIS geometry column + GiST index to tx_fema_nfhl_flood_zone so the
-- flood-hazard-fact plan phase can push point-in-polygon down to the database
-- instead of resolving O(parcels x zones) in JS.
--
-- Column type is geometry(Geometry, 4326), NOT Polygon: the NFHL corpus is
-- 100% MultiPolygon (measured 198178/198178) and a Polygon-only column would
-- reject every row.
-- Idempotent: safe to re-run.

CREATE EXTENSION IF NOT EXISTS postgis;

ALTER TABLE tx_fema_nfhl_flood_zone
  ADD COLUMN IF NOT EXISTS geom geometry(Geometry, 4326);

CREATE INDEX IF NOT EXISTS tx_fema_nfhl_flood_zone_geom_gist_idx
  ON tx_fema_nfhl_flood_zone
  USING GIST (geom);
