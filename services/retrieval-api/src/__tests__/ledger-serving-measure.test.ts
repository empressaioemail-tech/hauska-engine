/**
 * P-295 phase 1 — self-tests for the ledger-serving measurement instrument.
 *
 * THE FALSIFIER THIS SATISFIES (dispatch, falsifier 1): "run against a fixture where a cell
 * carries an atom reference and one where it does not, reports each correctly (shown in both
 * directions)." Both directions are asserted below against the SAME function the live
 * measurement calls, and the negative case is a real live shape (every one of the 26.8M
 * `value` cells in the six counties looks like it), not a shape invented to be classified.
 *
 * The not-vacuous test is the third one: a fixture whose pointer value is `null` must NOT
 * count. Without it, "0 of 26.8M carry a pointer" and "0 of 26.8M carry a pointer I
 * recognise" are the same observation, which is exactly the silent-fallback class this
 * program hunts.
 */

import { describe, expect, it } from "vitest";

import {
  ATOM_POINTER_KEYS,
  CELL_SHAPE_CSV_HEADER,
  atomPointerKeysOn,
  atomsEntityLookupExplainSql,
  atomsLookupSql,
  atomsParcelNodeExplainSql,
  cellShapeSql,
  classifyCellShape,
  countyRange,
  parseCellShapeCsv,
  percentile,
  shapeKindOf,
  summarizeRows,
  timingSummary,
  totalsFromRows,
  type CellShapeGroupRow,
} from "../ledger-serving-measure.js";

/** A cell as the factory store actually stores it (read live 2026-09-16, 48209:100226). */
const LIVE_COPIED_ONLY_CELL = {
  kind: "value",
  value: 20,
  source: "@empressaio/setback-corpus@1.1.0:buda-tx",
  vintage: "2026-09-15T00:54:11.683Z",
  dateBasis: "unreadable",
  sourceDate: null,
  districtCode: "B1",
  jurisdictionKey: "buda-tx",
  resolvedTableKey: "buda-tx",
};

/** The same cell, in the shape the ledger-as-serving-path ruling describes: accounting that names its atom. */
const LIVE_WITH_POINTER_CELL = { ...LIVE_COPIED_ONLY_CELL, atomDid: "did:hauska:setback-rule:48209:100226" };

describe("atom pointer detection — both directions", () => {
  it("POSITIVE: a cell carrying an atom reference reports that reference", () => {
    expect(atomPointerKeysOn(LIVE_WITH_POINTER_CELL)).toEqual(["atomDid"]);
    expect(shapeKindOf(LIVE_WITH_POINTER_CELL)).toBe("value-with-pointer");
  });

  it("NEGATIVE: the same cell without the reference reports none — it is copied-only", () => {
    expect(atomPointerKeysOn(LIVE_COPIED_ONLY_CELL)).toEqual([]);
    expect(shapeKindOf(LIVE_COPIED_ONLY_CELL)).toBe("value-copied-only");
  });

  it("NOT VACUOUS: a null or blank pointer is not a reference", () => {
    expect(atomPointerKeysOn({ kind: "value", value: 20, atomDid: null })).toEqual([]);
    expect(atomPointerKeysOn({ kind: "value", value: 20, atomDid: "   " })).toEqual([]);
    expect(shapeKindOf({ kind: "value", value: 20, atomDid: null })).toBe("value-copied-only");
  });

  it("every candidate spelling is detected, and an unrelated key is not", () => {
    for (const key of ATOM_POINTER_KEYS) {
      expect(atomPointerKeysOn({ kind: "value", value: 1, [key]: "did:hauska:x:1" })).toEqual([key]);
    }
    expect(atomPointerKeysOn({ kind: "value", value: 1, sourceAtom: "nope", atomCount: 2 })).toEqual([]);
  });

  it("a nested pointer is NOT counted — the reader would not follow it either", () => {
    const nested = { kind: "value", value: 1, inputs: [{ atomDid: "did:hauska:x:1" }] };
    expect(atomPointerKeysOn(nested)).toEqual([]);
  });

  it("row-shaped value cells are their own state, never 'copied-only'", () => {
    // Live shape of setbackRules: disposition "rows", no scalar `value` field.
    expect(shapeKindOf({ kind: "value", source: "x", rowCount: 1, disposition: "rows" })).toBe("value-no-kind-value-field");
  });

  it("non-value kinds classify by their own name", () => {
    expect(shapeKindOf({ kind: "unaccounted" })).toBe("unaccounted");
    expect(shapeKindOf({ kind: "not-applicable" })).toBe("not-applicable");
    expect(shapeKindOf({ kind: "absent-verified", basis: { disposition: "unincorporated" } })).toBe("absent-verified");
    expect(shapeKindOf({ kind: "refused", reason: "x" })).toBe("refused");
    expect(shapeKindOf(null)).toBe("no-kind");
    expect(classifyCellShape(undefined).kind).toBe("(no-kind)");
  });
});

describe("cell-shape SQL — the emitted statement is the measured one", () => {
  it("uses the PK prefix range, never a bare scan, and carries both guards", () => {
    const sql = cellShapeSql("48209");
    expect(sql).toContain("SET statement_timeout=");
    expect(sql).toContain("SET default_transaction_read_only=on;");
    expect(sql).toContain("WHERE place_key >= '48209:' AND place_key < '48210:'");
    expect(sql).toContain("FROM parcel_record_cell");
    expect(sql).not.toMatch(/FROM\s+parcel_record_cell\s*;/);
  });

  it("SQL pointer list and the TypeScript vocabulary cannot drift", () => {
    const sql = cellShapeSql("48209");
    const arrayLiteral = sql.match(/\?\| array\[([^\]]*)\]/)?.[1] ?? "";
    expect(arrayLiteral.split(", ").map((s) => s.replace(/'/g, ""))).toEqual([...ATOM_POINTER_KEYS]);
  });

  it("refuses a malformed county before any SQL is built", () => {
    expect(() => cellShapeSql("4820")).toThrow(/five digits/);
    expect(() => cellShapeSql("48209'; drop table parcel_record_cell; --")).toThrow(/five digits/);
    expect(countyRange("48021")).toEqual({ lo: "48021:", hi: "48022:" });
  });

  it("round-trips the emitted CSV, and refuses a changed header", () => {
    const csv = `${CELL_SHAPE_CSV_HEADER}\nsetbackFrontFt,value,(no-source),f,100\nsetbackFrontFt,value,txgio_parcel,f,5\n`;
    const rows = parseCellShapeCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ railKey: "setbackFrontFt", kind: "value", source: "(no-source)", hasPointer: false, cells: 100 });
    expect(() => parseCellShapeCsv(`rail_key,cells\nx,1\n`)).toThrow(/header changed/);
    expect(() => parseCellShapeCsv("")).toThrow(/empty/);
  });
});

describe("aggregation", () => {
  const rows: CellShapeGroupRow[] = [
    { railKey: "setbackFrontFt", kind: "value", source: "corpus:buda-tx", hasPointer: false, cells: 400 },
    { railKey: "setbackFrontFt", kind: "value", source: "corpus:buda-tx", hasPointer: true, cells: 100 },
    { railKey: "setbackFrontFt", kind: "unaccounted", source: "(no-source)", hasPointer: false, cells: 500 },
    { railKey: "maxHeightFt", kind: "value", source: "corpus:waco-tx", hasPointer: false, cells: 50 },
  ];

  it("splits value cells by pointer presence, with the denominator", () => {
    const [front, height] = summarizeRows(rows);
    expect(front!.railKey).toBe("setbackFrontFt");
    expect(front!.valueWithPointer).toBe(100);
    expect(front!.valueCopiedOnly).toBe(400);
    expect(front!.cells).toBe(1000);
    expect(front!.sources).toEqual({ "corpus:buda-tx": 500, "(no-source)": 500 });
    expect(height!.valueCopiedOnly).toBe(50);
  });

  it("totals carry the headline ratio with its counting rule", () => {
    const totals = totalsFromRows(rows, { "48209": 1000 }, ["48209"]);
    expect(totals.valueCells).toBe(550);
    expect(totals.valueCellsWithPointer).toBe(100);
    expect(totals.valueCellsCopiedOnly).toBe(450);
    expect(totals.railCount).toBe(2);
    expect(totals.totalCells).toBe(1050);
  });

  it("zero pointers is a reported zero, not an empty map", () => {
    const noPointers = rows.map((r) => ({ ...r, hasPointer: false }));
    const totals = totalsFromRows(noPointers, { "48209": 1050 }, ["48209"]);
    expect(totals.cellsWithPointerAnyKind).toBe(0);
    expect(totals.valueCellsCopiedOnly).toBe(550);
  });
});

describe("percentiles and timing", () => {
  it("nearest-rank p50/p95 distinguish, and are not interpolations", () => {
    const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(100);
    expect(percentile([5], 50)).toBe(5);
    expect(percentile([], 50)).toBeNull();
    expect(percentile(xs, 50)).not.toBe(percentile(xs, 95));
  });

  it("cold and warm samples are never pooled into one number", () => {
    const s = timingSummary({ coldMs: [900, 800], warmMs: [200, 210, 220] });
    expect(s.n).toEqual({ cold: 2, warm: 3 });
    expect(s.cold.p50).toBe(800);
    expect(s.warm.p50).toBe(210);
    expect(s.cold.p50).not.toBe(s.warm.p50);
  });
});

describe("atoms lookup SQL", () => {
  it("binds a bounded point-lookup list on (entity_type, entity_id)", () => {
    const sql = atomsLookupSql("setback-rule", ["48209:100226", "48021:34049"]);
    expect(sql).toContain("WHERE entity_type = 'setback-rule'");
    expect(sql).toContain("AND entity_id IN ('48209:100226', '48021:34049')");
    expect(sql).toContain("SET default_transaction_read_only=on;");
  });

  it("refuses an empty list and a malformed id — a whole-table query is never emitted", () => {
    expect(() => atomsLookupSql("setback-rule", [])).toThrow(/at least one/);
    expect(() => atomsLookupSql("setback-rule", ["48209; drop table atoms"])).toThrow(/fips/);
    expect(() => atomsLookupSql("Setback Rule", ["48209:1"])).toThrow(/kebab-case/);
  });

  it("plans are EXPLAIN, never ANALYZE — the falsifier must not run the query", () => {
    for (const sql of [atomsEntityLookupExplainSql("setback-rule", "48209:100226"), atomsParcelNodeExplainSql("setback-rule", "48209:100226")]) {
      expect(sql).toMatch(/^SET statement_timeout='\d+';\nSET default_transaction_read_only=on;\nEXPLAIN SELECT/);
      expect(sql).not.toContain("ANALYZE");
    }
    expect(atomsParcelNodeExplainSql("zoning-fact", "48209:100226")).toContain("body->>'parcelNodeId' = '48209:100226'");
  });
});
