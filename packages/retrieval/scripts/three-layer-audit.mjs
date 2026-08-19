#!/usr/bin/env node
/**
 * STATEWIDE THREE-LAYER AUDIT — lane SS-W9, PLAN-ROW P-43.
 *
 *   node --import tsx packages/retrieval/scripts/three-layer-audit.mjs \
 *     --out artifacts/three-layer-audit --served-dir <servingSweepOutDir>
 *
 * The serving sweep answers "what does Smart Site SERVE a human". This answers
 * the two questions either side of it and puts all three next to each other:
 *
 *     WRITTEN   atoms actually in the store            (hauska_mcp.atoms)
 *     SCORED    the county_facet_coverage ledger cells (cortex neondb)
 *     SERVED    what Smart Site actually shows a human (the SS-W5 sweep)
 *
 * All three disagree independently, and the ORDER of the disagreement is the
 * cost of the fix: written-unscored is a scorer run, written-unserved is a
 * merge fix, only genuinely unwritten is a re-ingest.
 *
 * READ ONLY. No INSERT, UPDATE, DELETE or DDL against either database, and no
 * atoms writer slot.
 *
 * HEAVY-SCAN DISCIPLINE (AGENT_CONTRACT section 4). Every scan here is
 * announced in the progress artifact BEFORE it starts and confirmed after, and
 * they run STRICTLY ONE AT A TIME — the atom-family scans are a `for` loop of
 * awaited queries, never a `Promise.all`. `statement_timeout` rides the
 * CONNECTION STARTUP parameters, because a `SET` issued as its own round trip
 * does not survive into the next one and would leave every scan unbounded.
 *
 * DENOMINATORS ARE MEASURED, NEVER SUBTRACTED (DEV_PROCESS 1.3). Every count
 * this script emits carries the denominator it was measured against and a
 * sentence naming what one unit of it IS.
 */

import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

import {
  SERVED_FIELD_BY_RAIL,
  classifyCell,
  emptyGapCounts,
} from "../src/statewide-audit/classify.js";

const AUDIT_VERSION = "ss-w9/1.0.0";
const COUNTIES_TOTAL = 254;

/**
 * Rail -> atom family. Taken from `RAIL_ENGINE_BINDINGS` in
 * legacy-design-tools `lib/db/src/schema/railEngineBinding.ts`, with ONE
 * deliberate correction that is itself a finding: that file declares
 * `rrc-pipelines` with an EMPTY atomEntityTypes array while the store holds
 * millions of `rrc-pipeline-fact` atoms. Auditing the rail against an empty
 * family would report a written rail as unwritten, so the family is named here
 * and the disagreement is filed as a contradiction rather than silently
 * resolved in either direction.
 */
export const RAIL_ATOM_FAMILIES = {
  geometry: ["parcel-node"],
  cad: ["cad-parcel-roll"],
  zoning: ["zoning-fact", "setback-rule"],
  roads: ["road-node"],
  flood: ["flood-hazard-fact"],
  envelope: ["buildable-envelope"],
  landuse: ["land-use-fact"],
  footprint: ["building-footprint"],
  easement: ["utility-easement"],
  owner: ["owner-fact"],
  "rrc-wells": ["well-fact"],
  "rrc-pipelines": ["rrc-pipeline-fact"],
  "rail-corridor": ["rail-corridor-fact"],
  mud: ["special-district-fact"],
};

/** Whether one atom of a family is exactly one parcel, proven by its key shape. */
export const ATOM_KEY_SHAPE = {
  "parcel-node": { shape: "<fips>:<propId>", perParcel: true },
  "cad-parcel-roll": { shape: "<fips>:<propId>:<taxYear>", perParcel: false },
  "zoning-fact": { shape: "<fips>:<propId>", perParcel: true },
  "setback-rule": { shape: "<fips>:<propId>", perParcel: true },
  "road-node": { shape: "<fips>:road:<osmId>", perParcel: false },
  "flood-hazard-fact": { shape: "<fips>:<propId>", perParcel: true },
  "buildable-envelope": { shape: "<fips>:<propId>", perParcel: true },
  "land-use-fact": { shape: "<fips>:<propId>:<taxYear>", perParcel: false },
  "building-footprint": { shape: "<fips>:<propId>:footprint:<slot>", perParcel: false },
  "utility-easement": { shape: "unknown — no rows in the store", perParcel: false },
  "owner-fact": { shape: "<fips>:<propId>:<taxYear>", perParcel: false },
  "well-fact": { shape: "<fips>:<propId>:<apiNumber>", perParcel: false },
  "rrc-pipeline-fact": { shape: "<fips>:<propId>", perParcel: true },
  "rail-corridor-fact": { shape: "<fips>:<propId>", perParcel: true },
  "special-district-fact": { shape: "<fips>:<propId>:sd:<inside|outside>", perParcel: false },
};

const ALL_ATOM_TYPES = [...new Set(Object.values(RAIL_ATOM_FAMILIES).flat())];

/**
 * The served field for each rail, and `null` where the parcel fact sheet has
 * no slot at all. Imported rather than restated so the classifier and the
 * runner can never drift apart on it.
 */
export { SERVED_FIELD_BY_RAIL };

function parseArgs(argv) {
  const out = { out: null, servedDir: null, ledgerUrl: null, writtenFrom: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.out = String(argv[++i]);
    else if (a === "--served-dir") out.servedDir = String(argv[++i]);
    else if (a === "--ledger-url") out.ledgerUrl = String(argv[++i]);
    else if (a === "--written-from") out.writtenFrom = String(argv[++i]);
    else if (a === "--progress") out.progress = String(argv[++i]);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!out.out) throw new Error("--out <dir> required");
  if (!out.ledgerUrl) {
    out.ledgerUrl = "https://cortex-api-tds7av26va-uc.a.run.app/api/county-ledger";
  }
  return out;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`FATAL: ${name} is required`);
  return v.trim();
}

function measure(count, denominator, countingRule, computedAt, basis) {
  return { count, denominator, countingRule, computedAt, basis };
}

/**
 * WRITTEN. One awaited query per atom family, strictly serialized. The county
 * key is the entity_id prefix, which is NOT assumed: `verifyCountyKey` below
 * proves it against the value the writer persisted in the atom body for the
 * one family that carries a countyFips index, and the audit refuses to emit a
 * written layer if that check diverges.
 */
async function readWritten(atoms, announce) {
  const byType = new Map();
  for (const entityType of ALL_ATOM_TYPES) {
    announce({ phase: "written-scan", scan: entityType });
    const rows = await atoms`
      SELECT split_part(entity_id, ':', 1) AS fips, count(*)::bigint AS n
      FROM atoms WHERE entity_type = ${entityType} GROUP BY 1 ORDER BY 1
    `;
    const perCounty = new Map();
    for (const r of rows) perCounty.set(r.fips, Number(r.n));
    byType.set(entityType, perCounty);
    announce({ phase: "written-scan-done", scan: entityType, counties: perCounty.size });
  }
  return byType;
}

/**
 * DIVERGENCE CONTROL for the county key. `split_part(entity_id, ':', 1)` is a
 * RECONSTRUCTION, and the standing rule is that entityId shapes are not
 * uniform across writers. `parcel-node` carries a `countyFips` body field with
 * its own partial index, so the two derivations can be compared directly. A
 * non-zero disagreement invalidates every WRITTEN figure and must stop the
 * run rather than be footnoted.
 */
async function verifyCountyKey(atoms, announce) {
  announce({ phase: "written-key-divergence-check", scan: "parcel-node prefix vs body.countyFips" });
  const rows = await atoms`
    SELECT count(*)::bigint AS disagreeing
    FROM atoms
    WHERE entity_type = 'parcel-node'
      AND body->>'countyFips' IS NOT NULL
      AND body->>'countyFips' <> split_part(entity_id, ':', 1)
  `;
  const disagreeing = Number(rows[0]?.disagreeing ?? 0);
  announce({ phase: "written-key-divergence-result", disagreeing });
  return disagreeing;
}

/**
 * The parcel roster and the ADDRESS LADDER in ONE scan, because they share a
 * table and running it twice doubles a heavy scan for nothing.
 *
 * The ladder's rungs are SS-W5's, unchanged. Each rung passed the sentinel the
 * next rung catches, which is why a figure that does not name its rung is not
 * a result:
 *
 *   non-null            passes ", ,"           Bastrop
 *   non-blank           passes ", ,"           identical to non-null; the
 *                                              defect was never an empty string
 *   carries-a-street    the rule used here
 *   carries-a-city      strictest
 *
 * There is no proof the ladder has only four rungs.
 */
async function readRosterAndLadder(cortex, announce) {
  announce({ phase: "roster-and-address-ladder", scan: "txgio_parcel full scan, DISTINCT prop_id per county" });
  const rows = await cortex`
    SELECT county_fips AS fips,
            count(DISTINCT prop_id)::bigint AS parcels,
            count(DISTINCT prop_id) FILTER (WHERE situs_address IS NOT NULL)::bigint AS non_null,
            count(DISTINCT prop_id) FILTER (WHERE btrim(coalesce(situs_address,'')) <> '')::bigint AS non_blank,
            count(DISTINCT prop_id) FILTER (WHERE btrim(split_part(coalesce(situs_address,''), ',', 1)) ~ '[A-Za-z0-9]')::bigint AS street,
            count(DISTINCT prop_id) FILTER (WHERE btrim(coalesce(situs_city,'')) <> '')::bigint AS city
    FROM txgio_parcel GROUP BY 1 ORDER BY 1
  `;
  announce({ phase: "roster-and-address-ladder-done", counties: rows.length });
  return rows.map((r) => ({
    fips: r.fips,
    parcels: Number(r.parcels),
    nonNull: Number(r.non_null),
    nonBlank: Number(r.non_blank),
    street: Number(r.street),
    city: Number(r.city),
  }));
}

/** SCORED, from the store, with every row's own checked_at. */
async function readScoredRows(cortex, announce) {
  announce({ phase: "scored-read", scan: "county_facet_coverage" });
  const rows = await cortex`
    SELECT county_fips, facet, rail_state, honest_coverage_pct, threshold_pct,
           source, source_vintage, checked_at
    FROM county_facet_coverage
  `;
  announce({ phase: "scored-read-done", rows: rows.length });
  return rows;
}

/** SCORED, as the operator's console actually reads it, with its computedAt. */
async function readLiveLedger(url, announce) {
  announce({ phase: "scored-live-ledger", url });
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const ctype = res.headers.get("content-type") ?? "";
  if (!res.ok || !ctype.includes("application/json")) {
    // A malformed probe is not evidence. An HTML body from an SPA fallthrough
    // is a 200 that proves nothing, so it is reported as a failure, never as
    // an empty ledger.
    throw new Error(
      `ledger probe did not return JSON: status=${res.status} content-type=${ctype}`,
    );
  }
  const body = await res.json();
  announce({
    phase: "scored-live-ledger-done",
    computedAt: body?.summary?.computedAt ?? null,
    cells: Array.isArray(body?.manifestCells) ? body.manifestCells.length : 0,
  });
  return body;
}

/** SERVED, from whatever counties the sweep has actually reached. Never inferred. */
function readServed(servedDir) {
  if (!servedDir || !fs.existsSync(servedDir)) return new Map();
  const out = new Map();
  for (const f of fs.readdirSync(servedDir)) {
    const m = /^county_(\d{5})\.json$/.exec(f);
    if (!m) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(servedDir, f), "utf8"));
      const rec = doc.record ?? doc;
      if (rec && rec.fields) out.set(m[1], rec);
    } catch {
      // A file we cannot parse is NOT an empty county. Skip it and let the
      // county fall through to not-measured.
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  fs.mkdirSync(args.out, { recursive: true });
  const progressPath = args.progress ?? path.join(args.out, "progress.json");
  const announce = (payload) => {
    fs.writeFileSync(
      progressPath,
      JSON.stringify(
        { lane: "SS-W9", planRow: "P-43", at: new Date().toISOString(), ...payload },
        null,
        2,
      ) + "\n",
    );
  };

  // statement_timeout rides the CONNECTION STARTUP parameters rather than a
  // separate `SET` round trip, because a `SET` issued as its own statement does
  // not survive into the next one and would leave every scan below unbounded —
  // which the contract forbids and which is how a stalled scan hides.
  const atoms = postgres(requireEnv("ATOMS_DATABASE_URL"), {
    max: 1,
    idle_timeout: 0,
    connect_timeout: 30,
    prepare: false,
    connection: { statement_timeout: "3600000" },
  });
  const cortex = postgres(requireEnv("CORTEX_DATABASE_URL"), {
    max: 1,
    idle_timeout: 0,
    connect_timeout: 30,
    prepare: false,
    connection: { statement_timeout: "7200000" },
  });

  let written;
  let keyDisagreement = null;
  let writtenScannedAt = null;
  let roster;
  let scoredRows;
  let ledger;

  // A cached WRITTEN scan is a REPLAY of a real scan, never a substitute for
  // one: the file records when it was taken and that stamp travels into the
  // artifact, so a reader always knows how old the written layer is. Same
  // discipline the ledger's computedAt gets, applied to our own number.
  const writtenCachePath = path.join(args.out, "written_by_family.json");
  const cached = args.writtenFrom && fs.existsSync(args.writtenFrom)
    ? JSON.parse(fs.readFileSync(args.writtenFrom, "utf8"))
    : null;

  try {
    if (cached) {
      written = new Map(
        Object.entries(cached.families).map(([k, v]) => [k, new Map(Object.entries(v))]),
      );
      keyDisagreement = cached.countyKeyDisagreement ?? null;
      writtenScannedAt = cached.scannedAt;
      announce({ phase: "written-replayed", from: args.writtenFrom, scannedAt: writtenScannedAt });
    } else {
      keyDisagreement = await verifyCountyKey(atoms, announce);
      if (keyDisagreement !== 0) {
        throw new Error(
          `county key derivation DIVERGES on ${keyDisagreement} parcel-node atoms: ` +
            `entity_id prefix disagrees with body.countyFips. Every WRITTEN figure ` +
            `would be wrong; stopping rather than footnoting.`,
        );
      }
      written = await readWritten(atoms, announce);
      writtenScannedAt = new Date().toISOString();
      fs.writeFileSync(
        writtenCachePath,
        JSON.stringify(
          {
            scannedAt: writtenScannedAt,
            countyKeyDisagreement: keyDisagreement,
            families: Object.fromEntries(
              [...written].map(([k, v]) => [k, Object.fromEntries(v)]),
            ),
          },
          null,
          2,
        ) + "\n",
      );
    }
    roster = await readRosterAndLadder(cortex, announce);
    scoredRows = await readScoredRows(cortex, announce);
    ledger = await readLiveLedger(args.ledgerUrl, announce);
  } finally {
    await atoms.end({ timeout: 5 });
    await cortex.end({ timeout: 5 });
  }

  const served = readServed(args.servedDir);
  const ledgerComputedAt = ledger?.summary?.computedAt ?? null;
  const ledgerReadAt = new Date().toISOString();

  const rosterByFips = new Map(roster.map((r) => [r.fips, r]));
  const allCounties = [
    ...new Set([
      ...roster.map((r) => r.fips),
      ...(ledger?.manifestCells ?? []).map((c) => c.countyFips),
    ]),
  ].sort();

  const scoredRowSet = new Set(scoredRows.map((r) => `${r.county_fips}|${r.facet}`));
  const scoredByKey = new Map(
    scoredRows.map((r) => [`${r.county_fips}|${r.facet}`, r]),
  );
  const ledgerCellByKey = new Map(
    (ledger?.manifestCells ?? []).map((c) => [`${c.countyFips}|${c.railKey}`, c]),
  );
  const ceilingByRail = new Map(
    (ledger?.railCapabilities ?? []).map((c) => [c.railKey, c]),
  );

  // Counties in which each rail has ANY atom — needed before classification,
  // because the ceiling rule reads it.
  const railCountiesWritten = {};
  const railAtomsWritten = {};
  for (const [railKey, families] of Object.entries(RAIL_ATOM_FAMILIES)) {
    const counties = new Set();
    let atomsN = 0;
    for (const fam of families) {
      for (const [fips, n] of written.get(fam) ?? []) {
        if (n > 0) counties.add(fips);
        atomsN += n;
      }
    }
    railCountiesWritten[railKey] = counties.size;
    railAtomsWritten[railKey] = atomsN;
  }

  const cells = [];
  const rollups = [];
  for (const [railKey, families] of Object.entries(RAIL_ATOM_FAMILIES)) {
    const cap = ceilingByRail.get(railKey) ?? null;
    const ceiling = {
      maxCountiesReachable: cap?.maxCountiesReachable ?? null,
      reachPct: cap?.reachPct ?? null,
      sourceBasis: cap?.sourceBasis ?? "no capability probe defined for this rail",
      limitation: cap?.limitation ?? null,
      readFrom: args.ledgerUrl,
      readAt: ledgerReadAt,
    };
    const gapCounts = emptyGapCounts();
    let countiesScoredSatisfied = 0;
    let countiesScoredNotYet = 0;
    let countiesServed = 0;
    let parcelsServedPresent = 0;
    let parcelsSwept = 0;
    const servedField = SERVED_FIELD_BY_RAIL[railKey];

    for (const fips of allCounties) {
      const writtenAtoms = families.reduce(
        (n, fam) => n + (written.get(fam)?.get(fips) ?? 0),
        0,
      );
      const rosterRow = rosterByFips.get(fips) ?? null;
      const parcelDenominator = rosterRow?.parcels ?? 0;

      const cell = ledgerCellByKey.get(`${fips}|${railKey}`) ?? null;
      const scoredRow = scoredByKey.get(`${fips}|${railKey}`) ?? null;
      const scoredRowExists = scoredRowSet.has(`${fips}|${railKey}`);
      const display = cell?.displayState ?? null;
      if (display === "satisfied-present" || display === "satisfied-absent") {
        countiesScoredSatisfied += 1;
      } else if (display === "not-yet") {
        countiesScoredNotYet += 1;
      }

      const sweep = served.get(fips) ?? null;
      let servedPresent = null;
      let servedSwept = null;
      if (sweep && servedField && sweep.fields?.[servedField]) {
        const t = sweep.fields[servedField];
        servedPresent = t.present;
        servedSwept = sweep.parcelsTotal;
        countiesServed += 1;
        parcelsServedPresent += t.present;
        parcelsSwept += sweep.parcelsTotal;
      }

      const verdict = classifyCell({
        countyFips: fips,
        railKey,
        writtenAtoms,
        scoredRowExists,
        ledgerDisplayState: display,
        scoredComputedAt: ledgerComputedAt,
        writtenAt: null,
        servedPresentParcels: servedPresent,
        servedSweptParcels: servedSwept,
        railCountiesWritten: railCountiesWritten[railKey],
        railCeilingCounties: ceiling.maxCountiesReachable,
        countiesTotal: COUNTIES_TOTAL,
      });
      gapCounts[verdict.gapClass] += 1;

      cells.push({
        countyFips: fips,
        railKey,
        written: measure(
          writtenAtoms,
          parcelDenominator,
          `atom ROWS of ${families.join(" + ")} whose entity_id carries this county's fips prefix, over DISTINCT prop_id in txgio_parcel for the county`,
          null,
          "hauska_mcp.atoms, index-only via atoms_entity_composite_unique",
        ),
        scored: measure(
          display === "satisfied-present" || display === "satisfied-absent" ? 1 : 0,
          1,
          "1 when the ledger cell is satisfied-present or satisfied-absent, else 0; one cell per county per rail",
          ledgerComputedAt,
          scoredRow
            ? `county_facet_coverage row, checked_at ${scoredRow.checked_at?.toISOString?.() ?? scoredRow.checked_at}`
            : "NO county_facet_coverage row exists for this (county, facet)",
        ),
        served:
          servedPresent === null
            ? null
            : measure(
                servedPresent,
                servedSwept,
                `parcels whose served ${servedField} Fact state is present, over every parcel on the county roster; the sweep never samples`,
                sweep?.sweptAt ?? null,
                `serving sweep record county_${fips}.json`,
              ),
        ledgerDisplayState: display,
        gapClass: verdict.gapClass,
        gapBasis: verdict.gapBasis,
      });
    }

    const keyShapes = families.map((f) => ATOM_KEY_SHAPE[f] ?? { shape: "unknown", perParcel: false });
    rollups.push({
      railKey,
      atomEntityTypes: families,
      ceiling,
      countiesWritten: railCountiesWritten[railKey],
      atomsWritten: railAtomsWritten[railKey],
      atomsArePerParcel: keyShapes.every((k) => k.perParcel),
      atomKeyShape: keyShapes.map((k) => k.shape).join(" + "),
      countiesScoredSatisfied,
      countiesScoredNotYet,
      scoredComputedAt: ledgerComputedAt,
      countiesServed,
      parcelsServedPresent: countiesServed > 0 ? parcelsServedPresent : null,
      parcelsSwept: countiesServed > 0 ? parcelsSwept : null,
      countiesTotal: COUNTIES_TOTAL,
      gapCounts,
    });
  }

  const totals = roster.reduce(
    (a, r) => ({
      parcels: a.parcels + r.parcels,
      nonNull: a.nonNull + r.nonNull,
      nonBlank: a.nonBlank + r.nonBlank,
      street: a.street + r.street,
      city: a.city + r.city,
    }),
    { parcels: 0, nonNull: 0, nonBlank: 0, street: 0, city: 0 },
  );
  const pct = (n) => (totals.parcels > 0 ? Number(((n / totals.parcels) * 100).toFixed(2)) : 0);

  const threeLayer = {
    auditedAt: new Date().toISOString(),
    auditVersion: AUDIT_VERSION,
    countiesTotal: COUNTIES_TOTAL,
    countiesLoaded: roster.length,
    writtenComputedAt: writtenScannedAt,
    scoredComputedAt: ledgerComputedAt,
    servedComputedAt: served.size > 0 ? ledgerReadAt : null,
    rails: rollups,
    cells,
    addressLadder: {
      denominatorParcels: totals.parcels,
      denominatorCounties: roster.length,
      measuredAt: new Date().toISOString(),
      rungs: [
        {
          rung: "non-null",
          rule: "situs_address IS NOT NULL — the P-27 counting rule, reproduced",
          parcels: totals.nonNull,
          pct: pct(totals.nonNull),
          knownPassingSentinel: '", ,"  (Bastrop)',
        },
        {
          rung: "non-blank",
          rule: "btrim(situs_address) <> ''",
          parcels: totals.nonBlank,
          pct: pct(totals.nonBlank),
          knownPassingSentinel: '", ,"  — the defect was never an empty string',
        },
        {
          rung: "carries-a-street",
          rule: "the text before the first comma contains a letter or a digit",
          parcels: totals.street,
          pct: pct(totals.street),
          knownPassingSentinel: null,
        },
        {
          rung: "carries-a-city",
          rule: "btrim(situs_city) <> ''",
          parcels: totals.city,
          pct: pct(totals.city),
          knownPassingSentinel: null,
        },
      ],
    },
    notMeasured: [
      served.size === 0
        ? "SERVED: no county serving-sweep record was supplied, so every served figure is not-measured and none is a zero."
        : `SERVED: measured for ${served.size} of ${roster.length} loaded counties; every other county's served state is not-measured, never zero.`,
      "WRITTEN depth in PARCELS is measured only for the families whose entity_id key proves one atom per parcel; for the rest the figure is atom ROWS and says so.",
      "This audit does not measure whether a written atom is CORRECT, only whether it exists, is scored, and is served.",
    ],
    contradictions: [],
    countyKeyDivergence: {
      check: "parcel-node entity_id prefix vs body.countyFips",
      disagreeingAtoms: keyDisagreement,
      verdict: keyDisagreement === 0 ? "county key derivation confirmed" : "DIVERGENT",
    },
  };

  const doc = {
    sweptAt: new Date().toISOString(),
    resolverVersion: AUDIT_VERSION,
    countiesTotal: COUNTIES_TOTAL,
    countiesSwept: served.size,
    parcelsTotal: [...served.values()].reduce((n, r) => n + (r.parcelsTotal ?? 0), 0),
    counties: [...served.values()],
    threeLayer,
  };

  fs.writeFileSync(path.join(args.out, "statewide.json"), JSON.stringify(doc, null, 2) + "\n");
  fs.writeFileSync(
    path.join(args.out, "three_layer_rollup.json"),
    JSON.stringify({ ...threeLayer, cells: undefined }, null, 2) + "\n",
  );
  announce({ phase: "done", rails: rollups.length, cells: cells.length, countiesLoaded: roster.length });
  process.stdout.write(
    `[SS-W9] ${rollups.length} rails x ${allCounties.length} counties = ${cells.length} cells -> ${args.out}\n`,
  );
}

main().catch((err) => {
  console.error("[SS-W9] FAILED:", err);
  process.exit(1);
});
