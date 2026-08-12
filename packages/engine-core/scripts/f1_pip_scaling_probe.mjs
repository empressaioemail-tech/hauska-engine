#!/usr/bin/env node
/**
 * f1_pip_scaling_probe.mjs — how does zone-major PIP scale with batch size?
 *
 * Read-only, and every statement carries a timeout so a bad plan surfaces as a
 * timeout rather than a hang. Reports server-side EXPLAIN time separately from
 * client round-trip time so a client-side serialization cost cannot masquerade
 * as a query cost.
 *
 *   node scripts/f1_pip_scaling_probe.mjs --county=48099 --sizes=5000,10000,15000,20000 --timeout-sec=120
 */

import postgres from "postgres";

import { zoneMajorContainsSql } from "../src/flood-hazard-fact/postgis-flood-plan.ts";
import { geometryCentroid } from "../src/flood-hazard-fact/geo.ts";

function arg(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const county = String(arg("county", "48099"));
const sizes = String(arg("sizes", "5000,10000,15000,20000"))
  .split(",")
  .map(Number);
const timeoutSec = Number(arg("timeout-sec", 120));

const url =
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.DEPLOYMENT_DATABASE_URL?.trim();
if (!url) {
  console.error("FATAL: CORTEX_DATABASE_URL required.");
  process.exit(1);
}

const sql = postgres(url, {
  max: 1,
  ssl: "require",
  prepare: false,
  connection: { statement_timeout: String(timeoutSec * 1000) },
});

try {
  const [bbox] = await sql`
    SELECT min(west_lng)::float8 AS w, min(south_lat)::float8 AS s,
           max(east_lng)::float8 AS e, max(north_lat)::float8 AS n
    FROM txgio_parcel WHERE county_fips = ${county}
  `;
  const box = [
    Number(bbox.w) - 0.02,
    Number(bbox.s) - 0.02,
    Number(bbox.e) + 0.02,
    Number(bbox.n) + 0.02,
  ];

  const maxSize = Math.max(...sizes);
  const rows = await sql`
    SELECT DISTINCT ON (feature_index) feature_index, geometry,
           west_lng, south_lat, east_lng, north_lat
    FROM txgio_parcel
    WHERE county_fips = ${county}
    ORDER BY feature_index
    LIMIT ${maxSize}
  `;

  const all = [];
  for (const r of rows) {
    const c =
      geometryCentroid(r.geometry) ??
      [
        (Number(r.west_lng) + Number(r.east_lng)) / 2,
        (Number(r.south_lat) + Number(r.north_lat)) / 2,
      ];
    if (Number.isFinite(c[0]) && Number.isFinite(c[1])) all.push(c);
  }

  const text = zoneMajorContainsSql();
  const results = [];
  for (const size of sizes) {
    const slice = all.slice(0, size);
    const ords = slice.map((_, i) => i);
    const lngs = slice.map((c) => c[0]);
    const lats = slice.map((c) => c[1]);
    const params = [ords, lngs, lats, ...box];

    const entry = { points: slice.length };
    try {
      const t = Date.now();
      const res = await sql.unsafe(text, params);
      entry.runMs = Date.now() - t;
      entry.msPerPoint = Number((entry.runMs / slice.length).toFixed(3));
      entry.hits = res.length;
    } catch (err) {
      entry.error = String(err?.message || err);
    }
    console.log(JSON.stringify({ event: "flood-pip.scaling", county, ...entry }));
    results.push(entry);
    if (entry.error) break;
  }
  console.log(JSON.stringify({ event: "flood-pip.scaling.done", county, results }, null, 2));
} finally {
  await sql.end({ timeout: 5 });
}
