#!/usr/bin/env node
/**
 * review-retired-parcel-nodes.mjs — P-212 retired-row review and repair.
 *
 * write-parcel-node-county.mjs's reconcile only ever examines rows CURRENTLY
 * `status: 'active'` (see reconcileCountyParcelNodes). A row a bad run once
 * retired stays retired forever, however complete a later plan becomes. This
 * CLI is the recovery path invariant S2 never provided: it re-derives the
 * CURRENT plan the same way the writer does, narrows every retired row down
 * to CANDIDATES the current plan predicts again (reviewRetiredParcelNodes),
 * then gates actual reactivation on a LIVE per-parcel corroboration
 * (decideRetiredParcelNodeReactivations) so a candidate the internal plan
 * re-predicts but a live source does NOT confirm — the exact shape of the
 * `77293` negative control — stays retired.
 *
 * REGENERATE, NOT HAND-PATCH. This never issues a bulk `UPDATE ... SET
 * status='active'`. Every reactivation is a re-derived, individually-reasoned
 * status transition through the same writer seam (writePropertyAtomsBatch)
 * as any other atom write, under the SAME (store, entity_type=parcel-node,
 * county_fips) write-slot lease write-parcel-node-county.mjs takes, and is
 * write-then-verified against the stored bytes exactly like that CLI.
 *
 * DRY RUN IS THE DEFAULT and predicts the apply: it builds the same
 * candidate list and runs the same live corroboration, reporting exactly
 * what would be reactivated and what would stay retired, without writing.
 *
 * LIVE CORROBORATION IS COUNTY-SPECIFIC. Only Bastrop (48021) has a wired
 * live source today (parcelCurrencyFromBcadMap against the public Bastrop
 * cadastral FeatureServer, the same one bastrop-batch-bulk-prefetch.mjs and
 * depth-warm-city-batch.mjs already use). A county with no registered live
 * source reports its candidates but reactivates none of them — no live
 * corroboration is available, so none is assumed; candidates are reported so
 * a human can register that county's source next, never dropped silently.
 *
 *   PARCEL_NODE_PATH=1 \
 *   TXGIO_DATABASE_URL=...ldt-deployment... \
 *   DATABASE_URL=...hauska_mcp... \
 *     pnpm --filter @hauska-engine/engine-core run review-retired-parcel-nodes -- \
 *       --county=48021 [--apply --run-id=<id>] [--out=path.json]
 */

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import postgres from "postgres";
import {
  createPgStorage,
  resolveSubstrateDatabaseUrl,
  takeScopedLease,
  releaseScopedLease,
} from "@hauska-engine/storage";

import {
  decideRetiredParcelNodeReactivations,
  planCountyParcelNodes,
  reviewRetiredParcelNodes,
} from "../src/parcel-node/index.ts";
import {
  consumeRunIdArg,
  railLeaseArgs,
  refuseApplyWithoutRunId,
} from "./writer-apply-lease.mjs";
import { parcelCurrencyFromBcadMap, bulkLoadBcadRingsByPropId } from "./bastrop-batch-bulk-prefetch.mjs";

/** County FIPS -> a function producing a propId -> boolean live-currency map. */
const LIVE_CURRENCY_SOURCES = {
  "48021": async (propIds) => {
    const bcadByPropId = await bulkLoadBcadRingsByPropId(propIds);
    const out = new Map();
    for (const propId of propIds) {
      out.set(propId, parcelCurrencyFromBcadMap(propId, bcadByPropId).ok);
    }
    return out;
  },
};

function parseArgs(argv) {
  const out = { county: null, apply: false, out: null, runId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--county") out.county = String(argv[++i] || "").trim();
    else if (a.startsWith("--county=")) out.county = a.slice("--county=".length).trim();
    else if (a === "--apply") out.apply = true;
    else if (a === "--out") out.out = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length).trim() || null;
    else {
      const next = consumeRunIdArg(a, argv, i, out);
      if (next !== null) i = next;
    }
  }
  return out;
}

if (process.env.PARCEL_NODE_PATH !== "1") {
  console.error("FATAL: PARCEL_NODE_PATH=1 required (guards against an accidental invocation).");
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (refuseApplyWithoutRunId("review-retired-parcel-nodes.refused", args.apply, args.runId)) {
  process.exit(2);
}
if (!args.county || !/^\d{5}$/.test(args.county)) {
  console.error("FATAL: --county=<5-digit FIPS> required.");
  process.exit(1);
}

const txgioUrl =
  process.env.TXGIO_DATABASE_URL?.trim() ||
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();
if (!txgioUrl) {
  console.error("FATAL: TXGIO_DATABASE_URL (or CORTEX_DATABASE_URL / DATABASE_URL) required.");
  process.exit(1);
}
const substrateUrl = resolveSubstrateDatabaseUrl();
if (!substrateUrl) {
  console.error("FATAL: DATABASE_URL / SUBSTRATE_DATABASE_URL required (the ATOMS store).");
  process.exit(1);
}

const txSql = postgres(txgioUrl, { max: 4, ssl: "require", prepare: false });
const handle = args.apply
  ? createPgStorage({ databaseUrl: substrateUrl, maxConnections: 8 })
  : null;
const reviewSql = handle
  ? handle.sql
  : postgres(substrateUrl, { max: 2, ssl: "require", prepare: false });

const t0 = performance.now();
const summary = {
  event: "review-retired-parcel-nodes.done",
  county: args.county,
  mode: args.apply ? "apply" : "dry-run",
  priorRetired: 0,
  candidates: 0,
  stillAbsent: 0,
  liveCurrencySource: LIVE_CURRENCY_SOURCES[args.county] ? "registered" : "none-registered",
  reactivated: 0,
  stillRetired: 0,
  verifyFailures: [],
  errors: 0,
};

try {
  // ---- Read the CURRENT complete county rows, exactly as write-parcel-node-county.mjs does.
  const rows = [];
  {
    let lastFeature = -1;
    let lastTile = "";
    while (true) {
      const page = await txSql`
        SELECT feature_index, tile_key, prop_id, geo_id, geometry, source_vintage
        FROM txgio_parcel
        WHERE county_fips = ${args.county}
          AND (feature_index, tile_key) > (${lastFeature}, ${lastTile})
        ORDER BY feature_index, tile_key
        LIMIT 2000
      `;
      if (page.length === 0) break;
      for (const p of page) {
        rows.push({
          featureIndex: p.feature_index,
          tileKey: p.tile_key,
          propId: p.prop_id,
          geoId: p.geo_id,
          geometry: p.geometry,
          sourceVintage: p.source_vintage,
        });
      }
      lastFeature = page[page.length - 1].feature_index;
      lastTile = page[page.length - 1].tile_key;
      if (page.length < 2000) break;
    }
  }
  if (rows.length === 0) {
    console.error(
      JSON.stringify({
        event: "review-retired-parcel-nodes.not-loaded",
        county: args.county,
        message: "county has zero rows in txgio_parcel right now -- cannot build a current plan to review against.",
      }),
    );
    process.exitCode = 1;
  } else {
    const plan = planCountyParcelNodes(rows, {
      countyFips: args.county,
      keyKind: "prop_id",
      geometrySourceTier: "txgio-stratmap",
    });

    // ---- Read every retired parcel-node row for this county.
    const storedRows = await reviewSql`
      SELECT body
      FROM atoms
      WHERE entity_type = 'parcel-node'
        AND body->>'countyFips' = ${args.county}
        AND body->>'status' = 'retired'
    `;
    const retired = storedRows.map((r) => ({
      parcelNodeId: r.body?.parcelNodeId,
      status: "retired",
      sourceVintage: r.body?.sourceVintage ?? null,
      retiredAt: r.body?.retiredAt ?? null,
      retiredReason: r.body?.retiredReason ?? null,
    }));

    const review = reviewRetiredParcelNodes(retired, plan);
    summary.priorRetired = review.priorRetired;
    summary.candidates = review.candidates.length;
    summary.stillAbsent = review.stillAbsent;

    // ---- Live corroboration, county-specific. No registered source => empty
    // map => decideRetiredParcelNodeReactivations reactivates nothing, and
    // every candidate is reported under stillRetired so it is never dropped.
    const source = LIVE_CURRENCY_SOURCES[args.county];
    let liveCurrency = new Map();
    if (source && review.candidates.length > 0) {
      const propIds = review.candidates.map((c) => c.parcelNodeId.split(":")[1]);
      const byPropId = await source(propIds);
      liveCurrency = new Map(
        review.candidates.map((c) => [
          c.parcelNodeId,
          byPropId.get(c.parcelNodeId.split(":")[1]) === true,
        ]),
      );
    }

    const verdict = decideRetiredParcelNodeReactivations(review, liveCurrency);
    summary.reactivated = verdict.reactivate.length;
    summary.stillRetired = verdict.stillRetired.length;
    summary.reactivateSample = verdict.reactivate.slice(0, 20);
    summary.stillRetiredSample = verdict.stillRetired.slice(0, 20);

    if (!args.apply) {
      console.log(
        JSON.stringify(
          {
            event: "review-retired-parcel-nodes.dry-run-prediction",
            ...summary,
            note: "dry-run predicts the apply exactly: --apply persists exactly these reactivations, through the same writer seam and lease as write-parcel-node-county.mjs",
          },
          null,
          2,
        ),
      );
    } else {
      if (verdict.reactivate.length === 0) {
        console.log(JSON.stringify({ ...summary, note: "nothing to reactivate" }, null, 2));
      } else {
        const lease = await takeScopedLease(
          handle.sql,
          railLeaseArgs({
            entityType: "parcel-node",
            countyFips: args.county,
            runId: args.runId,
            holderFallback: "review-retired-parcel-nodes",
          }),
        );
        try {
          // Bodies are rebuilt from the STORED row, never invented -- retiring
          // (and un-retiring) never writes a claim the store didn't already hold.
          const storedByParcelNodeId = new Map(
            storedRows.map((r) => [r.body?.parcelNodeId, r.body]),
          );
          const reactivatedAt = new Date().toISOString();
          const reactivateAtoms = verdict.reactivate
            .map((r) => {
              const body = storedByParcelNodeId.get(r.parcelNodeId);
              if (!body) return null;
              const next = { ...body, status: "active" };
              delete next.retiredAt;
              delete next.retiredReason;
              next.reactivatedAt = reactivatedAt;
              next.reactivatedReason = r.reactivatedReason;
              next.reactivationRunId = args.runId;
              // atomDid is deterministic from parcelNodeId (matches the lookup
              // write-parcel-node-county.mjs's own orphan-retire path relies on);
              // fall back to recomputing it if the stored body somehow lacks it.
              next.atomDid = next.atomDid ?? `did:hauska:parcel-node:${r.parcelNodeId}`;
              return next;
            })
            .filter(Boolean);

          await handle.storage.writePropertyAtomsBatch(reactivateAtoms, lease);

          // ---- Write-then-verify on the STORED BYTES, same discipline as
          // write-parcel-node-county.mjs: read the rows back and confirm the
          // status actually landed as active before reporting success.
          const dids = reactivateAtoms.map((a) => a.atomDid);
          const stored = await handle.sql`
            SELECT body FROM atoms WHERE atom_did IN ${handle.sql(dids)}
          `;
          const storedById = new Map(stored.map((s) => [s.body?.parcelNodeId, s.body]));
          for (const atom of reactivateAtoms) {
            const back = storedById.get(atom.parcelNodeId);
            if (!back || back.status !== "active") {
              summary.verifyFailures.push({
                parcelNodeId: atom.parcelNodeId,
                problem: "reactivation did not read back as active",
              });
            }
          }
          if (summary.verifyFailures.length > 0) {
            throw new Error(
              `write-then-verify FAILED on ${summary.verifyFailures.length} reactivation(s); ` +
                `first: ${JSON.stringify(summary.verifyFailures[0])}`,
            );
          }

          summary.event = "review-retired-parcel-nodes.applied";
          summary.runId = args.runId;
          summary.verified = reactivateAtoms.length - summary.verifyFailures.length;
          console.log(JSON.stringify(summary, null, 2));
        } finally {
          await releaseScopedLease(handle.sql, lease);
        }
      }
    }
  }

  summary.wallMs = Math.round(performance.now() - t0);
  if (args.out) {
    writeFileSync(args.out, JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ event: "review-retired-parcel-nodes.artifact", path: args.out }));
  }
} catch (err) {
  summary.errors += 1;
  summary.error = String(err?.stack || err);
  console.error(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
} finally {
  await txSql.end({ timeout: 5 });
  if (handle) await handle.close();
  else await reviewSql.end({ timeout: 5 });
}
