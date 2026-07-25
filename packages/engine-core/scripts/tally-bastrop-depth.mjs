#!/usr/bin/env node
/**
 * tally-bastrop-depth.mjs — R4 ledger SELECT: zoning-facts vs depth-warm vs roads (48021).
 *
 *   DATABASE_URL=... pnpm --filter @hauska-engine/engine-core run tally-bastrop-depth
 */

import postgres from "postgres";
import { resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

import { DEPTH_WARM_PROMOTION_MARKER } from "../src/depth-warm/types.ts";

const COUNTY_FIPS = "48021";
const url = resolveSubstrateDatabaseUrl();
if (!url) {
  console.error("FATAL: DATABASE_URL or SUBSTRATE_DATABASE_URL required.");
  process.exit(1);
}

const sql = postgres(url, { ssl: "require", max: 1, prepare: false });

try {
  const [roads] = await sql`
    SELECT count(*)::int AS road_nodes
    FROM atoms
    WHERE entity_type = 'road-node'
      AND body->>'roadNodeId' LIKE ${COUNTY_FIPS + ":road:%"}
  `;

  const [zoning] = await sql`
    SELECT
      count(*)::int AS zoning_facts_total,
      count(*) FILTER (
        WHERE NOT (body ? 'absence') AND coalesce(body->>'district', '') <> ''
      )::int AS zoning_facts_with_district,
      count(*) FILTER (WHERE body ? 'absence')::int AS zoning_honest_absence
    FROM atoms
    WHERE entity_type = 'zoning-fact'
      AND body->>'parcelNodeId' LIKE ${COUNTY_FIPS + ":%"}
  `;

  const [envelopes] = await sql`
    SELECT
      count(*)::int AS envelopes_total,
      count(*) FILTER (
        WHERE body->>'depthWarmPromotion' = ${DEPTH_WARM_PROMOTION_MARKER}
      )::int AS depth_warm_promoted
    FROM atoms
    WHERE entity_type = 'buildable-envelope'
      AND body->>'parcelNodeId' LIKE ${COUNTY_FIPS + ":%"}
  `;

  const depthRatio =
    zoning.zoning_facts_with_district > 0
      ? envelopes.depth_warm_promoted / zoning.zoning_facts_with_district
      : null;

  const report = {
    event: "R4-bastrop-depth-tally",
    countyFips: COUNTY_FIPS,
    at: new Date().toISOString(),
    road_nodes: roads.road_nodes,
    zoning_facts_total: zoning.zoning_facts_total,
    zoning_facts_with_district: zoning.zoning_facts_with_district,
    zoning_honest_absence: zoning.zoning_honest_absence,
    envelopes_total: envelopes.envelopes_total,
    depth_warm_promoted: envelopes.depth_warm_promoted,
    depth_ratio: depthRatio,
    depth_ratio_pct: depthRatio != null ? Number((depthRatio * 100).toFixed(4)) : null,
    proposedSql: {
      road_nodes: `SELECT count(*) FROM atoms WHERE entity_type='road-node' AND body->>'roadNodeId' LIKE '${COUNTY_FIPS}:road:%';`,
      zoning_with_district: `SELECT count(*) FROM atoms WHERE entity_type='zoning-fact' AND body->>'parcelNodeId' LIKE '${COUNTY_FIPS}:%' AND NOT (body ? 'absence') AND coalesce(body->>'district','') <> '';`,
      depth_warm_promoted: `SELECT count(*) FROM atoms WHERE entity_type='buildable-envelope' AND body->>'parcelNodeId' LIKE '${COUNTY_FIPS}:%' AND body->>'depthWarmPromotion' = '${DEPTH_WARM_PROMOTION_MARKER}';`,
      depth_ratio: `SELECT round(100.0 * depth_warm / nullif(zoning,0), 4) AS depth_pct FROM (SELECT (SELECT count(*) FROM atoms WHERE entity_type='buildable-envelope' AND body->>'parcelNodeId' LIKE '${COUNTY_FIPS}:%' AND body->>'depthWarmPromotion'='${DEPTH_WARM_PROMOTION_MARKER}') AS depth_warm, (SELECT count(*) FROM atoms WHERE entity_type='zoning-fact' AND body->>'parcelNodeId' LIKE '${COUNTY_FIPS}:%' AND NOT (body ? 'absence') AND coalesce(body->>'district','') <> '') AS zoning) s;`,
    },
  };

  console.log(JSON.stringify(report, null, 2));
} finally {
  await sql.end({ timeout: 5 });
}
