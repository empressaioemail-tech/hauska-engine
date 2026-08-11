#!/usr/bin/env node
/**
 * write-special-district-fact-county.mjs — `special-district-fact` writer (mud rail).
 *
 * BINARY point-in-polygon only — no proximity/buffer semantics.
 *
 *   SPECIAL_DISTRICT_FACT_PATH=1 \
 *   CORTEX_DATABASE_URL=... \
 *   DATABASE_URL=...hauska_mcp... \
 *     pnpm --filter @hauska-engine/engine-core run write-special-district-fact-county -- \
 *       --county=48201 [--apply] [--batch=500] [--limit=0]
 */

import { existsSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

import {
  attachComptrollerTaxRates,
  buildAtomForPlannedSpecialDistrict,
  buildAtomsForSpecialDistrictPlan,
  filterDistrictsByCounty,
  loadComptrollerRegistryFromCsv,
  lookupComptrollerTaxRate,
  planCountySpecialDistricts,
  verifyStoredSpecialDistrictFactAtom,
} from "../src/special-district-fact/index.ts";

const SOURCE_ADAPTER = "tceq-water-districts-v1";
const SOURCE_URL = "tx_special_district";
const DEFAULT_REGISTRY_CSV =
  process.env.COMPTROLLER_SPDPID_CSV?.trim() ||
  "P:/tmp/mud_recon/spdpid-entity.csv";

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

if (process.env.SPECIAL_DISTRICT_FACT_PATH !== "1") {
  console.error("FATAL: SPECIAL_DISTRICT_FACT_PATH=1 required.");
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

const poolUrl =
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.TXGIO_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();
if (!poolUrl) {
  console.error("FATAL: CORTEX_DATABASE_URL required.");
  process.exit(1);
}

const sql = postgres(poolUrl, { max: 4, ssl: "require", prepare: false });

async function districtTableExists() {
  const rows = await sql`SELECT to_regclass('public.tx_special_district') AS reg`;
  return rows[0]?.reg != null;
}

async function readParcelRoster() {
  return sql`
    SELECT county_fips, count(*)::int AS rows
    FROM txgio_parcel
    GROUP BY county_fips
    ORDER BY county_fips
  `;
}

if (args.listCounties) {
  try {
    const roster = await readParcelRoster();
    const hasTable = await districtTableExists();
    let districtRows = null;
    if (hasTable) {
      const r = await sql`SELECT count(*)::int AS n FROM tx_special_district`;
      districtRows = r[0]?.n ?? 0;
    }
    console.log(
      JSON.stringify({
        event: "special-district-fact.roster",
        districtTablePresent: hasTable,
        districtRows,
        counties: roster,
      }),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
  process.exit(0);
}

if (!args.county || !/^\d{5}$/.test(args.county)) {
  console.error("FATAL: --county=##### required (5-digit FIPS).");
  process.exit(1);
}

const summary = {
  county: args.county,
  apply: args.apply,
  storeTruth: {},
  plan: {},
  atomsBuilt: 0,
  atomsWritten: 0,
  rateEnrichedCount: 0,
  verified: 0,
  verifyFailures: [],
};

const t0 = performance.now();

try {
  const hasTable = await districtTableExists();
  summary.storeTruth.districtTablePresent = hasTable;
  if (!hasTable) {
    throw new Error("tx_special_district missing — run migration + ingest first");
  }

  const districtCount = await sql`
    SELECT count(*)::int AS n FROM tx_special_district WHERE county_fips = ${args.county}
  `;
  summary.storeTruth.districtRowsInCounty = districtCount[0]?.n ?? 0;

  const districtRows = await sql`
    SELECT district_row_id, district_id, district_name, district_type, county_fips,
           status, geometry, west_lng, south_lat, east_lng, north_lat
    FROM tx_special_district
    WHERE county_fips = ${args.county}
  `;
  const districts = districtRows.map((d) => ({
    districtRowId: d.district_row_id,
    districtId: d.district_id,
    districtName: d.district_name,
    districtType: d.district_type,
    countyFips: d.county_fips,
    status: d.status,
    geometry: d.geometry,
    westLng: Number(d.west_lng),
    southLat: Number(d.south_lat),
    eastLng: Number(d.east_lng),
    northLat: Number(d.north_lat),
  }));

  const parcels = [];
  const pageSize = 20000;
  let lastFeature = -1;
  const limit = args.limit > 0 ? args.limit : Infinity;

  while (parcels.length < limit) {
    const page = await sql`
      SELECT prop_id, feature_index, west_lng, south_lat, east_lng, north_lat
      FROM txgio_parcel
      WHERE county_fips = ${args.county}
        AND feature_index > ${lastFeature}
      ORDER BY feature_index
      LIMIT ${pageSize}
    `;
    if (page.length === 0) break;
    for (const p of page) {
      if (parcels.length >= limit) break;
      const centroid =
        Number.isFinite(p.west_lng) &&
        Number.isFinite(p.east_lng) &&
        Number.isFinite(p.south_lat) &&
        Number.isFinite(p.north_lat)
          ? [
              (Number(p.west_lng) + Number(p.east_lng)) / 2,
              (Number(p.south_lat) + Number(p.north_lat)) / 2,
            ]
          : null;
      parcels.push({
        parcelKey: p.prop_id ?? `_feature-${p.feature_index}`,
        centroid,
      });
    }
    lastFeature = page[page.length - 1].feature_index;
    if (page.length < pageSize) break;
  }

  summary.storeTruth.parcelsLoaded = parcels.length;

  let registry = null;
  let taxLookup = undefined;
  if (existsSync(DEFAULT_REGISTRY_CSV)) {
    registry = loadComptrollerRegistryFromCsv(DEFAULT_REGISTRY_CSV);
    taxLookup = (countyFips, districtType, districtName) =>
      lookupComptrollerTaxRate(registry, {
        countyFips,
        districtType,
        districtName,
      });
  } else {
    summary.storeTruth.registryCsvMissing = DEFAULT_REGISTRY_CSV;
  }

  let plan = planCountySpecialDistricts(parcels, districts, {
    countyFips: args.county,
    retainPlanned: args.apply,
    sampleLimit: args.apply ? 0 : 5,
    taxLookup: args.apply ? undefined : taxLookup,
  });

  if (args.apply && taxLookup) {
    plan = attachComptrollerTaxRates(plan, taxLookup);
  }
  summary.rateEnrichedCount = plan.counts.rateEnrichedCount;

  const wouldWriteTotal =
    plan.counts.presentMemberships + plan.counts.absentOutside;

  summary.plan = {
    parcelsRead: plan.parcelsRead,
    districtsIndexed: plan.districtsIndexed,
    emptyDistrictIndex: plan.emptyDistrictIndex,
    wouldWriteTotal,
    wouldWritePresentMemberships: plan.counts.presentMemberships,
    wouldWriteAbsentOutside: plan.counts.absentOutside,
    parcelsInDistrict: plan.counts.parcelsInDistrict,
    parcelsOutside: plan.counts.parcelsOutside,
    inDistrictRatio:
      plan.parcelsRead > 0
        ? Math.round(
            (plan.counts.parcelsInDistrict / plan.parcelsRead) * 10000,
          ) / 10000
        : 0,
    skippedUnusableKey: plan.counts.skippedUnusableKey,
  };

  const provenance = {
    sourceAdapter: SOURCE_ADAPTER,
    sourceCitation: `TCEQ tx_special_district (${districts.length} rows for county ${args.county})`,
    sourceUrl: SOURCE_URL,
    observedAt: new Date().toISOString(),
    jurisdictionTenant: `tx_${args.county}`,
    verificationStatus: "machine",
    sourceVintage: "2026-08-10",
  };

  const atoms = args.apply
    ? buildAtomsForSpecialDistrictPlan(plan, provenance)
    : [];
  summary.atomsBuilt = wouldWriteTotal;

  if (!args.apply) {
    const sampleEntries = plan.planned.slice(0, 5);
    const sampleAtoms = sampleEntries.map((entry) =>
      buildAtomForPlannedSpecialDistrict(entry, plan.countyFips, provenance),
    );
    const payload = {
      event: "special-district-fact-county.dry-run-prediction",
      county: args.county,
      elapsedMs: Math.round(performance.now() - t0),
      ...summary,
      sample: sampleAtoms.map((a) => ({
        atomDid: a.atomDid,
        parcelNodeId: a.parcelNodeId,
        entityId: a.entityId,
        districtType: a.districtType ?? null,
        districtId: a.districtId ?? null,
        absenceKind: a.absence?.kind ?? null,
        taxRate: a.taxRate ?? null,
      })),
      note: "BINARY PIP ONLY — no proximity semantics; --apply not run (slot held)",
    };
    console.log(JSON.stringify(payload));
    if (args.out) writeFileSync(args.out, JSON.stringify(payload, null, 2));
  } else {
    const substrateUrl = resolveSubstrateDatabaseUrl(process.env);
    const handle = await createPgStorage(substrateUrl);
    for (let i = 0; i < atoms.length; i += args.batch) {
      const slice = atoms.slice(i, i + args.batch);
      await handle.storage.writePropertyAtomsBatch(slice);
      summary.atomsWritten += slice.length;
      const dids = slice.map((a) => `did:hauska:special-district-fact:${a.entityId}`);
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
        const verdict = verifyStoredSpecialDistrictFactAtom(back, {
          parcelNodeId: atom.parcelNodeId,
          outcome: atom.absence ? "absent" : "present",
          districtId: atom.districtId,
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
          event: "special-district-fact-county.progress",
          county: args.county,
          written: summary.atomsWritten,
          verified: summary.verified,
          ofTotal: atoms.length,
        }),
      );
    }
    console.log(JSON.stringify({ event: "special-district-fact-county.done", ...summary }));
  }
} catch (err) {
  console.error(JSON.stringify({ event: "special-district-fact-county.error", message: String(err) }));
  process.exit(1);
} finally {
  await sql.end({ timeout: 10 });
}
