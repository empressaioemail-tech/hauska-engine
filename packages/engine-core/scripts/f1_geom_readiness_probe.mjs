#!/usr/bin/env node
/**
 * f1_geom_readiness_probe.mjs — is the PostGIS flood plan path available yet?
 *
 * Read-only. Polls `probeFloodZoneGeomReadiness` until the geom column is
 * populated on every row behind a GiST index, or the deadline passes.
 *
 *   node scripts/f1_geom_readiness_probe.mjs [--wait-sec=1200] [--interval-sec=30]
 */

import postgres from "postgres";

import { probeFloodZoneGeomReadiness } from "../src/flood-hazard-fact/postgis-flood-plan.ts";

function arg(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.slice(name.length + 3)) : fallback;
}

const waitSec = arg("wait-sec", 0);
const intervalSec = Math.max(5, arg("interval-sec", 30));

const url =
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.DEPLOYMENT_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("FATAL: CORTEX_DATABASE_URL or DEPLOYMENT_DATABASE_URL required.");
  process.exit(1);
}

const sql = postgres(url, { max: 1, ssl: "require", prepare: false });
const deadline = Date.now() + waitSec * 1000;

try {
  for (;;) {
    const readiness = await probeFloodZoneGeomReadiness(sql);
    console.log(
      JSON.stringify({
        event: "flood-geom.readiness",
        at: new Date().toISOString(),
        ...readiness,
      }),
    );
    if (readiness.ready || Date.now() >= deadline) {
      process.exitCode = readiness.ready ? 0 : 2;
      break;
    }
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
} finally {
  await sql.end({ timeout: 5 });
}
