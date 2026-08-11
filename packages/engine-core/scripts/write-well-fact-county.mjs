#!/usr/bin/env node
/**
 * write-well-fact-county.mjs — `well-fact` writer (rrc-wells rail).
 *
 * Joins txgio_parcel geometry against Texas RRC surface wells fetched live
 * from the Harris County mirror ArcGIS layer (statewide coverage). Carries
 * BOTH on-parcel (PIP) and near-parcel (within named radius) associations.
 *
 *   WELL_FACT_PATH=1 \
 *   CORTEX_DATABASE_URL=... \
 *   DATABASE_URL=...hauska_mcp... \
 *     pnpm --filter @hauska-engine/engine-core run write-well-fact-county -- \
 *       --county=48113 [--apply] [--batch=500] [--limit=0]
 *
 * DRY RUN IS THE DEFAULT and it PREDICTS the apply — same rows, same plan,
 * same constructed atoms. Compare its numbers to the apply's; they must match.
 */

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

import {
  WELL_FACT_PROXIMITY_RADIUS_METERS,
  buildAtomsForWellFactPlan,
  fetchRrcWellsForBBox,
  geometryCentroid,
  planCountyWellFacts,
  verifyStoredWellFactAtom,
} from "../src/well-fact/index.ts";

const SOURCE_ADAPTER = "texas-rrc-wells-v1";
const SOURCE_URL =
  "https://www.gis.hctx.net/arcgishcpid/rest/services/TXRRC/Wells/MapServer/0";

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

if (process.env.WELL_FACT_PATH !== "1") {
  console.error("FATAL: WELL_FACT_PATH=1 required (guards against an accidental invocation).");
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

const poolUrl =
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.TXGIO_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();
if (!poolUrl) {
  console.error(
    "FATAL: CORTEX_DATABASE_URL required — store holding txgio_parcel geometries.",
  );
  process.exit(1);
}

const sql = postgres(poolUrl, { max: 4, ssl: "require", prepare: false });

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
    console.log(
      JSON.stringify(
        {
          event: "well-fact.roster",
          source: "txgio_parcel bbox (execution time)",
          proximityRadiusMeters: WELL_FACT_PROXIMITY_RADIUS_METERS,
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
  event: "well-fact-county.done",
  county: args.county,
  mode: args.apply ? "apply" : "dry-run",
  storeTruth: null,
  sourceProbe: null,
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
        event: "well-fact-county.parcels-not-loaded",
        county: args.county,
        message: "county has zero rows in txgio_parcel",
      }),
    );
    process.exitCode = 1;
  } else {
    const countyBbox = {
      westLng: row.west_lng,
      southLat: row.south_lat,
      eastLng: row.east_lng,
      northLat: row.north_lat,
    };

    const wellFetch = await fetchRrcWellsForBBox(countyBbox);
    summary.sourceProbe = {
      layerUrl: SOURCE_URL,
      featureCount: wellFetch.wells.length,
      fieldNames: wellFetch.fieldNames,
      truncated: wellFetch.truncated,
      countyBbox,
    };

    summary.storeTruth = {
      parcelRows: row.rows,
      parcelFeatures: row.features,
      countyBbox,
      proximityRadiusMeters: WELL_FACT_PROXIMITY_RADIUS_METERS,
      note: "on-parcel PIP + near-parcel within named radius; one atom per (parcel, well)",
    };

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
        parcels.push({
          parcelKey: p.prop_id ?? `_feature-${p.feature_index}`,
          geometry: p.geometry,
          westLng: Number(p.west_lng),
          southLat: Number(p.south_lat),
          eastLng: Number(p.east_lng),
          northLat: Number(p.north_lat),
        });
      }
      lastFeature = page[page.length - 1].feature_index;
      if (page.length < pageSize) break;
    }

    let plan = planCountyWellFacts(parcels, wellFetch.wells, {
      countyFips: args.county,
      proximityRadiusMeters: WELL_FACT_PROXIMITY_RADIUS_METERS,
    });

    summary.plan = {
      parcelsRead: plan.parcelsRead,
      wellsIndexed: plan.wellsIndexed,
      proximityRadiusMeters: plan.proximityRadiusMeters,
      wouldWriteTotal: plan.planned.length,
      wouldWritePresent: plan.counts.present,
      wouldWriteAbsent: plan.counts.absent,
      wouldWriteOnParcel: plan.counts.onParcel,
      wouldWriteNearParcel: plan.counts.nearParcel,
      wouldWriteAbsentByKind: plan.counts.absentByKind,
      skippedUnusableKey: plan.counts.skippedUnusableKey,
      limitApplied: args.limit > 0 ? args.limit : null,
    };

    const provenance = {
      sourceAdapter: SOURCE_ADAPTER,
      sourceCitation: "Texas RRC public GIS (Harris County mirror) surface wells",
      sourceUrl: SOURCE_URL,
      observedAt: new Date().toISOString(),
      jurisdictionTenant: `tx_${args.county}`,
      verificationStatus: "machine",
    };
    const atoms = buildAtomsForWellFactPlan(plan, provenance);
    summary.atomsBuilt = atoms.length;

    const leaked = atoms.filter((a) => a.accessPolicy !== "public-free");
    if (leaked.length > 0) {
      throw new Error(
        `REFUSING TO WRITE: ${leaked.length} well atom(s) are not public-free`,
      );
    }

    if (!args.apply) {
      console.log(
        JSON.stringify({
          event: "well-fact-county.dry-run-prediction",
          county: args.county,
          ...summary.plan,
          sourceProbe: summary.sourceProbe,
          atomsBuilt: atoms.length,
          sample: atoms.slice(0, 3).map((a) => ({
            atomDid: a.atomDid,
            parcelNodeId: a.parcelNodeId,
            wellKey: a.wellKey,
            entityId: a.entityId,
            parcelRelation: a.parcelRelation ?? null,
            wellStatus: a.wellStatus ?? null,
            wellType: a.wellType ?? null,
            orphaned: a.orphaned ?? null,
            absenceKind: a.absence?.kind ?? null,
            proximityRadiusMeters: a.proximityRadiusMeters ?? null,
          })),
          note: "every atom above was CONSTRUCTED and contract-validated; --apply persists exactly these",
        }),
      );
    } else {
      for (let i = 0; i < atoms.length; i += args.batch) {
        const slice = atoms.slice(i, i + args.batch);
        await handle.storage.writePropertyAtomsBatch(slice);
        summary.atomsWritten += slice.length;

        // Look rows up by the atoms PRIMARY KEY (`atom_did`), never by the
        // `body->>'atomDid'` jsonb expression: no index serves the expression, so
        // every batch seq-scanned the whole atoms table. StoragePort upserts under
        // the canonical `did:hauska:<entityType>:<entityId>` form (body.atomDid
        // stays the contract `wlfact_<hex>` token), so the canonical did is what
        // the PK holds. `a.entityId` is the exact value written to `entity_id`.
        const dids = slice.map((a) => `did:hauska:well-fact:${a.entityId}`);
        const stored = await handle.sql`
          SELECT body FROM atoms
          WHERE atom_did IN ${handle.sql(dids)}
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
          const verdict = verifyStoredWellFactAtom(back, {
            parcelNodeId: atom.parcelNodeId,
            wellKey: atom.wellKey,
            outcome: atom.absence ? "absent" : "present",
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
            event: "well-fact-county.progress",
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
