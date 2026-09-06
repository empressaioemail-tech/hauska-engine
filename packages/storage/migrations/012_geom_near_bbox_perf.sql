-- 012_geom_near_bbox_perf.sql
--
-- Fixes two real production 504s on the viewport near-bbox endpoints
-- (/road-nodes/near-bbox, /building-footprints/near-bbox).
--
-- Fix 1: building-footprint had NO index supporting its
-- `body->>'parcelNodeId' LIKE 'fips:%'` county-scoping filter -- unlike
-- zoning-fact/setback-rule/buildable-envelope/parcel-terrain-model and
-- property-boundary-edge, which got this in migration 008. Measured: a
-- bare county-scoped filter on building-footprint alone plans as a
-- parallel bitmap scan of ~3.5M rows nationwide (cost ~10M; times out
-- past 90s just to COUNT, before any geometry check runs at all). Same
-- fix as 008, applied to the entity type it missed.
--
-- Fix 2: both road-node and building-footprint test bbox membership via
-- a correlated `EXISTS (SELECT 1 FROM jsonb_array_elements(...))` per
-- candidate row -- an unindexable, per-point scan (`\d atoms` confirms:
-- only btree text-pattern indexes exist, no PostGIS/GiST). Measured: even
-- WITH county scoping already in place (road-node's case), a real
-- Caldwell-county (48055) bbox took 24.5s against 13,790 candidate rows --
-- comfortably past a 10s proxy timeout, reproducing the reported 504.
-- This migration adds a small side table (atoms_geom_bbox) holding a
-- precomputed scalar bounding box per road-node/building-footprint atom.
-- It is populated by scripts/backfill-geom-bbox.mjs and kept current by
-- pg-storage.ts's write path going forward. The read path
-- (listRoadAtomsNearBbox / listBuildingFootprintsNearBbox) is cut over to
-- use it only once backfill coverage is verified complete for both
-- entity types -- seeing this table exist does not by itself change read
-- behavior.
--
-- Deliberately does not touch the atoms table's body or contentHash
-- semantics -- purely an auxiliary index/cache table computed FROM
-- existing atom bodies, mirroring the pattern tx_special_district already
-- proves out (real scalar bbox columns, plain btree comparisons, no
-- per-point scan).
--
-- Plain CREATE INDEX / CREATE TABLE (not CONCURRENTLY -- matches 008's
-- own precedent: "the multi-statement migration runner executes in one
-- implicit transaction"); brief write lock on atoms during the index
-- build, no lock on atoms for the new table (it is independent).
--
-- Idempotent (CREATE ... IF NOT EXISTS). Safe to re-run.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Fix 1: building-footprint county-prefix filter (same shape as 008's
-- atoms_property_parcel_node_idx / atoms_boundary_parcel_node_idx).
CREATE INDEX IF NOT EXISTS atoms_building_footprint_parcel_node_idx
  ON atoms ((body->>'parcelNodeId') text_pattern_ops)
  WHERE entity_type = 'building-footprint';

-- Fix 2: precomputed geometry bounding box for near-bbox viewport
-- queries. One row per road-node/building-footprint atom. Not a foreign
-- key to atoms(atom_did) -- atoms are retired in place, never hard
-- deleted, so no cascade behavior is needed, and skipping the FK avoids
-- extra lock coupling on the atoms write path.
CREATE TABLE IF NOT EXISTS atoms_geom_bbox (
  atom_did     text PRIMARY KEY,
  entity_type  text NOT NULL,
  county_fips  text,
  west_lng     double precision NOT NULL,
  south_lat    double precision NOT NULL,
  east_lng     double precision NOT NULL,
  north_lat    double precision NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS atoms_geom_bbox_lookup_idx
  ON atoms_geom_bbox (entity_type, county_fips, west_lng, east_lng, south_lat, north_lat);

INSERT INTO schema_migrations (filename)
VALUES ('012_geom_near_bbox_perf.sql')
ON CONFLICT (filename) DO NOTHING;
