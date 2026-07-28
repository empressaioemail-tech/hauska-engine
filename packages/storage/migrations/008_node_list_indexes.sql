-- 008_node_list_indexes.sql
--
-- Node LIST + node DETAIL jsonb expression indexes (CC county roster).
--
-- GET /nodes pages DISTINCT body->>'parcelNodeId' / body->>'roadNodeId'
-- per county, and the existing per-node detail paths
-- (listPropertyAtomsByParcelNodeId, listBoundaryEdgesByParcelNodeId,
-- listRoadAtomsByRoadNodeId, listRoadAtomsNearBbox county filter) all
-- filter on jsonb keys that had NO index — the known CC gold-parcel
-- (48021:28286) inspect timeout runs two of those unindexed scans.
--
-- text_pattern_ops btree serves BOTH the `= '48021:28286'` equality used
-- by detail queries AND the `LIKE '48021:%'` county-prefix used by the
-- parcel roster (property atom bodies carry no countyFips field — the
-- county lives only as the parcelNodeId prefix).
--
-- Partial indexes per entity-type family keep them small and match the
-- query predicates exactly.
--
-- Plain CREATE INDEX (not CONCURRENTLY — the multi-statement migration
-- runner executes in one implicit transaction); brief write lock on
-- `atoms` during apply.
--
-- Idempotent (CREATE INDEX IF NOT EXISTS, ON CONFLICT DO NOTHING). Safe
-- to re-run. Records itself into schema_migrations.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Parcel-anchored property atoms (zoning-fact / setback-rule /
-- buildable-envelope / parcel-terrain-model): roster + atom-chain detail.
CREATE INDEX IF NOT EXISTS atoms_property_parcel_node_idx
  ON atoms ((body->>'parcelNodeId') text_pattern_ops)
  WHERE entity_type IN (
    'zoning-fact',
    'setback-rule',
    'buildable-envelope',
    'parcel-terrain-model'
  );

-- Boundary-edge atoms: per-parcel edge list (node-detail edges_out).
CREATE INDEX IF NOT EXISTS atoms_boundary_parcel_node_idx
  ON atoms ((body->>'parcelNodeId') text_pattern_ops)
  WHERE entity_type = 'property-boundary-edge';

-- Road-node atoms: roster grouping + road atom-chain detail.
CREATE INDEX IF NOT EXISTS atoms_road_node_id_idx
  ON atoms ((body->>'roadNodeId') text_pattern_ops)
  WHERE entity_type = 'road-node';

-- Road-node county filter (roster + near-bbox viewport query).
CREATE INDEX IF NOT EXISTS atoms_road_county_fips_idx
  ON atoms ((body->>'countyFips'))
  WHERE entity_type = 'road-node';

INSERT INTO schema_migrations (filename)
VALUES ('008_node_list_indexes.sql')
ON CONFLICT (filename) DO NOTHING;
