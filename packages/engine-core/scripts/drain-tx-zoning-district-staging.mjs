#!/usr/bin/env node
/**
 * drain-tx-zoning-district-staging.mjs — READ-ONLY drain of staged zoning rows.
 *
 * DB → normalised payload JSON. No ArcGIS fetch. No atom mint. No parcel stamp.
 * Future Factory 2 zoning writer will consume this interface.
 *
 *   ZONING_STAGING_DRAIN_PATH=1 \
 *   CORTEX_DATABASE_URL=... \
 *     pnpm --filter @hauska-engine/engine-core run drain-tx-zoning-district-staging -- \
 *       --city=elgin-tx [--county=48021] [--base-only] [--out=path.json]
 */

import { writeFileSync } from "node:fs";

import postgres from "postgres";

import { drainZoningStagingRows } from "../src/zoning-staging/index.ts";

function parseArgs(argv) {
  const out = {
    city: null,
    county: null,
    baseOnly: true,
    allowMultiCity: false,
    out: null,
    limit: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--city") out.city = String(argv[++i] || "").trim();
    else if (a.startsWith("--city=")) out.city = a.slice("--city=".length).trim();
    else if (a === "--county") out.county = String(argv[++i] || "").trim();
    else if (a.startsWith("--county=")) out.county = a.slice("--county=".length).trim();
    else if (a === "--base-only") out.baseOnly = true;
    else if (a === "--include-unknown") out.baseOnly = false;
    else if (a === "--allow-multi-city") out.allowMultiCity = true;
    else if (a === "--limit") out.limit = Number(argv[++i] || 0);
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice("--limit=".length));
    else if (a === "--out") out.out = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length).trim() || null;
  }
  return out;
}

function stripPooler(url) {
  return String(url).replace(/-pooler/g, "");
}

if (process.env.ZONING_STAGING_DRAIN_PATH !== "1") {
  console.error("FATAL: ZONING_STAGING_DRAIN_PATH=1 required.");
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (!args.city && !args.county) {
  console.error("FATAL: --city and/or --county required.");
  process.exit(1);
}
if (!args.city && args.county && !args.allowMultiCity) {
  console.error(
    "FATAL: --county without --city mixes cities (C-3 collision class). " +
      "Pass --city=... (preferred) or --allow-multi-city.",
  );
  process.exit(1);
}

const raw =
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.DEPLOYMENT_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();
if (!raw) {
  console.error("FATAL: CORTEX_DATABASE_URL required.");
  process.exit(1);
}

const poolUrl = stripPooler(raw);
const sql = postgres(poolUrl, { max: 2, ssl: "require", prepare: false });

try {
  let rows;
  if (args.city && args.county) {
    rows = await sql`
      SELECT * FROM tx_zoning_district_staging
      WHERE city_key = ${args.city} AND parent_county_fips = ${args.county}
      ORDER BY staging_row_id
    `;
  } else if (args.city) {
    rows = await sql`
      SELECT * FROM tx_zoning_district_staging
      WHERE city_key = ${args.city}
      ORDER BY staging_row_id
    `;
  } else {
    rows = await sql`
      SELECT * FROM tx_zoning_district_staging
      WHERE parent_county_fips = ${args.county}
      ORDER BY city_key, staging_row_id
    `;
  }

  const drained = drainZoningStagingRows(rows, {
    cityKey: args.city,
    countyFips: args.county,
    baseOnly: args.baseOnly,
    allowMultiCity: args.allowMultiCity,
  });

  let payloadRows = drained.rows;
  if (args.limit > 0) payloadRows = payloadRows.slice(0, args.limit);

  const report = {
    event: "tx-zoning-district-staging.drain",
    primaryKey: drained.primaryKey,
    cityKey: args.city,
    countyFips: args.county,
    baseOnly: args.baseOnly,
    allowMultiCity: args.allowMultiCity,
    rowsRead: rows.length,
    rowsDrained: payloadRows.length,
    refused: drained.refused,
    note:
      "Factory 2 zoning writer will consume this drain later — this CLI does not mint atoms or stamp parcels. District codes are city-scoped; prefer --city.",
    sample: payloadRows.slice(0, 3).map((r) => ({
      stagingRowId: r.stagingRowId,
      cityKey: r.cityKey,
      districtCode: r.districtCode,
      layerRole: r.layerRole,
      geometryGrain: r.geometryGrain,
      sourceTierSatisfied: r.sourceTierSatisfied,
      passthroughKeyCount: Object.keys(r.passthroughAttributes).length,
    })),
  };

  console.log(JSON.stringify(report));
  if (args.out) {
    writeFileSync(
      args.out,
      JSON.stringify({ ...report, rows: payloadRows }, null, 2),
    );
  }
} finally {
  await sql.end({ timeout: 5 });
}
