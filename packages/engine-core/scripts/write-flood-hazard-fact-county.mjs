#!/usr/bin/env node
/**
 * write-flood-hazard-fact-county.mjs — `flood-hazard-fact` writer.
 *
 * Evaluates parcel centroids against bbox-filtered FEMA NFHL
 * `tx_fema_nfhl_flood_zone` polygons (Kenedy-friendly: never load all
 * 198,240 statewide features for a rural AOI). Outside mapped zones =
 * PRESENT inSFHA=false. Empty zone index = typed absence.
 *
 *   FLOOD_HAZARD_FACT_PATH=1 \
 *   CORTEX_DATABASE_URL=... \
 *   DATABASE_URL=...hauska_mcp... \
 *     pnpm --filter @hauska-engine/engine-core run write-flood-hazard-fact-county -- \
 *       --county=48261 [--apply] [--batch=500] [--limit=0]
 */

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

import {
  buildAtomsForFloodHazardPlan,
  filterZonesByBBox,
  geometryCentroid,
  planCountyFloodHazard,
  verifyStoredFloodHazardFactAtom,
} from "../src/flood-hazard-fact/index.ts";

const SOURCE_ADAPTER = "fema-nfhl-bulk-v1";
const SOURCE_URL = "tx_fema_nfhl_flood_zone";
/** Statewide S_FLD_HAZ_AR feature count from the source zip probe (report denominator). */
const NFHL_STATEWIDE_SOURCE_FEATURES = 198_240;

function parseArgs(argv) {
  const out = {
    county: null,
    apply: false,
    batch: 500,
    limit: 0,
    out: null,
    listCounties: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--county") out.county = String(argv[++i] || "").trim();
    else if (a.startsWith("--county=")) out.county = a.slice("--county=".length).trim();
    else if (a === "--apply") out.apply = true;
    else if (a === "--list-counties") out.listCounties = true;
    else if (a === "--batch") out.batch = Number(argv[++i] || 500);
    else if (a.startsWith("--batch=")) out.batch = Number(a.slice("--batch=".length));
    else if (a === "--limit") out.limit = Number(argv[++i] || 0);
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice("--limit=".length));
    else if (a === "--out") out.out = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length).trim() || null;
  }
  return out;
}

if (process.env.FLOOD_HAZARD_FACT_PATH !== "1") {
  console.error("FATAL: FLOOD_HAZARD_FACT_PATH=1 required (guards against an accidental invocation).");
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

const poolUrl =
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.TXGIO_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();
if (!poolUrl) {
  console.error(
    "FATAL: CORTEX_DATABASE_URL required — store holding txgio_parcel (+ tx_fema_nfhl_flood_zone when applied).",
  );
  process.exit(1);
}

const sql = postgres(poolUrl, { max: 4, ssl: "require", prepare: false });

async function nfhlTableExists() {
  const rows = await sql`
    SELECT to_regclass('public.tx_fema_nfhl_flood_zone') AS reg
  `;
  return rows[0]?.reg != null;
}

async function readParcelRoster() {
  return sql`
    SELECT county_fips,
           count(*)::int AS rows,
           count(DISTINCT feature_index)::int AS features,
           min(west_lng)::float8 AS west_lng,
           min(south_lat)::float8 AS south_lat,
           max(east_lng)::float8 AS east_lng,
           max(north_lat)::float8 AS north_lat
    FROM txgio_parcel
    GROUP BY county_fips
    ORDER BY county_fips
  `;
}

if (args.listCounties) {
  try {
    const roster = await readParcelRoster();
    const hasNfhl = await nfhlTableExists();
    let nfhlRows = null;
    if (hasNfhl) {
      const r = await sql`SELECT count(*)::int AS n FROM tx_fema_nfhl_flood_zone`;
      nfhlRows = r[0]?.n ?? 0;
    }
    console.log(
      JSON.stringify(
        {
          event: "flood-hazard-fact.roster",
          source: "txgio_parcel bbox (execution time) + tx_fema_nfhl_flood_zone",
          nfhlTablePresent: hasNfhl,
          nfhlRows,
          nfhlFractionOfSourceZip:
            nfhlRows == null
              ? null
              : Number((nfhlRows / NFHL_STATEWIDE_SOURCE_FEATURES).toFixed(6)),
          nfhlSourceZipFeatures: NFHL_STATEWIDE_SOURCE_FEATURES,
          countyCount: roster.length,
          counties: roster.map((r) => ({
            countyFips: r.county_fips,
            rows: r.rows,
            features: r.features,
            bbox: {
              westLng: r.west_lng,
              southLat: r.south_lat,
              eastLng: r.east_lng,
              northLat: r.north_lat,
            },
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
  process.exit(0);
}

if (!args.county || !/^\d{5}$/.test(args.county)) {
  console.error("FATAL: --county=<5-digit FIPS> required (or --list-counties).");
  await sql.end({ timeout: 5 });
  process.exit(1);
}

const substrateUrl = resolveSubstrateDatabaseUrl();
if (args.apply && !substrateUrl) {
  console.error("FATAL: --apply requires DATABASE_URL / SUBSTRATE_DATABASE_URL (the ATOMS store).");
  await sql.end({ timeout: 5 });
  process.exit(1);
}

const handle = args.apply
  ? createPgStorage({ databaseUrl: substrateUrl, maxConnections: 8 })
  : null;

const t0 = performance.now();
const summary = {
  event: "flood-hazard-fact-county.done",
  county: args.county,
  mode: args.apply ? "apply" : "dry-run",
  storeTruth: null,
  plan: null,
  atomsBuilt: 0,
  atomsWritten: 0,
  verified: 0,
  verifyFailures: [],
  errors: 0,
};

try {
  const roster = await readParcelRoster();
  const row = roster.find((r) => r.county_fips === args.county);
  if (!row) {
    console.error(
      JSON.stringify({
        event: "flood-hazard-fact-county.parcels-not-loaded",
        county: args.county,
        message: "county has zero rows in txgio_parcel",
      }),
    );
    process.exitCode = 1;
  } else {
    const hasNfhl = await nfhlTableExists();
    let nfhlRows = 0;
    if (hasNfhl) {
      const r = await sql`SELECT count(*)::int AS n FROM tx_fema_nfhl_flood_zone`;
      nfhlRows = r[0]?.n ?? 0;
    }

    const countyBbox = {
      westLng: row.west_lng,
      southLat: row.south_lat,
      eastLng: row.east_lng,
      northLat: row.north_lat,
    };

    summary.storeTruth = {
      parcelRows: row.rows,
      parcelFeatures: row.features,
      countyBbox,
      nfhlTablePresent: hasNfhl,
      nfhlRows,
      nfhlFractionOfSourceZip: Number(
        (nfhlRows / NFHL_STATEWIDE_SOURCE_FEATURES).toFixed(6),
      ),
      nfhlSourceZipFeatures: NFHL_STATEWIDE_SOURCE_FEATURES,
      note: "bbox-filter zones to county extent before point-in-polygon (Kenedy-friendly)",
    };

    // Load parcels (distinct features) with geometry for centroids.
    const parcels = [];
    let lastFeature = -1;
    while (true) {
      if (args.limit > 0 && parcels.length >= args.limit) break;
      const remaining =
        args.limit > 0 ? args.limit - parcels.length : Math.min(args.batch, 2000);
      const pageSize = Math.max(1, Math.min(args.batch, remaining, 2000));
      const page = await sql`
        SELECT DISTINCT ON (feature_index)
               feature_index, prop_id, geometry,
               west_lng, south_lat, east_lng, north_lat
        FROM txgio_parcel
        WHERE county_fips = ${args.county}
          AND feature_index > ${lastFeature}
        ORDER BY feature_index
        LIMIT ${pageSize}
      `;
      if (page.length === 0) break;
      for (const p of page) {
        if (args.limit > 0 && parcels.length >= args.limit) break;
        const centroid =
          geometryCentroid(p.geometry) ??
          (Number.isFinite(p.west_lng) && Number.isFinite(p.south_lat)
            ? [
                (Number(p.west_lng) + Number(p.east_lng)) / 2,
                (Number(p.south_lat) + Number(p.north_lat)) / 2,
              ]
            : null);
        parcels.push({
          parcelKey: p.prop_id ?? `_feature-${p.feature_index}`,
          centroid,
        });
      }
      lastFeature = page[page.length - 1].feature_index;
      if (page.length < pageSize) break;
    }

    // Bbox-filter NFHL zones to the county extent (+ small pad).
    let zones = [];
    if (hasNfhl && nfhlRows > 0) {
      const pad = 0.02;
      const west = countyBbox.westLng - pad;
      const south = countyBbox.southLat - pad;
      const east = countyBbox.eastLng + pad;
      const north = countyBbox.northLat + pad;
      const zoneRows = await sql`
        SELECT zone_row_id, fld_zone, zone_subty, sfha_tf, static_bfe,
               geometry, west_lng, south_lat, east_lng, north_lat,
               source_vintage, source_citation
        FROM tx_fema_nfhl_flood_zone
        WHERE west_lng <= ${east}
          AND east_lng >= ${west}
          AND south_lat <= ${north}
          AND north_lat >= ${south}
      `;
      const loaded = zoneRows.map((z) => ({
        zoneRowId: z.zone_row_id,
        fldZone: z.fld_zone,
        zoneSubty: z.zone_subty,
        sfhaTf: z.sfha_tf,
        staticBfe: z.static_bfe == null ? null : Number(z.static_bfe),
        geometry: z.geometry,
        westLng: Number(z.west_lng),
        southLat: Number(z.south_lat),
        eastLng: Number(z.east_lng),
        northLat: Number(z.north_lat),
        sourceVintage: z.source_vintage,
        sourceCitation: z.source_citation,
      }));
      // Second pass through the pure filter (unit-testable contract).
      zones = filterZonesByBBox(loaded, {
        westLng: west,
        southLat: south,
        eastLng: east,
        northLat: north,
      });
    }

    summary.storeTruth.zonesLoadedForCounty = zones.length;

    const plan = planCountyFloodHazard(parcels, zones, {
      countyFips: args.county,
    });
    summary.plan = {
      parcelsRead: plan.parcelsRead,
      zonesIndexed: plan.zonesIndexed,
      emptyZoneIndex: plan.emptyZoneIndex,
      wouldWriteTotal: plan.planned.length,
      wouldWritePresent: plan.counts.present,
      wouldWritePresentInSfha: plan.counts.presentInSfha,
      wouldWritePresentOutside: plan.counts.presentOutside,
      wouldWriteAbsent: plan.counts.absent,
      skippedUnusableKey: plan.counts.skippedUnusableKey,
    };

    const provenance = {
      sourceAdapter: SOURCE_ADAPTER,
      sourceCitation: hasNfhl
        ? `FEMA NFHL tx_fema_nfhl_flood_zone (${nfhlRows}/${NFHL_STATEWIDE_SOURCE_FEATURES} statewide rows; ${zones.length} bbox-filtered for ${args.county})`
        : `FEMA NFHL table absent (to_regclass NULL) for county ${args.county}`,
      sourceUrl: SOURCE_URL,
      observedAt: new Date().toISOString(),
      jurisdictionTenant: `tx_${args.county}`,
      verificationStatus: "machine",
      sourceVintage: zones[0]?.sourceVintage ?? undefined,
    };
    const atoms = buildAtomsForFloodHazardPlan(plan, provenance);
    summary.atomsBuilt = atoms.length;

    if (!args.apply) {
      console.log(
        JSON.stringify({
          event: "flood-hazard-fact-county.dry-run-prediction",
          county: args.county,
          storeTruth: summary.storeTruth,
          ...summary.plan,
          atomsBuilt: atoms.length,
          sample: atoms.slice(0, 3).map((a) => ({
            atomDid: a.atomDid,
            parcelNodeId: a.parcelNodeId,
            entityId: a.entityId,
            inSfha: a.inSpecialFloodHazardArea ?? null,
            floodZone: a.floodZone ?? null,
            absenceKind: a.absence?.kind ?? null,
          })),
          note: "every atom above was CONSTRUCTED and contract-validated; --apply persists exactly these",
        }),
      );
    } else {
      for (let i = 0; i < atoms.length; i += args.batch) {
        const slice = atoms.slice(i, i + args.batch);
        await handle.storage.writePropertyAtomsBatch(slice);
        summary.atomsWritten += slice.length;

        const dids = slice.map((a) => a.atomDid);
        const stored = await handle.sql`
          SELECT body FROM atoms
          WHERE entity_type = 'flood-hazard-fact'
            AND body->>'atomDid' IN ${handle.sql(dids)}
        `;
        const storedByDid = new Map(stored.map((s) => [s.body?.atomDid, s.body]));
        for (const atom of slice) {
          const back = storedByDid.get(atom.atomDid);
          if (!back) {
            summary.verifyFailures.push({
              atomDid: atom.atomDid,
              problem: "atom not readable back via body->>'atomDid' after write",
            });
            continue;
          }
          const verdict = verifyStoredFloodHazardFactAtom(back, {
            parcelNodeId: atom.parcelNodeId,
            outcome: atom.absence || atom.sourceTier === "absent" ? "absent" : "present",
          });
          if (verdict.ok) summary.verified += 1;
          else summary.verifyFailures.push(verdict);
        }

        if (summary.verifyFailures.length > 0) {
          throw new Error(
            `write-then-verify FAILED on ${summary.verifyFailures.length} atom(s); ` +
              `first: ${JSON.stringify(summary.verifyFailures[0])}`,
          );
        }

        console.log(
          JSON.stringify({
            event: "flood-hazard-fact-county.progress",
            county: args.county,
            written: summary.atomsWritten,
            verified: summary.verified,
            ofTotal: atoms.length,
          }),
        );
      }
    }
  }

  summary.wallMs = Math.round(performance.now() - t0);
  console.log(JSON.stringify(summary, null, 2));
  if (args.out) writeFileSync(args.out, JSON.stringify(summary, null, 2));
} catch (err) {
  summary.errors += 1;
  summary.error = String(err?.stack || err);
  console.error(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
  if (handle) await handle.close();
}
