#!/usr/bin/env node
/**
 * f1_pip_shape_bench.mjs — point-major vs zone-major PIP, same verdicts.
 *
 * Read-only. The point-major LATERAL (one GiST probe per centroid) is
 * index-correct but pays a detoast of every candidate NFHL mega-polygon on
 * EVERY point: 305k shared buffers for 100 points on 48099. The zone-major
 * shape drives the loop from the zone side, so each polygon is detoasted and
 * GEOS-prepared once per batch and the per-point cost collapses to a bbox
 * comparison plus a prepared-geometry hit.
 *
 *   node scripts/f1_pip_shape_bench.mjs --county=48099 --points=2000
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
const points = Number(arg("points", 2000));
const shapes = String(arg("shapes", "point,zone")).split(",");

const url =
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.DEPLOYMENT_DATABASE_URL?.trim();
if (!url) {
  console.error("FATAL: CORTEX_DATABASE_URL required.");
  process.exit(1);
}

const sql = postgres(url, { max: 2, ssl: "require", prepare: false });

try {
  const [bbox] = await sql`
    SELECT min(west_lng)::float8 AS w, min(south_lat)::float8 AS s,
           max(east_lng)::float8 AS e, max(north_lat)::float8 AS n
    FROM txgio_parcel WHERE county_fips = ${county}
  `;
  const pad = 0.02;
  const west = Number(bbox.w) - pad;
  const south = Number(bbox.s) - pad;
  const east = Number(bbox.e) + pad;
  const north = Number(bbox.n) + pad;

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

  const out = { event: "flood-pip.shape-bench", county, points: ords.length, shapes: {} };

  if (shapes.includes("point")) {
    const t = Date.now();
    const res = await sql.unsafe(containsSql(), [ords, lngs, lats]);
    const ms = Date.now() - t;
    out.shapes.pointMajor = {
      ms,
      msPerPoint: Number((ms / ords.length).toFixed(3)),
      hits: res.filter((r) => r.zone_row_id != null).length,
      digest: digest(res),
    };
  }

  if (shapes.includes("zone")) {
    const t = Date.now();
    const res = await sql.unsafe(zoneMajorContainsSql(), [
      ords,
      lngs,
      lats,
      west,
      south,
      east,
      north,
    ]);
    const ms = Date.now() - t;
    out.shapes.zoneMajor = {
      ms,
      msPerPoint: Number((ms / ords.length).toFixed(3)),
      hits: res.length,
      digest: digest(res),
    };
  }

  if (out.shapes.pointMajor && out.shapes.zoneMajor) {
    out.identical = out.shapes.pointMajor.digest === out.shapes.zoneMajor.digest;
    out.speedup = Number(
      (out.shapes.pointMajor.ms / out.shapes.zoneMajor.ms).toFixed(2),
    );
  }

  console.log(JSON.stringify(out, null, 2));
} finally {
  await sql.end({ timeout: 5 });
}

/** Order-independent fingerprint of the (ord -> zone) resolution. */
function digest(rows) {
  const lines = rows
    .filter((r) => r.zone_row_id != null)
    .map((r) => `${r.ord}|${r.zone_row_id}|${r.fld_zone}|${r.sfha_tf}`)
    .sort();
  return `${lines.length}:${hash(lines.join("\n"))}`;
}

function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}
