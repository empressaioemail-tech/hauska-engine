#!/usr/bin/env node
/**
 * populate-tx-fema-nfhl-geom.mjs — batched backfill of tx_fema_nfhl_flood_zone.geom
 * from the existing jsonb `geometry` column.
 *
 * Requires apply-tx-fema-nfhl-geom.mjs to have run first (column + GiST index).
 *
 * Gate: env F1_NFHL_GEOM_POPULATE=1. Without it the script reports what it would
 * do and exits 0, so an accidental invocation cannot write.
 *
 * Batching walks the zone_row_id primary key in ranges rather than passing id
 * arrays, so each UPDATE is an index range scan and the loop is resumable: the
 * `geom IS NULL` predicate makes a re-run a no-op over already-populated ranges.
 *
 * A batch whose ST_GeomFromGeoJSON call fails falls back to row-by-row so one
 * malformed GeoJSON row cannot strand 50k good ones. Failures are reported, not
 * swallowed.
 *
 * This writes to a staging geometry table. It is NOT the atoms bulk writer and
 * does not consume the atoms bulk-writer slot.
 */

import postgres from "postgres";

const TABLE = "tx_fema_nfhl_flood_zone";
const BATCH_SIZE = Number.parseInt(process.env.F1_NFHL_GEOM_BATCH ?? "50000", 10);
const STATEMENT_TIMEOUT_MS = Number.parseInt(
  process.env.F1_NFHL_GEOM_STATEMENT_TIMEOUT_MS ?? "900000",
  10,
);
const APPLY = process.env.F1_NFHL_GEOM_POPULATE === "1";

const poolUrl =
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.DEPLOYMENT_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();

if (!poolUrl) {
  console.error("FATAL: CORTEX_DATABASE_URL or DEPLOYMENT_DATABASE_URL required.");
  process.exit(1);
}
if (!Number.isFinite(BATCH_SIZE) || BATCH_SIZE < 1) {
  console.error(`FATAL: invalid F1_NFHL_GEOM_BATCH=${process.env.F1_NFHL_GEOM_BATCH}`);
  process.exit(1);
}

// max: 1 so the session-level statement_timeout cannot land on a different
// connection than the UPDATE it is meant to cover.
const sql = postgres(poolUrl, {
  max: 1,
  ssl: "require",
  prepare: false,
  idle_timeout: 60,
  connection: { statement_timeout: String(STATEMENT_TIMEOUT_MS) },
});

/** @param {string} lo @param {string} hi */
async function updateRange(lo, hi) {
  const res = await sql`
    UPDATE ${sql(TABLE)}
    SET geom = ST_SetSRID(ST_GeomFromGeoJSON(geometry::text), 4326)
    WHERE zone_row_id > ${lo}
      AND zone_row_id <= ${hi}
      AND geom IS NULL
      AND geometry IS NOT NULL`;
  return res.count;
}

/** Row-by-row fallback for a range whose set-based UPDATE threw. */
async function updateRangeRowwise(lo, hi) {
  const ids = await sql`
    SELECT zone_row_id
    FROM ${sql(TABLE)}
    WHERE zone_row_id > ${lo} AND zone_row_id <= ${hi} AND geom IS NULL AND geometry IS NOT NULL
    ORDER BY zone_row_id`;
  let updated = 0;
  const failures = [];
  for (const { zone_row_id: id } of ids) {
    try {
      const r = await sql`
        UPDATE ${sql(TABLE)}
        SET geom = ST_SetSRID(ST_GeomFromGeoJSON(geometry::text), 4326)
        WHERE zone_row_id = ${id} AND geom IS NULL`;
      updated += r.count;
    } catch (err) {
      failures.push({ zoneRowId: id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { updated, failures };
}

try {
  const [{ reg }] = await sql`SELECT to_regclass(${`public.${TABLE}`}) AS reg`;
  if (reg == null) {
    console.error(`FATAL: ${TABLE} does not exist.`);
    process.exit(1);
  }
  const [geomCol] = await sql`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${TABLE} AND column_name = 'geom'`;
  if (!geomCol) {
    console.error("FATAL: geom column absent. Run apply-tx-fema-nfhl-geom.mjs first.");
    process.exit(1);
  }

  const [before] = await sql`
    SELECT count(*)::int AS rows_total,
           count(geom)::int AS geom_populated,
           count(CASE WHEN geom IS NULL AND geometry IS NOT NULL THEN 1 END)::int AS pending
    FROM ${sql(TABLE)}`;

  if (!APPLY) {
    console.log(
      JSON.stringify(
        {
          event: "tx-fema-nfhl-geom.populate-skipped",
          reason: "F1_NFHL_GEOM_POPULATE!=1",
          batchSize: BATCH_SIZE,
          ...before,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  const startedAt = Date.now();
  const batches = [];
  const failures = [];
  let updatedTotal = 0;
  // Text PK ordering; the empty string sorts before every real id.
  let cursor = "";

  for (;;) {
    const [bound] = await sql`
      SELECT max(zone_row_id) AS hi
      FROM (
        SELECT zone_row_id
        FROM ${sql(TABLE)}
        WHERE zone_row_id > ${cursor}
        ORDER BY zone_row_id
        LIMIT ${BATCH_SIZE}
      ) s`;
    const hi = bound?.hi;
    if (hi == null) break;

    const batchStart = Date.now();
    let updated;
    let mode = "set";
    try {
      updated = await updateRange(cursor, hi);
    } catch (err) {
      mode = "rowwise";
      console.error(
        JSON.stringify({
          event: "tx-fema-nfhl-geom.batch-fallback",
          lo: cursor,
          hi,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      const fb = await updateRangeRowwise(cursor, hi);
      updated = fb.updated;
      failures.push(...fb.failures);
    }

    updatedTotal += updated;
    const batch = { lo: cursor, hi, mode, updated, wallMs: Date.now() - batchStart };
    batches.push(batch);
    console.log(JSON.stringify({ event: "tx-fema-nfhl-geom.batch", ...batch, updatedTotal }));
    cursor = hi;
  }

  await sql.unsafe(`ANALYZE ${TABLE}`);

  const [after] = await sql`
    SELECT count(*)::int AS rows_total,
           count(geom)::int AS geom_populated,
           count(CASE WHEN geom IS NULL AND geometry IS NOT NULL THEN 1 END)::int AS pending
    FROM ${sql(TABLE)}`;
  const byType = await sql`
    SELECT GeometryType(geom) AS geom_type, count(*)::int AS n
    FROM ${sql(TABLE)}
    WHERE geom IS NOT NULL
    GROUP BY 1
    ORDER BY 2 DESC`;

  console.log(
    JSON.stringify(
      {
        event: "tx-fema-nfhl-geom.populate-complete",
        batchSize: BATCH_SIZE,
        batches: batches.length,
        updatedTotal,
        before,
        after,
        geomTypeHistogram: byType,
        failureCount: failures.length,
        failures: failures.slice(0, 20),
        wallMs: Date.now() - startedAt,
      },
      null,
      2,
    ),
  );
} finally {
  await sql.end({ timeout: 10 });
}
