import { describe, expect, it } from "vitest";
import { CENTRAL_TX_COUNTIES } from "../central-tx-tally.js";
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
});
