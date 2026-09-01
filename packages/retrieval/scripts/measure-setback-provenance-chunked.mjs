#!/usr/bin/env node
/**
 * F-11 / A3 — chunked F1 provenance measure.
 * Borrows containment: cheap key load, half-open RANGE predicate,
 * one run_event per chunk, resume from ledger. Timeout stays 15s.
 *
 * Does not write atoms. A timed-out chunk is UNMEASURED, never 0.
 * Page size is DEFAULT_BAKE_PAGE_SIZE (8000), borrowed, not fitted.
 *
 *   DATABASE_URL=... node packages/retrieval/scripts/measure-setback-provenance-chunked.mjs
 *   node packages/retrieval/scripts/measure-setback-provenance-chunked.mjs --self-test
 */
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIPS,
  TIMEOUT,
  PLACEHOLDER_MARKER,
  PRE_REGISTERED_SPLIT,
  RECONCILE,
  nextEntityIdBound,
  selfTestMeasureClassifier,
} from "./measure-setback-provenance.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LEDGER_PATH = join(HERE, "f1-chunk-ledger.jsonl");

/** Borrowed from factory containment pagePropIds. Not a wallMs law. */
export const PAGE_SIZE = 8000;

export const MEASURE_SQL_CONTRACT = Object.freeze({
  entityIdRange: "entity_id >= $lo AND entity_id < $hi",
  atomDidRange: "atom_did >= $lo AND atom_did < $hi",
  forbidden: "IN (SELECT",
  timeout: TIMEOUT,
});

export function pageIds(ids, pageSize = PAGE_SIZE) {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error(`pageSize must be a positive integer, got ${pageSize}`);
  }
  const pages = [];
  for (let i = 0; i < ids.length; i += pageSize) {
    pages.push(ids.slice(i, i + pageSize));
  }
  return pages;
}

export function rangesFromPagedIds(pages, countyEnd) {
  return pages.map((page, i) => ({
    loInclusive: page[0],
    hiExclusive: pages[i + 1]?.[0] ?? countyEnd,
    nKeys: page.length,
  }));
}

export function chunkKey(fips, predicate, lo, hi) {
  return `${fips}\t${predicate}\t${lo}\t${hi ?? ""}`;
}

export function parseLedger(text) {
  if (!text || !text.trim()) return [];
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

export function loadLedger(path) {
  if (!existsSync(path)) return [];
  return parseLedger(readFileSync(path, "utf8"));
}

export function appendLedger(path, event) {
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
}

export function scoredKeys(events) {
  const keys = new Set();
  for (const e of events) {
    if (e?.kind === "run_event" && e.status === "scored") {
      keys.add(chunkKey(e.fips, e.predicate, e.lo, e.hi));
    }
  }
  return keys;
}

export function isTimeout(err) {
  if (!err || typeof err !== "object") return false;
  return (
    String(err.message ?? "").includes("statement timeout") ||
    err.code === "57014"
  );
}

export function emptyCounts() {
  return {
    placeholder: 0,
    "layer-23": 0,
    "road-class-setback-table": 0,
    "other-dimensional": 0,
  };
}

export function addCounts(a, b) {
  const out = emptyCounts();
  for (const k of Object.keys(out)) {
    out[k] = Number(a?.[k] ?? 0) + Number(b?.[k] ?? 0);
  }
  return out;
}

export function nonPlaceholder(counts) {
  return (
    Number(counts["layer-23"] ?? 0) +
    Number(counts["road-class-setback-table"] ?? 0) +
    Number(counts["other-dimensional"] ?? 0)
  );
}

/**
 * County total exists only when every planned chunk is scored.
 * A leftover UNMEASURED range refuses the total.
 */
export function summarizeCounty(events, fips, predicate) {
  const plans = events.filter(
    (e) => e?.kind === "chunk_plan" && e.fips === fips && e.predicate === predicate,
  );
  const latestPlan = plans.at(-1);
  if (!latestPlan) {
    return {
      fips,
      predicate,
      complete: false,
      totals: null,
      reason: "no chunk_plan",
      scoredRanges: [],
      unmeasuredRanges: [],
    };
  }
  if (latestPlan.status === "unmeasured") {
    return {
      fips,
      predicate,
      complete: false,
      totals: null,
      reason: latestPlan.reason ?? "chunk_plan unmeasured",
      scoredRanges: [],
      unmeasuredRanges: [],
    };
  }
  if (
    latestPlan.status === "planned" &&
    Number(latestPlan.nKeys) === 0 &&
    Array.isArray(latestPlan.ranges) &&
    latestPlan.ranges.length === 0
  ) {
    return {
      fips,
      predicate,
      complete: true,
      totals: emptyCounts(),
      nKeys: 0,
      nonPlaceholder: 0,
      reason: "scout returned 0 keys",
      scoredRanges: [],
      unmeasuredRanges: [],
    };
  }
  if (!latestPlan.ranges?.length) {
    return {
      fips,
      predicate,
      complete: false,
      totals: null,
      reason: "no chunk_plan ranges",
      scoredRanges: [],
      unmeasuredRanges: [],
    };
  }
  const scored = [];
  const unmeasured = [];
  for (const range of latestPlan.ranges) {
    const key = chunkKey(fips, predicate, range.loInclusive, range.hiExclusive);
    const hits = events.filter(
      (e) =>
        e?.kind === "run_event" &&
        chunkKey(e.fips, e.predicate, e.lo, e.hi) === key,
    );
    const last = hits.at(-1);
    if (last?.status === "scored") {
      scored.push({
        lo: range.loInclusive,
        hi: range.hiExclusive,
        nKeys: range.nKeys,
        counts: last.counts,
        wallMs: last.wallMs,
      });
    } else {
      unmeasured.push({
        lo: range.loInclusive,
        hi: range.hiExclusive,
        nKeys: range.nKeys,
        status: last?.status ?? "unrun",
        reason: last?.reason ?? "no run_event",
      });
    }
  }
  if (unmeasured.length > 0) {
    return {
      fips,
      predicate,
      complete: false,
      totals: null,
      reason: `${unmeasured.length} of ${latestPlan.ranges.length} ranges UNMEASURED`,
      scoredRanges: scored,
      unmeasuredRanges: unmeasured,
    };
  }
  let totals = emptyCounts();
  let nKeys = 0;
  for (const r of scored) {
    totals = addCounts(totals, r.counts);
    nKeys += r.nKeys;
  }
  return {
    fips,
    predicate,
    complete: true,
    totals,
    nKeys,
    nonPlaceholder: nonPlaceholder(totals),
    scoredRanges: scored,
    unmeasuredRanges: [],
  };
}

export function scorePublishedSplit(summaries) {
  const needed = FIPS;
  const missing = [];
  let placeholder = 0;
  let nonPh = 0;
  for (const fips of needed) {
    const s = summaries.find((x) => x.fips === fips && x.predicate === "entity_id");
    if (!s?.complete) {
      missing.push(fips);
      continue;
    }
    placeholder += Number(s.totals.placeholder ?? 0);
    nonPh += s.nonPlaceholder;
  }
  if (missing.length > 0) {
    return {
      placeholder: "UNMEASURED",
      nonPlaceholder: "UNMEASURED",
      missing,
      vsPublished: {
        placeholder188103: "UNMEASURED",
        nonPlaceholder158573: "UNMEASURED",
      },
    };
  }
  return {
    placeholder,
    nonPlaceholder: nonPh,
    missing: [],
    vsPublished: {
      placeholder188103:
        placeholder === PRE_REGISTERED_SPLIT.placeholder ? "stayed" : "moved",
      nonPlaceholder158573:
        nonPh === PRE_REGISTERED_SPLIT.nonPlaceholder ? "stayed" : "moved",
      placeholderDelta: placeholder - PRE_REGISTERED_SPLIT.placeholder,
      nonPlaceholderDelta: nonPh - PRE_REGISTERED_SPLIT.nonPlaceholder,
    },
  };
}

function likePlaceholder() {
  return `%${PLACEHOLDER_MARKER}%`;
}

export function selfTestChunked() {
  selfTestMeasureClassifier();
  if (TIMEOUT !== "15s") throw new Error("self-test FAIL: timeout was raised");
  if (PAGE_SIZE !== 8000) {
    throw new Error("self-test FAIL: page size is not the borrowed 8000");
  }
  if (MEASURE_SQL_CONTRACT.forbidden !== "IN (SELECT") {
    throw new Error("self-test FAIL: contract must forbid IN (SELECT) range cuts");
  }
  const measureSrc = String(measureRange);
  if (measureSrc.includes("IN (SELECT") || /LIMIT\s+\d+/i.test(measureSrc)) {
    throw new Error("self-test FAIL: measureRange uses IN (SELECT) or LIMIT");
  }

  const ids = ["48021:1", "48021:2", "48021:3", "48021:4"];
  const pages = pageIds(ids, 2);
  const ranges = rangesFromPagedIds(pages, "48022:");
  if (ranges.length !== 2) throw new Error("self-test FAIL: page count");
  if (ranges[0].loInclusive !== "48021:1" || ranges[0].hiExclusive !== "48021:3") {
    throw new Error("self-test FAIL: first range is not half-open");
  }
  if (ranges[1].hiExclusive !== "48022:") {
    throw new Error("self-test FAIL: last hi must be county end, not a LIMIT key");
  }

  const plan = {
    kind: "chunk_plan",
    fips: "48453",
    predicate: "entity_id",
    ranges: [
      { loInclusive: "48453:a", hiExclusive: "48453:b", nKeys: 2 },
      { loInclusive: "48453:b", hiExclusive: "48454:", nKeys: 2 },
    ],
  };
  const scoredOnlyFirst = [
    plan,
    {
      kind: "run_event",
      fips: "48453",
      predicate: "entity_id",
      lo: "48453:a",
      hi: "48453:b",
      status: "scored",
      counts: { placeholder: 2, "layer-23": 0, "road-class-setback-table": 0, "other-dimensional": 0 },
    },
    {
      kind: "run_event",
      fips: "48453",
      predicate: "entity_id",
      lo: "48453:b",
      hi: "48454:",
      status: "unmeasured",
      reason: "statement_timeout 15s",
    },
  ];
  const partial = summarizeCounty(scoredOnlyFirst, "48453", "entity_id");
  if (partial.complete !== false || partial.totals !== null) {
    throw new Error("self-test FAIL: partial sweep produced a total");
  }
  if (partial.unmeasuredRanges.length !== 1 || partial.scoredRanges.length !== 1) {
    throw new Error("self-test FAIL: scored and unmeasured ranges not split");
  }
  const split = scorePublishedSplit([partial]);
  if (split.placeholder !== "UNMEASURED" || split.nonPlaceholder !== "UNMEASURED") {
    throw new Error("self-test FAIL: published split invented from a partial");
  }

  const emptyPlan = [
    {
      kind: "chunk_plan",
      fips: "48309",
      predicate: "entity_id",
      status: "planned",
      nKeys: 0,
      ranges: [],
    },
  ];
  const emptySum = summarizeCounty(emptyPlan, "48309", "entity_id");
  if (emptySum.complete !== true || emptySum.nKeys !== 0 || emptySum.totals.placeholder !== 0) {
    throw new Error("self-test FAIL: successful empty scout must be complete zeros, not UNMEASURED");
  }
  const missing = summarizeCounty([], "48309", "entity_id");
  if (missing.complete !== false || missing.totals !== null) {
    throw new Error("self-test FAIL: absent plan must stay UNMEASURED");
  }

  const keys = scoredKeys(scoredOnlyFirst);
  if (!keys.has(chunkKey("48453", "entity_id", "48453:a", "48453:b"))) {
    throw new Error("self-test FAIL: scored chunk not skipped on resume");
  }
  if (keys.has(chunkKey("48453", "entity_id", "48453:b", "48454:"))) {
    throw new Error("self-test FAIL: unmeasured chunk treated as scored");
  }

  const timeoutErr = { message: "canceling statement due to statement timeout", code: "57014" };
  if (!isTimeout(timeoutErr)) throw new Error("self-test FAIL: timeout not detected");
}

function parseArgs(argv) {
  const out = {
    selfTest: argv.includes("--self-test"),
    scoutOnly: argv.includes("--scout-only"),
    summarizeOnly: argv.includes("--summarize-only"),
    ledger: DEFAULT_LEDGER_PATH,
    fips: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ledger") out.ledger = argv[++i];
    else if (a.startsWith("--ledger=")) out.ledger = a.slice("--ledger=".length);
    else if (a === "--fips") out.fips = argv[++i];
    else if (a.startsWith("--fips=")) out.fips = a.slice("--fips=".length);
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function countsFromRows(rows) {
  const counts = emptyCounts();
  for (const r of rows) {
    const k = r.provenance;
    if (k in counts) counts[k] = Number(r.n);
  }
  return counts;
}

async function loadKeys(sql, { startCol, start, end }) {
  if (startCol === "entity_id") {
    return sql`
      SELECT entity_id AS k
      FROM atoms
      WHERE entity_type = 'setback-rule'
        AND entity_id >= ${start}
        AND entity_id < ${end}
      ORDER BY entity_id
    `;
  }
  return sql`
    SELECT atom_did AS k
    FROM atoms
    WHERE entity_type = 'setback-rule'
      AND atom_did >= ${start}
      AND atom_did < ${end}
    ORDER BY atom_did
  `;
}

async function measureRange(sql, { startCol, start, end }) {
  const needle = likePlaceholder();
  if (startCol === "entity_id") {
    return sql`
      SELECT
        CASE
          WHEN body->'sourceCodeAtomRef'->>'atomDid' LIKE ${needle}
            OR body->'fieldProvenance'->'front'->>'atomDid' LIKE ${needle}
            OR body->'fieldProvenance'->'side'->>'atomDid' LIKE ${needle}
            OR body->'fieldProvenance'->'rear'->>'atomDid' LIKE ${needle}
            THEN 'placeholder'
          WHEN body->>'sourceAdapter' = 'bastrop-per-parcel-record-layer-23'
            THEN 'layer-23'
          WHEN body->>'sourceAdapter' = 'road-class-setback-table'
            THEN 'road-class-setback-table'
          ELSE 'other-dimensional'
        END AS provenance,
        count(*)::bigint AS n
      FROM atoms
      WHERE entity_type = 'setback-rule'
        AND entity_id >= ${start}
        AND entity_id < ${end}
      GROUP BY 1
    `;
  }
  return sql`
    SELECT
      CASE
        WHEN body->'sourceCodeAtomRef'->>'atomDid' LIKE ${needle}
          OR body->'fieldProvenance'->'front'->>'atomDid' LIKE ${needle}
          OR body->'fieldProvenance'->'side'->>'atomDid' LIKE ${needle}
          OR body->'fieldProvenance'->'rear'->>'atomDid' LIKE ${needle}
          THEN 'placeholder'
        WHEN body->>'sourceAdapter' = 'bastrop-per-parcel-record-layer-23'
          THEN 'layer-23'
        WHEN body->>'sourceAdapter' = 'road-class-setback-table'
          THEN 'road-class-setback-table'
        ELSE 'other-dimensional'
      END AS provenance,
      count(*)::bigint AS n
    FROM atoms
    WHERE entity_type = 'setback-rule'
      AND atom_did >= ${start}
      AND atom_did < ${end}
    GROUP BY 1
  `;
}

async function measureEnvelopes(sql, start, end) {
  return sql`
    SELECT count(*)::bigint AS n
    FROM atoms
    WHERE entity_type = 'buildable-envelope'
      AND entity_id >= ${start}
      AND entity_id < ${end}
  `;
}

async function runTimed(sql, fn) {
  const t0 = Date.now();
  try {
    await sql.unsafe(`SET statement_timeout = '${TIMEOUT}'`);
    const value = await fn();
    return { ok: true, value, wallMs: Date.now() - t0 };
  } catch (err) {
    const timedOut = isTimeout(err);
    return {
      ok: false,
      timedOut,
      reason: timedOut ? `statement_timeout ${TIMEOUT}` : String(err?.message ?? err),
      wallMs: Date.now() - t0,
    };
  }
}

async function scoutAndPlan(sql, ledgerPath, events, { fips, predicate, start, end }) {
  const existing = [...events]
    .reverse()
    .find(
      (e) =>
        e?.kind === "chunk_plan" &&
        e.fips === fips &&
        e.predicate === predicate &&
        e.status === "planned" &&
        Array.isArray(e.ranges),
    );
  if (existing) return existing;

  const scout = await runTimed(sql, () => loadKeys(sql, { startCol: predicate, start, end }));
  if (!scout.ok) {
    const event = {
      kind: "chunk_plan",
      at: nowIso(),
      fips,
      predicate,
      status: "unmeasured",
      reason: scout.reason,
      wallMs: scout.wallMs,
      timeout: TIMEOUT,
      ranges: [],
    };
    appendLedger(ledgerPath, event);
    return event;
  }
  const ids = scout.value.map((r) => String(r.k));
  const ranges = ids.length === 0 ? [] : rangesFromPagedIds(pageIds(ids), end);
  const event = {
    kind: "chunk_plan",
    at: nowIso(),
    fips,
    predicate,
    status: "planned",
    nKeys: ids.length,
    loInclusive: ids[0] ?? null,
    hiExclusive: end,
    pageSize: PAGE_SIZE,
    pageSizeNote: "borrowed DEFAULT_BAKE_PAGE_SIZE; wallMs is data",
    ranges,
    wallMs: scout.wallMs,
    timeout: TIMEOUT,
  };
  appendLedger(ledgerPath, event);
  return event;
}

async function runChunk(sql, ledgerPath, events, { fips, predicate, range }) {
  const key = chunkKey(fips, predicate, range.loInclusive, range.hiExclusive);
  if (scoredKeys(events).has(key)) {
    return { skipped: true, key };
  }
  const measured = await runTimed(sql, () =>
    measureRange(sql, {
      startCol: predicate,
      start: range.loInclusive,
      end: range.hiExclusive,
    }),
  );
  const event = {
    kind: "run_event",
    at: nowIso(),
    fips,
    predicate,
    lo: range.loInclusive,
    hi: range.hiExclusive,
    nKeys: range.nKeys,
    wallMs: measured.wallMs,
    timeout: TIMEOUT,
  };
  if (!measured.ok) {
    event.status = "unmeasured";
    event.reason = measured.reason;
    event.counts = null;
  } else {
    event.status = "scored";
    event.counts = countsFromRows(measured.value);
  }
  appendLedger(ledgerPath, event);
  events.push(event);
  console.error(
    JSON.stringify({
      progress: event.status,
      fips,
      predicate,
      lo: event.lo,
      hi: event.hi,
      wallMs: event.wallMs,
      nKeys: event.nKeys ?? null,
    }),
  );
  return event;
}

async function runEnvelopes(sql, ledgerPath, events, { fips, start, end }) {
  const key = chunkKey(fips, "envelope_entity_id", start, end);
  if (scoredKeys(events).has(key)) return { skipped: true, key };
  const measured = await runTimed(sql, () => measureEnvelopes(sql, start, end));
  const event = {
    kind: "run_event",
    at: nowIso(),
    fips,
    predicate: "envelope_entity_id",
    lo: start,
    hi: end,
    wallMs: measured.wallMs,
    timeout: TIMEOUT,
  };
  if (!measured.ok) {
    event.status = "unmeasured";
    event.reason = measured.reason;
    event.n = null;
  } else {
    event.status = "scored";
    event.n = Number(measured.value[0]?.n ?? 0);
  }
  appendLedger(ledgerPath, event);
  events.push(event);
  return event;
}

async function measureCounty(sql, ledgerPath, events, fips) {
  const start = `${fips}:`;
  const end = nextEntityIdBound(fips);
  const didStart = `did:hauska:setback-rule:${start}`;
  const didEnd = `did:hauska:setback-rule:${end}`;

  const entityPlan = await scoutAndPlan(sql, ledgerPath, events, {
    fips,
    predicate: "entity_id",
    start,
    end,
  });
  if (!events.includes(entityPlan)) events.push(entityPlan);
  if (entityPlan.status === "planned") {
    for (const range of entityPlan.ranges) {
      await runChunk(sql, ledgerPath, events, { fips, predicate: "entity_id", range });
    }
  }

  const didPlan = await scoutAndPlan(sql, ledgerPath, events, {
    fips,
    predicate: "atom_did",
    start: didStart,
    end: didEnd,
  });
  if (!events.includes(didPlan)) events.push(didPlan);
  if (didPlan.status === "planned") {
    for (const range of didPlan.ranges) {
      await runChunk(sql, ledgerPath, events, { fips, predicate: "atom_did", range });
    }
  }

  await runEnvelopes(sql, ledgerPath, events, { fips, start, end });
  return {
    entityId: summarizeCounty(events, fips, "entity_id"),
    atomDid: summarizeCounty(events, fips, "atom_did"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  selfTestChunked();
  if (args.selfTest) {
    console.log(
      JSON.stringify({
        snapshot: "self-test",
        selfTest: "pass",
        timeout: TIMEOUT,
        pageSize: PAGE_SIZE,
        chunkPredicate: MEASURE_SQL_CONTRACT,
        axes: [
          "sourceCodeAtomRef",
          "fieldProvenance.front",
          "fieldProvenance.side",
          "fieldProvenance.rear",
        ],
        preRegisteredSplit: PRE_REGISTERED_SPLIT,
        f4: "held",
      }),
    );
    return;
  }

  if (args.summarizeOnly) {
    const events = loadLedger(args.ledger);
    const summaries = FIPS.map((fips) => summarizeCounty(events, fips, "entity_id"));
    const didSummaries = FIPS.map((fips) => summarizeCounty(events, fips, "atom_did"));
    console.log(
      JSON.stringify(
        {
          snapshot: nowIso(),
          source: "ledger",
          ledger: args.ledger,
          timeout: TIMEOUT,
          entityId: summaries,
          atomDid: didSummaries,
          publishedSplit: scorePublishedSplit(summaries),
          preRegisteredSplit: PRE_REGISTERED_SPLIT,
        },
        null,
        2,
      ),
    );
    return;
  }

  const url = process.env.DATABASE_URL ?? process.env.ATOMS_DATABASE_URL;
  if (!url) {
    console.error(
      JSON.stringify({
        snapshot: "unmeasured",
        reason: "DATABASE_URL / ATOMS_DATABASE_URL unset",
        selfTest: "pass",
      }),
    );
    process.exit(2);
  }
  if (url.includes("-pooler")) {
    console.error(JSON.stringify({ snapshot: "unmeasured", reason: "pooler host refused" }));
    process.exit(2);
  }

  const fipsList = args.fips ? [args.fips] : FIPS;
  if (args.fips && !FIPS.includes(args.fips)) {
    throw new Error(`fips ${args.fips} is not in ${FIPS.join(",")}`);
  }

  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { max: 1, idle_timeout: 20, connect_timeout: 15 });
  const events = loadLedger(args.ledger);
  const startedAt = nowIso();
  try {
    const db = await sql`SELECT current_database() AS db`;
    const dbName = String(db[0]?.db ?? "");
    if (dbName !== "hauska_mcp") {
      throw new Error(`refusing database ${dbName}; expected hauska_mcp`);
    }
    if (args.scoutOnly) {
      const scouts = [];
      for (const fips of fipsList) {
        const start = `${fips}:`;
        const end = nextEntityIdBound(fips);
        const plan = await scoutAndPlan(sql, args.ledger, events, {
          fips,
          predicate: "entity_id",
          start,
          end,
        });
        scouts.push(plan);
      }
      console.log(JSON.stringify({ snapshot: nowIso(), timeout: TIMEOUT, scouts }, null, 2));
      return;
    }
    for (const fips of fipsList) {
      await measureCounty(sql, args.ledger, events, fips);
    }
    const summaries = FIPS.map((fips) => summarizeCounty(events, fips, "entity_id"));
    const didSummaries = FIPS.map((fips) => summarizeCounty(events, fips, "atom_did"));
    console.log(
      JSON.stringify(
        {
          snapshot: nowIso(),
          startedAt,
          timeout: TIMEOUT,
          pageSize: PAGE_SIZE,
          db: dbName,
          axes: [
            "sourceCodeAtomRef",
            "fieldProvenance.front",
            "fieldProvenance.side",
            "fieldProvenance.rear",
          ],
          preRegisteredSplit: PRE_REGISTERED_SPLIT,
          falsifier:
            "Adding side, rear and sourceCodeAtomRef must not move 188103 or 158573",
          f4: "held",
          entityId: summaries,
          atomDid: didSummaries,
          publishedSplit: scorePublishedSplit(summaries),
          ledger: args.ledger,
        },
        null,
        2,
      ),
    );
  } finally {
    await sql.end({ timeout: 2 });
  }
}

const invoked =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) {
  main().catch((err) => {
    console.error(JSON.stringify({ snapshot: "unmeasured", reason: String(err) }));
    process.exit(2);
  });
}
