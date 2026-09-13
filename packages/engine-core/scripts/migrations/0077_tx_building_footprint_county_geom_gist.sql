-- Composite (county_fips, geom) GiST index for tx_building_footprint (P-158
-- phase 3). Requires the btree_gist extension so a non-spatial equality
-- column (county_fips) can share a GiST index with the geometry column.
--
-- FINDING (2026-09-13, this migration's own reconciliation note): the
-- footprint candidate-prefilter query (stagedEnvelopeCandidatesSql,
-- packages/engine-core/src/building-footprint/staged-footprint-join.ts)
-- joins a batch of parcel envelopes against
-- `tx_building_footprint WHERE county_fips = $6 AND ST_Intersects(geom, envelope)`.
-- Before this index, the only indexes available were a GiST on `geom` alone
-- (tx_building_footprint_geom_gist_idx) and a plain btree on `county_fips`
-- alone (tx_building_footprint_county_idx). For any large county the
-- planner chose a BitmapAnd combining both -- and critically, it rebuilt
-- the full county_fips bitmap (up to ~364K rows for Travis, 48453) ONCE PER
-- ENVELOPE in the unnest batch, not once per query. Measured live via
-- EXPLAIN ANALYZE: 384ms for a 10-envelope test batch, with the
-- county_fips bitmap scan alone re-executed 10 times (loops=10). Confirmed
-- as the mechanism blocking Travis's building-footprint writer from
-- completing (both the staging and production runs had produced zero
-- write-loop progress after over an hour). A single composite GiST index
-- collapses both predicates into one index scan; the identical query
-- pattern dropped to low milliseconds after this index was built live
-- against staging and production via CREATE INDEX CONCURRENTLY before this
-- migration file was authored (both are idempotent no-ops here: CREATE
-- EXTENSION IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).
--
-- Applied live via apply-tx-building-footprint-migration.mjs's own pattern
-- (CONCURRENTLY, no lock, safe alongside an in-flight writer) -- this file
-- exists so a future fresh environment (a new Neon branch, a rebuilt
-- staging copy) provisions the same index without rediscovering the same
-- BitmapAnd defect from scratch.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE INDEX IF NOT EXISTS "tx_building_footprint_county_geom_gist_idx"
  ON "tx_building_footprint" USING GIST ("county_fips", "geom");
