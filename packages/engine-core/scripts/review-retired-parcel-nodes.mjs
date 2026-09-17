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
 * LIVE CORROBORATION IS COUNTY-SPECIFIC. Bastrop (48021) has used
 * parcelCurrencyFromBcadMap against the public Bastrop cadastral FeatureServer since
 * P-212 (the same source bastrop-batch-bulk-prefetch.mjs and depth-warm-city-batch.mjs
 * use). P-275 adds a second, independent reading for Caldwell (48055), Hays (48209),
 * Travis (48453) and Williamson (48491) via `county-parcel-id-currency.mjs`, each against
 * that county's OWN public cadastral service. McLennan (48309) has NO usable public
 * county-wide service and therefore NO registered source — deliberately, and reported as
 * such (see LIVE_CURRENCY_SOURCES).
 *
 * THE READING IS TRI-STATE (P-275). A candidate is `live`, `absent` (the county's own
 * source was asked and does not have it), or `unmeasured` (nobody asked: no source
 * registered, the source was unreachable, the chunk failed, or the id is a synthetic
 * within-vintage key that no external service can be asked about). A county with no
 * source reports its candidates as UNMEASURED — never as "not found" — because the
 * absence of a measurement is not a measurement of absence.
 *
 *   PARCEL_NODE_PATH=1 \
 *   TXGIO_DATABASE_URL=...ldt-deployment... \
 *   DATABASE_URL=...hauska_mcp... \
 *     pnpm --filter @hauska-engine/engine-core run review-retired-parcel-nodes -- \
 *       --county=48021 [--apply --run-id=<id>] [--out=path.json] [--blast-radius-override=<token>]
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
  isSyntheticParcelKey,
  planCountyParcelNodes,
  reviewRetiredParcelNodes,
} from "../src/parcel-node/index.ts";
import {
  consumeRunIdArg,
  railLeaseArgs,
  refuseApplyWithoutRunId,
} from "./writer-apply-lease.mjs";
import {
  LIVE_CURRENCY_SOURCES,
  NO_SOURCE_REASONS,
  registeredLiveCurrencyCounties,
} from "./county-live-currency-sources.mjs";
import {
  MAX_REACTIVATION_SHARE,
  REACTIVATION_TRANSITION,
  REACTIVATION_WRITER,
  planReactivationWrite,
  reactivationOverrideFromEnv,
  reactivationOverrideValue,
} from "./retired-reactivation-guard.mjs";

/**
 * The registry itself lives in `county-live-currency-sources.mjs` — one place that says which
 * county is read from where, by which field, and why that field is the node-id namespace. See that
 * file for the Q1/Q2 test, the Williamson `QuickRefID` trap, and the county that deliberately
 * registers nothing. This CLI never imports a source directly: it asks the registry, and reports
 * the registry's own shape in the summary so a reader can tell "no candidates" from "no source".
 */
const REGISTRY_SUMMARY = {
  registered: registeredLiveCurrencyCounties(),
  noSourceReason: NO_SOURCE_REASONS,
};

function parseArgs(argv) {
  const out = { county: null, apply: false, out: null, runId: null, blastRadiusOverride: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--county") out.county = String(argv[++i] || "").trim();
    else if (a.startsWith("--county=")) out.county = a.slice("--county=".length).trim();
    else if (a === "--apply") out.apply = true;
    else if (a === "--out") out.out = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length).trim() || null;
    else if (a === "--blast-radius-override") out.blastRadiusOverride = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--blast-radius-override=")) {
      out.blastRadiusOverride = a.slice("--blast-radius-override=".length).trim() || null;
    } else {
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
  // P-275: the live-currency reading is tri-state, and the three counts are reported apart.
  // `unmeasured` is NOT folded into anything: it is the absence of a reading, not a reading.
  liveCurrencySource: LIVE_CURRENCY_SOURCES[args.county] ? "registered" : "none-registered",
  liveCurrencyRegistry: REGISTRY_SUMMARY,
  liveCurrencyRequests: 0,
  confirmedLive: 0,
  confirmedAbsent: 0,
  unmeasured: 0,
  unmeasuredReasons: [],
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

    // The county's whole parcel-node population, so a retired SHARE has a denominator that is
    // stated rather than assumed. One aggregate on the same predicate as the retired read.
    const [countyCounts] = await reviewSql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE body->>'status' = 'retired')::int AS retired
      FROM atoms
      WHERE entity_type = 'parcel-node'
        AND body->>'countyFips' = ${args.county}
    `;
    summary.countyParcelNodesRetiredAsStored = countyCounts.retired;
    if (countyCounts.retired !== retired.length) {
      // Read at two different instants, or the row filter disagrees. Either way it is stated, so a
      // reader knows the shares below rest on the same predicate as the review.
      summary.countyParcelNodesRetiredNote =
        "the aggregate and the row read disagreed on the retired count; the row read is authoritative for this review";
    }

    const review = reviewRetiredParcelNodes(retired, plan);
    summary.priorRetired = review.priorRetired;
    summary.candidates = review.candidates.length;
    summary.stillAbsent = review.stillAbsent;

    // ---- Live corroboration, county-specific, TRI-STATE (P-275).
    //
    // Three things a candidate can be, and they are not interchangeable:
    //   live        the county's own source answered and HAS this id.
    //   absent      the county's own source answered and does NOT have this id.
    //   unmeasured  nobody obtained an answer: no source registered, the source was
    //               unreachable, a chunk failed, or the id is a synthetic within-vintage key
    //               that no external service can be asked about at all.
    //
    // `unmeasured` is never reported as `absent`. That conflation is the defect this replaces:
    // an unreachable source used to look exactly like a county-wide "the parcels are gone".
    const source = LIVE_CURRENCY_SOURCES[args.county];
    const liveCurrency = new Map();
    if (review.candidates.length > 0) {
      if (!source) {
        for (const c of review.candidates) {
          liveCurrency.set(c.parcelNodeId, {
            reading: "unmeasured",
            reason: `no live-currency source registered for county ${args.county}`,
          });
        }
      } else {
        // A synthetic key is `{county}:{SYNTHETIC_PARCEL_KEY_PREFIX}...` — an identity scoped to
        // one source vintage (invariant S1). It is not a live-queryable identity anywhere, so
        // asking a county about it would be asking a meaningless question; the honest reading is
        // UNMEASURED with that reason, and it must not be reported as absent.
        const askable = [];
        for (const c of review.candidates) {
          if (isSyntheticParcelKey(c.parcelNodeId)) {
            liveCurrency.set(c.parcelNodeId, {
              reading: "unmeasured",
              reason:
                "synthetic within-vintage key: it is an identity for one source vintage only " +
                "(invariant S1), not a parcel identifier any external service can be asked about",
            });
          } else {
            askable.push(c.parcelNodeId);
          }
        }
        if (askable.length > 0) {
          let liveRequests = typeof source.requests === "number" ? source.requests : null;
          try {
            const byId = await source(askable.map((id) => id.split(":")[1]));
            // The request count is a property of the READER (a getter), not of the Map it returns:
            // reading `.requests` off the Map silently reported 0 for every county that did ask.
            if (typeof source.requests === "number") liveRequests = source.requests;
            for (const id of askable) {
              const key = id.split(":")[1];
              // The Bastrop source keys by normalized propId, the ArcGIS reader by normalized
              // id; accept either spelling of the same token.
              const reading = byId.get(key) ?? byId.get(String(Number(key))) ?? byId.get(key.replace(/^0+(?=\d)/, ""));
              if (reading && typeof reading === "object" && typeof reading.reading === "string") {
                liveCurrency.set(id, reading);
              } else if (reading === true || reading === "live") {
                liveCurrency.set(id, { reading: "live" });
              } else if (reading === false || reading === "absent") {
                liveCurrency.set(id, { reading: "absent" });
              } else {
                liveCurrency.set(id, {
                  reading: "unmeasured",
                  reason: `county ${args.county} source returned no reading for this id`,
                });
              }
            }
          } catch (err) {
            // WHOLE-SOURCE failure (bad URL, DNS, no such field on the layer, non-JSON). Every
            // candidate of this county becomes UNMEASURED with the transport reason -- the run
            // does not report zero candidates and does not report them as absent.
            summary.liveCurrencySource = "unreachable";
            const reason = `county ${args.county} live-currency source unreachable: ${err?.message ?? err}`;
            for (const id of askable) liveCurrency.set(id, { reading: "unmeasured", reason });
          }
          summary.liveCurrencyRequests = liveRequests;
        }
      }
    }

    const verdict = decideRetiredParcelNodeReactivations(review, liveCurrency);
    summary.confirmedLive = verdict.reactivate.length;
    summary.confirmedAbsent = verdict.confirmedAbsent.length;
    summary.unmeasured = verdict.unmeasured.length;
    summary.unmeasuredReasons = [
      ...new Set(verdict.unmeasured.map((u) => u.reason.replace(/UNMEASURED: /, ""))),
    ].slice(0, 5);
    summary.reactivated = verdict.reactivate.length;
    summary.stillRetired = verdict.stillRetired.length;

    // ---- The share readings, each with its denominator NAMED IN THE KEY, because the dispatch's
    // falsifier turns on exactly this: a "live count" is meaningless without the set it was
    // measured over. Three different shares, three different denominators:
    //   retiredShareOfCountyNodes_*        denominator = ALL of the county's parcel-node atoms
    //   reactivationShareOfRetiredPopulation  denominator = the retired atoms this run drew from
    // The last one is also the blast-radius denominator, so a reader can see the number the guard
    // was measured against rather than inferring it.
    summary.countyParcelNodes = countyCounts.total;
    summary.retiredShareOfCountyNodesBefore =
      countyCounts.total > 0 ? review.priorRetired / countyCounts.total : null;
    summary.retiredShareOfCountyNodesAfterHypotheticalReactivation =
      countyCounts.total > 0
        ? (review.priorRetired - verdict.reactivate.length) / countyCounts.total
        : null;
    summary.reactivationShareOfRetiredPopulation =
      review.priorRetired > 0 ? verdict.reactivate.length / review.priorRetired : null;
    summary.reactivateSample = verdict.reactivate.slice(0, 20);
    summary.confirmedAbsentSample = verdict.confirmedAbsent.slice(0, 20);
    summary.unmeasuredSample = verdict.unmeasured.slice(0, 20);

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
      // P-275: the blast-radius refusal on the REACTIVATION direction, BEFORE the write lease.
      // `planReactivationWrite` throws (BLAST_RADIUS_EXCEEDED, or an override mismatch/malformed
      // token) rather than returning a plan, so the `await takeScopedLease` below is unreachable
      // on a refusal. Nothing is written, and the refusal names the exact token that would
      // authorize THESE measured counts.
      summary.blastRadiusControl = {
        writer: REACTIVATION_WRITER,
        transition: REACTIVATION_TRANSITION,
        maxShare: MAX_REACTIVATION_SHARE,
        denominator: "the county's prior retired rows this reactivation is drawn from",
      };
      const writePlan = planReactivationWrite({
        countyFips: args.county,
        review,
        verdict,
        override: args.blastRadiusOverride ?? reactivationOverrideFromEnv(),
      });
      summary.blastRadius = writePlan.blastRadius;
      if (!writePlan.write) {
        console.log(JSON.stringify({ ...summary, note: writePlan.reason }, null, 2));
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
  // P-213/P-275: a blast-radius refusal carries its own measured record (share, affected,
  // population) plus the exact token that would authorize it -- surface both, so the refusal is
  // as legible as a pass and the authorized re-run is mechanical rather than a hunt.
  if (err?.record) summary.blastRadius = err.record;
  if (err?.code === "BLAST_RADIUS_EXCEEDED" && err?.expectedToken) {
    summary.blastRadiusOverrideNeeded = err.expectedToken;
    summary.blastRadiusReRunHint =
      `re-execute with --blast-radius-override=${reactivationOverrideValue(args.county, err.affected, err.population)}`;
  }
  console.error(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
} finally {
  await txSql.end({ timeout: 5 });
  if (handle) await handle.close();
  else await reviewSql.end({ timeout: 5 });
}
