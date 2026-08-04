#!/usr/bin/env node
/**
 * bake-property-atom-county.mjs — Master WDLL 3.12 / breadth WDLL county bake.
 *
 * Reads cortex Neon place_layer_snapshots (CORTEX_DATABASE_URL).
 * Emits zoning-fact / setback-rule / buildable-envelope via emitters.
 * Writes via StoragePort batch to hauska_mcp (DATABASE_URL).
 * Monitors honest-absence rate; flags mid-run spikes.
 * Records per-county ledger + approx compute cost (I-H).
 *
 *   PROPERTY_ATOM_PATH=1 \
 *   DATABASE_URL=...hauska_mcp... \
 *   CORTEX_DATABASE_URL=...neondb... \
 *     pnpm --filter @hauska-engine/engine-core run bake-property-atom-county -- \
 *       --county=48055 [--limit=0] [--offset=0] [--batch=200] [--spike-pp=40]
 *
 * Acceptance: WDLL breadth items 2,3,7.
 *
 * --cascade-absence-only mode (additive; named-decline-beats-silent-absence
 * cascade for the 48021 unzoned cohort): reads DIRECTLY from substrate
 * (DATABASE_URL only — no CORTEX_DATABASE_URL / cortex snapshot scan in this
 * mode). Finds parcels that already carry an absence zoning-fact
 * (absence.kind = 'no-zoning-stamp', no district) AND have no
 * buildable-envelope atom yet; mints ONLY a buildable-envelope honest-decline
 * (R27 persisted-decline shape, code unzoned-no-district-basis) for each.
 * NEVER mints or updates zoning-fact or setback-rule atoms; NEVER touches a
 * parcel whose zoning-fact carries a real district (city cohort) — enforced
 * in the query itself. Idempotent/resumable: re-running skips parcels that
 * already have an envelope atom.
 *
 *   PROPERTY_ATOM_PATH=1 DATABASE_URL=...hauska_mcp... \
 *     pnpm --filter @hauska-engine/engine-core run bake-property-atom-county -- \
 *       --county=48021 --cascade-absence-only [--batch=200]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

import { emitFromTier1Snapshot } from "../src/property-reasoning/bake-from-tier1-snapshot.ts";
import { buildCascadeEnvelopeDecline } from "../src/property-reasoning/cascade-unzoned-envelope-decline.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER_DIR = join(
  HERE,
  "../src/property-reasoning/fixtures/breadth-ledgers",
);

const COUNTY_NAMES = {
  "48021": "Bastrop",
  "48027": "Bell",
  "48029": "Bexar",
  "48055": "Caldwell",
  "48091": "Comal",
  "48187": "Guadalupe",
  "48209": "Hays",
  "48309": "McLennan",
  "48453": "Travis",
  "48491": "Williamson",
  "48113": "Dallas",
  "48439": "Tarrant",
  "48085": "Collin",
  "48121": "Denton",
  "48397": "Rockwall",
  "48139": "Ellis",
  "48251": "Johnson",
  "48257": "Kaufman",
  "48367": "Parker",
};

function parseArgs(argv) {
  const out = {
    county: null,
    limit: 0,
    offset: 0,
    batch: 200,
    spikePp: 40,
    dryRun: false,
    cascadeAbsenceOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--county") out.county = String(argv[++i] || "").trim();
    else if (a.startsWith("--county=")) out.county = a.slice("--county=".length);
    else if (a === "--limit") out.limit = Number(argv[++i] || 0);
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice("--limit=".length));
    else if (a === "--offset") out.offset = Number(argv[++i] || 0);
    else if (a.startsWith("--offset=")) out.offset = Number(a.slice("--offset=".length));
    else if (a === "--batch") out.batch = Number(argv[++i] || 200);
    else if (a.startsWith("--batch=")) out.batch = Number(a.slice("--batch=".length));
    else if (a === "--spike-pp") out.spikePp = Number(argv[++i] || 40);
    else if (a.startsWith("--spike-pp="))
      out.spikePp = Number(a.slice("--spike-pp=".length));
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--cascade-absence-only") out.cascadeAbsenceOnly = true;
  }
  return out;
}

if (process.env.PROPERTY_ATOM_PATH !== "1") {
  console.error("FATAL: PROPERTY_ATOM_PATH=1 required.");
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (!args.county || !COUNTY_NAMES[args.county]) {
  console.error(
    `FATAL: --county=FIPS required. Known: ${Object.keys(COUNTY_NAMES).join(",")}`,
  );
  process.exit(1);
}

const substrateUrl = resolveSubstrateDatabaseUrl();
const cortexUrl = process.env.CORTEX_DATABASE_URL?.trim();
if (!substrateUrl) {
  console.error("FATAL: DATABASE_URL or SUBSTRATE_DATABASE_URL required.");
  process.exit(1);
}
// --cascade-absence-only reads/writes substrate only — no cortex snapshot scan.
if (!args.cascadeAbsenceOnly && !cortexUrl) {
  console.error("FATAL: CORTEX_DATABASE_URL required.");
  process.exit(1);
}

const handle = createPgStorage({ databaseUrl: substrateUrl, maxConnections: 8 });
const cortexSql = args.cascadeAbsenceOnly
  ? null
  : postgres(cortexUrl, {
      max: 4,
      ssl: "require",
      prepare: false,
    });

if (args.cascadeAbsenceOnly) {
  await runCascadeAbsenceOnly();
  process.exit(process.exitCode ?? 0);
}

const t0 = performance.now();
const prefix = `node:${args.county}:`;

const countRows = await cortexSql`
  select count(*)::int as n
  from place_layer_snapshots
  where adapter_key = 'node-facets:tier1'
    and place_key like ${prefix + "%"}
`;
const denominator = countRows[0]?.n ?? 0;

const ledger = {
  id: `breadth-county-${args.county}`,
  countyFips: args.county,
  countyName: COUNTY_NAMES[args.county],
  bakedAt: new Date().toISOString(),
  purpose: "WDLL 3.12 / breadth Central-TX property-atom county bake",
  geometryCeiling: "include-all-10 — live txgio_parcel has geometry for all metro counties",
  bounds: {
    denominatorTier1: denominator,
    offset: args.offset,
    limit: args.limit === 0 ? null : args.limit,
    explicitCap: args.limit > 0,
    dryRun: args.dryRun,
  },
  totals: {
    parcelsSeen: 0,
    parcelsEmitted: 0,
    atomsWritten: 0,
    zoningPresent: 0,
    zoningAbsence: 0,
    setbackPresent: 0,
    envelopePresent: 0,
    emitErrors: 0,
  },
  honestAbsenceRate: {
    zoning: null,
    note: "zoningAbsence / parcelsSeen — spike monitor vs baseline window",
  },
  spikeFlags: [],
  compute: {
    units: 0,
    wallMs: 0,
    approxUsdNote: "",
    costGateUsd: 200,
    flaggedOverCost: false,
  },
  status: "running",
};

mkdirSync(LEDGER_DIR, { recursive: true });

function flushLedger() {
  const path = join(LEDGER_DIR, `${args.county}.json`);
  writeFileSync(path, JSON.stringify(ledger, null, 2));
  return path;
}

const baselineWindow = 500;
let baselineAbsenceRate = null;
const rolling = [];
let atomBatch = [];

async function flushAtomBatch() {
  if (atomBatch.length === 0) return;
  if (!args.dryRun) {
    await handle.storage.writePropertyAtomsBatch(atomBatch);
  }
  ledger.totals.atomsWritten += atomBatch.length;
  ledger.compute.units += atomBatch.length;
  atomBatch = [];
}

function observeAbsence(isAbsence) {
  rolling.push(isAbsence ? 1 : 0);
  if (rolling.length > 1000) rolling.shift();
  if (ledger.totals.parcelsSeen === baselineWindow) {
    const abs = ledger.totals.zoningAbsence;
    baselineAbsenceRate = abs / baselineWindow;
  }
  if (baselineAbsenceRate != null && rolling.length >= 200) {
    const windowAbs = rolling.reduce((a, b) => a + b, 0) / rolling.length;
    const spikePp = (windowAbs - baselineAbsenceRate) * 100;
    if (spikePp >= args.spikePp) {
      const flag = {
        atParcel: ledger.totals.parcelsSeen,
        baselineAbsenceRate,
        windowAbsenceRate: windowAbs,
        spikePp,
        message:
          "Honest-absence rate spike — possible source outage; do not treat as silent no-answer",
      };
      if (
        ledger.spikeFlags.length === 0 ||
        ledger.spikeFlags[ledger.spikeFlags.length - 1].atParcel <
          ledger.totals.parcelsSeen - 500
      ) {
        ledger.spikeFlags.push(flag);
        console.error(JSON.stringify({ event: "breadth.absence-spike", ...flag }));
      }
    }
  }
}

console.log(
  JSON.stringify({
    event: "breadth-county-bake.start",
    county: args.county,
    name: COUNTY_NAMES[args.county],
    denominator,
    offset: args.offset,
    limit: args.limit || "all",
    dryRun: args.dryRun,
  }),
);

const pageSize = Math.max(50, Math.min(args.batch, 500));
let fetched = 0;
let dbOffset = args.offset;

try {
  while (true) {
    if (args.limit > 0 && fetched >= args.limit) break;

    const take =
      args.limit > 0 ? Math.min(pageSize, args.limit - fetched) : pageSize;

    const rows = await cortexSql`
      select place_key, payload_json
      from place_layer_snapshots
      where adapter_key = 'node-facets:tier1'
        and place_key like ${prefix + "%"}
      order by place_key
      limit ${take}
      offset ${dbOffset}
    `;
    ledger.compute.units += 1;

    if (rows.length === 0) break;

    for (const row of rows) {
      const placeKey = String(row.place_key || "");
      const parcelNodeId = placeKey.startsWith("node:")
        ? placeKey.slice("node:".length)
        : placeKey;
      ledger.totals.parcelsSeen += 1;
      fetched += 1;

      try {
        const emitted = emitFromTier1Snapshot(
          parcelNodeId,
          row.payload_json ?? {},
          args.county,
        );
        observeAbsence(emitted.zoningAbsence);
        if (emitted.zoningPresent) ledger.totals.zoningPresent += 1;
        if (emitted.zoningAbsence) ledger.totals.zoningAbsence += 1;
        if (emitted.setbackPresent) ledger.totals.setbackPresent += 1;
        if (emitted.envelopePresent) ledger.totals.envelopePresent += 1;

        for (const atom of emitted.atoms) {
          atomBatch.push(atom);
        }
        if (emitted.atoms.length > 0) ledger.totals.parcelsEmitted += 1;
        if (atomBatch.length >= args.batch) await flushAtomBatch();
      } catch (err) {
        ledger.totals.emitErrors += 1;
        console.error(
          JSON.stringify({
            event: "breadth.emit-error",
            parcelNodeId,
            error: String(err?.message || err),
          }),
        );
      }

      if (ledger.totals.parcelsSeen % 2000 === 0) {
        await flushAtomBatch();
        ledger.honestAbsenceRate.zoning =
          ledger.totals.parcelsSeen > 0
            ? ledger.totals.zoningAbsence / ledger.totals.parcelsSeen
            : null;
        ledger.compute.wallMs = Math.round(performance.now() - t0);
        flushLedger();
        console.log(
          JSON.stringify({
            event: "breadth.progress",
            county: args.county,
            parcelsSeen: ledger.totals.parcelsSeen,
            atomsWritten: ledger.totals.atomsWritten,
            zoningAbsenceRate: ledger.honestAbsenceRate.zoning,
            wallMs: ledger.compute.wallMs,
          }),
        );
      }
    }

    dbOffset += rows.length;
    if (rows.length < take) break;
  }

  await flushAtomBatch();

  ledger.honestAbsenceRate.zoning =
    ledger.totals.parcelsSeen > 0
      ? ledger.totals.zoningAbsence / ledger.totals.parcelsSeen
      : null;
  ledger.compute.wallMs = Math.round(performance.now() - t0);
  // Rough Neon CU estimate: ~$0.16/CU-hour; assume 0.25 CU sustained.
  const hours = ledger.compute.wallMs / 3_600_000;
  const approxUsd = hours * 0.25 * 0.16 + ledger.totals.atomsWritten * 0.000002;
  ledger.compute.approxUsd = Number(approxUsd.toFixed(4));
  ledger.compute.approxUsdNote =
    `wall=${ledger.compute.wallMs}ms units=${ledger.compute.units}; ` +
    `approx $${ledger.compute.approxUsd} (0.25 CU × $0.16/hr + $0.000002/atom write heuristic)`;
  ledger.compute.flaggedOverCost = approxUsd > ledger.compute.costGateUsd;
  ledger.bakedPct = {
    ofTier1Denominator:
      denominator > 0 ? ledger.totals.parcelsSeen / denominator : null,
    zoningPresentOfSeen:
      ledger.totals.parcelsSeen > 0
        ? ledger.totals.zoningPresent / ledger.totals.parcelsSeen
        : null,
    setbackOfSeen:
      ledger.totals.parcelsSeen > 0
        ? ledger.totals.setbackPresent / ledger.totals.parcelsSeen
        : null,
    envelopeOfSeen:
      ledger.totals.parcelsSeen > 0
        ? ledger.totals.envelopePresent / ledger.totals.parcelsSeen
        : null,
  };
  ledger.status =
    ledger.spikeFlags.length > 0
      ? "completed-with-spike-flags"
      : ledger.compute.flaggedOverCost
        ? "completed-over-cost-gate"
        : "completed";

  const path = flushLedger();
  console.log(
    JSON.stringify({
      event: "breadth-county-bake.done",
      ledgerPath: path,
      status: ledger.status,
      totals: ledger.totals,
      honestAbsenceRate: ledger.honestAbsenceRate,
      bakedPct: ledger.bakedPct,
      compute: ledger.compute,
      spikeFlags: ledger.spikeFlags,
    }),
  );

  if (ledger.compute.flaggedOverCost) {
    console.error(
      JSON.stringify({
        event: "breadth.cost-gate",
        county: args.county,
        approxUsd: ledger.compute.approxUsd,
        gate: ledger.compute.costGateUsd,
      }),
    );
    process.exitCode = 2;
  }
} catch (err) {
  ledger.status = "failed";
  ledger.error = String(err?.stack || err);
  flushLedger();
  console.error(err);
  process.exitCode = 1;
} finally {
  await cortexSql.end({ timeout: 5 });
  await handle.close();
}

/**
 * --cascade-absence-only: mint ONLY a buildable-envelope honest-decline
 * (unzoned-no-district-basis) for parcels that already carry an absence
 * zoning-fact (absence.kind = 'no-zoning-stamp', no district) and have no
 * buildable-envelope atom yet. Reads/writes substrate directly — no cortex
 * snapshot. NEVER mints or updates a zoning-fact or setback-rule atom.
 * HARD CONSTRAINT enforced in the query itself: only parcels whose LATEST
 * zoning-fact carries no district (body->>'district' IS NULL) are selected
 * — a parcel with a real district (city cohort) is never returned by this
 * query and therefore never written to in this mode.
 */
async function runCascadeAbsenceOnly() {
  const cascadeHandle = handle;
  const sql = cascadeHandle.sql;
  const county = args.county;
  const t0c = performance.now();

  const summary = {
    event: "cascade-absence-only",
    county,
    name: COUNTY_NAMES[county],
    dryRun: args.dryRun,
    scanned: 0,
    cascaded: 0,
    skippedExisting: 0,
    errors: 0,
  };

  console.log(
    JSON.stringify({
      event: "cascade-absence-only.start",
      county,
      name: COUNTY_NAMES[county],
      dryRun: args.dryRun,
    }),
  );

  const pageSize = Math.max(50, Math.min(args.batch, 500));
  let atomBatch = [];
  let lastParcelNodeId = "";

  async function flush() {
    if (atomBatch.length === 0) return;
    if (!args.dryRun) {
      await cascadeHandle.storage.writePropertyAtomsBatch(atomBatch);
    }
    atomBatch = [];
  }

  try {
    while (true) {
      if (args.limit > 0 && summary.scanned >= args.limit) break;
      const take =
        args.limit > 0
          ? Math.min(pageSize, args.limit - summary.scanned)
          : pageSize;

      // Keyset (not OFFSET) pagination on parcel_node_id — stable across a
      // long-running resumable scan. Latest zoning-fact per parcel in this
      // county that is a genuine absence (no district — the
      // unincorporated/unzoned cohort). A parcel whose latest zoning-fact
      // carries a real district (city cohort) is excluded by the
      // `district IS NULL` predicate below and is never returned by this
      // query, hence never written to in this mode (HARD CONSTRAINT).
      const rows = await sql`
        SELECT DISTINCT ON (body->>'parcelNodeId')
          body->>'parcelNodeId' AS parcel_node_id,
          atom_did,
          body->'baseFacts'->>'situsCity' AS situs_city,
          body->>'district' AS district,
          body->'absence'->>'kind' AS absence_kind
        FROM atoms
        WHERE entity_type = 'zoning-fact'
          AND jurisdiction_tenant LIKE ${`breadth_${county}_%`}
          AND body->>'parcelNodeId' > ${lastParcelNodeId}
        ORDER BY body->>'parcelNodeId', updated_at DESC NULLS LAST
        LIMIT ${take}
      `;
      if (rows.length === 0) break;

      const absenceRows = rows.filter(
        (r) => r.district === null && r.absence_kind === "no-zoning-stamp",
      );
      const candidateIds = absenceRows.map((r) => r.parcel_node_id);
      const existingEnvelopeIds = new Set();
      if (candidateIds.length > 0) {
        const existing = await sql`
          SELECT DISTINCT body->>'parcelNodeId' AS parcel_node_id
          FROM atoms
          WHERE entity_type = 'buildable-envelope'
            AND body->>'parcelNodeId' IN ${sql(candidateIds)}
        `;
        for (const e of existing) existingEnvelopeIds.add(e.parcel_node_id);
      }

      const extractedAt = new Date().toISOString();
      for (const row of rows) {
        summary.scanned += 1;
        const isAbsence =
          row.district === null && row.absence_kind === "no-zoning-stamp";
        if (isAbsence && existingEnvelopeIds.has(row.parcel_node_id)) {
          summary.skippedExisting += 1;
        } else if (isAbsence) {
          try {
            const decline = buildCascadeEnvelopeDecline(
              {
                parcelNodeId: row.parcel_node_id,
                atomDid: row.atom_did,
                situsCity: row.situs_city,
              },
              county,
              extractedAt,
            );
            atomBatch.push(decline);
            summary.cascaded += 1;
            if (atomBatch.length >= args.batch) await flush();
          } catch (err) {
            summary.errors += 1;
            console.error(
              JSON.stringify({
                event: "cascade-absence-only.emit-error",
                parcelNodeId: row.parcel_node_id,
                error: String(err?.message || err),
              }),
            );
          }
        }
        // Non-absence (city-cohort) rows are counted in `scanned` for an
        // honest denominator but are never cascaded and never skipped —
        // they are simply not this mode's concern.
        if (summary.scanned % 1000 === 0) {
          await flush();
          console.log(
            JSON.stringify({
              event: "cascade-absence-only.progress",
              county,
              scanned: summary.scanned,
              cascaded: summary.cascaded,
              skippedExisting: summary.skippedExisting,
              errors: summary.errors,
              wallMs: Math.round(performance.now() - t0c),
            }),
          );
        }
      }

      lastParcelNodeId = rows[rows.length - 1].parcel_node_id;
      if (rows.length < take) break;
    }

    await flush();
    summary.wallMs = Math.round(performance.now() - t0c);
    console.log(
      JSON.stringify({
        event: "cascade-absence-only.done",
        ...summary,
      }),
    );
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await cascadeHandle.close();
  }
}
