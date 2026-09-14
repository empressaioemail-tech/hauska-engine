#!/usr/bin/env node
/**
 * PARCEL-B-GATE-SCHED (F-01) — rail-scoped publish gate CLI. The engine half
 * the mission names: evaluates one (county, rail) pair via
 * loadCountyRailCells (paged internally) + evaluateRailGate, never the
 * whole-county loadCountyParcelRecords (measured 101.5s/smallest county,
 * CELL-LEDGER close). CP2 correction: the FIRST version of this card's
 * loader issued one unbounded (county, rail)-scoped statement — fast on the
 * smallest county (408.8ms) but measured to TIME OUT (120s+, idle store) on
 * Travis, the largest program county, because parcel_record_cell's primary
 * key orders rows by (place_key, rail_key) and a wide place_key range with a
 * trailing-column rail_key filter cannot skip the other ~64 sibling rows per
 * parcel. loadCountyRailCells now pages internally (500 rows/statement by
 * default) — this is the actual "streaming/batched per rail" the mission
 * names.
 *
 *   FACTORY_DATABASE_URL=... node packages/engine-core/scripts/gate-rail-cli.mjs --county=48055 --rail=flood
 *
 * P-195: evaluateRailGate now REQUIRES the program-wide declared-ahead rail
 * set (see publish-gate.ts). --declared-ahead=<comma,separated,list> lets a
 * caller looping over many (county, rail) pairs compute it ONCE and pass it
 * to every invocation, avoiding one full-table parcel_record_cell scan per
 * subprocess (AGENT_CONTRACT section 4, heavy-scan serialization). Omit the
 * flag entirely for a standalone one-off run and this CLI computes it itself
 * via loadProgramWideLiveRailKeys -- correct but a real scan, so never loop
 * this CLI without the flag. --declared-ahead= (present, empty) means
 * "nothing is declared ahead," distinct from the flag being absent.
 *
 * Prints one JSON verdict line to stdout. Non-zero exit on any query/DB
 * error; exit 0 regardless of ok:true/false in the verdict itself (a REFUSE
 * verdict is a successful evaluation, not a CLI failure — the caller reads
 * the verdict's own `ok` field).
 */
import postgres from "postgres";

import {
  loadCountyRailCells,
  evaluateRailGate,
  loadProgramWideLiveRailKeys,
  declaredAheadFromLiveRailKeys,
} from "../src/parcel-record/index.ts";

function parseArgs(argv) {
  const out = { county: null, rail: null, declaredAhead: null };
  for (const a of argv) {
    if (a.startsWith("--county=")) out.county = a.slice("--county=".length).trim();
    else if (a.startsWith("--rail=")) out.rail = a.slice("--rail=".length).trim();
    else if (a.startsWith("--declared-ahead=")) {
      const raw = a.slice("--declared-ahead=".length).trim();
      out.declaredAhead = raw.length === 0 ? [] : raw.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  if (!out.county) {
    console.error("FATAL: --county=<fips> is required");
    process.exit(1);
  }
  if (!out.rail) {
    console.error("FATAL: --rail=<railKey> is required");
    process.exit(1);
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
  await sql`SET statement_timeout = '30s'`;

  let declaredAhead = args.declaredAhead;
  let declaredAheadReadAt = null;
  if (declaredAhead === null) {
    const liveness = await loadProgramWideLiveRailKeys(sql);
    declaredAhead = declaredAheadFromLiveRailKeys(liveness.liveRailKeys);
    declaredAheadReadAt = liveness.readAt;
  }

  const loadStart = Date.now();
  const loaded = await loadCountyRailCells(sql, args.county, args.rail);
  const loadMs = Date.now() - loadStart;

  const verdict = evaluateRailGate(loaded.cells, args.rail, {
    programWideDeclaredAheadRailKeys: declaredAhead,
  });

  const payload = {
    kind: "parcel-b-gate-sched-rail-verdict",
    at: new Date().toISOString(),
    countyFips: args.county,
    railKey: args.rail,
    loadMs,
    pageCount: loaded.pageCount,
    parcelRowCount: loaded.parcelRowCount,
    readAt: loaded.readAt,
    declaredAheadSource: args.declaredAhead === null ? "computed-live" : "flag",
    declaredAheadReadAt,
    verdict,
  };

  console.log(JSON.stringify(payload));
  await sql.end();
}

main().catch(async (err) => {
  console.error(JSON.stringify({ kind: "parcel-b-gate-sched-rail-verdict-error", countyFips: args.county, railKey: args.rail, error: String(err && err.message || err) }));
  await sql.end({ timeout: 1 }).catch(() => {});
  process.exit(1);
});
