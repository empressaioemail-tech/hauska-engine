#!/usr/bin/env node
/**
 * onboard-preflight CLI — the OPS-8 pre-flight gate for a fips (operator-
 * ratified 2026-08-03). Same invocation style as block13-cert-grade.mjs:
 * env DATABASE_URL etc., exits on its own, prints JSON.
 *
 * READ-ONLY. Never throws for an expected condition — every check produces
 * PASS or a NAMED decline. Checks that need live DB/network run only when
 * creds/config are present; without them the check honestly declines
 * "not runnable: <missing env>" rather than faking a PASS.
 *
 *   DATABASE_URL=... NODE_OPTIONS=--use-system-ca \
 *     pnpm --filter @hauska-engine/engine-core exec tsx scripts/onboard-preflight.mjs --fips=48021
 */
import postgres from "postgres";
import { resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";
import { runOnboardPreflight } from "../src/registry/onboard-preflight.ts";

function parseArgs(argv) {
  const out = { fips: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fips") out.fips = String(argv[++i] || "").trim();
    else if (a.startsWith("--fips=")) out.fips = a.slice("--fips=".length).trim();
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.fips) {
  console.error("FATAL: --fips=<fips> required");
  process.exit(2);
}

const url = resolveSubstrateDatabaseUrl();
const sql = url ? postgres(url, { ssl: "require", max: 2, prepare: false }) : null;

/** Rail A / zoning source reachability — a plain HTTP HEAD/GET against the registry row's URL. */
async function probeHttpReachable(targetUrl, label) {
  if (!targetUrl) return { reachable: false, detail: `${label}: no URL on row` };
  try {
    const res = await fetch(targetUrl, { method: "GET", signal: AbortSignal.timeout(10_000) });
    return { reachable: res.ok, detail: res.ok ? undefined : `${label} HTTP ${res.status}` };
  } catch (err) {
    return { reachable: false, detail: `${label}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const deps = {
  probeRailASource: async (row) => {
    const layerUrl = row.railPerParcel?.featureServerLayerUrl;
    if (!layerUrl) return { reachable: false, detail: "no railPerParcel featureServerLayerUrl on row" };
    return probeHttpReachable(`${layerUrl.replace(/\/$/, "")}?f=json`, "Rail A featureServer");
  },
  probeZoningSource: async (row) => {
    // The registry row does not yet carry a distinct zoning-source URL field
    // (zoning is served off the same Rail A layer for euclidean-zoned rows
    // today); probe the same layer as a reachability proxy.
    const layerUrl = row.railPerParcel?.featureServerLayerUrl;
    if (!layerUrl) return { reachable: false, detail: "no zoning source wired on row" };
    return probeHttpReachable(`${layerUrl.replace(/\/$/, "")}?f=json`, "zoning source");
  },
  // NOTE: buildable-envelope atom bodies carry `parcelNodeId` (e.g.
  // "48021:34145"), never a `countyFips` key — confirmed against
  // emit-buildable-envelope.ts and every other county-scoped query in this
  // repo (block13-cert-grade.mjs, depth-warm-*-batch.mjs, tally-*-depth.mjs
  // all filter on `body->>'parcelNodeId' LIKE '<fips>:%'`). Filtering on a
  // key that never exists on the row silently matches zero atoms — a 0/0
  // "PASS" that looks like "measured, zero superseded" but is actually
  // "measurement path broken" (caught live against Bastrop 2026-08-03; see
  // onboard-preflight.ts's MEASURE-EMPTY-COHORT decline, which is the
  // backstop for this class of bug even after this fix).
  probeSupersededCohort: sql
    ? async (row) => {
        const fipsPrefix = `${row.fips}:%`;
        const [{ total }] = await sql`
          SELECT count(*)::int AS total FROM atoms
          WHERE entity_type = 'buildable-envelope' AND body->>'parcelNodeId' LIKE ${fipsPrefix}
        `;
        const [{ superseded }] = await sql`
          SELECT count(*)::int AS superseded FROM atoms
          WHERE entity_type = 'buildable-envelope' AND body->>'parcelNodeId' LIKE ${fipsPrefix}
            AND body ? 'supersededVintage'
        `;
        return { supersededCount: superseded, totalCount: total };
      }
    : undefined,
  probeMixedVintageResidue: sql
    ? async (row) => {
        const fipsPrefix = `${row.fips}:%`;
        const [{ residue }] = await sql`
          SELECT count(*)::int AS residue FROM atoms
          WHERE entity_type = 'buildable-envelope' AND body->>'parcelNodeId' LIKE ${fipsPrefix}
            AND body ? 'staleResidue'
        `;
        return { residueCount: residue, measured: true };
      }
    : undefined,
  // probeGeometryParity, probeServePathHealth, probeCostSample are left
  // unconfigured here deliberately: they require, respectively, a live
  // geometry-warm run against a sample, a deployed serve-path endpoint, and
  // a metered sample-cohort run. None are mechanically derivable from the
  // registry row + this repo's local config alone — each declines
  // "not runnable" honestly per the dispatch rule, never a fake PASS.
};

try {
  const { report, ledgerEvents } = await runOnboardPreflight(args.fips, deps);
  console.log(JSON.stringify({ report, ledgerEvents }, null, 2));
  const anyDecline = report.rows.some((r) => r.railPlan.declines.length > 0);
  if (anyDecline) process.exitCode = 0; // declines are expected output, not a script failure
} finally {
  if (sql) await sql.end();
}
