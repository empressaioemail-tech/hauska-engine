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

const EXCLUDED_MID_CUTOVER = {
  countyFips: "48021",
  railKey: "cityLimits",
  verdict: "excluded-mid-cutover",
  evaluatedAt: EVALUATED_AT,
};

/** A slated pair's /record rail, through the HTTP route. */
async function serveOf(app: ReturnType<typeof buildApp>, railKey: string): Promise<string> {
  const res = await app.request("/property-nodes/48021:34049/record");
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    rails: Record<string, { serve: string; gate: { verdict: string | null; evaluatedAt: string | null } }>;
  };
  return body.rails[railKey]!.serve;
}

function appFor(store: ParcelFactoryStore) {
  return buildApp({ storage: new InMemoryStorage(), apiKey: "", factoryStore: store });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FALSIFIER 1 — an excluded-* row survives the store and serves 'refused'", () => {
  it("loadGateVerdict returns 'excluded-mid-cutover' verbatim (not null)", async () => {
    const store = memoryFactoryStore({ places: ["48021:34049"], verdicts: [EXCLUDED_MID_CUTOVER] });
    expect(await store.loadGateVerdict("48021", "cityLimits")).toEqual({
      verdict: "excluded-mid-cutover",
      evaluatedAt: EVALUATED_AT,
    });
  });

  it("the /record reader serves that slated rail as 'refused', with the kind intact in the gate block", async () => {
    const store = memoryFactoryStore({ places: ["48021:34049"], verdicts: [EXCLUDED_MID_CUTOVER] });
    const result = await readParcelRecord(
      store,
      { async getAtom() { return { atom: null }; } },
      "48021:34049",
      "48021",
      "34049",
    );
    expect(result.rails.cityLimits!.serve).toBe("refused");
    expect(result.rails.cityLimits!.gate).toEqual({
      verdict: "excluded-mid-cutover",
      evaluatedAt: EVALUATED_AT,
    });
  });

  it("the HTTP surface LDT reads returns the string, and /record says refused", async () => {
    const app = appFor(
      memoryFactoryStore({ places: ["48021:34049"], verdicts: [EXCLUDED_MID_CUTOVER] }),
    );
    const res = await app.request("/parcel-record-gate-verdict/48021/cityLimits");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      countyFips: "48021",
      railKey: "cityLimits",
      verdict: { verdict: "excluded-mid-cutover", evaluatedAt: EVALUATED_AT },
    });
    expect(await serveOf(app, "cityLimits")).toBe("refused");
  });

  it("all three excluded-* kinds behave identically (the family, not one string)", async () => {
    expect([...PARCEL_GATE_VERDICT_VOCABULARY_PIN.excludedKinds]).toHaveLength(3);
    for (const kind of PARCEL_GATE_VERDICT_VOCABULARY_PIN.excludedKinds) {
      const store = memoryFactoryStore({
        places: ["48021:34049"],
        verdicts: [{ ...EXCLUDED_MID_CUTOVER, verdict: kind }],
      });
      expect((await store.loadGateVerdict("48021", "cityLimits"))!.verdict).toBe(kind);
      expect(await serveOf(appFor(store), "cityLimits")).toBe("refused");
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

  it("an unrecognised string never reaches the customer as a verdict: the slated rail is legacy-transitional", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = appFor(
      memoryFactoryStore({
        places: ["48021:34049"],
        verdicts: [{ ...EXCLUDED_MID_CUTOVER, verdict: "excluded-invented-gamma" }],
      }),
    );
    // Fail closed, exactly as a missing row does — never a fabricated verdict.
    expect(await serveOf(app, "cityLimits")).toBe("legacy-transitional");
    const res = await app.request("/parcel-record-gate-verdict/48021/cityLimits");
    expect(await res.json()).toEqual({
      countyFips: "48021",
      railKey: "cityLimits",
      verdict: null,
    });
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

describe("FALSIFIER 4 — no serve change for any string that exists in the store today", () => {
  it("pass serves 'record'; refuse and excluded serve 'refused'; each is returned verbatim", async () => {
    const cases: Array<{ verdict: string; serve: string }> = [
      { verdict: "pass", serve: "record" },
      { verdict: "refuse", serve: "refused" },
      { verdict: "excluded", serve: "refused" },
    ];
    for (const c of cases) {
      const store = memoryFactoryStore({
        places: ["48021:34049"],
        verdicts: [{ ...EXCLUDED_MID_CUTOVER, verdict: c.verdict }],
      });
      const app = appFor(store);
      expect(await serveOf(app, "cityLimits")).toBe(c.serve);
      const res = await app.request("/parcel-record-gate-verdict/48021/cityLimits");
      const body = (await res.json()) as { verdict: { verdict: string } | null };
      expect(body.verdict!.verdict).toBe(c.verdict);
    }
  });

  it("a rail with NO verdict row still takes the no-verdict path (legacy-transitional), unchanged", async () => {
    const app = appFor(memoryFactoryStore({ places: ["48021:34049"] }));
    expect(await serveOf(app, "cityLimits")).toBe("legacy-transitional");
  });

  it("a verdict read that fails still takes the no-verdict path (legacy-transitional), unchanged", async () => {
    // The production store's `catch` turns a read failure into the same null
    // a missing row produces (parcel-record-db.ts loadGateVerdict); model
    // exactly that, since it is the path a scheduled-write outage takes.
    const store: ParcelFactoryStore = {
      ...memoryFactoryStore({ places: ["48021:34049"] }),
      loadGateVerdict: async () => null,
    };
    expect(await serveOf(appFor(store), "cityLimits")).toBe("legacy-transitional");
  });

  it("an unreadable store still declares a 503 refusal at the route, unchanged", async () => {
    const app = appFor(memoryFactoryStore({ failReads: true }));
    const res = await app.request("/property-nodes/48021:34049/record");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { errorClass: string };
    expect(body.errorClass).toBe("read-failed");
  });
});
