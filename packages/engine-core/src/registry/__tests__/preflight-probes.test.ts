import { describe, it, expect, vi } from "vitest";

import { BASTROP_REGISTRY_ROW } from "../jurisdiction-registry.js";
import {
  buildGeometryParityProbe,
  buildServePathHealthProbe,
  buildCostSampleProbe,
  COST_MODEL_USD_PER_COMPUTE_HOUR,
  COST_MODEL_USD_PER_1K_EXTERNAL_CALLS,
  COST_SAMPLE_UNMEASURABLE_SENTINEL_USD,
} from "../preflight-probes.js";
import type { GradeOneParcelFn } from "../preflight-probes.js";

const ROW = BASTROP_REGISTRY_ROW;
const SAMPLE_5 = ["48021:1", "48021:2", "48021:3", "48021:4", "48021:5"];

const passGrader: GradeOneParcelFn = async () => ({ pass: true });
const honestDeclineGrader: GradeOneParcelFn = async () => ({ pass: true, honestDecline: true });

function makeSampleLoader(ids: string[] = SAMPLE_5) {
  return vi.fn(async (_row: unknown, sampleSize = 5) => ids.slice(0, sampleSize));
}
function makeRoadsLoader(roads: unknown[] = []) {
  return vi.fn(async () => roads);
}

describe("buildGeometryParityProbe", () => {
  it("PASSes (diverged: false) when every sampled parcel grades pass=true", async () => {
    const probe = buildGeometryParityProbe({
      sql: {},
      txSql: {},
      storage: {},
      descriptor: {},
      loadSample: makeSampleLoader(),
      loadRoads: makeRoadsLoader(),
      gradeOneParcel: passGrader,
    });
    const result = await probe(ROW);
    expect(result.diverged).toBe(false);
    expect(result.sampleSize).toBe(5);
  });

  it("PASSes when sampled parcels honest-decline (pass=true, honestDecline=true) — not a divergence", async () => {
    const probe = buildGeometryParityProbe({
      sql: {},
      txSql: {},
      storage: {},
      descriptor: {},
      loadSample: makeSampleLoader(),
      loadRoads: makeRoadsLoader(),
      gradeOneParcel: honestDeclineGrader,
    });
    const result = await probe(ROW);
    expect(result.diverged).toBe(false);
  });

  it("DECLINEs (diverged: true) when a sampled parcel grades pass=false", async () => {
    const diverging: GradeOneParcelFn = async (parcelNodeId) => ({
      pass: parcelNodeId !== "48021:3",
    });
    const probe = buildGeometryParityProbe({
      sql: {},
      txSql: {},
      storage: {},
      descriptor: {},
      loadSample: makeSampleLoader(),
      loadRoads: makeRoadsLoader(),
      gradeOneParcel: diverging,
    });
    const result = await probe(ROW);
    expect(result.diverged).toBe(true);
    expect(result.detail).toMatch(/1 of 5 parcels diverged/);
    expect(result.detail).toContain("48021:3");
  });

  it("declines honestly (does not throw) when loadSample rejects — e.g. a row with no wired parcel rail", async () => {
    const probe = buildGeometryParityProbe({
      sql: {},
      txSql: {},
      storage: {},
      descriptor: {},
      loadSample: vi.fn(async () => {
        throw new Error("registry cohort: no railPerParcel row for FIPS 48021");
      }),
      loadRoads: makeRoadsLoader(),
      gradeOneParcel: passGrader,
    });
    const result = await probe(ROW);
    expect(result.diverged).toBe(true);
    expect(result.detail).toMatch(/sample load failed/);
  });

  it("declines honestly when the sample is empty", async () => {
    const probe = buildGeometryParityProbe({
      sql: {},
      txSql: {},
      storage: {},
      descriptor: {},
      loadSample: makeSampleLoader([]),
      loadRoads: makeRoadsLoader(),
      gradeOneParcel: passGrader,
    });
    const result = await probe(ROW);
    expect(result.diverged).toBe(true);
    expect(result.sampleSize).toBe(0);
    expect(result.detail).toMatch(/empty sample/);
  });

  it("uses a deterministic sample: the same loadSample stub called twice returns the same order", async () => {
    const loadSample = makeSampleLoader();
    const probe = buildGeometryParityProbe({
      sql: {},
      txSql: {},
      storage: {},
      descriptor: {},
      loadSample,
      loadRoads: makeRoadsLoader(),
      gradeOneParcel: passGrader,
    });
    await probe(ROW);
    await probe(ROW);
    expect(loadSample.mock.calls[0]).toEqual(loadSample.mock.calls[1]);
  });
});

describe("buildServePathHealthProbe", () => {
  function jsonResponse(status: number): Response {
    return new Response(JSON.stringify({}), { status });
  }

  it("PASSes (reachable: true) when health, search, and atom-chain all succeed", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200)) // /health/search
      .mockResolvedValueOnce(jsonResponse(200)) // /search
      .mockResolvedValueOnce(jsonResponse(200)); // /property-nodes/.../atom-chain
    const probe = buildServePathHealthProbe({
      baseUrl: "https://retrieval.example.com",
      apiKey: "test-key",
      loadSample: makeSampleLoader(["48021:1"]),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await probe(ROW);
    expect(result.reachable).toBe(true);
    expect(result.detail).toMatch(/ledger-write probe: not wireable from engine/);
  });

  it("DECLINEs with the exact '401' class when /search returns 401 (the outage-causing shape)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200)) // /health/search ok
      .mockResolvedValueOnce(jsonResponse(401)); // /search 401
    const probe = buildServePathHealthProbe({
      baseUrl: "https://retrieval.example.com",
      apiKey: "bad-key",
      loadSample: makeSampleLoader(["48021:1"]),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await probe(ROW);
    expect(result.reachable).toBe(false);
    expect(result.detail).toBe("serve path unhealthy: retrieval auth 401");
  });

  it("DECLINEs with 401 when the atom-chain read is unauthorized even if /search passed", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200)) // /health/search
      .mockResolvedValueOnce(jsonResponse(200)) // /search
      .mockResolvedValueOnce(jsonResponse(401)); // atom-chain 401
    const probe = buildServePathHealthProbe({
      baseUrl: "https://retrieval.example.com",
      apiKey: "test-key",
      loadSample: makeSampleLoader(["48021:1"]),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await probe(ROW);
    expect(result.reachable).toBe(false);
    expect(result.detail).toBe("serve path unhealthy: retrieval auth 401");
  });

  it("DECLINEs when /health/search itself is unhealthy (non-2xx)", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(503));
    const probe = buildServePathHealthProbe({
      baseUrl: "https://retrieval.example.com",
      apiKey: "test-key",
      loadSample: makeSampleLoader(["48021:1"]),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await probe(ROW);
    expect(result.reachable).toBe(false);
    expect(result.detail).toMatch(/health\/search HTTP 503/);
  });

  it("DECLINEs honestly (does not throw) when fetch rejects (network error)", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const probe = buildServePathHealthProbe({
      baseUrl: "https://retrieval.example.com",
      apiKey: "test-key",
      loadSample: makeSampleLoader(["48021:1"]),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await probe(ROW);
    expect(result.reachable).toBe(false);
    expect(result.detail).toMatch(/unreachable: ECONNREFUSED/);
  });
});

describe("buildCostSampleProbe", () => {
  it("PASSes with an estimate under the $200 gate and flags estimate: true", async () => {
    let tick = 0;
    const now = () => {
      tick += 100; // 100ms per call: startMs then endMs => 100ms elapsed
      return tick;
    };
    const probe = buildCostSampleProbe({
      sql: {},
      txSql: {},
      storage: {},
      descriptor: {},
      loadSample: makeSampleLoader(),
      loadRoads: makeRoadsLoader(),
      gradeOneParcel: passGrader,
      loadCohortCount: async () => 100,
      now,
    });
    const result = await probe(ROW);
    expect(result.detail).toMatch(/estimate: true/);
    expect(result.detail).toContain(String(COST_MODEL_USD_PER_COMPUTE_HOUR));
    expect(result.detail).toContain(String(COST_MODEL_USD_PER_1K_EXTERNAL_CALLS));
    expect(result.estimatedUsd).toBeLessThan(200);
    expect(result.estimatedUsd).toBeGreaterThan(0);
  });

  it("DECLINEs (estimate at/over the $200 gate) for a large cohort extrapolation", async () => {
    let tick = 0;
    const now = () => {
      tick += 60_000; // 60s per call — large wall-clock per parcel
      return tick;
    };
    const probe = buildCostSampleProbe({
      sql: {},
      txSql: {},
      storage: {},
      descriptor: {},
      loadSample: makeSampleLoader(),
      loadRoads: makeRoadsLoader(),
      gradeOneParcel: passGrader,
      loadCohortCount: async () => 500_000,
      now,
    });
    const result = await probe(ROW);
    expect(result.estimatedUsd).toBeGreaterThanOrEqual(200);
    expect(result.detail).toMatch(/estimate: true/);
  });

  it("never presents the extrapolation as a measured cohort cost (detail always says 'not measured cohort cost')", async () => {
    const probe = buildCostSampleProbe({
      sql: {},
      txSql: {},
      storage: {},
      descriptor: {},
      loadSample: makeSampleLoader(),
      loadRoads: makeRoadsLoader(),
      gradeOneParcel: passGrader,
      loadCohortCount: async () => 50,
    });
    const result = await probe(ROW);
    expect(result.detail).toMatch(/not measured cohort cost/);
  });

  it("uses the sentinel (over-gate) when the sample cannot be measured — never a false PASS", async () => {
    const probe = buildCostSampleProbe({
      sql: {},
      txSql: {},
      storage: {},
      descriptor: {},
      loadSample: vi.fn(async () => {
        throw new Error("no railPerParcel row");
      }),
      loadRoads: makeRoadsLoader(),
      gradeOneParcel: passGrader,
      loadCohortCount: async () => 100,
    });
    const result = await probe(ROW);
    expect(result.estimatedUsd).toBe(COST_SAMPLE_UNMEASURABLE_SENTINEL_USD);
    expect(result.estimatedUsd).toBeGreaterThanOrEqual(200);
    expect(result.detail).toMatch(/could not be measured/);
  });

  it("declines to 0 (not a fabricated large or small number) for a genuinely empty cohort sample", async () => {
    const probe = buildCostSampleProbe({
      sql: {},
      txSql: {},
      storage: {},
      descriptor: {},
      loadSample: makeSampleLoader([]),
      loadRoads: makeRoadsLoader(),
      gradeOneParcel: passGrader,
      loadCohortCount: async () => 0,
    });
    const result = await probe(ROW);
    expect(result.estimatedUsd).toBe(0);
    expect(result.detail).toMatch(/empty sample/);
  });
});
