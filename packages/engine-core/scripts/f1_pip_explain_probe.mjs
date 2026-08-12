#!/usr/bin/env node
/**
 * f1_pip_explain_probe.mjs — EXPLAIN ANALYZE the PostGIS PIP batch shape.
 *
 * Read-only. Pulls N real parcel centroids for a county and runs the writer's
 * own contains query under EXPLAIN (ANALYZE, BUFFERS) so a bad plan (seq scan
 * per point) is visible instead of inferred from a long wall time.
 *
 *   node scripts/f1_pip_explain_probe.mjs --county=48099 --points=200
 */

import postgres from "postgres";

import {
  containsSql,
  zoneMajorContainsSql,
} from "../src/flood-hazard-fact/postgis-flood-plan.ts";
import { geometryCentroid } from "../src/flood-hazard-fact/geo.ts";

function arg(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const county = String(arg("county", "48099"));
const points = Number(arg("points", 200));
const shape = String(arg("shape", "point"));

const url =
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.DEPLOYMENT_DATABASE_URL?.trim();
if (!url) {
  console.error("FATAL: CORTEX_DATABASE_URL required.");
  process.exit(1);
}

const sql = postgres(url, { max: 2, ssl: "require", prepare: false });

try {
  const rows = await sql`
    SELECT DISTINCT ON (feature_index) feature_index, geometry,
           west_lng, south_lat, east_lng, north_lat
    FROM txgio_parcel
    WHERE county_fips = ${county}
    ORDER BY feature_index
    LIMIT ${points}
  `;

  const ords = [];
  const lngs = [];
  const lats = [];
  for (const r of rows) {
    const c =
      geometryCentroid(r.geometry) ??
      [
        (Number(r.west_lng) + Number(r.east_lng)) / 2,
        (Number(r.south_lat) + Number(r.north_lat)) / 2,
      ];
    if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    ords.push(ords.length);
    lngs.push(c[0]);
    lats.push(c[1]);
  }

  let text = containsSql();
  let params = [ords, lngs, lats];
  if (shape === "zone") {
    const [bbox] = await sql`
      SELECT min(west_lng)::float8 AS w, min(south_lat)::float8 AS s,
             max(east_lng)::float8 AS e, max(north_lat)::float8 AS n
      FROM txgio_parcel WHERE county_fips = ${county}
    `;
    text = zoneMajorContainsSql();
    params = [
      ords,
      lngs,
      lats,
      Number(bbox.w) - 0.02,
      Number(bbox.s) - 0.02,
      Number(bbox.e) + 0.02,
      Number(bbox.n) + 0.02,
    ];
  }

  const t0 = Date.now();
  const plan = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS) ${text}`, params);
  const explainMs = Date.now() - t0;

  const t1 = Date.now();
  const result = await sql.unsafe(text, params);
  const runMs = Date.now() - t1;

  const hits = result.filter((r) => r.zone_row_id != null).length;
  console.log(
    JSON.stringify(
      {
        event: "flood-pip.explain",
        county,
        shape,
        points: ords.length,
        explainMs,
        runMs,
        msPerPoint: Number((runMs / Math.max(1, ords.length)).toFixed(3)),
        hits,
      },
      null,
      2,
    ),
  );
  for (const line of plan) console.log(line["QUERY PLAN"]);
} finally {
  await sql.end({ timeout: 5 });
}
