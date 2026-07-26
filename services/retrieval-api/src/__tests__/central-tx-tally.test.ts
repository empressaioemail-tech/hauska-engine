import { describe, expect, it } from "vitest";
import {
  CENTRAL_TX_COUNTIES,
  DEPTH_WARM_PROMOTION_MARKER,
  PLACE_TYPE_DISTRICT_CODES,
  depthRatioPlaceTypePct,
} from "../central-tx-tally.js";
import { buildApp } from "../server.js";

describe("GET /stats/central-tx-node-graph", () => {
  it("returns 503 when substrate DB is not configured", async () => {
    const prevSub = process.env.SUBSTRATE_DATABASE_URL;
    const prevDb = process.env.DATABASE_URL;
    delete process.env.SUBSTRATE_DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const app = buildApp({ apiKey: "", substrateDatabaseUrl: "" });
      const res = await app.request("/stats/central-tx-node-graph");
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/not configured/i);
    } finally {
      if (prevSub !== undefined) process.env.SUBSTRATE_DATABASE_URL = prevSub;
      else delete process.env.SUBSTRATE_DATABASE_URL;
      if (prevDb !== undefined) process.env.DATABASE_URL = prevDb;
      else delete process.env.DATABASE_URL;
    }
  });

  it("Central-TX FIPS map includes Travis + Hays (Gate A counties)", () => {
    expect(CENTRAL_TX_COUNTIES["48453"]).toBe("Travis");
    expect(CENTRAL_TX_COUNTIES["48209"]).toBe("Hays");
    expect(Object.keys(CENTRAL_TX_COUNTIES)).toHaveLength(10);
  });

  it("depth ratio uses place-type denominator (Bastrop reconciliation shape)", () => {
    expect(DEPTH_WARM_PROMOTION_MARKER).toBe("depth-warm-promoted-v1");
    expect(PLACE_TYPE_DISTRICT_CODES).toEqual([
      "P-1",
      "P-2",
      "P-3",
      "P-4",
      "P-5",
    ]);
    expect(depthRatioPlaceTypePct(2345, 3657)).toBe(64.12);
    expect(depthRatioPlaceTypePct(0, 0)).toBe(0);
  });
});
