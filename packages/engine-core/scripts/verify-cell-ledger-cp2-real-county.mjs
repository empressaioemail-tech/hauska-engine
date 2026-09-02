#!/usr/bin/env node
/**
 * CELL-LEDGER CP2 — verify the publish gate against a REAL, loader-fetched
 * county. Read-only throughout: two SELECTs via loadCountyParcelRecords,
 * zero writes. The "repair" step mutates one in-memory cell only, never the
 * store.
 *
 *   FACTORY_DATABASE_URL=... node packages/engine-core/scripts/verify-cell-ledger-cp2-real-county.mjs --county=48055
 */
import { writeFileSync } from "node:fs";

import postgres from "postgres";

import {
  loadCountyParcelRecords,
  evaluatePublishGate,
} from "../src/parcel-record/index.ts";

function parseArgs(argv) {
  const out = { county: "48055", out: null };
  for (const a of argv) {
    if (a.startsWith("--county=")) out.county = a.slice("--county=".length).trim();
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length).trim();
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const url = process.env.FACTORY_DATABASE_URL?.trim();
if (!url) {
  console.error("FATAL: FACTORY_DATABASE_URL required.");
  process.exit(1);
}

const sql = postgres(url, { max: 2, ssl: "require", prepare: false });

async function main() {
  await sql`SET default_transaction_read_only = on`;
  const [{ current_database: db }] = await sql`SELECT current_database()`;

  const loadStart = Date.now();
  const loaded = await loadCountyParcelRecords(sql, args.county);
  const loadMs = Date.now() - loadStart;

  const identity = loaded.parcelRowCount * 65 === loaded.cellRowCount;

  const verdictBefore = evaluatePublishGate(loaded.records);

  let repair = null;
  if (verdictBefore.unaccountedSamples.length > 0) {
    const sample = verdictBefore.unaccountedSamples[0];
    const target = loaded.records.find((r) => r.placeKey === sample.placeKey);
    const before = { ...target.cells[sample.railKey] };
    // In-memory repair only — never written back to the store.
    target.cells[sample.railKey] = {
      kind: "absent-verified",
      basis: "CP2 synthetic in-memory repair — verification only, not written to store",
    };
    const verdictAfter = evaluatePublishGate(loaded.records);
    repair = {
      placeKey: sample.placeKey,
      railKey: sample.railKey,
      before,
      unaccountedCountBefore: verdictBefore.unaccountedCount,
      unaccountedCountAfter: verdictAfter.unaccountedCount,
      delta: verdictBefore.unaccountedCount - verdictAfter.unaccountedCount,
      deltaIsExactlyOne: verdictBefore.unaccountedCount - verdictAfter.unaccountedCount === 1,
    };
  }

  const payload = {
    kind: "cell-ledger-cp2-real-county-verification",
    at: new Date().toISOString(),
    currentDatabase: db,
    countyFips: args.county,
    loadMs,
    parcelRowCount: loaded.parcelRowCount,
    cellRowCount: loaded.cellRowCount,
    identityCheck: {
      formula: `${loaded.parcelRowCount} x 65 = ${loaded.parcelRowCount * 65}`,
      cellRowCount: loaded.cellRowCount,
      exact: identity,
    },
    readAt: loaded.readAt,
    verdictBefore: {
      ok: verdictBefore.ok,
      unaccountedCount: verdictBefore.unaccountedCount,
      excludedDeclaredAheadCount: verdictBefore.excludedDeclaredAhead.length,
      excludedDeclaredAhead: verdictBefore.excludedDeclaredAhead,
      warnings: verdictBefore.warnings,
      sampleUnaccounted: verdictBefore.unaccountedSamples.slice(0, 5),
    },
    repair,
    writesIssued: 0,
  };

  const text = JSON.stringify(payload, null, 2);
  if (args.out) writeFileSync(args.out, text);
  console.log(text);

  await sql.end();
}

main().catch(async (err) => {
  console.error(err);
  await sql.end({ timeout: 1 }).catch(() => {});
  process.exit(1);
});
