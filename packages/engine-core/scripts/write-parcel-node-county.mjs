#!/usr/bin/env node
/**
 * write-parcel-node-county.mjs — Rail 1 `parcel-node` writer.
 *
 * Walks a loaded county's `txgio_parcel` rows and emits `parcel-node` atoms,
 * closing the seam between the STATEWIDE factory (which loads parcel geometry)
 * and the atom layer the County Manifest counts. Before this CLI, every wave
 * county could land its geometry and Rail 1 would still read empty.
 *
 * TWO SEPARATE DATABASES — mixing them up is the exact bug warden-sweep's
 * header documents (`relation "txgio_parcel" does not exist` in prod):
 *   TXGIO_DATABASE_URL — the LDT deployment Neon carrying `txgio_parcel`
 *     (cadastral geometry). READ ONLY in this CLI; it is never written.
 *   DATABASE_URL / SUBSTRATE_DATABASE_URL — the ATOMS Neon. The only store
 *     this CLI writes, and only under --apply.
 * There is a DATABASE_URL fallback for the single-database dev setup, but prod
 * must set TXGIO_DATABASE_URL explicitly.
 *
 *   PARCEL_NODE_PATH=1 \
 *   TXGIO_DATABASE_URL=...ldt-deployment... \
 *   DATABASE_URL=...hauska_mcp... \
 *     pnpm --filter @hauska-engine/engine-core run write-parcel-node-county -- \
 *       --county=48261 [--apply] [--batch=500] [--limit=0] [--out=path.json]
 *
 * DRY RUN IS THE DEFAULT and it PREDICTS the apply. It reads the same rows,
 * builds the same plan, and reports atoms-that-would-be-written broken out by
 * kind. It is not a count of zero. Compare its numbers to the apply's; they
 * must match exactly.
 *
 * STORE-TRUTH SIZING (Geometry Law rule 8). `--list-counties` reads the county
 * roster from `txgio_parcel` AT EXECUTION TIME:
 *   SELECT county_fips, count(*), count(DISTINCT feature_index) ... GROUP BY 1
 * There is deliberately NO hardcoded county allowlist in this file. A
 * hardcoded 19-county allowlist blocked the entire statewide ingest once, and
 * process counts have disagreed with store truth before. If a county has rows,
 * this CLI can write its atoms; nothing else gates it.
 *
 * DE-DUPLICATION. `txgio_parcel` writes a feature once per 0.02-degree grid
 * cell its bbox intersects (PK `(county_fips, tile_key, feature_index)`), so a
 * naive row count over-reports parcels by the seam factor — 1.07x on the metro
 * blend, 4.46x on rural Kenedy. Reconciliation is on `feature_index`, the
 * shapefile sequence number, matching the PMTiles bake and the store readers.
 * ACCOUNT identity is kept separate from GEOMETRY identity: see
 * `src/parcel-node/plan-county-parcel-nodes.ts` for why a geometry-keyed dedup
 * would silently discard 133 Tarrant leasehold accounts sharing one polygon.
 *
 * IDEMPOTENT. `atom_did` is derived from `parcelNodeId`, `writePropertyAtomsBatch`
 * upserts on it, and `parcelNodeContentHash` hashes the claim rather than the
 * run timestamp, so a re-run over unchanged source neither duplicates rows nor
 * churns content hashes.
 *
 * WRITE-THEN-VERIFY (Geometry Law rule 3). After each applied batch the CLI
 * SELECTs the rows back out of `atoms` and re-validates the STORED BYTES
 * against `PARCEL_NODE_SCHEMA` plus the plan that produced them. A verify
 * failure is fatal — the run stops rather than continuing to write atoms whose
 * stored form was never confirmed.
 *
 * RE-ACQUISITION (invariants S1/S2 — see src/parcel-node/). Upsert alone is
 * only correct for a county being written for the FIRST time. On a re-acquire,
 * parcels that vanished from the source were previously left `status: "active"`
 * with a pointer at deleted geometry, reading as current forever. This CLI now
 * reconciles the prior active set against the plan, RETIRES the orphans, and
 * fails closed if any active orphan survives the pass — a run cannot report
 * success while stale rows still read as live. Keyless features are keyed
 * `_feature-<vintage>-<index>` so a shapefile reshuffle cannot upsert one
 * vintage's land onto another's; the prior vintage's synthetic rows drop out of
 * the plan and are retired like any other orphan.
 */

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

import {
  assertNoActiveOrphans,
  buildAtomsForPlan,
  planCountyParcelNodes,
  reconcileCountyParcelNodes,
  verifyStoredParcelNodeAtom,
} from "../src/parcel-node/index.ts";

const SOURCE_ADAPTER = "txgio-stratmap-bulk-v1";
const SOURCE_URL = "https://data.geographic.texas.gov/";

function parseArgs(argv) {
  const out = {
    county: null,
    apply: false,
    batch: 500,
    limit: 0,
    out: null,
    listCounties: false,
    keyKind: null,
    tier: "txgio-stratmap",
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
    else if (a === "--key-kind") out.keyKind = String(argv[++i] || "").trim();
    else if (a.startsWith("--key-kind=")) out.keyKind = a.slice("--key-kind=".length).trim();
    else if (a === "--tier") out.tier = String(argv[++i] || "").trim();
    else if (a.startsWith("--tier=")) out.tier = a.slice("--tier=".length).trim();
  }
  return out;
}

if (process.env.PARCEL_NODE_PATH !== "1") {
  console.error("FATAL: PARCEL_NODE_PATH=1 required (guards against an accidental invocation).");
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

const txgioUrl =
  process.env.TXGIO_DATABASE_URL?.trim() ||
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();
if (!txgioUrl) {
  console.error("FATAL: TXGIO_DATABASE_URL (or CORTEX_DATABASE_URL / DATABASE_URL) required — the store holding txgio_parcel.");
  process.exit(1);
}

const txSql = postgres(txgioUrl, { max: 4, ssl: "require", prepare: false });

/**
 * STORE-TRUTH ROSTER (Geometry Law rule 8): the set of counties that have
 * parcel geometry is whatever `txgio_parcel` says RIGHT NOW. Never a constant.
 */
async function readCountyRosterFromStore() {
  return txSql`
    SELECT county_fips,
           count(*)::int AS rows,
           count(DISTINCT feature_index)::int AS features,
           min(source_vintage) AS min_vintage,
           max(source_vintage) AS max_vintage
    FROM txgio_parcel
    GROUP BY county_fips
    ORDER BY county_fips
  `;
}

if (args.listCounties) {
  try {
    const roster = await readCountyRosterFromStore();
    console.log(
      JSON.stringify(
        {
          event: "parcel-node.roster",
          source: "txgio_parcel (read at execution time — no hardcoded allowlist)",
          countyCount: roster.length,
          totalRows: roster.reduce((a, r) => a + r.rows, 0),
          totalFeatures: roster.reduce((a, r) => a + r.features, 0),
          counties: roster.map((r) => ({
            countyFips: r.county_fips,
            rows: r.rows,
            features: r.features,
            seamFactor: Number((r.rows / r.features).toFixed(4)),
            vintage: r.min_vintage === r.max_vintage ? r.min_vintage : `${r.min_vintage}..${r.max_vintage}`,
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    await txSql.end({ timeout: 5 });
  }
  process.exit(0);
}

if (!args.county || !/^\d{5}$/.test(args.county)) {
  console.error("FATAL: --county=<5-digit FIPS> required (or --list-counties).");
  await txSql.end({ timeout: 5 });
  process.exit(1);
}

if (args.keyKind && !["prop_id", "geo_id_crosswalk", "unresolved"].includes(args.keyKind)) {
  console.error("FATAL: --key-kind must be prop_id | geo_id_crosswalk | unresolved.");
  await txSql.end({ timeout: 5 });
  process.exit(1);
}
if (!["txgio-stratmap", "county-arcgis-override"].includes(args.tier)) {
  console.error("FATAL: --tier must be txgio-stratmap | county-arcgis-override.");
  await txSql.end({ timeout: 5 });
  process.exit(1);
}

const substrateUrl = resolveSubstrateDatabaseUrl();
if (args.apply && !substrateUrl) {
  console.error("FATAL: --apply requires DATABASE_URL / SUBSTRATE_DATABASE_URL (the ATOMS store).");
  await txSql.end({ timeout: 5 });
  process.exit(1);
}

const handle = args.apply
  ? createPgStorage({ databaseUrl: substrateUrl, maxConnections: 8 })
  : null;

const t0 = performance.now();
const summary = {
  event: "parcel-node-county.done",
  county: args.county,
  mode: args.apply ? "apply" : "dry-run",
  storeTruth: null,
  plan: null,
  reconcile: null,
  atomsBuilt: 0,
  atomsWritten: 0,
  verified: 0,
  orphansRetired: 0,
  verifyFailures: [],
  errors: 0,
};

/**
 * Read the county's CURRENT active parcel-node rows so the reconcile can
 * compute the orphan set. Read in both modes: the dry run must predict the
 * retirements as well as the writes, or it is not a prediction of the apply.
 */
async function readPriorActiveParcelNodes(sql, countyFips) {
  const rows = await sql`
    SELECT body
    FROM atoms
    WHERE entity_type = 'parcel-node'
      AND body->>'countyFips' = ${countyFips}
  `;
  return rows.map((r) => ({
    parcelNodeId: r.body?.parcelNodeId,
    status: r.body?.status === "retired" ? "retired" : "active",
    sourceVintage: r.body?.sourceVintage ?? null,
  }));
}

try {
  // ---- Store-truth sizing for THIS county, at execution time.
  const roster = await readCountyRosterFromStore();
  const row = roster.find((r) => r.county_fips === args.county);
  if (!row) {
    console.error(
      JSON.stringify({
        event: "parcel-node-county.not-loaded",
        county: args.county,
        message:
          "county has zero rows in txgio_parcel — it is NOT-YET, not verified-absent. " +
          "Do not mint a _county_coverage anchor for it: that anchor means a source was " +
          "probed and found unpublished, which this CLI has not established.",
        loadedCounties: roster.map((r) => r.county_fips),
      }),
    );
    process.exitCode = 1;
  } else {
    summary.storeTruth = {
      rows: row.rows,
      features: row.features,
      seamFactor: Number((row.rows / row.features).toFixed(4)),
      vintage: row.min_vintage === row.max_vintage ? row.min_vintage : `${row.min_vintage}..${row.max_vintage}`,
      note: "read from txgio_parcel at execution time (Geometry Law rule 8)",
    };

    console.log(
      JSON.stringify({
        event: "parcel-node-county.start",
        county: args.county,
        mode: summary.mode,
        storeTruth: summary.storeTruth,
      }),
    );

    // ---- Read the county's rows. Keyset-paginated on (feature_index, tile_key)
    // so a long scan is stable and resumable; NOT OFFSET.
    const pageSize = Math.max(50, Math.min(args.batch, 2000));
    const rows = [];
    let lastFeature = -1;
    let lastTile = "";
    while (true) {
      if (args.limit > 0 && rows.length >= args.limit) break;
      const page = await txSql`
        SELECT feature_index, tile_key, prop_id, geo_id, geometry, source_vintage
        FROM txgio_parcel
        WHERE county_fips = ${args.county}
          AND (feature_index, tile_key) > (${lastFeature}, ${lastTile})
        ORDER BY feature_index, tile_key
        LIMIT ${pageSize}
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
      if (page.length < pageSize) break;
    }

    // Default key kind is prop_id; --key-kind=unresolved is how a crosswalk
    // county with no established join is run honestly.
    const policy = {
      countyFips: args.county,
      keyKind: args.keyKind ?? "prop_id",
      geometrySourceTier: args.tier,
    };

    const plan = planCountyParcelNodes(rows, policy);
    summary.plan = {
      rowsRead: plan.rowsRead,
      distinctFeatures: plan.distinctFeatures,
      seamFactor: plan.seamFactor,
      keyKind: policy.keyKind,
      wouldWriteTotal: plan.planned.length,
      wouldWriteResolved: plan.counts.resolved,
      wouldWriteAbsent: plan.counts.absent,
      wouldWriteAbsentByKind: plan.counts.absentByKind,
      multiFeatureAccounts: plan.counts.multiFeatureAccounts,
      foldedExtraFeatures: plan.counts.foldedExtraFeatures,
    };

    // The plan is built identically in both modes — this line is why the dry
    // run predicts the apply instead of merely counting.
    const provenance = {
      sourceAdapter: SOURCE_ADAPTER,
      sourceCitation: `TxGIO StratMap Land Parcels, county ${args.county}, vintage ${summary.storeTruth.vintage}`,
      sourceUrl: SOURCE_URL,
      observedAt: new Date().toISOString(),
      jurisdictionTenant: `tx_${args.county}`,
      verificationStatus: "machine",
    };
    const atoms = buildAtomsForPlan(plan, args.tier, provenance);
    summary.atomsBuilt = atoms.length;

    // ---- RE-ACQUISITION RECONCILE (invariant S2). Needs the atoms store, so
    // it only runs when one is configured. In dry-run WITHOUT a substrate URL
    // the orphan set is unknowable and is reported as such rather than as zero
    // — reporting zero orphans because we did not look is the lie this whole
    // module exists to prevent.
    let reconcile = null;
    let retireAtoms = [];
    if (substrateUrl) {
      const reconcileHandle =
        handle ?? createPgStorage({ databaseUrl: substrateUrl, maxConnections: 2 });
      try {
        const priorRows = await readPriorActiveParcelNodes(
          reconcileHandle.sql,
          args.county,
        );
        reconcile = reconcileCountyParcelNodes(
          priorRows,
          plan,
          summary.storeTruth.vintage,
        );

        // Retirement is a STATUS TRANSITION on the row, re-persisted through
        // the same writer seam so the retired body is contract-valid and
        // write-then-verifiable like any other. Bodies are rebuilt from the
        // stored row so retiring never invents a new claim.
        if (reconcile.orphans.length > 0) {
          const orphanIds = reconcile.orphans.map((o) => o.parcelNodeId);
          const retiredAt = new Date().toISOString();
          for (let i = 0; i < orphanIds.length; i += 500) {
            const idSlice = orphanIds.slice(i, i + 500);
            // PRIMARY KEY lookup, same reason as the verify below: a
            // `body->>'parcelNodeId' IN (...)` predicate seq-scans the whole
            // atoms table. parcel-node atom_did is deterministic
            // (`did:hauska:parcel-node:<parcelNodeId>`), so the orphan ids
            // map directly onto primary keys.
            const orphanDids = idSlice.map(
              (pid) => `did:hauska:parcel-node:${pid}`,
            );
            const stored = await reconcileHandle.sql`
              SELECT body FROM atoms
              WHERE atom_did IN ${reconcileHandle.sql(orphanDids)}
            `;
            for (const s of stored) {
              const orphan = reconcile.orphans.find(
                (o) => o.parcelNodeId === s.body?.parcelNodeId,
              );
              if (!orphan) continue;
              retireAtoms.push({
                ...s.body,
                status: "retired",
                retiredAt,
                retiredReason: orphan.reason,
              });
            }
          }
        }

        summary.reconcile = {
          priorActive: reconcile.priorActive,
          plannedIds: reconcile.plannedIds,
          ...reconcile.counts,
          orphanSample: reconcile.orphans.slice(0, 5),
          retireAtomsBuilt: retireAtoms.length,
        };
      } finally {
        if (!handle) await reconcileHandle.close();
      }
    } else {
      summary.reconcile = {
        skipped: true,
        reason:
          "no DATABASE_URL / SUBSTRATE_DATABASE_URL configured; the prior active set could not be " +
          "read, so the orphan set is UNKNOWN — not zero. Re-acquiring a county without this " +
          "reconcile is contract-unsafe.",
      };
    }

    if (!args.apply) {
      console.log(
        JSON.stringify({
          event: "parcel-node-county.dry-run-prediction",
          county: args.county,
          ...summary.plan,
          atomsBuilt: atoms.length,
          reconcile: summary.reconcile,
          sample: atoms.slice(0, 3).map((a) => ({
            parcelNodeId: a.parcelNodeId,
            geometryLoaded: a.geometryLoaded,
            absenceKind: a.absence?.kind ?? null,
          })),
          note: "every atom above was CONSTRUCTED and contract-validated; --apply persists exactly these, and retires the orphans reported above",
        }),
      );
    } else {
      for (let i = 0; i < atoms.length; i += args.batch) {
        const slice = atoms.slice(i, i + args.batch);
        await handle.storage.writePropertyAtomsBatch(slice);
        summary.atomsWritten += slice.length;

        // ---- Write-then-verify on the STORED BYTES (Geometry Law rule 3).
        //
        // LOOK ROWS UP BY THE PRIMARY KEY, never by a jsonb expression.
        // `body->>'parcelNodeId' IN (...)` is an expression predicate that no
        // index serves for a large array, so Postgres seq-scans the WHOLE
        // atoms table once per batch. Measured 2026-08-11 on the live table at
        // 16.2M rows: 229,382 ms per 5,000-id batch (22 atoms/sec) versus
        // 399 ms by atom_did (12,531 atoms/sec) — 575x. Past ~11M rows the
        // table no longer fits cache and the scan turns into physical I/O that
        // also evicts and dirties pages the sweep's own writes need
        // (EXPLAIN BUFFERS: read=3,230,674 dirtied=212,124).
        //
        // WHAT DID NOT CHANGE: this still reads the STORED BYTES back and
        // re-validates them. Only HOW the rows are located changed.
        const dids = slice.map((a) => a.atomDid);
        const stored = await handle.sql`
          SELECT body FROM atoms
          WHERE atom_did IN ${handle.sql(dids)}
        `;
        const storedById = new Map(
          stored.map((s) => [s.body?.parcelNodeId, s.body]),
        );
        for (const atom of slice) {
          const back = storedById.get(atom.parcelNodeId);
          if (!back) {
            summary.verifyFailures.push({
              parcelNodeId: atom.parcelNodeId,
              problem: "atom not readable back from the store after write",
            });
            continue;
          }
          const verdict = verifyStoredParcelNodeAtom(back, {
            parcelNodeId: atom.parcelNodeId,
            outcome: atom.geometryLoaded ? "resolved" : "absent",
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
            event: "parcel-node-county.progress",
            county: args.county,
            written: summary.atomsWritten,
            verified: summary.verified,
            ofTotal: atoms.length,
          }),
        );
      }

      // ---- ORPHAN RETIREMENT (invariant S2), after the upserts so the new
      // plan is fully landed before anything is taken out of currency.
      if (retireAtoms.length > 0) {
        for (let i = 0; i < retireAtoms.length; i += args.batch) {
          const slice = retireAtoms.slice(i, i + args.batch);
          await handle.storage.writePropertyAtomsBatch(slice);
          summary.orphansRetired += slice.length;
        }
        console.log(
          JSON.stringify({
            event: "parcel-node-county.orphans-retired",
            county: args.county,
            retired: summary.orphansRetired,
          }),
        );
      }

      // ---- FAIL-CLOSED post-condition (invariant S2). Read the store back and
      // require that no active row for this county is absent from the plan.
      // Gated on what the STORE now holds, never on what we intended to write.
      if (reconcile) {
        const remaining = await handle.sql`
          SELECT body->>'parcelNodeId' AS parcel_node_id
          FROM atoms
          WHERE entity_type = 'parcel-node'
            AND body->>'countyFips' = ${args.county}
            AND coalesce(body->>'status', 'active') <> 'retired'
        `;
        const verdict = assertNoActiveOrphans(
          reconcile,
          remaining.map((r) => r.parcel_node_id),
        );
        summary.orphanVerdict = verdict;
        if (!verdict.ok) {
          throw new Error(
            `ORPHAN RETIREMENT FAILED (invariant S2): ${verdict.problem}; ` +
              `still active: ${JSON.stringify(verdict.stillActive)}`,
          );
        }
      }
    }
  }

  summary.wallMs = Math.round(performance.now() - t0);
  console.log(JSON.stringify(summary, null, 2));
  if (args.out) {
    writeFileSync(args.out, JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ event: "parcel-node-county.artifact", path: args.out }));
  }
} catch (err) {
  summary.errors += 1;
  summary.error = String(err?.stack || err);
  console.error(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
} finally {
  await txSql.end({ timeout: 5 });
  if (handle) await handle.close();
}
