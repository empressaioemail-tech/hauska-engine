import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";

import { buildApp } from "../server.js";
import {
  memoryFactoryStore,
  resolveStoredGateVerdictKind,
  type ParcelFactoryStore,
} from "../parcel-record-db.js";
import { readParcelRecord } from "../parcel-record-reader.js";
import { PARCEL_GATE_VERDICT_VOCABULARY_PIN } from "../parcel-gate-verdict-vocabulary.js";

/**
 * P-293 remainder — the four dispatch falsifiers, measured end to end.
 *
 * `48021:cityLimits` is the fixture pair because it is a real SLATE entry
 * (src/parcel-record-slate.json line 10), so it is the only kind of pair for
 * which the verdict store is consulted at all; `48021:34049` is the real
 * Bastrop parcel the P-152 tests use.
 *
 * The unrecognised-string cases use a DISTINCT invented string per test: the
 * emission guard is a module-level Set keyed by (county, rail, string) per
 * process, and that dedupe is itself under test below, so the cases must not
 * collide with each other.
 */

const EVALUATED_AT = "2026-09-16T20:03:09.067Z";

/**
 * P-297 changed the serve half of these tests, and only the serve half. Before
 * A-193 a slated rail's serve state WAS the verdict; now the verdict is
 * information on the response and the parcel's own cell decides. So every test
 * below that used to read its serve expectation off a verdict now puts a real
 * `parcel_record_cell` row in the fixture store and reads it off the CELL —
 * while the verdict-vocabulary assertions (verbatim survival, fail-closed null,
 * one log line) are untouched, because P-293's findings still hold.
 */
const VALUE_CELL = {
  kind: "value",
  value: "Bastrop",
  source: "landing_parcel_jurisdiction",
  vintage: "2026-09-02T18:13:56.751Z",
};
const CELL_ROW = { placeKey: "48021:34049", railKey: "cityLimits", cellState: VALUE_CELL };

const EXCLUDED_MID_CUTOVER = {
  countyFips: "48021",
  railKey: "cityLimits",
  verdict: "excluded-mid-cutover",
  evaluatedAt: EVALUATED_AT,
};

/** A slated pair's /record rail, through the HTTP route. */
async function railOf(app: ReturnType<typeof buildApp>, railKey: string) {
  const res = await app.request("/property-nodes/48021:34049/record");
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    rails: Record<
      string,
      {
        serve: string;
        gate: { verdict: string | null; evaluatedAt: string | null };
        refusal: { code: string; reason: string } | null;
      }
    >;
  };
  return body.rails[railKey]!;
}

async function serveOf(app: ReturnType<typeof buildApp>, railKey: string): Promise<string> {
  return (await railOf(app, railKey)).serve;
}

function appFor(store: ParcelFactoryStore) {
  return buildApp({ storage: new InMemoryStorage(), apiKey: "", factoryStore: store });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FALSIFIER 1 — an excluded-* row survives the store, and (P-297) no longer decides the serve state", () => {
  it("loadGateVerdict returns 'excluded-mid-cutover' verbatim (not null)", async () => {
    const store = memoryFactoryStore({ places: ["48021:34049"], verdicts: [EXCLUDED_MID_CUTOVER] });
    expect(await store.loadGateVerdict("48021", "cityLimits")).toEqual({
      verdict: "excluded-mid-cutover",
      evaluatedAt: EVALUATED_AT,
    });
  });

  it("the /record reader SERVES a parcel that has its own cell, with the excluded kind intact in the gate block", async () => {
    const store = memoryFactoryStore({
      places: ["48021:34049"],
      cells: [CELL_ROW],
      verdicts: [EXCLUDED_MID_CUTOVER],
    });
    const result = await readParcelRecord(
      store,
      { async getAtom() { return { atom: null }; } },
      "48021:34049",
      "48021",
      "34049",
    );
    // Before P-297 this read "refused": a county-wide exclusion outranked the
    // parcel's own answered cell. It does not any more.
    expect(result.rails.cityLimits!.serve).toBe("record");
    expect(result.rails.cityLimits!.refusal).toBeNull();
    expect(result.rails.cityLimits!.gate).toEqual({
      verdict: "excluded-mid-cutover",
      evaluatedAt: EVALUATED_AT,
    });
  });

  it("and with NO cell for that slated rail it is a declared refusal whose reason is the missing row, not the excluded grade", async () => {
    const store = memoryFactoryStore({ places: ["48021:34049"], verdicts: [EXCLUDED_MID_CUTOVER] });
    const result = await readParcelRecord(
      store,
      { async getAtom() { return { atom: null }; } },
      "48021:34049",
      "48021",
      "34049",
    );
    expect(result.rails.cityLimits!.serve).toBe("refused");
    expect(result.rails.cityLimits!.refusal!.code).toBe("no-such-parcel-or-rail");
    expect(result.rails.cityLimits!.refusal!.reason).toContain("No parcel_record_cell row exists");
    // The grade is still reported. It is simply not the reason for the refusal.
    expect(result.rails.cityLimits!.gate.verdict).toBe("excluded-mid-cutover");
  });

  it("the HTTP surface LDT reads returns the string, and /record serves the cell", async () => {
    const app = appFor(
      memoryFactoryStore({
        places: ["48021:34049"],
        cells: [CELL_ROW],
        verdicts: [EXCLUDED_MID_CUTOVER],
      }),
    );
    const res = await app.request("/parcel-record-gate-verdict/48021/cityLimits");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      countyFips: "48021",
      railKey: "cityLimits",
      verdict: { verdict: "excluded-mid-cutover", evaluatedAt: EVALUATED_AT },
    });
    expect(await serveOf(app, "cityLimits")).toBe("record");
  });

  it("all three excluded-* kinds behave identically (the family, not one string)", async () => {
    expect([...PARCEL_GATE_VERDICT_VOCABULARY_PIN.excludedKinds]).toHaveLength(3);
    for (const kind of PARCEL_GATE_VERDICT_VOCABULARY_PIN.excludedKinds) {
      const store = memoryFactoryStore({
        places: ["48021:34049"],
        cells: [CELL_ROW],
        verdicts: [{ ...EXCLUDED_MID_CUTOVER, verdict: kind }],
      });
      expect((await store.loadGateVerdict("48021", "cityLimits"))!.verdict).toBe(kind);
      expect(await serveOf(appFor(store), "cityLimits")).toBe("record");
    }
  });
});

describe("FALSIFIER 2 — an unrecognised string fails closed to null AND logs once", () => {
  it("resolution is null (unchanged) and the warning names county, rail, raw string and the pin", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const invented = "excluded-invented-alpha";
    const store = memoryFactoryStore({
      places: ["48021:34049"],
      verdicts: [{ ...EXCLUDED_MID_CUTOVER, verdict: invented }],
    });

    expect(await store.loadGateVerdict("48021", "cityLimits")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain("48021");
    expect(line).toContain("cityLimits");
    expect(line).toContain(invented);
    expect(line).toContain(PARCEL_GATE_VERDICT_VOCABULARY_PIN.factoryShaShort);

    // Same (county, rail, string) again in the same process: no second line.
    expect(await store.loadGateVerdict("48021", "cityLimits")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);

    // A DIFFERENT unrecognised string is its own finding.
    const inventedTwo = "excluded-invented-beta";
    const storeTwo = memoryFactoryStore({
      verdicts: [{ ...EXCLUDED_MID_CUTOVER, verdict: inventedTwo }],
    });
    expect(await storeTwo.loadGateVerdict("48021", "cityLimits")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]![0])).toContain(inventedTwo);
  });

  it("an unrecognised string never reaches the customer as a verdict: the gate block is null and the CELL decides the serve", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = appFor(
      memoryFactoryStore({
        places: ["48021:34049"],
        cells: [CELL_ROW],
        verdicts: [{ ...EXCLUDED_MID_CUTOVER, verdict: "excluded-invented-gamma" }],
      }),
    );
    // Fail closed, exactly as a missing row does — never a fabricated verdict.
    const res = await app.request("/parcel-record-gate-verdict/48021/cityLimits");
    expect(await res.json()).toEqual({
      countyFips: "48021",
      railKey: "cityLimits",
      verdict: null,
    });
    // A withheld grade is not a serve refusal (P-297): the parcel's own cell is
    // still served, and the gate block reports honestly that nothing is known.
    const rail = await railOf(app, "cityLimits");
    expect(rail.serve).toBe("record");
    expect(rail.gate).toEqual({ verdict: null, evaluatedAt: null });
    expect(rail.refusal).toBeNull();
  });

  it("the store layer is the ONE judge: a recognised string is returned, an unrecognised one is nulled", () => {
    expect(resolveStoredGateVerdictKind("48021", "cityLimits", "excluded-no-acquisition-path")).toBe(
      "excluded-no-acquisition-path",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveStoredGateVerdictKind("48209", "setbackRearFt", "excluded-invented-delta")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("FALSIFIER 4 (P-293's, superseded by A-193) — every string in the store keeps its own meaning, and none of them decides the serve state", () => {
  it("pass, refuse and excluded each come back verbatim, and a value cell serves 'record' under ALL THREE", async () => {
    for (const verdict of ["pass", "refuse", "excluded"]) {
      const store = memoryFactoryStore({
        places: ["48021:34049"],
        cells: [CELL_ROW],
        verdicts: [{ ...EXCLUDED_MID_CUTOVER, verdict }],
      });
      const app = appFor(store);
      // P-297 flipped this expectation on purpose: 'refuse' and 'excluded' used
      // to make this rail refuse. They cannot any more — the cell answers.
      expect({ verdict, serve: await serveOf(app, "cityLimits") }).toEqual({
        verdict,
        serve: "record",
      });
      const res = await app.request("/parcel-record-gate-verdict/48021/cityLimits");
      const body = (await res.json()) as { verdict: { verdict: string } | null };
      expect(body.verdict!.verdict).toBe(verdict);
    }
  });

  it("a rail with NO verdict row still serves from its own cell: the verdict was never the switch", async () => {
    const app = appFor(
      memoryFactoryStore({ places: ["48021:34049"], cells: [CELL_ROW] }),
    );
    const rail = await railOf(app, "cityLimits");
    expect(rail.serve).toBe("record");
    expect(rail.gate).toEqual({ verdict: null, evaluatedAt: null });
    expect(rail.refusal).toBeNull();
  });

  it("and a slated rail with no cell is a declared refusal even under a PASSING verdict (fail closed survives the change)", async () => {
    const app = appFor(
      memoryFactoryStore({
        places: ["48021:34049"],
        verdicts: [{ ...EXCLUDED_MID_CUTOVER, verdict: "pass" }],
      }),
    );
    const rail = await railOf(app, "cityLimits");
    expect(rail.serve).toBe("refused");
    expect(rail.gate.verdict).toBe("pass");
    expect(rail.refusal!.code).toBe("no-such-parcel-or-rail");
  });

  it("a verdict read that fails does not become a serve refusal: the cell still decides", async () => {
    // The production store's `catch` turns a read failure into the same null
    // a missing row produces (parcel-record-db.ts loadGateVerdict); model
    // exactly that, since it is the path a scheduled-write outage takes.
    const store: ParcelFactoryStore = {
      ...memoryFactoryStore({ places: ["48021:34049"], cells: [CELL_ROW] }),
      loadGateVerdict: async () => null,
    };
    const rail = await railOf(appFor(store), "cityLimits");
    expect(rail.serve).toBe("record");
    expect(rail.gate).toEqual({ verdict: null, evaluatedAt: null });
  });

  it("an unreadable store still declares a 503 refusal at the route, unchanged", async () => {
    const app = appFor(memoryFactoryStore({ failReads: true }));
    const res = await app.request("/property-nodes/48021:34049/record");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { errorClass: string };
    expect(body.errorClass).toBe("read-failed");
  });
});
