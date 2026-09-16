/**
 * P-295 phase 1 (OPS-24) — MEASURE what a ledger-served surface would have to read.
 *
 * THIS MODULE WRITES NOTHING, READS NOTHING AND DECIDES NOTHING. It exists so that the
 * question "can this rail serve from `parcel_record_cell` through retrieval-api's reader
 * today?" is answered by counts with a denominator instead of by prose. The build phase is
 * graded elsewhere (P-230's predicate); this lane proposes, it does not cut over.
 *
 * WHY IT LIVES BESIDE THE READER. Every measurement here is a question about the shape the
 * reader (`parcel-record-reader.ts`) consumes. `extractAtomDid` reads ONE field today —
 * top-level `cell.atomDid` — and the whole cut-over question turns on how many live cells
 * actually carry one. Keeping the pointer vocabulary in the same package as the reader means
 * the day a pointer field is added, the grep for its readers lands here too.
 *
 * THE POINTER VOCABULARY IS NAMED, NOT IMPLIED (DEV_PROCESS: an absence carries its basis).
 * `ATOM_POINTER_KEYS` is the candidate set the measurement tests for, and every entry is
 * either (a) the reader's own field or (b) a spelling a writer could plausibly have used for
 * the same thing. A measurement that only tested `atomDid` would report "0 of 26.8M" and
 * could not tell a reader that is unprepared from a writer that used a different name; the
 * candidates close that gap for the full population, and the sampled key vocabulary
 * (see the close artifact) closes it for arbitrary spellings on a 600k-row sample.
 *
 * TOP-LEVEL ONLY, AND SAID SO. A nested pointer (e.g. an `inputs[].atomDid`) is NOT counted
 * as a cell→atom reference, because the reader's `extractAtomDid` would not follow it
 * either. Counting it would report a readiness the serve path does not have.
 */

/** Every top-level `cell_state` key this instrument treats as a cell→atom reference. */
export const ATOM_POINTER_KEYS = [
  "atomDid",
  "atom_did",
  "atomRef",
  "atom_ref",
  "atomDids",
  "atomRefs",
  "atomVersion",
  "atom_version",
] as const;

export type AtomPointerKey = (typeof ATOM_POINTER_KEYS)[number];

/**
 * The six material kinds a cell can be in, plus the two states a measurement must never
 * conflate: a cell that carries a copied value AND a pointer ("value-with-pointer", the
 * ledger-as-serving-path end state) versus one that carries only a copied value
 * ("value-copied-only", accounting that is not yet dereferenceable).
 */
export type CellShapeKind =
  | "value-with-pointer"
  | "value-copied-only"
  | "value-no-kind-value-field"
  | "unaccounted"
  | "not-applicable"
  | "absent-verified"
  | "refused"
  | "no-kind";

export interface CellShape {
  /** `cell_state.kind` verbatim, or "(no-kind)" when absent. */
  kind: string;
  /** The pointer keys actually present, in vocabulary order. Empty means no reference. */
  atomPointerKeys: AtomPointerKey[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * The top-level pointer keys present on this cell, in `ATOM_POINTER_KEYS` order.
 * A key present with a null/empty value is NOT a reference: a writer that wrote
 * `atomDid: null` did not name an atom, and counting it would overstate readiness.
 */
export function atomPointerKeysOn(cell: unknown): AtomPointerKey[] {
  const rec = asRecord(cell);
  if (!rec) return [];
  const out: AtomPointerKey[] = [];
  for (const key of ATOM_POINTER_KEYS) {
    const v = rec[key];
    if (typeof v === "string" && v.trim().length > 0) out.push(key);
    else if (Array.isArray(v) && v.length > 0) out.push(key);
  }
  return out;
}

/**
 * Classify one cell. `kind: "value"` splits on the pointer test — that split IS the
 * measurement P-295 exists to make, so it is one function, never a SQL FILTER that could
 * drift from what the reader does.
 */
export function classifyCellShape(cell: unknown): CellShape {
  const rec = asRecord(cell);
  const kind = rec && typeof rec.kind === "string" && rec.kind.trim() ? rec.kind : "(no-kind)";
  const pointerKeys = atomPointerKeysOn(rec);
  return { kind, atomPointerKeys: pointerKeys };
}

export function shapeKindOf(cell: unknown): CellShapeKind {
  const { kind, atomPointerKeys } = classifyCellShape(cell);
  if (kind === "value") {
    if (atomPointerKeys.length > 0) return "value-with-pointer";
    const rec = asRecord(cell);
    // A `value` cell with no `value` field is its own state (setbackRules is the live
    // example: disposition "rows", no scalar). Folding it into "copied-only" would report
    // a copied number that is not there.
    return rec && "value" in rec ? "value-copied-only" : "value-no-kind-value-field";
  }
  if (kind === "unaccounted") return "unaccounted";
  if (kind === "not-applicable") return "not-applicable";
  if (kind === "absent-verified") return "absent-verified";
  if (kind === "refused") return "refused";
  return "no-kind";
}

/* ------------------------------- aggregation ------------------------------- */

/** One `(rail_key, kind, source, has_pointer)` group as the store returns it. */
export interface CellShapeGroupRow {
  railKey: string;
  kind: string;
  source: string;
  hasPointer: boolean;
  cells: number;
}

export interface RailSummary {
  railKey: string;
  cells: number;
  kinds: Record<string, number>;
  sources: Record<string, number>;
  /** `value` cells carrying a pointer of any kind. */
  valueWithPointer: number;
  /** `value` cells carrying only a copied value. */
  valueCopiedOnly: number;
  /**
   * Cells of any kind carrying a pointer. Must be 0 while no pointer is written.
   *
   * NOTE ON WHAT THE GROUPED QUERY CANNOT SPLIT: a `value` cell with no scalar `value`
   * field (row-shaped rails such as setbackRules) is a distinct state at the CELL level —
   * `shapeKindOf` returns "value-no-kind-value-field" for it — but the grouped cell-shape
   * SQL counts by (kind, source, has_pointer) only, so both land in `valueCopiedOnly` here.
   * A row-level probe, not this aggregate, is what separates them.
   */
  cellsWithPointerAnyKind: number;
}

export function summarizeRows(rows: readonly CellShapeGroupRow[]): RailSummary[] {
  const byRail = new Map<string, RailSummary>();
  for (const row of rows) {
    let r = byRail.get(row.railKey);
    if (!r) {
      r = {
        railKey: row.railKey,
        cells: 0,
        kinds: {},
        sources: {},
        valueWithPointer: 0,
        valueCopiedOnly: 0,
        cellsWithPointerAnyKind: 0,
      };
      byRail.set(row.railKey, r);
    }
    const n = row.cells;
    r.cells += n;
    r.kinds[row.kind] = (r.kinds[row.kind] ?? 0) + n;
    r.sources[row.source] = (r.sources[row.source] ?? 0) + n;
    if (row.hasPointer) r.cellsWithPointerAnyKind += n;
    if (row.kind === "value") {
      if (row.hasPointer) r.valueWithPointer += n;
      else r.valueCopiedOnly += n;
    }
  }
  return [...byRail.values()].sort((a, b) => b.cells - a.cells);
}

export interface CellShapeTotals {
  counties: string[];
  totalCells: number;
  perCounty: Record<string, number>;
  byKind: Record<string, number>;
  rails: RailSummary[];
  railCount: number;
  valueCells: number;
  /** THE headline number: `value` cells carrying an atom reference of any kind. */
  valueCellsWithPointer: number;
  valueCellsCopiedOnly: number;
  cellsWithPointerAnyKind: number;
}

export function totalsFromRows(
  rows: readonly CellShapeGroupRow[],
  perCounty: Record<string, number>,
  counties: readonly string[],
): CellShapeTotals {
  const rails = summarizeRows(rows);
  const byKind: Record<string, number> = {};
  let totalCells = 0;
  for (const r of rails) {
    totalCells += r.cells;
    for (const [k, v] of Object.entries(r.kinds)) byKind[k] = (byKind[k] ?? 0) + v;
  }
  return {
    counties: [...counties],
    totalCells,
    perCounty,
    byKind: Object.fromEntries(Object.entries(byKind).sort((a, b) => b[1] - a[1])),
    rails,
    railCount: rails.length,
    valueCells: rails.reduce((s, r) => s + (r.kinds.value ?? 0), 0),
    valueCellsWithPointer: rails.reduce((s, r) => s + r.valueWithPointer, 0),
    valueCellsCopiedOnly: rails.reduce((s, r) => s + r.valueCopiedOnly, 0),
    cellsWithPointerAnyKind: rails.reduce((s, r) => s + r.cellsWithPointerAnyKind, 0),
  };
}

/* --------------------------------- timing --------------------------------- */

/**
 * The `/record` latency of the route the map panel and the PDF both call, for 20 parcels,
 * cold and warm. `cold` and `warm` are separate arrays because a single pooled set would
 * let a warm sample answer a cold question.
 */
export interface RecordTiming {
  coldMs: number[];
  warmMs: number[];
}

/** Nearest-rank percentile. p=50 on [1..4] returns 2, never an interpolated value no observation had. */
export function percentile(sortedOrNot: readonly number[], p: number): number | null {
  if (sortedOrNot.length === 0) return null;
  const sorted = [...sortedOrNot].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[idx]!;
}

export function timingSummary(t: RecordTiming): {
  n: { cold: number; warm: number };
  cold: { p50: number | null; p95: number | null; min: number | null; max: number | null };
  warm: { p50: number | null; p95: number | null; min: number | null; max: number | null };
} {
  const one = (xs: readonly number[]) => ({
    p50: percentile(xs, 50),
    p95: percentile(xs, 95),
    min: xs.length ? Math.min(...xs) : null,
    max: xs.length ? Math.max(...xs) : null,
  });
  return { n: { cold: t.coldMs.length, warm: t.warmMs.length }, cold: one(t.coldMs), warm: one(t.warmMs) };
}

/* ----------------------------------- SQL ---------------------------------- */

/** Five-digit FIPS, checked before any SQL is built (a malformed county never reaches the store). */
export function assertCountyFips(countyFips: string): string {
  if (!/^\d{5}$/.test(countyFips)) throw new Error(`countyFips must be five digits, got ${JSON.stringify(countyFips)}`);
  return countyFips;
}

/** The half-open upper bound of a county's `place_key` prefix range: 48021 -> '48022:'. */
export function countyRange(countyFips: string): { lo: string; hi: string } {
  assertCountyFips(countyFips);
  return { lo: `${countyFips}:`, hi: `${Number(countyFips) + 1}:` };
}

/**
 * The header the cell-shape COPY emits, in order. Parsing is asserted against it rather than
 * positional, so a column added on one side and not the other fails loudly.
 */
export const CELL_SHAPE_CSV_HEADER = "rail_key,kind,source,has_pointer,cells" as const;

/**
 * Cell shape per rail for one county.
 *
 * ACCESS PATH, STATED: the county `place_key` prefix range is a range scan on the
 * `(place_key, rail_key)` primary key — never `rail_key` alone across all counties, and never
 * a bare scan. `SET statement_timeout` and `SET default_transaction_read_only=on` are part of
 * the statement, not a caller's habit (a heavy scan without them is what the dispatch forbids).
 */
export function cellShapeSql(countyFips: string, statementTimeoutMs = 1_500_000): string {
  const { lo, hi } = countyRange(countyFips);
  return [
    `SET statement_timeout='${Math.trunc(statementTimeoutMs)}';`,
    `SET default_transaction_read_only=on;`,
    `COPY (`,
    `  SELECT rail_key,`,
    `         coalesce(cell_state->>'kind','(no-kind)') AS kind,`,
    `         coalesce(cell_state->>'source','(no-source)') AS source,`,
    `         (cell_state ?| array[${ATOM_POINTER_KEYS.map((k) => `'${k}'`).join(", ")}]) AS has_pointer,`,
    `         count(*) AS cells`,
    `    FROM parcel_record_cell`,
    `   WHERE place_key >= '${lo}' AND place_key < '${hi}'`,
    `   GROUP BY 1,2,3,4`,
    `) TO STDOUT WITH (FORMAT csv, HEADER true);`,
  ].join("\n");
}

/** The one place the CSV header this instrument parses is asserted. */
export function parseCellShapeCsv(raw: string): CellShapeGroupRow[] {
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) throw new Error("cell-shape CSV is empty (an empty result is not an absence)");
  if (lines[0] !== CELL_SHAPE_CSV_HEADER) {
    throw new Error(`cell-shape CSV header changed: got ${JSON.stringify(lines[0])}, want ${JSON.stringify(CELL_SHAPE_CSV_HEADER)}`);
  }
  const out: CellShapeGroupRow[] = [];
  for (const line of lines.slice(1)) {
    const lastComma = line.lastIndexOf(",");
    const head = line.slice(0, lastComma).split(",");
    const cells = Number(line.slice(lastComma + 1));
    if (head.length !== 4 || !Number.isFinite(cells)) throw new Error(`malformed cell-shape row: ${JSON.stringify(line)}`);
    const [railKey, kind, source, hasPointer] = head as [string, string, string, string];
    out.push({ railKey, kind, source, hasPointer: hasPointer === "t" || hasPointer === "true", cells });
  }
  return out;
}

/**
 * The atoms-existence probe for one entity type over a list of parcel node ids.
 *
 * INDEX PATH, STATED: `(entity_type, entity_id)` — `atoms_entity_composite_unique`, a unique
 * btree — so this is N point lookups and never a scan of the 199 GB `atoms` table. The
 * partial index `atoms_property_parcel_node_idx` reaches the same rows through
 * `body->>'parcelNodeId'`; `atomsEntityLookupExplainSql` is the EXPLAIN either way, and the
 * plan is a falsifier, not a footnote: an unindexed path on that table must be refused, not run.
 */
export function atomsLookupSql(entityType: string, parcelNodeIds: readonly string[]): string {
  if (!/^[a-z][a-z0-9-]*$/.test(entityType)) throw new Error(`entityType must be kebab-case, got ${JSON.stringify(entityType)}`);
  for (const id of parcelNodeIds) {
    if (!/^\d{5}:[A-Za-z0-9._-]+$/.test(id)) throw new Error(`parcelNodeId must be <fips>:<prop_id>, got ${JSON.stringify(id)}`);
  }
  if (parcelNodeIds.length === 0) throw new Error("atoms lookup needs at least one parcel node id (never a whole-table query)");
  const list = parcelNodeIds.map((id) => `'${id}'`).join(", ");
  return [
    `SET statement_timeout='120000';`,
    `SET default_transaction_read_only=on;`,
    `SELECT entity_type, entity_id, atom_did, body->>'districtCode' AS district_code,`,
    `       body->>'district' AS district, body->>'front' AS front, body->>'side' AS side,`,
    `       body->>'rear' AS rear, body->>'sideCornerFt' AS side_corner_ft,`,
    `       body->>'outcome' AS outcome, fetched_at`,
    `  FROM atoms`,
    ` WHERE entity_type = '${entityType}'`,
    `   AND entity_id IN (${list});`,
  ].join("\n");
}

/** `EXPLAIN` (never `EXPLAIN ANALYZE` — this must not run the query) for one lookup. */
export function atomsEntityLookupExplainSql(entityType: string, parcelNodeId: string): string {
  if (!/^\d{5}:[A-Za-z0-9._-]+$/.test(parcelNodeId)) throw new Error(`parcelNodeId must be <fips>:<prop_id>, got ${JSON.stringify(parcelNodeId)}`);
  return [
    `SET statement_timeout='60000';`,
    `SET default_transaction_read_only=on;`,
    `EXPLAIN SELECT entity_type, atom_did`,
    `  FROM atoms`,
    ` WHERE entity_type = '${entityType}' AND entity_id = '${parcelNodeId}';`,
  ].join("\n");
}

/** `EXPLAIN` (never ANALYZE) for the partial-index spelling of the same question. */
export function atomsParcelNodeExplainSql(entityType: string, parcelNodeId: string): string {
  return [
    `SET statement_timeout='60000';`,
    `SET default_transaction_read_only=on;`,
    `EXPLAIN SELECT entity_type, atom_did`,
    `  FROM atoms`,
    ` WHERE entity_type = '${entityType}' AND body->>'parcelNodeId' = '${parcelNodeId}';`,
  ].join("\n");
}
