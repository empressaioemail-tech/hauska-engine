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
 *       --county=48055 [--limit=0] [--offset=0] [--batch=500] [--spike-pp=40] \
 *       [--prop-ids-file=<path>]
 *
 * `--prop-ids-file=<path>` (scoped mode): restricts zoning-fact / setback-rule /
 * buildable-envelope emit to exactly the prop ids listed in the file — one per
 * line, either a raw CAD prop id ("31131") or a full parcelNodeId ("48021:31131";
 * the county-fips prefix is stripped; --county still governs place_key prefix).
 * WITHOUT this flag the CLI is the whole-county cortex snapshot scan; this flag
 * only ever narrows. Summary reports listSize / matched / notFoundInTier1.
 *
 * Acceptance: WDLL breadth items 2,3,7.
 *
 * --cascade-absence-only mode (additive; named-decline-beats-silent-absence
 * cascade for the county-wide absence-zoning cohort): reads DIRECTLY from
 * substrate (DATABASE_URL only — no CORTEX_DATABASE_URL / cortex snapshot
 * scan in this mode). Finds parcels that already carry an absence
 * zoning-fact (absence.kind = 'no-zoning-stamp', no district) AND have no
 * buildable-envelope atom yet; mints ONLY a buildable-envelope honest-decline
 * (R27 persisted-decline shape) for each. NEVER mints or updates zoning-fact
 * or setback-rule atoms; NEVER touches a parcel whose zoning-fact carries a
 * real district (city cohort) — enforced in the query itself. Idempotent/
 * resumable: re-running skips parcels that already have an envelope atom.
 *
 * CITY-AWARE (2026-08-04, REASON-OVERSTATES fix): mints one of TWO honest
 * decline variants per parcel, keyed on the persisted jurisdiction_tenant's
 * city segment (see cascade-unzoned-envelope-decline.ts for the full field
 * decision + reliability caveat) — code unzoned-no-district-basis for a
 * genuinely unincorporated/no-signal parcel, code no-district-on-record for
 * a parcel whose situs address carried a town name (likely in-city, just not
 * yet onboarded).
 *
 *   PROPERTY_ATOM_PATH=1 DATABASE_URL=...hauska_mcp... \
 *     pnpm --filter @hauska-engine/engine-core run bake-property-atom-county -- \
 *       --county=48021 --cascade-absence-only [--batch=500]
 *       [--parcel-min=48309:0] [--parcel-max=48309:249999999]
 *
 * --parcel-min / --parcel-max (cascade-absence-only only): lexicographic
 * bounds on body->>'parcelNodeId' for keyspace sharding — N concurrent
 * scanners split one county; summary reports shardId + bounds; union of
 * shard cascaded sets must equal a solo run (prove before mega-county apply).
 *
 * --reword-city-parcels mode (additive backfill; UPDATE-in-place, dry-run
 * default): finds EXISTING buildable-envelope rows carrying the old
 * unzoned-no-district-basis code whose zoning-fact's jurisdiction_tenant now
 * carries a city signal, and rewrites their warmVerifyDeclineCode/
 * warmVerifyDecline to no-district-on-record in place (contentHash
 * recomputed via contentHashExcludingProvenance so rewarm-determinism
 * holds). Never touches a parcel with no city signal (correctly-worded
 * already) or a parcel that already carries no-district-on-record
 * (idempotent). Dry-run by default; pass --apply to persist.
 *
 * REQUIRES --city-segments=<comma-separated segments> (2026-08-05,
 * McDade-catch fix): a 2026-08-04 dry-run on 48021 showed the whole-county
 * form is too blunt — 38,026 would-reword included McDade, an
 * UNINCORPORATED community whose situs segment is not an incorporated city;
 * rewording those would be factually wrong. --reword-city-parcels now
 * REQUIRES an explicit allowlist of city segments (as extracted by
 * jurisdictionTenantCitySegment, e.g. "smithville"); only parcels whose
 * extracted citySegment exactly matches an allowlisted segment are
 * reworded — all others are skipped and counted
 * (skippedNotAllowlisted). Invoking --reword-city-parcels WITHOUT
 * --city-segments fails loud (non-zero exit) before any query runs; the
 * blunt whole-county form is unrunnable.
 *
 *   PROPERTY_ATOM_PATH=1 DATABASE_URL=...hauska_mcp... \
 *     pnpm --filter @hauska-engine/engine-core run bake-property-atom-county -- \
 *       --county=48021 --reword-city-parcels --city-segments=smithville \
 *       [--apply] [--limit=N] [--batch=500]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

import { emitFromTier1Snapshot } from "../src/property-reasoning/bake-from-tier1-snapshot.ts";
import {
  buildCascadeEnvelopeDecline,
  jurisdictionTenantCitySegment,
  NO_DISTRICT_ON_RECORD_CODE,
  NO_DISTRICT_ON_RECORD_REASON,
  UNZONED_NO_DISTRICT_BASIS_CODE,
} from "../src/property-reasoning/cascade-unzoned-envelope-decline.ts";
import { contentHashExcludingProvenance } from "../src/property-reasoning/confidence.ts";

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
    batch: 500,
    spikePp: 40,
    dryRun: false,
    cascadeAbsenceOnly: false,
    rewordCityParcels: false,
    apply: false,
    citySegments: null,
    parcelMin: null,
    parcelMax: null,
    cascadeIdsOut: null,
    propIdsFile: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--county") out.county = String(argv[++i] || "").trim();
    else if (a.startsWith("--county=")) out.county = a.slice("--county=".length);
    else if (a === "--limit") out.limit = Number(argv[++i] || 0);
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice("--limit=".length));
    else if (a === "--offset") out.offset = Number(argv[++i] || 0);
    else if (a.startsWith("--offset=")) out.offset = Number(a.slice("--offset=".length));
    else if (a === "--batch") out.batch = Number(argv[++i] || 500);
    else if (a.startsWith("--batch=")) out.batch = Number(a.slice("--batch=".length));
    else if (a === "--spike-pp") out.spikePp = Number(argv[++i] || 40);
    else if (a.startsWith("--spike-pp="))
      out.spikePp = Number(a.slice("--spike-pp=".length));
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--cascade-absence-only") out.cascadeAbsenceOnly = true;
    else if (a === "--reword-city-parcels") out.rewordCityParcels = true;
    else if (a === "--apply") out.apply = true;
    else if (a === "--city-segments")
      out.citySegments = String(argv[++i] || "");
    else if (a.startsWith("--city-segments="))
      out.citySegments = a.slice("--city-segments=".length);
    else if (a === "--parcel-min")
      out.parcelMin = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--parcel-min="))
      out.parcelMin = a.slice("--parcel-min=".length).trim() || null;
    else if (a === "--parcel-max")
      out.parcelMax = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--parcel-max="))
      out.parcelMax = a.slice("--parcel-max=".length).trim() || null;
    else if (a === "--cascade-ids-out")
      out.cascadeIdsOut = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--cascade-ids-out="))
      out.cascadeIdsOut = a.slice("--cascade-ids-out=".length).trim() || null;
    else if (a === "--prop-ids-file")
      out.propIdsFile = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--prop-ids-file="))
      out.propIdsFile = a.slice("--prop-ids-file=".length).trim() || null;
  }
  return out;
}

/**
 * Normalize a raw CAD prop id (leading zeros stripped from all-digit ids).
 */
function normalizePropId(propId) {
  const t = String(propId ?? "").trim();
  if (!/^\d+$/.test(t)) return t;
  return t.replace(/^0+(?=\d)/, "");
}

/**
 * Parse a `--prop-ids-file`: one id per line, blank lines and `#`-prefixed
 * comment lines ignored. Each line may be a raw prop id or a full
 * parcelNodeId ("48021:31131") — county prefix stripped.
 */
function parsePropIdsFile(raw) {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length === 0) {
    throw new Error("--prop-ids-file is empty (no usable lines)");
  }
  const ids = new Set();
  for (const line of lines) {
    const afterColon = line.includes(":") ? line.split(":").pop() : line;
    const trimmed = String(afterColon ?? "").trim();
    if (!trimmed) {
      throw new Error(`--prop-ids-file: unparseable line "${line}"`);
    }
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(
        `--prop-ids-file: line "${line}" is not a positive integer prop id`,
      );
    }
    ids.add(normalizePropId(trimmed));
  }
  return ids;
}

/**
 * Build cortex place_key values for a scoped roster.
 */
function placeKeysForPropIds(countyFips, propIds) {
  return [...propIds].map((id) => `node:${countyFips}:${id}`);
}

/** Split place_key list into fixed-size chunks for batched cortex reads. */
function chunkPlaceKeyList(keys, size) {
  if (size <= 0) throw new Error("chunk size must be positive");
  const chunks = [];
  for (let i = 0; i < keys.length; i += size) {
    chunks.push(keys.slice(i, i + size));
  }
  return chunks;
}

/**
 * Stable shard label for cascade keyspace bounds (summary + proof artifacts).
 */
function deriveShardId(parcelMin, parcelMax) {
  if (!parcelMin && !parcelMax) return "full";
  const lo = parcelMin ?? "";
  const hi = parcelMax ?? "";
  return `${lo}..${hi}`;
}

/**
 * Optional lexicographic keyspace bounds for cascade-absence-only pagination.
 * Returns a postgres.js SQL fragment to AND into the WHERE clause.
 */
function cascadeKeyspaceBoundsSql(sql, parcelMin, parcelMax) {
  return sql`
    ${parcelMin ? sql`AND body->>'parcelNodeId' >= ${parcelMin}` : sql``}
    ${parcelMax ? sql`AND body->>'parcelNodeId' <= ${parcelMax}` : sql``}
  `;
}

/**
 * Parse a --city-segments value into a normalized, deduped Set of city
 * segments (comma-separated; blank entries and surrounding whitespace
 * dropped). Segments are compared as-is against jurisdictionTenantCitySegment
 * output, which is already lowercased/underscored at bake time — callers
 * should pass segments in that same shape (e.g. "smithville", "del_valle").
 */
function parseCitySegmentsAllowlist(raw) {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
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

const citySegmentsAllowlist = parseCitySegmentsAllowlist(args.citySegments);
if (args.rewordCityParcels && citySegmentsAllowlist.size === 0) {
  console.error(
    "FATAL: --reword-city-parcels requires --city-segments=<comma-separated segments>. " +
      "A 2026-08-04 dry-run on 48021 found the whole-county form too blunt — it would have " +
      "reworded McDade, an unincorporated community, alongside genuine in-city parcels — so " +
      "the un-scoped form is disabled; pass the exact jurisdictionTenantCitySegment values " +
      "(e.g. --city-segments=smithville) to reword.",
  );
  process.exit(1);
}

/** Scoped roster (--prop-ids-file); undefined on whole-county runs. */
let scopedPropIds = null;
if (args.propIdsFile) {
  if (args.cascadeAbsenceOnly || args.rewordCityParcels) {
    console.error(
      "FATAL: --prop-ids-file is incompatible with --cascade-absence-only / --reword-city-parcels.",
    );
    process.exit(1);
  }
  try {
    scopedPropIds = parsePropIdsFile(readFileSync(args.propIdsFile, "utf8"));
  } catch (err) {
    console.error(`FATAL: --prop-ids-file: ${err?.message || err}`);
    process.exit(1);
  }
}

const substrateUrl = resolveSubstrateDatabaseUrl();
const cortexUrl = process.env.CORTEX_DATABASE_URL?.trim();
if (!substrateUrl) {
  console.error("FATAL: DATABASE_URL or SUBSTRATE_DATABASE_URL required.");
  process.exit(1);
}
// --cascade-absence-only and --reword-city-parcels read/write substrate
// only — no cortex snapshot scan.
const substrateOnlyMode = args.cascadeAbsenceOnly || args.rewordCityParcels;
if (!substrateOnlyMode && !cortexUrl) {
  console.error("FATAL: CORTEX_DATABASE_URL required.");
  process.exit(1);
}

const handle = createPgStorage({ databaseUrl: substrateUrl, maxConnections: 8 });
const cortexSql = substrateOnlyMode
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

if (args.rewordCityParcels) {
  await runRewordCityParcels();
  process.exit(process.exitCode ?? 0);
}

const t0 = performance.now();
const prefix = `node:${args.county}:`;
const scopedPlaceKeys = scopedPropIds
  ? placeKeysForPropIds(args.county, scopedPropIds)
  : null;

const countRows = scopedPlaceKeys
  ? [{ n: scopedPlaceKeys.length }]
  : await cortexSql`
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
    ...(scopedPropIds
      ? {
          scoped: true,
          propIdsFile: args.propIdsFile,
          listSize: scopedPropIds.size,
        }
      : {}),
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
  scoped: scopedPropIds
    ? {
        listSize: scopedPropIds.size,
        matched: 0,
        notFoundInTier1: [],
      }
    : undefined,
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
    ...(scopedPropIds
      ? {
          scoped: true,
          propIdsFile: args.propIdsFile,
          listSize: scopedPropIds.size,
        }
      : {}),
  }),
);

const pageSize = Math.max(50, Math.min(args.batch, 500));
let fetched = 0;
let dbOffset = args.offset;
const foundPlaceKeys = new Set();

async function processBreadthRows(rows) {
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
}

try {
  if (scopedPlaceKeys) {
    for (const chunk of chunkPlaceKeyList(scopedPlaceKeys, pageSize)) {
      if (args.limit > 0 && fetched >= args.limit) break;
      const take =
        args.limit > 0 ? Math.min(chunk.length, args.limit - fetched) : chunk.length;
      const keys = chunk.slice(0, take);

      const rows = await cortexSql`
        select place_key, payload_json
        from place_layer_snapshots
        where adapter_key = 'node-facets:tier1'
          and place_key = ANY(${keys})
        order by place_key
      `;
      ledger.compute.units += 1;

      for (const row of rows) {
        foundPlaceKeys.add(String(row.place_key || ""));
      }

      await processBreadthRows(rows);
      if (args.limit > 0 && fetched >= args.limit) break;
    }

    if (ledger.scoped) {
      ledger.scoped.matched = foundPlaceKeys.size;
      ledger.scoped.notFoundInTier1 = [...scopedPropIds].filter(
        (id) => !foundPlaceKeys.has(`node:${args.county}:${id}`),
      );
    }
  } else {
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

    await processBreadthRows(rows);

    dbOffset += rows.length;
    if (rows.length < take) break;
  }
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
      ...(ledger.scoped ? { scoped: ledger.scoped } : {}),
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

  const shardId = deriveShardId(args.parcelMin, args.parcelMax);
  const summary = {
    event: "cascade-absence-only",
    county,
    name: COUNTY_NAMES[county],
    dryRun: args.dryRun,
    shardId,
    ...(args.parcelMin ? { parcelMin: args.parcelMin } : {}),
    ...(args.parcelMax ? { parcelMax: args.parcelMax } : {}),
    scanned: 0,
    cascaded: 0,
    skippedExisting: 0,
    errors: 0,
  };
  const cascadedParcelIds = [];

  console.log(
    JSON.stringify({
      event: "cascade-absence-only.start",
      county,
      name: COUNTY_NAMES[county],
      dryRun: args.dryRun,
      shardId,
      ...(args.parcelMin ? { parcelMin: args.parcelMin } : {}),
      ...(args.parcelMax ? { parcelMax: args.parcelMax } : {}),
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
      // City-membership signal: jurisdiction_tenant (breadth_${fips}_${city}),
      // NOT body->'baseFacts'->>'situsCity' — baseFacts is a Tier-1 SNAPSHOT
      // field (cortex-side), never persisted onto the zoning-fact atom BODY
      // (confirmed: ZoningFactAtomInstance carries no baseFacts key), so that
      // JSON path was always NULL in this mode. jurisdiction_tenant IS a real
      // persisted+indexed column, and descriptorForCounty() already folds
      // situsCity into it at original bake time (see
      // cascade-unzoned-envelope-decline.ts module doc for the full field
      // decision + reliability caveat).
      const rows = await sql`
        SELECT DISTINCT ON (body->>'parcelNodeId')
          body->>'parcelNodeId' AS parcel_node_id,
          atom_did,
          jurisdiction_tenant,
          body->>'district' AS district,
          body->'absence'->>'kind' AS absence_kind
        FROM atoms
        WHERE entity_type = 'zoning-fact'
          AND jurisdiction_tenant LIKE ${`breadth_${county}_%`}
          AND body->>'parcelNodeId' > ${lastParcelNodeId}
          ${cascadeKeyspaceBoundsSql(sql, args.parcelMin, args.parcelMax)}
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
                situsCity: jurisdictionTenantCitySegment(row.jurisdiction_tenant),
              },
              county,
              extractedAt,
            );
            atomBatch.push(decline);
            summary.cascaded += 1;
            if (args.cascadeIdsOut) cascadedParcelIds.push(row.parcel_node_id);
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
    if (args.cascadeIdsOut) {
      cascadedParcelIds.sort();
      writeFileSync(
        args.cascadeIdsOut,
        JSON.stringify(cascadedParcelIds, null, 0),
      );
      summary.cascadeIdsOut = args.cascadeIdsOut;
      summary.cascadeIdsCount = cascadedParcelIds.length;
    }
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

/**
 * --reword-city-parcels: targeted UPDATE-in-place backfill (not a re-mint).
 * Existing cascade envelope declines minted BEFORE the city-aware fix
 * (2026-08-04) all carry warmVerifyDeclineCode = unzoned-no-district-basis,
 * even for parcels whose zoning-fact jurisdiction_tenant now shows a city
 * signal (Smithville-area remainder etc. — see cascade-unzoned-envelope-
 * decline.ts module doc for the field decision). This clears that stale
 * wording by rewriting warmVerifyDeclineCode/warmVerifyDecline to
 * no-district-on-record on exactly those rows, recomputing contentHash via
 * contentHashExcludingProvenance (same hash convention the fresh-mint path
 * uses) so rewarm-determinism holds. Dry-run by default; --apply persists.
 * Idempotent: a second run finds zero candidates (WHERE clause excludes rows
 * already carrying no-district-on-record). Never touches zoning-fact or
 * setback-rule atoms; never touches a parcel with no city signal (that
 * parcel's unzoned-no-district-basis wording is already correct).
 *
 * ALLOWLIST-SCOPED (2026-08-05, McDade-catch fix): the caller-supplied
 * --city-segments allowlist (parsed into citySegmentsAllowlist at module
 * scope; presence already enforced fail-loud before this function can be
 * reached) further restricts candidates to rows whose extracted
 * citySegment exactly matches an allowlisted segment. A candidate whose
 * citySegment carries a real city signal but is NOT on the allowlist is
 * counted in skippedNotAllowlisted and left untouched — this is what makes
 * the whole-county sweep that caught McDade (an unincorporated community
 * whose situs segment is not an incorporated city) impossible: only
 * explicitly-named segments are ever reworded.
 */
async function runRewordCityParcels() {
  const sql = handle.sql;
  const county = args.county;
  const t0r = performance.now();
  const dryRun = !args.apply;

  const summary = {
    event: "reword-city-parcels",
    county,
    name: COUNTY_NAMES[county],
    dryRun,
    citySegmentsAllowlist: [...citySegmentsAllowlist].sort(),
    scanned: 0,
    reworded: 0,
    skippedNoCitySignal: 0,
    skippedNotAllowlisted: 0,
    skippedAlreadyReworded: 0,
    errors: 0,
  };

  console.log(
    JSON.stringify({
      event: "reword-city-parcels.start",
      county,
      name: COUNTY_NAMES[county],
      dryRun,
      citySegmentsAllowlist: summary.citySegmentsAllowlist,
    }),
  );

  const pageSize = Math.max(50, Math.min(args.batch, 500));
  let lastEntityId = "";

  try {
    while (true) {
      if (args.limit > 0 && summary.scanned >= args.limit) break;
      const take =
        args.limit > 0
          ? Math.min(pageSize, args.limit - summary.scanned)
          : pageSize;

      // Keyset (not OFFSET) pagination on entity_id — stable across a
      // long-running resumable backfill. Candidate envelopes:
      // entity_type='buildable-envelope', code is the OLD
      // unzoned-no-district-basis value, jurisdiction under this county's
      // breadth-bake tenant prefix. Joined back to the LATEST zoning-fact for
      // the same parcel to read that row's jurisdiction_tenant (the
      // envelope's own jurisdictionTenant was minted from the SAME
      // descriptor at cascade time, so in practice they match — the join
      // guards against any future drift rather than trusting the envelope's
      // copy blindly).
      const rows = await sql`
        SELECT
          env.entity_id AS entity_id,
          env.atom_did AS atom_did,
          env.body AS body,
          zf.jurisdiction_tenant AS zf_jurisdiction_tenant
        FROM atoms env
        LEFT JOIN LATERAL (
          SELECT jurisdiction_tenant
          FROM atoms z
          WHERE z.entity_type = 'zoning-fact'
            AND z.body->>'parcelNodeId' = env.body->>'parcelNodeId'
          ORDER BY z.updated_at DESC NULLS LAST
          LIMIT 1
        ) zf ON true
        WHERE env.entity_type = 'buildable-envelope'
          AND env.jurisdiction_tenant LIKE ${`breadth_${county}_%`}
          AND env.body->>'warmVerifyDeclineCode' = ${UNZONED_NO_DISTRICT_BASIS_CODE}
          AND env.entity_id > ${lastEntityId}
        ORDER BY env.entity_id
        LIMIT ${take}
      `;
      if (rows.length === 0) break;

      for (const row of rows) {
        summary.scanned += 1;
        try {
          const citySegment = jurisdictionTenantCitySegment(
            row.zf_jurisdiction_tenant,
          );
          if (!citySegment) {
            summary.skippedNoCitySignal += 1;
            continue;
          }
          if (!citySegmentsAllowlist.has(citySegment)) {
            summary.skippedNotAllowlisted += 1;
            continue;
          }
          const body =
            row.body && typeof row.body === "object" ? { ...row.body } : {};
          if (body.warmVerifyDeclineCode === NO_DISTRICT_ON_RECORD_CODE) {
            summary.skippedAlreadyReworded += 1;
            continue;
          }

          const next = {
            ...body,
            warmVerifyDeclineCode: NO_DISTRICT_ON_RECORD_CODE,
            warmVerifyDecline: NO_DISTRICT_ON_RECORD_REASON,
            outcome: {
              kind: "no-buildable-area",
              reason: NO_DISTRICT_ON_RECORD_REASON,
            },
          };
          delete next.contentHash;
          next.contentHash = contentHashExcludingProvenance(next);

          if (dryRun) {
            if (summary.reworded < 3) {
              console.log(
                `[reword-city-parcels] DRY sample entity_id=${row.entity_id} ` +
                  `citySegment=${citySegment} old=${UNZONED_NO_DISTRICT_BASIS_CODE} ` +
                  `new=${NO_DISTRICT_ON_RECORD_CODE}`,
              );
            }
            summary.reworded += 1;
            continue;
          }

          await sql`
            UPDATE atoms
            SET body = ${sql.json(next)},
                content_hash = ${next.contentHash},
                updated_at = NOW()
            WHERE entity_type = 'buildable-envelope'
              AND entity_id = ${row.entity_id}
          `;
          summary.reworded += 1;
        } catch (err) {
          summary.errors += 1;
          console.error(
            JSON.stringify({
              event: "reword-city-parcels.emit-error",
              entityId: row.entity_id,
              error: String(err?.message || err),
            }),
          );
        }
        if (summary.scanned % 1000 === 0) {
          console.log(
            JSON.stringify({
              event: "reword-city-parcels.progress",
              county,
              scanned: summary.scanned,
              reworded: summary.reworded,
              wallMs: Math.round(performance.now() - t0r),
            }),
          );
        }
      }

      lastEntityId = rows[rows.length - 1].entity_id;
      if (rows.length < take) break;
    }

    summary.wallMs = Math.round(performance.now() - t0r);
    console.log(
      JSON.stringify({
        event: "reword-city-parcels.done",
        ...summary,
      }),
    );
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await handle.close();
  }
}
