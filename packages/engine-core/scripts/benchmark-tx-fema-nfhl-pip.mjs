#!/usr/bin/env node
/**
 * benchmark-tx-fema-nfhl-pip.mjs — SELECT-only benchmark proving the
 * tx_fema_nfhl_flood_zone GiST index serves point-in-polygon, and measuring what
 * it actually costs.
 *
 * Measurements:
 *   1. Single-point ST_Contains — EXPLAIN ANALYZE, expects an index scan on
 *      tx_fema_nfhl_flood_zone_geom_gist_idx.
 *   2. County-envelope candidate window (ST_Intersects) — the shape the writer's
 *      plan phase uses to pull candidate zones.
 *   3. Batched PIP over N parcel centroids via LATERAL join — EXPLAIN ANALYZE plus
 *      a separate wall-clock run.
 *   4. Optional (F1_NFHL_BENCH_SUBDIVIDE=1) ST_Subdivide comparison.
 *
 * The subdivide leg exists because the index is not the whole cost. The GiST
 * index locates candidate zones in under a millisecond, but ST_Contains must then
 * detoast and run GEOS over the candidate MultiPolygon, and this corpus is wildly
 * skewed: median 81 vertices, p99 15352, maximum 1372407, largest single geometry
 * 21 MB, 3428 MB of geometry in total. Subdividing into a session-scoped temp
 * table isolates that second cost without touching the shared schema.
 *
 * Parcel centroids come from txgio_parcel's bbox columns (that table has no
 * geometry column), so this measures the flood-zone index rather than a second
 * unrelated geometry path.
 *
 * Read-only against the shared schema. No DDL, no writes, no atoms.
 */

import postgres from "postgres";

const TABLE = "tx_fema_nfhl_flood_zone";
const GIST_INDEX = "tx_fema_nfhl_flood_zone_geom_gist_idx";
const COUNTY_FIPS = process.env.F1_NFHL_BENCH_COUNTY ?? "48099";
const POINTS = Number.parseInt(process.env.F1_NFHL_BENCH_POINTS ?? "1000", 10);
const SUBDIVIDE_MAX_VERTICES = Number.parseInt(
  process.env.F1_NFHL_BENCH_SUBDIVIDE_VERTICES ?? "256",
  10,
);

const poolUrl =
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.DEPLOYMENT_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();

if (!poolUrl) {
  console.error("FATAL: CORTEX_DATABASE_URL or DEPLOYMENT_DATABASE_URL required.");
  process.exit(1);
}

const sql = postgres(poolUrl, { max: 1, ssl: "require", prepare: false });
const planText = (rows) => rows.map((r) => r["QUERY PLAN"]).join("\n");

try {
  const [{ v: postgisVersion }] = await sql`SELECT PostGIS_Version() AS v`;
  const [counts] = await sql`
    SELECT count(*)::int AS rows_total, count(geom)::int AS geom_populated
    FROM ${sql(TABLE)}`;

  const [bbox] = await sql`
    SELECT min(west_lng) AS west, min(south_lat) AS south,
           max(east_lng) AS east, max(north_lat) AS north
    FROM txgio_parcel
    WHERE county_fips = ${COUNTY_FIPS}`;

  const centroids = await sql`
    SELECT (west_lng + east_lng) / 2.0 AS lng, (south_lat + north_lat) / 2.0 AS lat
    FROM txgio_parcel
    WHERE county_fips = ${COUNTY_FIPS}
      AND west_lng IS NOT NULL AND east_lng IS NOT NULL
      AND south_lat IS NOT NULL AND north_lat IS NOT NULL
    LIMIT ${POINTS}`;
  const lngs = centroids.map((r) => Number(r.lng));
  const lats = centroids.map((r) => Number(r.lat));

  const singlePlan = await sql`
    EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
    SELECT z.zone_row_id, z.fld_zone, z.sfha_tf
    FROM ${sql(TABLE)} z
    WHERE ST_Contains(z.geom, ST_SetSRID(ST_MakePoint(${lngs[0]}, ${lats[0]}), 4326))`;

  const bboxPlan = await sql`
    EXPLAIN (ANALYZE, BUFFERS)
    SELECT count(*)
    FROM ${sql(TABLE)} z
    WHERE ST_Intersects(
      z.geom,
      ST_MakeEnvelope(${bbox.west}, ${bbox.south}, ${bbox.east}, ${bbox.north}, 4326))`;

  const batchPlan = await sql`
    EXPLAIN (ANALYZE, BUFFERS)
    SELECT p.ord, z.fld_zone, z.sfha_tf
    FROM unnest(${lngs}::float8[], ${lats}::float8[]) WITH ORDINALITY AS p(lng, lat, ord)
    LEFT JOIN LATERAL (
      SELECT z2.fld_zone, z2.sfha_tf
      FROM ${sql(TABLE)} z2
      WHERE ST_Contains(z2.geom, ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326))
      LIMIT 1
    ) z ON true`;

  const t0 = Date.now();
  const batchRows = await sql`
    SELECT p.ord, z.fld_zone, z.sfha_tf
    FROM unnest(${lngs}::float8[], ${lats}::float8[]) WITH ORDINALITY AS p(lng, lat, ord)
    LEFT JOIN LATERAL (
      SELECT z2.fld_zone, z2.sfha_tf
      FROM ${sql(TABLE)} z2
      WHERE ST_Contains(z2.geom, ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326))
      LIMIT 1
    ) z ON true`;
  const pipBenchmarkMs = Date.now() - t0;

  let subdivide = null;
  if (process.env.F1_NFHL_BENCH_SUBDIVIDE === "1") {
    const sub0 = Date.now();
    await sql`CREATE TEMP TABLE IF NOT EXISTS nfhl_sub (
      zone_row_id text, fld_zone text, sfha_tf text, geom geometry(Geometry, 4326))`;
    await sql`TRUNCATE nfhl_sub`;
    await sql`
      INSERT INTO nfhl_sub (zone_row_id, fld_zone, sfha_tf, geom)
      SELECT z.zone_row_id, z.fld_zone, z.sfha_tf,
             ST_Subdivide(z.geom, ${SUBDIVIDE_MAX_VERTICES})
      FROM ${sql(TABLE)} z
      WHERE ST_Intersects(
        z.geom,
        ST_MakeEnvelope(${bbox.west}, ${bbox.south}, ${bbox.east}, ${bbox.north}, 4326))`;
    await sql`CREATE INDEX ON nfhl_sub USING GIST (geom)`;
    await sql`ANALYZE nfhl_sub`;
    const buildMs = Date.now() - sub0;
    const [{ n: pieces }] = await sql`SELECT count(*)::int AS n FROM nfhl_sub`;
    const [{ n: sourceZones }] =
      await sql`SELECT count(DISTINCT zone_row_id)::int AS n FROM nfhl_sub`;

    const t1 = Date.now();
    const subRows = await sql`
      SELECT p.ord, z.fld_zone, z.sfha_tf
      FROM unnest(${lngs}::float8[], ${lats}::float8[]) WITH ORDINALITY AS p(lng, lat, ord)
      LEFT JOIN LATERAL (
        SELECT z2.fld_zone, z2.sfha_tf
        FROM nfhl_sub z2
        WHERE ST_Contains(z2.geom, ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326))
        LIMIT 1
      ) z ON true`;
    const subPipMs = Date.now() - t1;
    subdivide = {
      maxVertices: SUBDIVIDE_MAX_VERTICES,
      buildMs,
      pieces,
      sourceZones,
      pipMs: subPipMs,
      msPerPoint: lngs.length ? subPipMs / lngs.length : null,
      matchedPoints: subRows.filter((r) => r.fld_zone != null).length,
      sfhaPoints: subRows.filter((r) => r.sfha_tf === "T").length,
    };
  }

  const plans = {
    singlePoint: planText(singlePlan),
    countyBbox: planText(bboxPlan),
    batchedLateral: planText(batchPlan),
  };
  const usesGist = Object.fromEntries(
    Object.entries(plans).map(([k, v]) => [k, v.includes(GIST_INDEX)]),
  );

  console.log(
    JSON.stringify(
      {
        event: "tx-fema-nfhl-pip.benchmark",
        postgisVersion,
        countyFips: COUNTY_FIPS,
        rowsTotal: counts.rows_total,
        geomPopulated: counts.geom_populated,
        countyBbox: bbox,
        pipBenchmarkPoints: lngs.length,
        pipBenchmarkMs,
        pipMsPerPoint: lngs.length ? pipBenchmarkMs / lngs.length : null,
        matchedPoints: batchRows.filter((r) => r.fld_zone != null).length,
        sfhaPoints: batchRows.filter((r) => r.sfha_tf === "T").length,
        gistIndexUsed: Object.values(usesGist).every(Boolean),
        gistIndexUsedByQuery: usesGist,
        subdivide,
        plans,
      },
      null,
      2,
    ),
  );
} finally {
  await sql.end({ timeout: 10 });
}
