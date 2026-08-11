#!/usr/bin/env node
/**
 * One-shot county join: materialize 254 county bboxes once, then batch-update wells.
 */
import postgres from "postgres";

const poolUrl = process.env.DEPLOYMENT_DATABASE_URL?.trim();
if (!poolUrl) process.exit(1);

const sql = postgres(poolUrl, { max: 1, ssl: "require", prepare: false });
const t0 = Date.now();

try {
  await sql`
    CREATE TABLE IF NOT EXISTS tx_county_bbox (
      county_fips text PRIMARY KEY,
      west_lng double precision NOT NULL,
      south_lat double precision NOT NULL,
      east_lng double precision NOT NULL,
      north_lat double precision NOT NULL
    )
  `;
  await sql`DELETE FROM tx_county_bbox`;
  await sql`
    INSERT INTO tx_county_bbox (county_fips, west_lng, south_lat, east_lng, north_lat)
    SELECT county_fips,
           min(west_lng)::float8,
           min(south_lat)::float8,
           max(east_lng)::float8,
           max(north_lat)::float8
    FROM txgio_parcel
    GROUP BY county_fips
  `;
  const bboxCount = await sql`SELECT count(*)::int AS n FROM tx_county_bbox`;
  console.error(JSON.stringify({ event: "county-bbox-built", counties: bboxCount[0]?.n }));

  let total = 0;
  while (true) {
    const updated = await sql`
      WITH batch AS (
        SELECT well_row_id, lng, lat
        FROM tx_rrc_well
        WHERE county_fips IS NULL
        LIMIT 20000
      ),
      picked AS (
        SELECT DISTINCT ON (b.well_row_id)
          b.well_row_id,
          c.county_fips
        FROM batch b
        INNER JOIN tx_county_bbox c ON
          b.lng >= c.west_lng AND b.lng <= c.east_lng
          AND b.lat >= c.south_lat AND b.lat <= c.north_lat
        ORDER BY
          b.well_row_id,
          (c.east_lng - c.west_lng) * (c.north_lat - c.south_lat)
      )
      UPDATE tx_rrc_well w
      SET county_fips = p.county_fips
      FROM picked p
      WHERE w.well_row_id = p.well_row_id
      RETURNING w.well_row_id
    `;
    if (updated.length === 0) break;
    total += updated.length;
    console.error(JSON.stringify({ event: "county-bbox-join", total, batch: updated.length }));
  }

  const stats = await sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE county_fips IS NOT NULL)::int AS with_county,
      count(*) FILTER (WHERE county_fips IS NULL)::int AS null_county
    FROM tx_rrc_well
  `;

  console.log(
    JSON.stringify({
      event: "county-bbox-join.done",
      totalUpdated: total,
      stats: stats[0],
      elapsedMs: Date.now() - t0,
      method:
        "tx_county_bbox materialized from txgio_parcel; smallest county bbox wins per well",
    }),
  );
} finally {
  await sql.end({ timeout: 5 });
}
