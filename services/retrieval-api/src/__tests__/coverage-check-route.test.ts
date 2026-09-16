import { describe, expect, it } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";

import { buildApp } from "../server.js";
import { memoryCoverageCheckStore } from "../coverage-check.js";
import { memoryFactoryStore } from "../parcel-record-db.js";

const COVERED_STORE = memoryCoverageCheckStore({
  zipRows: {
    "78209": [{ countyFips: "48029", n: 12300 }],
    "76541": [
      { countyFips: "48027", n: 6897 },
      { countyFips: "48319", n: 3 },
    ],
  },
  tier1Counties: new Set(["48029", "48027"]),
  countyNames: { "48027": "Bell" },
});

describe("GET /parcel-record-gate-verdict/coverage/check (P-210)", () => {
  it("declares a refusal, never a guess, when the coverage store is not configured", async () => {
    const app = buildApp({ storage: new InMemoryStorage(), apiKey: "", coverageStore: null });
    const res = await app.request("/parcel-record-gate-verdict/coverage/check?city=Austin&state=TX");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("indeterminate");
  });

  it("serves covered for a real query with all three params", async () => {
    const app = buildApp({ storage: new InMemoryStorage(), apiKey: "", coverageStore: COVERED_STORE });
    const res = await app.request(
      "/parcel-record-gate-verdict/coverage/check?city=San+Antonio&state=TX&zip=78209",
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "covered" });
  });

  it("never crashes into a bare 500: a store that throws still returns a well-formed indeterminate body", async () => {
    const throwingStore = {
      checkCoverage: async () => {
        throw new Error("simulated unhandled failure");
      },
      close: async () => {},
    };
    const app = buildApp({ storage: new InMemoryStorage(), apiKey: "", coverageStore: throwingStore });
    const res = await app.request("/parcel-record-gate-verdict/coverage/check?zip=76541");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; reason: string };
    expect(body.status).toBe("indeterminate");
    expect(body.reason).toContain("simulated unhandled failure");
  });

  it(
    "ROUTE-ORDERING TRAP (dispatch's own named risk): the literal /coverage/check path is not " +
      "shadowed by the dynamic /:countyFips/:railKey sibling, which regex-checks its params only " +
      "inside its own handler body, not at the router level",
    async () => {
      const app = buildApp({ storage: new InMemoryStorage(), apiKey: "", coverageStore: COVERED_STORE });
      const res = await app.request(
        "/parcel-record-gate-verdict/coverage/check?city=Killeen&state=TX&zip=76541",
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      // Reaching the coverage-check response shape (not the dynamic route's
      // {countyFips, railKey, verdict} shape, and not its 400 "invalid path")
      // proves this request landed in the correct handler.
      expect(body.status).toBe("covered");
    },
  );

  it("the dynamic gate-verdict sibling still works unshadowed for a real county/rail pair", async () => {
    const factoryStore = memoryFactoryStore({
      verdicts: [{ countyFips: "48021", railKey: "cityLimits", verdict: "pass", evaluatedAt: "2026-09-11T20:03:09.067Z" }],
    });
    const app = buildApp({ storage: new InMemoryStorage(), apiKey: "", factoryStore, coverageStore: COVERED_STORE });
    const res = await app.request("/parcel-record-gate-verdict/48021/cityLimits");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { countyFips: string; railKey: string; verdict: unknown };
    expect(body.countyFips).toBe("48021");
    expect(body.railKey).toBe("cityLimits");
    expect(body.verdict).toEqual({ verdict: "pass", evaluatedAt: "2026-09-11T20:03:09.067Z" });
  });

  it("the dynamic sibling still rejects a malformed countyFips with its own 400, unaffected by the new route", async () => {
    const app = buildApp({ storage: new InMemoryStorage(), apiKey: "", coverageStore: COVERED_STORE });
    const res = await app.request("/parcel-record-gate-verdict/notafips/cityLimits");
    expect(res.status).toBe(400);
  });
});
