#!/usr/bin/env node
/**
 * Prove parcel-record on one county: instantiate + ingest existing data.
 *
 *   PARCEL_RECORD_PATH=1 \
 *   CORTEX_DATABASE_URL=... \
 *   DATABASE_URL=... \
 *     node packages/engine-core/scripts/prove-parcel-record-county.mjs --county=48021
 */

import { writeFileSync } from "node:fs";

import postgres from "postgres";

import {
  COUNTY_RAIL_LEDGER_DISPOSITION,
  PARCEL_RECORD_RAIL_COUNT,
  RAILS_ADDED_BEYOND_SEED,
  auditNotApplicableCells,
  diffCellStateCounts,
  indexAtomsByPlaceKey,
  ingestAtomsOntoRecords,
  ingestCadOntoRecords,
  instantiateParcelRecord,
  summarizeCountyRecords,
  texasCtxProgramConfig,
} from "../src/parcel-record/index.ts";

function parseArgs(argv) {
  const out = { county: "48021", out: null, limit: 0 };
  for (const a of argv) {
    if (a.startsWith("--county=")) out.county = a.slice("--county=".length).trim();
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length).trim();
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice("--limit=".length)) || 0;
  }
  return out;
}

if (process.env.PARCEL_RECORD_PATH !== "1") {
  console.error("FATAL: PARCEL_RECORD_PATH=1 required.");
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const cortexUrl =
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.PRODUCTION_NEONDB_URL?.trim() ||
  process.env.TXGIO_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();
if (!cortexUrl) {
  console.error("FATAL: CORTEX_DATABASE_URL required.");
  process.exit(1);
}

const atomsUrl = process.env.DATABASE_URL?.trim() || cortexUrl;
const cortex = postgres(cortexUrl, { max: 4, ssl: "require", prepare: false });
const atoms = postgres(atomsUrl, { max: 4, ssl: "require", prepare: false });

const fips = args.county;
const fipsLo = `${fips}000000000000`;
const fipsHi = `${fips}ffffffffffff`;

async function main() {
  const [{ current_database: cortexDb }] = await cortex`SELECT current_database()`;
  const [{ current_database: atomsDb }] = await atoms`SELECT current_database()`;

  let parcelSql = cortex`
    SELECT DISTINCT ON (prop_id) prop_id::text AS prop_id
    FROM cad_property
    WHERE county_fips = ${fips}
    ORDER BY prop_id, tax_year DESC
  `;
  if (args.limit > 0) {
    parcelSql = cortex`
      SELECT prop_id FROM (
        SELECT DISTINCT ON (prop_id) prop_id::text AS prop_id
        FROM cad_property
        WHERE county_fips = ${fips}
        ORDER BY prop_id, tax_year DESC
      ) sub
      LIMIT ${args.limit}
    `;
  }
  const parcels = await parcelSql;

  let incorporatedRows = [];
  try {
    incorporatedRows = await cortex`
      SELECT cp.prop_id::text AS prop_id,
             bool_or(
               EXISTS (
                 SELECT 1
                 FROM landing_tx_city_boundary b
                 WHERE ST_Contains(b.geom, ST_PointOnSurface(tg.geom))
               )
             ) AS incorporated
      FROM cad_property cp
      JOIN txgio_parcel tg
        ON tg.county_fips = cp.county_fips AND tg.prop_id = cp.prop_id
      WHERE cp.county_fips = ${fips}
      GROUP BY cp.prop_id
    `;
  } catch {
    incorporatedRows = [];
  }

  const incMap = new Map(
    incorporatedRows.map((r) => [String(r.prop_id), r.incorporated === true]),
  );

  const records = parcels.map((p) => {
    const propId = String(p.prop_id);
    const incorporated = incMap.has(propId) ? incMap.get(propId) : null;
    return instantiateParcelRecord({
      countyFips: fips,
      propId,
      incorporated,
    });
  });

  const before = diffCellStateCounts(records);
  const beforeSummary = summarizeCountyRecords(records);
  const notApplicableAuditBefore = auditNotApplicableCells(records);

  const cadRows = await cortex`
    SELECT DISTINCT ON (prop_id)
      prop_id::text AS prop_id,
      situs_address, situs_city, situs_zip, legal_description, exemption_codes,
      land_value, improvement_value, market_value, assessed_value, year_built,
      living_area_sqft, land_acres, property_use_code
    FROM cad_property
    WHERE county_fips = ${fips}
    ORDER BY prop_id, tax_year DESC
  `;
  const cadMap = new Map(cadRows.map((r) => [String(r.prop_id), r]));
  const vintage = new Date().toISOString();
  const cadIngest = ingestCadOntoRecords(records, cadMap, vintage);

  const atomRows = await atoms`
    SELECT entity_type, entity_id, count(*)::int AS n
    FROM atoms
    WHERE entity_id >= ${fipsLo} AND entity_id < ${fipsHi}
    GROUP BY entity_type, entity_id
  `;
  const atomIngest = ingestAtomsOntoRecords(
    records,
    indexAtomsByPlaceKey(atomRows),
    vintage,
  );

  const after = diffCellStateCounts(records);
  const nonUnaccounted = (counts) =>
    Object.entries(counts).reduce((acc, [k, v]) => (k === "unaccounted" ? acc : acc + v), 0);
  const cellsMovedOnExistingData =
    nonUnaccounted(after) - nonUnaccounted(before);

  const payload = {
    kind: "parcel-record-live-measured",
    at: new Date().toISOString(),
    countyFips: fips,
    parcelCount: records.length,
    railCount: PARCEL_RECORD_RAIL_COUNT,
    currentDatabase: { cortex: cortexDb, atoms: atomsDb },
    programConfig: texasCtxProgramConfig(),
    before,
    after,
    cellsMovedOnExistingData,
    cadIngest,
    atomIngest,
    notApplicableAuditBefore,
    railsAddedBeyondSeed: RAILS_ADDED_BEYOND_SEED,
    countyRailLedgerDisposition: COUNTY_RAIL_LEDGER_DISPOSITION,
    beforeSummary,
    incorporationJoinRows: incorporatedRows.length,
  };

  const text = JSON.stringify(payload, null, 2);
  if (args.out) writeFileSync(args.out, text);
  else console.log(text);

  await cortex.end();
  await atoms.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
