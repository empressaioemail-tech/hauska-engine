#!/usr/bin/env node
/**
 * benchmark-footprint-parcel-join.mjs — per-county footprint↔parcel join timing (P2-4).
 *
 *   CORTEX_DATABASE_URL=... \
 *     pnpm --filter @hauska-engine/engine-core run benchmark-footprint-parcel-join -- \
 *       [--county=48021] [--county=48113] [--out=path.json]
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import postgres from "postgres";

import {
  geometryOuterRing,
  joinFootprintsToParcels,
} from "../src/building-footprint/index.ts";

function parseArgs(argv) {
  const out = { counties: ["48021", "48113"], out: null, parcelLimit: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--county") out.counties.push(String(argv[++i] || "").trim());
    else if (a.startsWith("--county=")) out.counties.push(a.slice("--county=".length).trim());
    else if (a === "--out") out.out = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length).trim() || null;
    else if (a === "--parcel-limit") out.parcelLimit = Number(argv[++i] || 0);
    else if (a.startsWith("--parcel-limit="))
      out.parcelLimit = Number(a.slice("--parcel-limit=".length));
  }
  out.counties = [...new Set(out.counties.filter((c) => /^\d{5}$/.test(c)))];
  return out;
}

const args = parseArgs(process.argv.slice(2));

const poolUrl =
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.DEPLOYMENT_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();

if (!poolUrl) {
  console.error("FATAL: CORTEX_DATABASE_URL required.");
  process.exit(1);
}

const sql = postgres(poolUrl, { max: 4, ssl: "require", prepare: false });

const DEFAULT_PARCEL_LIMIT = {
  "48021": 200,
  "48113": 0,
};

async function benchmarkCounty(countyFips) {
  const explainRows = await sql.unsafe(
    `EXPLAIN SELECT footprint_row_id, footprint_id, geometry, west_lng, south_lat, east_lng, north_lat
     FROM tx_building_footprint
     WHERE county_fips = $1`,
    [countyFips],
  );
  const explainPlan = explainRows.map((r) => r["QUERY PLAN"]).join("\n");

  const tFootprint0 = performance.now();
  const footprintRows = await sql`
    SELECT footprint_row_id, footprint_id, geometry
    FROM tx_building_footprint
    WHERE county_fips = ${countyFips}
  `;
  const footprintQueryMs = Math.round(performance.now() - tFootprint0);

  const footprints = [];
  for (const row of footprintRows) {
    const ring = geometryOuterRing(row.geometry);
    if (!ring) continue;
    footprints.push({
      footprintId: row.footprint_id,
      ring,
    });
  }

  const parcelLimit =
    args.parcelLimit != null && args.parcelLimit > 0
      ? args.parcelLimit
      : DEFAULT_PARCEL_LIMIT[countyFips] ?? 0;

  const tParcel0 = performance.now();
  const parcelRows =
    parcelLimit > 0
      ? await sql`
          SELECT DISTINCT ON (feature_index)
                 feature_index, prop_id, geometry
          FROM txgio_parcel
          WHERE county_fips = ${countyFips}
          ORDER BY feature_index
          LIMIT ${parcelLimit}
        `
      : await sql`
          SELECT DISTINCT ON (feature_index)
                 feature_index, prop_id, geometry
          FROM txgio_parcel
          WHERE county_fips = ${countyFips}
          ORDER BY feature_index
        `;
  const parcelQueryMs = Math.round(performance.now() - tParcel0);

  const parcels = [];
  for (const p of parcelRows) {
    parcels.push({
      parcelKey: p.prop_id ?? `_feature-${p.feature_index}`,
      ring: geometryOuterRing(p.geometry),
    });
  }

  const tJoin0 = performance.now();
  const joinResult = joinFootprintsToParcels(
    parcels
      .filter((p) => p.ring != null)
      .map((p) => ({
        parcelNodeId: p.parcelKey,
        propId: p.parcelKey,
        fips: countyFips,
        ring: p.ring,
      })),
    footprints,
  );
  const joinMs = Math.round(performance.now() - tJoin0);

  return {
    countyFips,
    footprintCount: footprints.length,
    parcelCount: parcels.length,
    parcelLimit: parcelLimit > 0 ? parcelLimit : null,
    footprintQueryMs,
    parcelQueryMs,
    joinMs,
    joinStats: {
      footprintsJoined: joinResult.footprintsJoined,
      orphanRejected: joinResult.orphanRejected,
      parcelsWithFootprint: joinResult.parcelsWithFootprint,
      parcelsAbsentSentinel: joinResult.parcelsAbsentSentinel,
    },
    explainPlan,
  };
}

const report = {
  event: "tx-building-footprint.benchmark-parcel-join",
  counties: [],
};

try {
  const reg = await sql`SELECT to_regclass('public.tx_building_footprint') AS reg`;
  if (reg[0]?.reg == null) {
    throw new Error("tx_building_footprint missing — run migration + ingest first");
  }

  for (const countyFips of args.counties) {
    report.counties.push(await benchmarkCounty(countyFips));
  }

  console.log(JSON.stringify(report, null, 2));
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outPath = args.out || join(__dirname, "_p2-4-benchmark.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.error(JSON.stringify({ event: "tx-building-footprint.benchmark-written", outPath }));
} catch (err) {
  console.error(JSON.stringify({ event: "tx-building-footprint.benchmark-error", message: String(err) }));
  process.exit(1);
} finally {
  await sql.end({ timeout: 10 });
}
