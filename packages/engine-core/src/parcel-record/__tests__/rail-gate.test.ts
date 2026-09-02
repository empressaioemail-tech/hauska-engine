import { describe, expect, it } from "vitest";

import {
  evaluateRailGate,
  loadCountyRailCells,
  loadCountyRailCellsPage,
  countyRailCellsFirstAfter,
  type ParcelRecordSqlClient,
  type RailCell,
  type RailGateVerdict,
} from "../index.js";

function cell(placeKey: string, kind: "value" | "absent-verified" | "refused" | "not-applicable" | "unaccounted"): RailCell {
  if (kind === "value") {
    return { placeKey, state: { kind, source: "test", vintage: "test", value: "x" } };
  }
  if (kind === "absent-verified") {
    return { placeKey, state: { kind, basis: "test fixture" } };
  }
  if (kind === "refused") {
    return { placeKey, state: { kind, refusal: "test fixture" } };
  }
  if (kind === "not-applicable") {
    return { placeKey, state: { kind, reason: "test fixture" } };
  }
  return { placeKey, state: { kind: "unaccounted" } };
}

describe("evaluateRailGate (PARCEL-B-GATE-SCHED)", () => {
  it("a rail with zero earned cells is declared-ahead and passes trivially (matches deriveLiveRailKeys' definition of live)", () => {
    const cells = [cell("48021:1", "unaccounted"), cell("48021:2", "unaccounted")];
    const verdict = evaluateRailGate(cells, "flood");
    expect(verdict.ok).toBe(true);
    expect(verdict.excludedDeclaredAhead).toEqual(["flood"]);
    expect(verdict.unaccountedCount).toBe(0);
  });

  it("a live rail (at least one earned cell) with zero unaccounted cells passes and is NOT excluded (falsifier: a live, fully-accounted rail must never appear in excludedDeclaredAhead)", () => {
    const cells = [cell("48021:1", "value"), cell("48021:2", "absent-verified")];
    const verdict = evaluateRailGate(cells, "flood");
    expect(verdict.ok).toBe(true);
    expect(verdict.excludedDeclaredAhead).toEqual([]);
    expect(verdict.unaccountedCount).toBe(0);
  });

  it("a live rail with at least one unaccounted cell refuses (falsifier: this is the case the whole gate exists to catch)", () => {
    const cells = [cell("48021:1", "value"), cell("48021:2", "unaccounted")];
    const verdict = evaluateRailGate(cells, "flood");
    expect(verdict.ok).toBe(false);
    expect(verdict.unaccountedCount).toBe(1);
    expect(verdict.unaccountedSamples[0]?.placeKey).toBe("48021:2");
    expect(verdict.excludedDeclaredAhead).toEqual([]);
  });

  it("refused counts as earned, matching isEarnedCell — a rail live only via refused cells is scored, not excluded", () => {
    const cells = [cell("48021:1", "refused"), cell("48021:2", "unaccounted")];
    const verdict = evaluateRailGate(cells, "wells");
    expect(verdict.excludedDeclaredAhead).toEqual([]);
    expect(verdict.ok).toBe(false);
    expect(verdict.unaccountedCount).toBe(1);
  });

  it("not-applicable cells are neither earned nor unaccounted — a county entirely not-applicable for a rail is declared-ahead, not a refusal (falsifier: not-applicable must not be miscounted as unaccounted)", () => {
    const cells = [cell("48021:1", "not-applicable"), cell("48021:2", "not-applicable")];
    const verdict = evaluateRailGate(cells, "zoningDistrict");
    expect(verdict.ok).toBe(true);
    expect(verdict.unaccountedCount).toBe(0);
    expect(verdict.excludedDeclaredAhead).toEqual(["zoningDistrict"]);
  });

  it("cellCount always reflects the input size regardless of verdict shape", () => {
    const cells = [cell("48021:1", "value"), cell("48021:2", "value"), cell("48021:3", "unaccounted")];
    const verdict = evaluateRailGate(cells, "flood");
    expect(verdict.cellCount).toBe(3);
  });

  it("verdict shape matches PublishGateVerdict's field names (ok/unaccountedCount/excludedDeclaredAhead) so a B-READER consumer generalizes across both instruments", () => {
    const verdict: RailGateVerdict = evaluateRailGate([cell("48021:1", "value")], "flood");
    expect(verdict).toHaveProperty("ok");
    expect(verdict).toHaveProperty("unaccountedCount");
    expect(verdict).toHaveProperty("excludedDeclaredAhead");
    expect(Array.isArray(verdict.excludedDeclaredAhead)).toBe(true);
  });
});

describe("loadCountyRailCellsPage + loadCountyRailCells (PARCEL-B-GATE-SCHED, CP2-corrected paged design)", () => {
  /** Simulates the real table: pages ordered by place_key, LIMIT-bounded, never one unbounded statement. */
  function fakePagedSql(
    parcelCount: number,
    allCellRows: Array<{ place_key: string; cell_state: unknown }>,
  ): ParcelRecordSqlClient {
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      if (text.includes("count(*) AS count FROM parcel_record")) {
        return [{ count: parcelCount }];
      }
      if (text.includes("FROM parcel_record_cell")) {
        const after = values[0] as string;
        const upper = values[1] as string;
        const railKey = values[2] as string;
        const pageSize = values[3] as number;
        return allCellRows
          .filter((r) => r.place_key > after && r.place_key < upper)
          .filter(() => true) // rail_key already pre-filtered into allCellRows by the test fixture
          .sort((a, b) => (a.place_key < b.place_key ? -1 : 1))
          .slice(0, pageSize)
          .map((r) => ({ place_key: r.place_key, cell_state: r.cell_state }));
      }
      throw new Error(`unexpected query in fakePagedSql: ${text.slice(0, 60)}`);
    }) as unknown as ParcelRecordSqlClient;
    return sql;
  }

  it("loadCountyRailCellsPage returns nextAfter=null when a page comes back under pageSize (last page)", async () => {
    const sql = fakePagedSql(2, [
      { place_key: "48021:1", cell_state: { kind: "value", source: "test", vintage: "test", value: "x" } },
      { place_key: "48021:2", cell_state: { kind: "unaccounted" } },
    ]);
    const page = await loadCountyRailCellsPage(sql, "48021", "flood", countyRailCellsFirstAfter("48021"), 10);
    expect(page.cells).toHaveLength(2);
    expect(page.nextAfter).toBeNull();
  });

  it("loadCountyRailCellsPage returns a non-null nextAfter (the last row's place_key) when a page is exactly full (falsifier: a full page must never be silently treated as the last page)", async () => {
    const sql = fakePagedSql(3, [
      { place_key: "48021:1", cell_state: { kind: "value", source: "test", vintage: "test", value: "x" } },
      { place_key: "48021:2", cell_state: { kind: "unaccounted" } },
      { place_key: "48021:3", cell_state: { kind: "value", source: "test", vintage: "test", value: "y" } },
    ]);
    const page = await loadCountyRailCellsPage(sql, "48021", "flood", countyRailCellsFirstAfter("48021"), 2);
    expect(page.cells).toHaveLength(2);
    expect(page.nextAfter).toBe("48021:2");
  });

  it("loadCountyRailCells pages through and accumulates the full county, across a page boundary (falsifier: this is the exact shape that was measured to time out unpaged on Travis)", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      place_key: `48021:${i + 1}`,
      cell_state: i % 2 === 0 ? { kind: "value", source: "test", vintage: "test", value: "x" } : { kind: "unaccounted" },
    }));
    const sql = fakePagedSql(5, rows);
    const result = await loadCountyRailCells(sql, "48021", "flood", 2);
    expect(result.cells).toHaveLength(5);
    expect(result.pageCount).toBe(3); // 2 + 2 + 1
    expect(result.parcelRowCount).toBe(5);
  });

  it("throws loud on a row-count mismatch across the accumulated pages rather than silently evaluating a partial rail (falsifier: the whole point of this check is that fewer cells than parcels must never pass silently)", async () => {
    const sql = fakePagedSql(3, [
      { place_key: "48021:1", cell_state: { kind: "value", source: "test", vintage: "test", value: "x" } },
    ]);
    await expect(loadCountyRailCells(sql, "48021", "flood")).rejects.toThrow(/data-integrity defect/);
  });
});
