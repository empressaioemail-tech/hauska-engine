#!/usr/bin/env node
/**
 * backfill-geom-bbox.mjs — populate atoms_geom_bbox for road-node /
 * building-footprint atoms (see migration 012_geom_near_bbox_perf.sql).
 *
 * Batched, keyset-paginated (ORDER BY atom_did, cursor = last atom_did
 * seen) so no single statement scans the whole entity type at once.
 * Idempotent (ON CONFLICT DO UPDATE) — safe to interrupt and re-run from
 * the beginning, or resume from a specific atom_did with --resume-from.
 * Does not touch the atoms table itself, only the new side table.
 *
 *   DATABASE_URL=... node packages/storage/scripts/backfill-geom-bbox.mjs \
 *     --entity-type=road-node [--batch=2000] [--resume-from=<atom_did>] \
 *     [--county-fips=48055]
 *
 * --county-fips narrows the atom_did prefix range to one county (both
 * road-node and building-footprint atom_dids embed the county fips right
 * after the entity type: did:hauska:road-node:<fips>:road:<id>,
 * did:hauska:building-footprint:<fips>:<propId>) -- a targeted, fast
 * pass for verifying/unblocking specific counties without waiting on a
 * full nationwide backfill.
 */

import postgres from "postgres";

function parseArgs(argv) {
  const out = { entityType: null, batch: 10000, resumeFrom: null, countyFips: null };
  for (const a of argv) {
    if (a.startsWith("--entity-type=")) out.entityType = a.slice("--entity-type=".length);
    else if (a.startsWith("--batch=")) out.batch = Number(a.slice("--batch=".length));
    else if (a.startsWith("--resume-from=")) out.resumeFrom = a.slice("--resume-from=".length);
    else if (a.startsWith("--county-fips=")) out.countyFips = a.slice("--county-fips=".length);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!["road-node", "building-footprint"].includes(args.entityType)) {
  console.error("FATAL: --entity-type=road-node|building-footprint required");
  process.exit(1);
}
if (!Number.isFinite(args.batch) || args.batch <= 0) {
  console.error("FATAL: --batch must be a positive number");
  process.exit(1);
}

const url = process.env.DATABASE_URL ?? process.env.SUBSTRATE_DATABASE_URL;
if (!url) {
  console.error("FATAL: neither DATABASE_URL nor SUBSTRATE_DATABASE_URL is set.");
  process.exit(1);
}

// hauska_mcp got a 2-minute DATABASE-level statement_timeout default
// (2026-09-06, countAtoms() recurrence hardening) — generous for normal
// serving-path queries but tighter than this script's own real per-batch
// cost can run under heavy contention (measured up to ~6min/batch earlier
// tonight). This is a deliberate, known long-running admin script, not a
// stray caller the new default is meant to catch — opt back out per
// session rather than fight the new default silently.
const sql = postgres(url, {
  ssl: "require",
  max: 1,
  prepare: false,
  connection: { statement_timeout: "0" },
});

const isRoadNode = args.entityType === "road-node";

// atom_did is `did:hauska:<entityType>:<entityId>` (buildAtomDid) -- every
// road-node/building-footprint atom_did sorts contiguously under this
// prefix. Paginating on ENTITY_TYPE + `ORDER BY atom_did` (an earlier
// version of this script did that) forces Postgres to sort the WHOLE
// entity type (2.5M+ rows) before applying LIMIT, since atoms_entity_type_idx
// doesn't cover atom_did order -- measured: a bare, computation-free
// `entity_type = 'road-node' ORDER BY atom_did LIMIT 3000` alone timed out
// past 30s. Paginating on the atom_did PREFIX RANGE instead lets Postgres
// use atoms_pkey (already ordered by atom_did) directly -- same 3,000-row
// batch measured at 62ms for the bare id fetch, ~1.4s once the per-row
// bbox computation is added back in.
const idPrefixLower = args.countyFips
  ? `did:hauska:${args.entityType}:${args.countyFips}:`
  : `did:hauska:${args.entityType}:`;
const idPrefixUpper = args.countyFips
  ? `did:hauska:${args.entityType}:${args.countyFips};` // ';' = next char after ':'
  : `did:hauska:${args.entityType};`;

let cursor = args.resumeFrom ?? idPrefixLower;
let totalUpserted = 0;
let totalSkippedNoGeometry = 0;
let batchNum = 0;
const t0 = Date.now();

try {
  for (;;) {
    batchNum++;
    // LATERAL calls jsonb_array_elements exactly ONCE per row (all 4 bounds
    // computed in the same pass) -- an earlier version used 4 separate
    // correlated subqueries (one jsonb_array_elements call per bound) and a
    // single 3,000-row batch never finished in 3+ minutes; this shape is
    // the fix, not just a smaller batch size.
    const rows = isRoadNode
      ? await sql`
          SELECT a.atom_did, a.body->>'countyFips' AS county_fips,
                 b.west_lng, b.east_lng, b.south_lat, b.north_lat
          FROM atoms a,
          LATERAL (
            SELECT min((pt->>0)::float8) AS west_lng,
                   max((pt->>0)::float8) AS east_lng,
                   min((pt->>1)::float8) AS south_lat,
                   max((pt->>1)::float8) AS north_lat
            FROM jsonb_array_elements(a.body->'centerline'->'coordinates') pt
          ) b
          WHERE a.atom_did > ${cursor}
            AND a.atom_did < ${idPrefixUpper}
            AND a.entity_type = 'road-node'
          ORDER BY a.atom_did ASC
          LIMIT ${args.batch}
        `
      : await sql`
          SELECT a.atom_did, split_part(a.body->>'parcelNodeId', ':', 1) AS county_fips,
                 b.west_lng, b.east_lng, b.south_lat, b.north_lat
          FROM atoms a,
          LATERAL (
            SELECT min((pt->>0)::float8) AS west_lng,
                   max((pt->>0)::float8) AS east_lng,
                   min((pt->>1)::float8) AS south_lat,
                   max((pt->>1)::float8) AS north_lat
            FROM jsonb_array_elements(a.body->'footprintGeometry'->'coordinates'->0) pt
          ) b
          WHERE a.atom_did > ${cursor}
            AND a.atom_did < ${idPrefixUpper}
            AND a.entity_type = 'building-footprint'
          ORDER BY a.atom_did ASC
          LIMIT ${args.batch}
        `;

    if (rows.length === 0) break;

    const valid = rows.filter(
      (r) =>
        r.west_lng != null &&
        r.east_lng != null &&
        r.south_lat != null &&
        r.north_lat != null,
    );
    totalSkippedNoGeometry += rows.length - valid.length;

    if (valid.length > 0) {
      const dids = valid.map((r) => r.atom_did);
      const entityTypes = valid.map(() => args.entityType);
      const countyFipsArr = valid.map((r) => r.county_fips ?? null);
      const west = valid.map((r) => r.west_lng);
      const south = valid.map((r) => r.south_lat);
      const east = valid.map((r) => r.east_lng);
      const north = valid.map((r) => r.north_lat);

      await sql`
        INSERT INTO atoms_geom_bbox
          (atom_did, entity_type, county_fips, west_lng, south_lat, east_lng, north_lat)
        SELECT * FROM UNNEST(
          ${dids}::text[],
          ${entityTypes}::text[],
          ${countyFipsArr}::text[],
          ${west}::float8[],
          ${south}::float8[],
          ${east}::float8[],
          ${north}::float8[]
        )
        ON CONFLICT (atom_did) DO UPDATE SET
          county_fips = EXCLUDED.county_fips,
          west_lng = EXCLUDED.west_lng,
          south_lat = EXCLUDED.south_lat,
          east_lng = EXCLUDED.east_lng,
          north_lat = EXCLUDED.north_lat,
          updated_at = now()
      `;
      totalUpserted += valid.length;
    }

    cursor = rows[rows.length - 1].atom_did;
    console.log(
      JSON.stringify({
        event: "backfill-geom-bbox.progress",
        entityType: args.entityType,
        batchNum,
        batchSize: rows.length,
        totalUpserted,
        totalSkippedNoGeometry,
        cursor,
        elapsedS: ((Date.now() - t0) / 1000).toFixed(1),
      }),
    );

    if (rows.length < args.batch) break;
  }

  console.log(
    JSON.stringify({
      event: "backfill-geom-bbox.done",
      entityType: args.entityType,
      totalUpserted,
      totalSkippedNoGeometry,
      elapsedS: ((Date.now() - t0) / 1000).toFixed(1),
      lastCursor: cursor,
    }),
  );
  await sql.end({ timeout: 5 });
  process.exit(0);
} catch (err) {
  console.error(
    JSON.stringify({
      event: "backfill-geom-bbox.failed",
      entityType: args.entityType,
      error: err instanceof Error ? err.message : String(err),
      lastGoodCursor: cursor,
      totalUpserted,
    }),
  );
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
}
