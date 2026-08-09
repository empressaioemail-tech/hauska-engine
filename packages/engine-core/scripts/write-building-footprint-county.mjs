#!/usr/bin/env node
/**
 * write-building-footprint-county.mjs — `building-footprint` writer (T3 WS4 / ADR-029).
 *
 * Default source: Microsoft Global ML Building Footprints (`ml-derived`,
 * `accessPolicy=public-free`). Statewide-uniform routing — no county-specific
 * hardcoding in shared machinery.
 *
 *   BUILDING_FOOTPRINT_PATH=1 \
 *   CORTEX_DATABASE_URL=... \
 *   DATABASE_URL=...hauska_mcp... \
 *     pnpm --filter @hauska-engine/engine-core run write-building-footprint-county -- \
 *       --county=48021 [--apply] [--batch=500] [--limit=0] \
 *       [--fixture=path/to/ml-footprints.geojson]
 *
 * Dry-run is the default and constructs the same atoms apply would write.
 * Without --fixture the ML loader returns zero bbox features → one county-coverage
 * absence atom (never silent zero rows). Pass a clipped GeoJSON fixture for join dry-runs.
 */

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

import {
  FOOTPRINT_WRITER_ADAPTER,
  GLOBAL_ML_TEXAS_ZIP_URL,
  ML_FOOTPRINT_SOURCE_CITATION,
  ML_FOOTPRINT_SOURCE_VINTAGE,
  buildAtomsForBuildingFootprintPlan,
  geometryOuterRing,
  loadMlFootprintsForBbox,
  planCountyBuildingFootprints,
  verifyStoredBuildingFootprintAtom,
} from "../src/building-footprint/index.ts";

function parseArgs(argv) {
  const out = {
    county: null,
    apply: false,
    batch: 500,
    limit: 0,
    out: null,
    listCounties: false,
    fixture: null,
    adapterKind: null,
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
    else if (a === "--fixture") out.fixture = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--fixture="))
      out.fixture = a.slice("--fixture=".length).trim() || null;
    else if (a === "--adapter-kind") out.adapterKind = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--adapter-kind="))
      out.adapterKind = a.slice("--adapter-kind=".length).trim() || null;
  }
  return out;
}

if (process.env.BUILDING_FOOTPRINT_PATH !== "1") {
  console.error(
    "FATAL: BUILDING_FOOTPRINT_PATH=1 required (guards against an accidental invocation).",
  );
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

const poolUrl =
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.TXGIO_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();
if (!poolUrl) {
  console.error(
    "FATAL: CORTEX_DATABASE_URL (or TXGIO_DATABASE_URL / DATABASE_URL) required — the store holding txgio_parcel.",
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
          event: "building-footprint.roster",
          source:
            "txgio_parcel bbox (read at execution time — no hardcoded allowlist)",
          defaultAdapter: "ml-global-building-footprints",
          defaultSourceTier: "ml-derived",
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
  event: "building-footprint-county.done",
  county: args.county,
  mode: args.apply ? "apply" : "dry-run",
  storeTruth: null,
  footprint: null,
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
        event: "building-footprint-county.parcels-not-loaded",
        county: args.county,
        message:
          "county has zero rows in txgio_parcel — it is NOT-YET for this rail. " +
          "Do not invent verified-absence unless a source probe documented no geometry.",
        loadedCounties: roster.map((r) => r.county_fips),
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

    summary.storeTruth = {
      parcelRows: row.rows,
      parcelFeatures: row.features,
      countyBbox,
      mlFixture: args.fixture,
      note: "read from txgio_parcel at execution time",
    };

    const parcelInputs = [];
    let lastFeature = -1;
    while (true) {
      if (args.limit > 0 && parcelInputs.length >= args.limit) break;
      const remaining =
        args.limit > 0 ? args.limit - parcelInputs.length : Math.min(args.batch, 2000);
      const pageSize = Math.max(1, Math.min(args.batch, remaining, 2000));
      const page = await sql`
        SELECT DISTINCT ON (feature_index)
               feature_index, prop_id, geometry
        FROM txgio_parcel
        WHERE county_fips = ${args.county}
          AND feature_index > ${lastFeature}
        ORDER BY feature_index
        LIMIT ${pageSize}
      `;
      if (page.length === 0) break;
      for (const p of page) {
        if (args.limit > 0 && parcelInputs.length >= args.limit) break;
        parcelInputs.push({
          parcelKey: p.prop_id ?? `_feature-${p.feature_index}`,
          ring: geometryOuterRing(p.geometry),
        });
      }
      lastFeature = page[page.length - 1].feature_index;
      if (page.length < pageSize) break;
    }

    const mlLoad = await loadMlFootprintsForBbox({
      bbox: countyBbox,
      ...(args.fixture ? { fixturePath: args.fixture } : {}),
    });

    summary.storeTruth.mlSourceLabel = mlLoad.sourceLabel;

    const plan = planCountyBuildingFootprints(parcelInputs, mlLoad.features, {
      countyFips: args.county,
      ...(args.adapterKind ? { footprintAdapterKind: args.adapterKind } : {}),
    });

    summary.footprint = {
      adapterKind: plan.route.adapterKind,
      sourceTier: plan.route.sourceTier,
      sourceUrl: plan.route.sourceUrl,
      featuresRead: plan.featuresRead,
      footprintsJoined: plan.joinStats.footprintsJoined,
      parcelsWithFootprint: plan.joinStats.parcelsWithFootprint,
      parcelsAbsentSentinel: plan.joinStats.parcelsAbsentSentinel,
      orphanRejected: plan.joinStats.orphanRejected,
      mlEmptyBbox: plan.mlEmptyBbox,
      atomsWouldWrite: plan.planned.length,
    };

    summary.plan = {
      parcelsRead: plan.parcelsRead,
      wouldWriteTotal: plan.planned.length,
      wouldWritePresent: plan.counts.present,
      wouldWriteAbsentPerParcel: plan.counts.absentPerParcel,
      wouldWriteCountyCoverageAbsent: plan.counts.countyCoverageAbsent,
      skippedUnusableKey: plan.counts.skippedUnusableKey,
      skippedNoRing: plan.counts.skippedNoRing,
    };

    const provenance = {
      sourceAdapter: FOOTPRINT_WRITER_ADAPTER,
      sourceCitation: ML_FOOTPRINT_SOURCE_CITATION,
      sourceUrl: GLOBAL_ML_TEXAS_ZIP_URL,
      sourceVintage: ML_FOOTPRINT_SOURCE_VINTAGE,
      observedAt: new Date().toISOString(),
      jurisdictionTenant: `tx_${args.county}`,
      verificationStatus: "machine",
    };
    const atoms = buildAtomsForBuildingFootprintPlan(plan, provenance);
    summary.atomsBuilt = atoms.length;

    if (!args.apply) {
      console.log(
        JSON.stringify({
          event: "building-footprint-county.dry-run-prediction",
          county: args.county,
          mode: "dry-run",
          storeTruth: summary.storeTruth,
          footprint: summary.footprint,
          ...summary.plan,
          atomsBuilt: atoms.length,
          sample: atoms.slice(0, 3).map((a) => ({
            atomDid: a.atomDid,
            parcelNodeId: a.parcelNodeId,
            footprintId: a.footprintId,
            entityId: a.entityId,
            sourceTier: a.sourceTier,
            absenceKind: a.absence?.kind ?? null,
            verifiedAbsence: a.verifiedAbsence?.evaluated ?? null,
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
          WHERE entity_type = 'building-footprint'
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
          const outcome =
            atom.absence || atom.sourceTier === "absent" || atom.verifiedAbsence
              ? "absent"
              : "present";
          const verdict = verifyStoredBuildingFootprintAtom(back, {
            parcelNodeId: atom.parcelNodeId,
            footprintId: atom.footprintId,
            outcome,
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
            event: "building-footprint-county.progress",
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
  if (args.out) {
    writeFileSync(args.out, JSON.stringify(summary, null, 2));
  }
} catch (err) {
  summary.errors += 1;
  summary.error = String(err?.stack || err);
  console.error(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
  if (handle) await handle.close();
}
