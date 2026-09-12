#!/usr/bin/env node
/**
 * retag-building-footprint-county.mjs — one-shot, idempotent county_fips
 * correction for `tx_building_footprint` (OPS-23 P-158 phase 3).
 *
 * FINDING (phase 2 close, _inbox/2026-09-12_p158-footprint_close.json):
 * tx_building_footprint.county_fips was assigned by a coarse (likely
 * bounding-box) method at staging time and is wrong near county lines --
 * confirmed 29.6% correctly tagged inside Bastrop city limits (the rest
 * attributed to Lee 48287 or Caldwell 48055) and 0% correctly tagged for
 * West Lake Hills' footprints inside Travis County (100% attributed to Hays
 * 48209 instead). Neither anchor parcel is a source gap: the nearest true
 * footprint to 48021:34049 is 1.63m away (tagged 48287); the nearest to
 * 48453:113408 has distance 0 -- it contains the record point (tagged
 * 48209). This job fixes the TAG, not the geometry.
 *
 * METHOD (closed; do not invent a second): PRIMARY = the footprint's own
 * centroid tested by ST_Contains against each county polygon in
 * tx_county_boundary, using the existing GiST index on
 * tx_building_footprint.geom (the `&&` bbox operator) as the candidate
 * prefilter -- an indexed per-county join, not a 10.6M x 254 cross product.
 * A centroid is contained by at most one of the (non-overlapping) county
 * polygons, so the primary pass is deterministic. This is the same class of
 * method hauska-factory's `landing_parcel_jurisdiction` job already applies
 * on the parcel side (src/jobs/p2-juris-store.mjs CHUNK_GEOMETRY_SQL: ring
 * method, ST_Covers / ST_Intersection). FALLBACK = for the residual rows
 * whose centroid lands inside NO county polygon (a boundary sliver/gap or a
 * degenerate ring), the county with the LARGEST overlap AREA
 * (ST_Area(ST_Intersection(fp.geom, county.geom))) among counties whose
 * bbox intersects the footprint's bbox. The fallback only ever considers
 * rows the primary pass left untouched; it never re-decides a row the
 * primary pass already resolved.
 *
 * IDEMPOTENT: every UPDATE is `... WHERE county_fips IS DISTINCT FROM
 * <computed>`, so a row already carrying its correct tag is never rewritten
 * and a second run of this job is a no-op everywhere the first run
 * succeeded. Never sets a value it cannot support with a real containment
 * or overlap test; a row with no candidate at all (should not occur --
 * every Texas footprint's centroid falls in exactly one of the 254 TX
 * counties or fails the fallback's own bbox prefilter, which is reported,
 * never silently skipped) is counted and named, never guessed at.
 *
 * The pure SQL/CLI helpers live in retag-building-footprint-county-lib.mjs
 * (no `postgres` import, no top-level side effect) so they can be unit
 * tested by direct import; this file adds the `postgres` connection and the
 * top-level `main()` execution, and is exercised via spawnSync like every
 * other county writer script in this directory (writer-apply-lease.test.mjs
 * is the existing pattern), never imported directly into a test process.
 *
 *   RETAG_BUILDING_FOOTPRINT_COUNTY_PATH=1 \
 *   CORTEX_DATABASE_URL=... \
 *     pnpm --filter @hauska-engine/engine-core run retag-building-footprint-county -- \
 *       [--target=staging|production] [--apply] [--county=48021,48453] \
 *       [--skip-fallback] [--out=path.json]
 *
 * DRY RUN IS THE DEFAULT: reports candidates / would_retag per driving
 * county with no write. --apply requires CLOUD_RUN_JOB (the Cloud Run Jobs
 * platform's own environment marker -- never a caller-supplied flag); a
 * laptop --apply refuses LAPTOP_WRITE_FROZEN before opening any connection,
 * same mechanism P-169 wired into write-building-footprint-county.mjs
 * (packages/engine-core/scripts/writer-apply-lease.mjs
 * refuseApplyOutsideCloudRunJob), 2026-09-12 ruling
 * (_decisions/2026-09-12_loaders_get_cloud_jobs_no_break_glass.md).
 *
 * --county scopes which county POLYGONS drive the primary pass (default:
 * all 254 rows in tx_county_boundary, state_fips='48' -- the real one-shot
 * statewide job). A scoped run (e.g. --county=48021,48453) only DISCOVERS
 * rows whose true county is in the given list -- it is a safe, bounded
 * proof pass for named counties, not a partial statewide fix; a full
 * unscoped run is what "one-shot job... for every row" in the mission
 * means, and --skip-fallback is only for a scoped proof pass, since the
 * fallback needs the full county roster to find a straddling row's true
 * largest-overlap county.
 */

import postgres from "postgres";

import { refuseApplyOutsideCloudRunJob } from "./writer-apply-lease.mjs";
import {
  BOUNDARY_TABLE,
  RESIDUAL_UNRESOLVED_ROWS_SQL,
  RESIDUAL_UNRESOLVED_SQL,
  TABLE,
  fallbackLargestOverlapSql,
  parseCountyList,
  primaryCountSql,
  primaryRetagSql,
  resolveRetagSourceUrl,
} from "./retag-building-footprint-county-lib.mjs";

function parseArgs(argv) {
  const out = {
    apply: false,
    target: null,
    county: null,
    skipFallback: false,
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--target") out.target = String(argv[++i] || "").trim();
    else if (a.startsWith("--target=")) out.target = a.slice("--target=".length).trim();
    else if (a === "--county") out.county = String(argv[++i] || "").trim();
    else if (a.startsWith("--county=")) out.county = a.slice("--county=".length).trim();
    else if (a === "--skip-fallback") out.skipFallback = true;
    else if (a === "--out") out.out = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length).trim() || null;
  }
  return out;
}

function log(event, extra = {}) {
  console.log(JSON.stringify({ event, ...extra }));
}

function refuse(code, message, detail = {}) {
  console.error(JSON.stringify({ event: "retag-building-footprint-county.refused", code, message, ...detail }));
  process.exitCode = 2;
}

async function main() {
  if (process.env.RETAG_BUILDING_FOOTPRINT_COUNTY_PATH !== "1") {
    refuse("PATH_GUARD", "RETAG_BUILDING_FOOTPRINT_COUNTY_PATH=1 required (guards against accidental invocation).");
    return;
  }

  const args = parseArgs(process.argv.slice(2));

  if (refuseApplyOutsideCloudRunJob("retag-building-footprint-county.refused", args.apply)) {
    process.exitCode = 2;
    return;
  }

  let cortexUrl;
  if (args.target) {
    try {
      cortexUrl = resolveRetagSourceUrl(process.env, args.target);
    } catch (err) {
      refuse(err.code || "TARGET_ENV_MISSING", err.message, { target: args.target });
      return;
    }
  } else {
    cortexUrl =
      process.env.CORTEX_DATABASE_URL?.trim() ||
      process.env.TXGIO_DATABASE_URL?.trim() ||
      process.env.DATABASE_URL?.trim();
  }
  if (!cortexUrl) {
    refuse("CORTEX_URL_REQUIRED", "CORTEX_DATABASE_URL (or --target=staging|production) required -- the store holding tx_building_footprint / tx_county_boundary.");
    return;
  }

  const sql = postgres(cortexUrl, { max: 4, ssl: "require", prepare: false });

  try {
    const requestedCounties = parseCountyList(args.county);
    const roster = requestedCounties
      ? requestedCounties.map((c) => ({ county_fips: c }))
      : await sql`SELECT county_fips, county_name FROM ${sql(BOUNDARY_TABLE)} WHERE state_fips = '48' ORDER BY county_fips`;

    log("retag-building-footprint-county.start", {
      target: args.target,
      apply: args.apply,
      scoped: Boolean(requestedCounties),
      countiesToProcess: roster.length,
    });

    const perCounty = [];
    let totalExamined = 0;
    let totalRetagged = 0;

    for (const row of roster) {
      const countyFips = row.county_fips;
      const countQ = primaryCountSql(countyFips);
      const before = await sql.unsafe(countQ.text, countQ.values);
      const trueCount = Number(before[0]?.true_count ?? 0);
      const alreadyCorrect = Number(before[0]?.already_correct ?? 0);
      const currentlyTagged = Number(before[0]?.currently_tagged ?? 0);
      const wouldRetag = trueCount - alreadyCorrect;

      let retagged = 0;
      if (args.apply && wouldRetag > 0) {
        const upd = primaryRetagSql(countyFips);
        const result = await sql.unsafe(upd.text, upd.values);
        retagged = Array.isArray(result) ? result.length : Number(result?.count ?? 0);
      }

      totalExamined += trueCount;
      totalRetagged += retagged;

      const afterTagged = args.apply ? currentlyTagged + retagged : currentlyTagged;
      perCounty.push({
        county_fips: countyFips,
        true_geometric_count: trueCount,
        currently_tagged_before: currentlyTagged,
        already_correct_before: alreadyCorrect,
        would_retag: wouldRetag,
        retagged: args.apply ? retagged : null,
        currently_tagged_after: args.apply ? afterTagged : null,
      });

      log("retag-building-footprint-county.county-progress", {
        county_fips: countyFips,
        true_geometric_count: trueCount,
        currently_tagged_before: currentlyTagged,
        would_retag: wouldRetag,
        retagged: args.apply ? retagged : null,
      });
    }

    let fallback = { ran: false, residualUnresolved: null, resolved: 0 };
    if (!args.skipFallback && !requestedCounties) {
      const residual = await sql.unsafe(RESIDUAL_UNRESOLVED_SQL);
      const residualN = Number(residual[0]?.n ?? 0);
      fallback.ran = true;
      fallback.residualUnresolved = residualN;
      if (residualN > 0) {
        const rows = await sql.unsafe(RESIDUAL_UNRESOLVED_ROWS_SQL);
        for (const r of rows) {
          const pick = fallbackLargestOverlapSql(r.footprint_row_id);
          const best = await sql.unsafe(pick.text, pick.values);
          const bestCounty = best[0]?.county_fips ?? null;
          if (bestCounty && args.apply) {
            await sql`UPDATE ${sql(TABLE)} SET county_fips = ${bestCounty} WHERE footprint_row_id = ${r.footprint_row_id}`;
            fallback.resolved += 1;
          } else if (bestCounty) {
            fallback.resolved += 1;
          }
        }
      }
      log("retag-building-footprint-county.fallback", fallback);
    }

    const summary = {
      event: "retag-building-footprint-county.summary",
      target: args.target,
      apply: args.apply,
      scoped: Boolean(requestedCounties),
      countiesProcessed: roster.length,
      rowsExaminedTrueGeometric: totalExamined,
      rowsRetagged: args.apply ? totalRetagged : null,
      rowsWouldRetagIfApplied: args.apply ? null : perCounty.reduce((a, c) => a + c.would_retag, 0),
      fallback,
      perCounty,
    };
    log("retag-building-footprint-county.summary", summary);

    if (args.out) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(args.out, JSON.stringify(summary, null, 2));
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ event: "retag-building-footprint-county.fatal", message: err.message, code: err.code }));
  process.exitCode = 1;
});
