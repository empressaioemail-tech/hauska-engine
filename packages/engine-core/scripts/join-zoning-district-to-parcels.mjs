#!/usr/bin/env node
/**
 * join-zoning-district-to-parcels.mjs — real point-in-polygon spatial join
 * between tx_zoning_district_staging (real, already-fetched district
 * polygons) and txgio_parcel (real parcel geometry), emitting zoning-fact
 * atoms for every parcel that actually falls inside one of the city's
 * district polygons.
 *
 * Built for Lockhart (48055): its zoning layer (Caldwell_CAD_Parcel_Map/
 * FeatureServer/49, 244 features) carries district polygons with NO prop_id
 * — there is no attribute join to parcels, only a real geometric one. The
 * staging side (tx_zoning_district_staging) already holds 107 cities' worth
 * of real staged district polygons; nothing downstream of staging has ever
 * turned any of them into a per-parcel district before. This script is that
 * missing step, written generically (--city-key) so proving it correct on
 * Lockhart makes the same script immediately reusable elsewhere — but it is
 * ONLY ever run here against Lockhart; running it for any other city is a
 * separate, explicit decision.
 *
 * The join is the ONLY thing that decides which parcels belong to this city
 * — there is no separate city-limits filter. A parcel whose point-on-surface
 * does not fall inside any of the city's district polygons is simply not
 * this city's concern; nothing is emitted for it.
 *
 * Never overwrites an existing zoning-fact atom that already carries a real
 * (non-absence) district from another source (e.g. the cortex Tier-1
 * breadth-bake) — those are reported as skipped, not silently replaced.
 *
 *   ZONING_STAGING_PATH=1 \
 *   CORTEX_DATABASE_URL=... (direct, no -pooler) \
 *   DATABASE_URL=...hauska_mcp... (required for --apply) \
 *     pnpm --filter @hauska-engine/engine-core run join-zoning-district-to-parcels -- \
 *       --city-key=lockhart-tx --county=48055 [--apply --run-id=...] [--batch=200] [--limit=0]
 *
 * Dry-run is the default and constructs the same atoms --apply would write.
 */

import { performance } from "node:perf_hooks";

import postgres from "postgres";
import {
  createPgStorage,
  resolveSubstrateDatabaseUrl,
  takeScopedLease,
  releaseScopedLease,
} from "@hauska-engine/storage";

import { emitZoningFact } from "../src/property-reasoning/emit-zoning-fact.ts";
import {
  consumeRunIdArg,
  railLeaseArgs,
  refuseApplyWithoutRunId,
} from "./writer-apply-lease.mjs";

function parseArgs(argv) {
  const out = {
    cityKey: null,
    county: null,
    apply: false,
    batch: 200,
    limit: 0,
    runId: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--city-key") out.cityKey = String(argv[++i] || "").trim().toLowerCase();
    else if (a.startsWith("--city-key="))
      out.cityKey = a.slice("--city-key=".length).trim().toLowerCase();
    else if (a === "--county") out.county = String(argv[++i] || "").trim();
    else if (a.startsWith("--county=")) out.county = a.slice("--county=".length).trim();
    else if (a === "--apply") out.apply = true;
    else if (a === "--batch") out.batch = Number(argv[++i] || 200);
    else if (a.startsWith("--batch=")) out.batch = Number(a.slice("--batch=".length));
    else if (a === "--limit") out.limit = Number(argv[++i] || 0);
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice("--limit=".length));
    else {
      const next = consumeRunIdArg(a, argv, i, out);
      if (next !== null) i = next;
    }
  }
  return out;
}

if (process.env.ZONING_STAGING_PATH !== "1") {
  console.error("FATAL: ZONING_STAGING_PATH=1 required (guards against an accidental invocation).");
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (refuseApplyWithoutRunId("zoning-district-parcel-join.refused", args.apply, args.runId)) {
  process.exit(2);
}
if (!args.cityKey || !/^[a-z0-9-]+$/.test(args.cityKey)) {
  console.error("FATAL: --city-key=<slug> required (e.g. lockhart-tx).");
  process.exit(1);
}
if (!args.county || !/^\d{5}$/.test(args.county)) {
  console.error("FATAL: --county=<5-digit FIPS> required.");
  process.exit(1);
}

const rawCortex = process.env.CORTEX_DATABASE_URL?.trim() || process.env.TXGIO_DATABASE_URL?.trim();
if (!rawCortex) {
  console.error("FATAL: CORTEX_DATABASE_URL required (the store holding txgio_parcel + tx_zoning_district_staging).");
  process.exit(1);
}
const cortexUrl = rawCortex.replace(/-pooler/g, "");
const sql = postgres(cortexUrl, { max: 4, ssl: "require", prepare: false });

// atoms lives in the substrate store (hauska_mcp), a DIFFERENT database from
// txgio_parcel/tx_zoning_district_staging (cortex/neondb) -- needed even in
// dry-run mode to report an honest atomsToWrite count (excluding parcels
// already stamped from another source), not just at --apply time.
const substrateUrlForRead = resolveSubstrateDatabaseUrl();
if (!substrateUrlForRead) {
  console.error("FATAL: DATABASE_URL / SUBSTRATE_DATABASE_URL required (to check for already-stamped parcels, even in dry-run).");
  process.exit(1);
}
const atomsReadSql = postgres(substrateUrlForRead, { max: 2, ssl: "require", prepare: false });

const t0 = performance.now();
const summary = {
  event: "zoning-district-parcel-join.done",
  cityKey: args.cityKey,
  county: args.county,
  mode: args.apply ? "apply" : "dry-run",
  staging: null,
  join: null,
  plan: null,
  atomsBuilt: 0,
  atomsWritten: 0,
  verified: 0,
  verifyFailures: [],
  errors: 0,
};

try {
  const stagingCheck = await sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE layer_role = 'base' AND is_overlay = false)::int AS base_rows,
      count(DISTINCT district_code)::int AS distinct_districts,
      min(city_name) AS city_name,
      min(source_url) AS source_url,
      min(source_citation) AS source_citation,
      min(geometry_grain) AS geometry_grain
    FROM tx_zoning_district_staging
    WHERE city_key = ${args.cityKey}
  `;
  const staging = stagingCheck[0];
  summary.staging = staging;
  if (!staging || staging.total === 0) {
    console.error(
      JSON.stringify({
        event: "zoning-district-parcel-join.no-staged-rows",
        cityKey: args.cityKey,
        message: "tx_zoning_district_staging has zero rows for this cityKey — nothing to join.",
      }),
    );
    process.exit(1);
  }
  if (staging.base_rows === 0) {
    console.error(
      JSON.stringify({
        event: "zoning-district-parcel-join.no-base-rows",
        cityKey: args.cityKey,
        message: `${staging.total} staged rows exist but none are layer_role='base'/non-overlay — refusing to join against overlay-only data.`,
      }),
    );
    process.exit(1);
  }

  // The real join: for every geometry-bearing parcel in this county, does its
  // point-on-surface fall inside one of the city's real (base, non-overlay)
  // district polygons? ST_PointOnSurface (not centroid) guarantees a point
  // that is actually inside the parcel's own ring, even for concave shapes.
  // Flag multi-match parcels rather than silently picking one -- real
  // zoning district polygons should partition the plane, not overlap; a
  // match count > 1 is a genuine data-quality finding worth surfacing.
  const joinRows = await sql`
    WITH matches AS (
      SELECT
        p.prop_id,
        p.county_fips,
        z.district_code,
        z.district_name,
        z.staging_row_id,
        z.object_id,
        z.source_url,
        z.source_citation,
        z.city_name,
        z.fetched_at
      FROM txgio_parcel p
      JOIN tx_zoning_district_staging z
        ON z.city_key = ${args.cityKey}
       AND z.layer_role = 'base'
       AND z.is_overlay = false
      WHERE p.county_fips = ${args.county}
        AND p.geom IS NOT NULL
        AND p.prop_id IS NOT NULL
        AND p.prop_id <> ''
        AND p.prop_id <> '0'
        AND ST_Contains(
              ST_SetSRID(ST_GeomFromGeoJSON(z.geometry::text), 4326),
              ST_PointOnSurface(p.geom)
            )
    )
    SELECT prop_id, county_fips,
           array_agg(DISTINCT district_code) AS district_codes,
           count(*)::int AS match_count,
           (array_agg(district_code))[1] AS district_code,
           (array_agg(district_name))[1] AS district_name,
           (array_agg(staging_row_id))[1] AS staging_row_id,
           (array_agg(object_id))[1] AS object_id,
           (array_agg(source_url))[1] AS source_url,
           (array_agg(source_citation))[1] AS source_citation,
           (array_agg(city_name))[1] AS city_name,
           (array_agg(fetched_at))[1] AS fetched_at
    FROM matches
    GROUP BY prop_id, county_fips
    ORDER BY prop_id
    ${args.limit > 0 ? sql`LIMIT ${args.limit}` : sql``}
  `;

  // "Ambiguous" means the DISTRICT is unclear, not merely that more than one
  // staged polygon row matched -- a parcel point can legitimately land on
  // more than one row of the SAME district (e.g. adjacent polygon features
  // sharing a boundary) without that being a real conflict. Only flag a
  // parcel when its matched rows disagree on district_code.
  const clean = joinRows.filter((r) => r.district_codes.length === 1);
  const ambiguous = joinRows.filter((r) => r.district_codes.length > 1);

  summary.join = {
    parcelsMatched: joinRows.length,
    parcelsCleanMatch: clean.length,
    parcelsAmbiguousMatch: ambiguous.length,
    ambiguousSample: ambiguous.slice(0, 5).map((r) => ({
      propId: r.prop_id,
      districtCodes: r.district_codes,
    })),
  };

  if (clean.length === 0) {
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  }

  const parcelNodeIds = clean.map((r) => `${r.county_fips}:${r.prop_id}`);

  // Never overwrite a real (non-absence) district already stamped from
  // another source (e.g. cortex Tier-1 breadth-bake) -- report as skipped.
  const existing = await atomsReadSql`
    SELECT entity_id, body->>'district' AS district, (body ? 'absence') AS has_absence
    FROM atoms
    WHERE entity_type = 'zoning-fact' AND entity_id = ANY(${parcelNodeIds})
  `;
  const existingByEntityId = new Map(existing.map((r) => [r.entity_id, r]));

  const extractedAt = new Date().toISOString();
  const jurisdictionTenant = `breadth_${args.county}_${args.cityKey.replace(/-/g, "_")}`;
  const descriptor = {
    key: args.cityKey,
    displayName: staging.city_name ?? args.cityKey,
    jurisdictionTenant,
    parcelFips: args.county,
    defaultAccessPolicy: "public-free",
    sourceAdapter: "zoning-district-staging-spatial-join",
    sourceUrl: staging.source_url,
  };

  const atoms = [];
  let skippedAlreadyStamped = 0;
  for (const row of clean) {
    const parcelNodeId = `${row.county_fips}:${row.prop_id}`;
    const already = existingByEntityId.get(parcelNodeId);
    if (already && !already.has_absence && already.district) {
      skippedAlreadyStamped += 1;
      continue;
    }
    const atom = emitZoningFact(descriptor, {
      parcelNodeId,
      districtCode: row.district_code ?? null,
      districtLabel: row.district_name ?? undefined,
      matchBasis: "exact",
      sourceCitation:
        `Real point-in-polygon spatial join: parcel centroid falls inside ` +
        `${row.city_name ?? args.cityKey} zoning district polygon ` +
        `(district_code=${row.district_code}, object_id=${row.object_id}, ` +
        `staging_row_id=${row.staging_row_id}, staged ${row.fetched_at}). ` +
        `${row.source_citation ?? ""}`.trim(),
      extractedAt,
    });
    atoms.push(atom);
  }

  summary.plan = {
    cleanMatches: clean.length,
    skippedAlreadyStamped,
    atomsToWrite: atoms.length,
  };
  summary.atomsBuilt = atoms.length;

  if (!args.apply) {
    summary.sample = atoms.slice(0, 5).map((a) => ({
      atomDid: a.atomDid,
      parcelNodeId: a.parcelNodeId,
      district: a.district,
      sourceCitation: a.sourceCitation,
    }));
    summary.note = "every atom above was CONSTRUCTED and contract-validated; --apply persists exactly these";
    summary.wallMs = Math.round(performance.now() - t0);
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  }

  const substrateUrl = resolveSubstrateDatabaseUrl();
  if (!substrateUrl) {
    console.error("FATAL: --apply requires DATABASE_URL / SUBSTRATE_DATABASE_URL (the ATOMS store).");
    process.exit(1);
  }
  const handle = createPgStorage({ databaseUrl: substrateUrl, maxConnections: 8 });

  const lease = await takeScopedLease(
    handle.sql,
    railLeaseArgs({
      entityType: "zoning-fact",
      countyFips: args.county,
      runId: args.runId,
      holderFallback: "zoning-district-parcel-join",
    }),
  );
  summary.lease = {
    holder_token: lease.holder_token,
    scope: lease.scope,
    stolen_from: lease.stolen_from,
  };
  try {
    for (let i = 0; i < atoms.length; i += args.batch) {
      const slice = atoms.slice(i, i + args.batch);
      await handle.storage.writePropertyAtomsBatch(slice, lease);
      summary.atomsWritten += slice.length;

      const dids = slice.map((a) => a.atomDid);
      const stored = await handle.sql`
        SELECT atom_did, body FROM atoms WHERE atom_did = ANY(${dids})
      `;
      const storedByDid = new Map(stored.map((s) => [s.atom_did, s.body]));
      for (const atom of slice) {
        const back = storedByDid.get(atom.atomDid);
        if (!back || back.district !== atom.district) {
          summary.verifyFailures.push({
            atomDid: atom.atomDid,
            problem: !back ? "atom not readable back after write" : "district mismatch on read-back",
          });
          continue;
        }
        summary.verified += 1;
      }
      if (summary.verifyFailures.length > 0) {
        throw new Error(
          `write-then-verify FAILED on ${summary.verifyFailures.length} atom(s); first: ${JSON.stringify(summary.verifyFailures[0])}`,
        );
      }
      console.log(
        JSON.stringify({
          event: "zoning-district-parcel-join.progress",
          cityKey: args.cityKey,
          written: summary.atomsWritten,
          verified: summary.verified,
          ofTotal: atoms.length,
        }),
      );
    }
  } finally {
    await releaseScopedLease(handle.sql, lease);
    await handle.close();
  }

  summary.wallMs = Math.round(performance.now() - t0);
  console.log(JSON.stringify(summary, null, 2));
} catch (err) {
  summary.errors += 1;
  summary.error = err instanceof Error ? err.stack ?? err.message : String(err);
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
  await atomsReadSql.end({ timeout: 5 });
}
