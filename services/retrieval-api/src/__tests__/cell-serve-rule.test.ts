import { describe, expect, it } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";

import fixtureRaw from "../__fixtures__/cell-serve-rule.json" with { type: "json" };
import { memoryFactoryStore } from "../parcel-record-db.js";
import {
  CELL_SERVE_RULE_ID,
  isSlatedForCellServe,
  readParcelRecord,
  resolveCellServeDecision,
  type CellServeRefusalCode,
  type ParcelRecordResponse,
} from "../parcel-record-reader.js";

import { buildApp } from "../server.js";

/**
 * P-297 (OPS-24, operator ruling A-193,
 * `_decisions/2026-09-16_county_verdict_is_not_the_serve_switch.md`, OPS-24
 * law 7) — THE ENGINE HALF's own test of the ONE RULE.
 *
    10| * THE FIXTURE IS THE CROSS-REPO CONTRACT. `src/__fixtures__/cell-serve-rule.json`
 * is a byte-identical copy of legacy-design-tools' own copy (LDT PR #710). The
 * tests below read that file and compare it, row by row, against this repo's
 * rule — so a copy that disagrees with the function fails, and editing either
 * side alone fails. The engine's copy is NOT edited: it is a copy.
 *
 * WHY THE FOUR expect FIELDS ARE COMPARED LITERALLY. The rule's decision type
 * carries exactly the fixture's four fields (`serve`, `form`, `absenceVerdict`,
 * `refusalCode`), plus `reason` which the fixture deliberately does not pin
 * (reason TEXT is each reader's own voice; the CODE is the contract). So the
 * comparison below is equality on the contract, not a paraphrase of it.
 */

/** The fixture's own shape. Cast at the import boundary: a JSON module's inferred type has no index signature. */
interface FixtureExpect {
  serve: "cell" | "current-path";
  form: "value" | "absence" | "refusal" | null;
  absenceVerdict: "absent-verified" | "not-applicable" | null;
  refusalCode: string | null;
}
interface FixtureRow {
  name: string;
  slated: boolean;
  cellState: Record<string, unknown> | null;
  companionRows?: unknown[];
  expect: FixtureExpect;
}
const fixture = fixtureRaw as unknown as {
  _ruleId: string;
  pinnedRowNames: string[];
  rows: FixtureRow[];
};

/**
 * THIS REPO'S copy of the pinned rows. Deliberately a second, hand-kept list
 * (the same device legacy-design-tools' own `cellServeRule.test.ts` uses): the
 * fixture file's `pinnedRowNames` is asserted EQUAL to this one, in both
 * directions, so neither a row quietly dropped from the file nor a row quietly
 * dropped from the test can pass. A row ADDED upstream fails here until this
 * list is updated deliberately — which is the point of pinning.
 */
const ENGINE_PINNED_ROW_NAMES = [
  "unslated-value-cell-keeps-the-current-path",
  "unslated-no-cell-keeps-the-current-path",
  "slated-value-cell-is-served-as-its-value",
  "slated-verified-zero-is-served-as-zero-not-as-an-absence",
  "slated-value-cell-with-companion-rows-is-still-a-value",
  "slated-absent-verified-is-served-as-the-stated-absence",
  "slated-not-applicable-is-a-stated-absence-not-a-refusal",
  "slated-refused-cell-is-a-declared-refusal-carrying-the-engines-own-reason",
  "slated-unaccounted-cell-is-a-declared-refusal-never-a-legacy-value",
  "slated-malformed-cell-is-a-declared-refusal-not-a-guess",
  "slated-no-cell-at-all-is-a-declared-refusal-naming-the-missing-row",
];

/** The fixture's expectation, read off the engine's own rule. */
function observedExpect(row: FixtureRow): FixtureExpect {
  const d = resolveCellServeDecision(row.slated, row.cellState);
  return {
    serve: d.serve,
    form: d.form,
    absenceVerdict: d.absenceVerdict,
    refusalCode: d.refusalCode,
  };
}

describe("cell-serve-rule.json — the shared fixture is this repo's contract (P-297)", () => {
  it("carries the rule id this repo publishes, so the two halves cannot be different rules", () => {
    expect(fixture._ruleId).toBe(CELL_SERVE_RULE_ID);
  });

  it("the file's pinnedRowNames equals this repo's copy of them, and every pinned name exists", () => {
    // Both directions, so neither side can drop a row.
    expect([...fixture.pinnedRowNames].sort()).toEqual([...ENGINE_PINNED_ROW_NAMES].sort());
    expect(fixture.pinnedRowNames.length).toBeGreaterThan(0);
    const names = new Set(fixture.rows.map((r) => r.name));
    for (const pinned of ENGINE_PINNED_ROW_NAMES) expect(names.has(pinned)).toBe(true);
  });

  it("THIS REPO'S RULE AGREES WITH EVERY ROW on all four contract fields", () => {
    expect(fixture.rows.length).toBeGreaterThan(0);
    for (const row of fixture.rows) {
      expect({ row: row.name, ...observedExpect(row) }).toEqual({ row: row.name, ...row.expect });
    }
  });

  it("the comparison can distinguish (a fixture that pinned one answer for every row could not)", () => {
    // Not vacuity theatre: assert the fixture actually spans the decision space,
    // so an equality test that happened to agree everywhere is not read as proof.
    const serves = new Set(fixture.rows.map((r) => r.expect.serve));
    const forms = new Set(fixture.rows.map((r) => r.expect.form));
    const codes = new Set(fixture.rows.map((r) => r.expect.refusalCode));
    const slatedValues = new Set(fixture.rows.map((r) => r.slated));
    expect([...serves].sort()).toEqual(["cell", "current-path"]);
    // `String(null)` is "null", so a null `form` sorts between the words; the
    // mapping is only to make the comparison order-insensitive.
    expect([...forms].map((f) => String(f)).sort()).toEqual(["absence", "null", "refusal", "value"]);
    expect(slatedValues).toEqual(new Set([true, false]));
    // Every documented cell kind, the malformed case and the no-row case are present.
    expect(codes).toEqual(
      new Set(["engine-refused", "unaccounted", "malformed-cell", "no-such-parcel-or-rail", null]),
    );
  });

  it("every refusal code the fixture pins is inside this repo's own refusal union", () => {
    const union: ReadonlySet<string> = new Set<CellServeRefusalCode>([
      "engine-refused",
      "unaccounted",
      "malformed-cell",
      "no-such-parcel-or-rail",
    ]);
    for (const row of fixture.rows) {
      if (row.expect.refusalCode !== null) expect(union.has(row.expect.refusalCode)).toBe(true);
    }
  });
});

/* ------------------------- the reader, on the wire ------------------------- */

const PLACE_KEY = "48021:34049";
const CITY_LIMITS = "cityLimits"; // slated in 48021 (parcel-record-slate.json)
const PIPELINES = "pipelines"; // NOT slated anywhere: the unslated control

const VALUE_CELL = {
  kind: "value",
  value: "Bastrop",
  source: "landing_parcel_jurisdiction",
  vintage: "2026-09-02T18:13:56.751Z",
};
const ABSENT_CELL = {
  kind: "absent-verified",
  basis: { method: "zone-major-sweep", finding: "no point falls within this parcel", vintage: "2026-08-16" },
};
const UNACCOUNTED_CELL = { kind: "unaccounted" };
const REFUSED_CELL = { kind: "refused", reason: "no usable district could be resolved from the declared source" };
const MALFORMED_CELL = { kind: "something-this-reader-has-never-seen", value: 12 };

function recordFor(
  cells: ReadonlyArray<{ railKey: string; cellState: Record<string, unknown> }>,
  verdict: { verdict: string; evaluatedAt: string } | null,
  companionRows: ReadonlyArray<{
    railKey: string;
    rowIndex: number;
    payload: unknown;
    source: string;
    vintage: string;
  }> = [],
): Promise<ParcelRecordResponse> {
  const store = memoryFactoryStore({
    places: [PLACE_KEY],
    cells: cells.map((c) => ({ placeKey: PLACE_KEY, railKey: c.railKey, cellState: c.cellState })),
    companionRows: companionRows.map((r) => ({ placeKey: PLACE_KEY, ...r })),
    verdicts: verdict
      ? [{ countyFips: "48021", railKey: CITY_LIMITS, verdict: verdict.verdict, evaluatedAt: verdict.evaluatedAt }]
      : [],
  });
  return readParcelRecord(store, { async getAtom() { return { atom: null }; } }, PLACE_KEY, "48021", "34049");
}

describe("the slate is the cut-over switch, not the county verdict (P-297)", () => {
  it("isSlatedForCellServe answers from the vendored slate, both ways", () => {
    expect(isSlatedForCellServe("48021", CITY_LIMITS)).toBe(true);
    expect(isSlatedForCellServe("48021", PIPELINES)).toBe(false);
    // An empty county is not a lookup: it cannot be slated.
    expect(isSlatedForCellServe("", CITY_LIMITS)).toBe(false);
  });

  it("FALSIFIER 1 — a slated pair whose county verdict is 'refuse' serves a parcel with a value cell AS THAT VALUE", async () => {
    // Before P-297 this read 'refused', and the caller kept the stale bake.
    const record = await recordFor([{ railKey: CITY_LIMITS, cellState: VALUE_CELL }], {
      verdict: "refuse",
      evaluatedAt: "2026-09-17T00:00:00.000Z",
    });
    const rail = record.rails[CITY_LIMITS]!;
    expect(rail.serve).toBe("record");
    expect(rail.refusal).toBeNull();
    expect(rail.cell).toEqual(VALUE_CELL);
    // The verdict is still on the response, as information. This is what makes
    // the test non-vacuous: the verdict really was loaded and really was 'refuse'.
    expect(rail.gate).toEqual({ verdict: "refuse", evaluatedAt: "2026-09-17T00:00:00.000Z" });
  });

  it("FALSIFIER 2 — an unaccounted cell is a DECLARED REFUSAL with its reason, whatever the county verdict says", async () => {
    // Both directions of the county verdict, because the ruling's whole point is
    // that neither can move this answer.
    for (const verdict of ["pass", "refuse"] as const) {
      const record = await recordFor([{ railKey: CITY_LIMITS, cellState: UNACCOUNTED_CELL }], {
        verdict,
        evaluatedAt: "2026-09-17T00:00:00.000Z",
      });
      const rail = record.rails[CITY_LIMITS]!;
      expect({ verdict, serve: rail.serve }).toEqual({ verdict, serve: "refused" });
      expect(rail.refusal).not.toBeNull();
      expect(rail.refusal!.code).toBe("unaccounted");
      expect(rail.refusal!.reason.length).toBeGreaterThan(0);
      // The cell body travels verbatim so the caller can see what the store
      // said; what does NOT travel is a served value, which is the point.
      expect(rail.cell).toEqual(UNACCOUNTED_CELL);
    }
  });

  it("companion rows do not move the decision (the fixture's own row, driven end to end)", async () => {
    // A `value` cell carrying its payload in companion rows rather than a scalar
    // is still a value, and the rows are still on the wire for the rail.
    const rowsCell = { kind: "value", source: "tx_rrc", vintage: "2026-08-16", value: null, disposition: "rows", rowCount: 1 };
    const record = await recordFor([{ railKey: CITY_LIMITS, cellState: rowsCell }], null, [
      {
        railKey: CITY_LIMITS,
        rowIndex: 0,
        payload: { api: "42000001030000", wellStatus: "dry", isOrphan: false },
        source: "tx_rrc",
        vintage: "2026-08-16",
      },
    ]);
    const rail = record.rails[CITY_LIMITS]!;
    expect(rail.serve).toBe("record");
    expect(rail.refusal).toBeNull();
    expect(rail.companions).toEqual([
      { rowIndex: 0, payload: { api: "42000001030000", wellStatus: "dry", isOrphan: false }, source: "tx_rrc", vintage: "2026-08-16" },
    ]);
  });

  it("a refused cell carries the STORE'S OWN reason verbatim, and a missing cell names the missing row", async () => {
    const refused = await recordFor([{ railKey: CITY_LIMITS, cellState: REFUSED_CELL }], null);
    expect(refused.rails[CITY_LIMITS]!.serve).toBe("refused");
    expect(refused.rails[CITY_LIMITS]!.refusal).toEqual({
      code: "engine-refused",
      reason: "no usable district could be resolved from the declared source",
    });

    const missing = await recordFor([], { verdict: "pass", evaluatedAt: "2026-09-17T00:00:00.000Z" });
    expect(missing.rails[CITY_LIMITS]!.cell).toBeNull();
    expect(missing.rails[CITY_LIMITS]!.serve).toBe("refused");
    expect(missing.rails[CITY_LIMITS]!.refusal!.code).toBe("no-such-parcel-or-rail");
    expect(missing.rails[CITY_LIMITS]!.refusal!.reason).toContain("No parcel_record_cell row exists");
  });

  it("a cell of a kind this reader has never seen is its OWN refusal, never folded into 'no cell'", async () => {
    const record = await recordFor([{ railKey: CITY_LIMITS, cellState: MALFORMED_CELL }], null);
    expect(record.rails[CITY_LIMITS]!.serve).toBe("refused");
    expect(record.rails[CITY_LIMITS]!.refusal!.code).toBe("malformed-cell");
    // The unreadable body is still returned verbatim, so a reader can see what
    // the store actually said rather than a summarised guess.
    expect(record.rails[CITY_LIMITS]!.cell).toEqual(MALFORMED_CELL);
  });

  it("a stated absence is served as 'record' with the cell's own verdict, never as a refusal", async () => {
    const record = await recordFor([{ railKey: CITY_LIMITS, cellState: ABSENT_CELL }], {
      verdict: "refuse",
      evaluatedAt: "2026-09-17T00:00:00.000Z",
    });
    const rail = record.rails[CITY_LIMITS]!;
    expect(rail.serve).toBe("record");
    expect(rail.refusal).toBeNull();
    expect(rail.cell).toEqual(ABSENT_CELL);
  });

  it("FALSIFIER 3 — an unslated pair is unchanged: legacy-transitional, no refusal, cell still returned, verdict never even consulted", async () => {
    const record = await recordFor([{ railKey: PIPELINES, cellState: VALUE_CELL }], {
      verdict: "refuse",
      evaluatedAt: "2026-09-17T00:00:00.000Z",
    });
    const rail = record.rails[PIPELINES]!;
    expect(rail.serve).toBe("legacy-transitional");
    expect(rail.refusal).toBeNull();
    expect(rail.cell).toEqual(VALUE_CELL);
    // An unslated pair never had a verdict (the reader's own long-standing
    // short-circuit, kept): the gate block is empty.
    expect(rail.gate).toEqual({ verdict: null, evaluatedAt: null });
  });

  it("the HTTP wire carries the refusal, so the customer surface can state the reason", async () => {
    const app = buildApp({ storage: new InMemoryStorage(), apiKey: "", factoryStore: memoryFactoryStore({
      places: [PLACE_KEY],
      cells: [{ placeKey: PLACE_KEY, railKey: CITY_LIMITS, cellState: UNACCOUNTED_CELL }],
      verdicts: [{ countyFips: "48021", railKey: CITY_LIMITS, verdict: "pass", evaluatedAt: "2026-09-17T00:00:00.000Z" }],
    }) });
    const res = await app.request(`/property-nodes/${PLACE_KEY}/record`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rails: Record<string, { serve: string; refusal: { code: string; reason: string } | null }>;
    };
    expect(body.rails[CITY_LIMITS]!.serve).toBe("refused");
    expect(body.rails[CITY_LIMITS]!.refusal).toEqual({
      code: "unaccounted",
      reason: "parcel_record has not yet examined this rail for this parcel. Refusing rather than serving a pipeline word.",
    });
    // The unslated control on the same response is untouched.
    expect(body.rails[PIPELINES]!.serve).toBe("legacy-transitional");
    expect(body.rails[PIPELINES]!.refusal).toBeNull();
  });
});
