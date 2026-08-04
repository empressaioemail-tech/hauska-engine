import { describe, it, expect, vi } from "vitest";

import { BASTROP_REGISTRY_ROW } from "../jurisdiction-registry.js";
import { runOnboardPreflight } from "../onboard-preflight.js";
import {
  buildGeometryParityProbe,
  buildServePathHealthProbe,
  buildCostSampleProbe,
  buildOnboardPreflightDeps,
  COST_MODEL_USD_PER_COMPUTE_HOUR,
  COST_MODEL_USD_PER_1K_EXTERNAL_CALLS,
  COST_SAMPLE_UNMEASURABLE_SENTINEL_USD,
} from "../preflight-probes.js";
import type { GradeOneParcelFn } from "../preflight-probes.js";

const ROW = BASTROP_REGISTRY_ROW;
const SAMPLE_5 = ["48021:1", "48021:2", "48021:3", "48021:4", "48021:5"];

const passGrader: GradeOneParcelFn = async () => ({ pass: true, gates: {}, edges: [] });
const honestDeclineGrader: GradeOneParcelFn = async () => ({
  pass: true,
  honestDecline: true,
  gates: {},
  edges: [],
});

function makeSampleLoader(ids: string[] = SAMPLE_5) {
  return vi.fn(async (_row: unknown, sampleSize = 5) => ids.slice(0, sampleSize));
}
function makeRoadsLoader(roads: unknown[] = []) {
  return vi.fn(async () => roads);
}

describe("buildGeometryParityProbe", () => {
  it("PASSes (diverged: false) when every sampled parcel grades pass=true", async () => {
    const probe = buildGeometryParityProbe({
      sql: {} as never,
      txSql: {} as never,
      storage: {} as never,
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
      sql: {} as never,
      txSql: {} as never,
      storage: {} as never,
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
      gates: {},
      edges: [],
    });
    const probe = buildGeometryParityProbe({
      sql: {} as never,
      txSql: {} as never,
      storage: {} as never,
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
      sql: {} as never,
      txSql: {} as never,
      storage: {} as never,
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
      sql: {} as never,
      txSql: {} as never,
      storage: {} as never,
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
      sql: {} as never,
      txSql: {} as never,
      storage: {} as never,
      descriptor: {},
      loadSample,
      loadRoads: makeRoadsLoader(),
      gradeOneParcel: passGrader,
    });
    await probe(ROW);
    await probe(ROW);
    expect(loadSample.mock.calls[0]).toEqual(loadSample.mock.calls[1]);
  });

  it("threads the row's railC.cadastralQueryUrl into gradeOneParcel's ctx (fix/unzoned-cert-cadastral-url-param — never lets a non-Bastrop row silently grade against Bastrop's cadastral service)", async () => {
    const capturedCtxs: unknown[] = [];
    const capturingGrader: GradeOneParcelFn = async (_id, ctx) => {
      capturedCtxs.push(ctx);
      return { pass: true, gates: {}, edges: [] };
    };
    const nonBastropRow = {
      ...ROW,
      rowId: "Travis-test",
      fips: "48453",
      railC: { ...ROW.railC, cadastralQueryUrl: "https://traviscad.example/query" },
    };
    const probe = buildGeometryParityProbe({
      sql: {} as never,
      txSql: {} as never,
      storage: {} as never,
      descriptor: {},
      loadSample: makeSampleLoader(["48453:1"]),
      loadRoads: makeRoadsLoader(),
      gradeOneParcel: capturingGrader,
    });
    await probe(nonBastropRow);
    expect(capturedCtxs).toHaveLength(1);
    expect((capturedCtxs[0] as { cadastralQueryUrl?: string }).cadastralQueryUrl).toBe(
      "https://traviscad.example/query",
    );
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
      sql: {} as never,
      txSql: {} as never,
      storage: {} as never,
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
      sql: {} as never,
      txSql: {} as never,
      storage: {} as never,
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
      sql: {} as never,
      txSql: {} as never,
      storage: {} as never,
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
      sql: {} as never,
      txSql: {} as never,
      storage: {} as never,
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
      sql: {} as never,
      txSql: {} as never,
      storage: {} as never,
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

/**
 * S4 — buildOnboardPreflightDeps. This is the shared factory both
 * onboard-preflight.mjs (the standalone CLI) and block13-cert-grade.mjs's
 * --preflight-row-id internal preflight now wire, so an internal preflight
 * run gets the SAME live probes instead of an empty deps object (the bug:
 * block13-cert-grade.mjs used to call runOnboardPreflight(fips, {}), so
 * every probe-backed check spuriously declined "not runnable" regardless of
 * whether the source was actually reachable). A fake AGOL fetch stub stands
 * in for the live ArcGIS FeatureServer so loadRegistryDistrictCohortByRow
 * (used internally for the deterministic sample + cohort count) resolves
 * without live network.
 */
function fakeAgolFetch(propIds: string[] = ["1", "2", "3", "4", "5"]): typeof fetch {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    // Probe reachability checks (Rail A / zoning) hit "...?f=json" with a
    // plain GET and only need a 2xx; the cohort query hits ".../query".
    if (url.includes("/query")) {
      return new Response(
        JSON.stringify({ features: propIds.map((id) => ({ attributes: { prop_id: id } })) }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("buildOnboardPreflightDeps", () => {
  it("wires probeRailASource / probeZoningSource unconditionally (no DB/retrieval creds needed)", async () => {
    const deps = buildOnboardPreflightDeps({
      descriptor: {},
      gradeOneParcel: passGrader,
      loadRoads: makeRoadsLoader(),
      fetchImpl: fakeAgolFetch(),
    });
    expect(deps.probeRailASource).toBeDefined();
    expect(deps.probeZoningSource).toBeDefined();
    const railResult = await deps.probeRailASource!(ROW);
    expect(railResult.reachable).toBe(true);
  });

  it("omits probeSupersededCohort / probeMixedVintageResidue when no sql is supplied (honest not-runnable, matches CLI's sql-only gate)", () => {
    const deps = buildOnboardPreflightDeps({
      descriptor: {},
      gradeOneParcel: passGrader,
      loadRoads: makeRoadsLoader(),
      fetchImpl: fakeAgolFetch(),
    });
    expect(deps.probeSupersededCohort).toBeUndefined();
    expect(deps.probeMixedVintageResidue).toBeUndefined();
  });

  it("wires probeSupersededCohort / probeMixedVintageResidue when sql is supplied", () => {
    // Stub sql as a tagged-template function (sql`...`) returning the same
    // row shape for every query used in these two probes.
    const taggedSql = Object.assign(
      (..._args: unknown[]) => Promise.resolve([{ total: 10, superseded: 1, residue: 0 }]),
      {},
    ) as unknown as CertSql;
    const deps = buildOnboardPreflightDeps({
      sql: taggedSql,
      descriptor: {},
      gradeOneParcel: passGrader,
      loadRoads: makeRoadsLoader(),
      fetchImpl: fakeAgolFetch(),
    });
    expect(deps.probeSupersededCohort).toBeDefined();
    expect(deps.probeMixedVintageResidue).toBeDefined();
  });

  it("omits probeGeometryParity / probeCostSample when sql/txSql/storage are incomplete", () => {
    const deps = buildOnboardPreflightDeps({
      sql: {} as never,
      // txSql and storage absent — grading creds incomplete.
      descriptor: {},
      gradeOneParcel: passGrader,
      loadRoads: makeRoadsLoader(),
      fetchImpl: fakeAgolFetch(),
    });
    expect(deps.probeGeometryParity).toBeUndefined();
    expect(deps.probeCostSample).toBeUndefined();
  });

  it("omits probeServePathHealth when retrievalApiUrl/Key are absent", () => {
    const deps = buildOnboardPreflightDeps({
      descriptor: {},
      gradeOneParcel: passGrader,
      loadRoads: makeRoadsLoader(),
      fetchImpl: fakeAgolFetch(),
    });
    expect(deps.probeServePathHealth).toBeUndefined();
  });

  it("wires probeServePathHealth when retrievalApiUrl/Key are both present", () => {
    const deps = buildOnboardPreflightDeps({
      descriptor: {},
      gradeOneParcel: passGrader,
      loadRoads: makeRoadsLoader(),
      retrievalApiUrl: "https://retrieval.example.com",
      retrievalApiKey: "test-key",
      fetchImpl: fakeAgolFetch(),
    });
    expect(deps.probeServePathHealth).toBeDefined();
  });

  it(
    "cert-path preflight parity: with stubbed probes injected via buildOnboardPreflightDeps, " +
      "the cert-path preflight (runOnboardPreflight fed this deps object, mirroring " +
      "block13-cert-grade.mjs's --preflight-row-id call) PASSes every probe-backed check " +
      "exactly like the standalone onboard-preflight.mjs gate would with the same env present",
    async () => {
      const taggedSql = Object.assign(
        (..._args: unknown[]) => Promise.resolve([{ total: 100, superseded: 1, residue: 0 }]),
        {},
      ) as unknown as CertSql;
      const fetchImpl = vi
        .fn()
        // check 1 probeRailASource, check 2 probeZoningSource reachability GETs
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
      const deps = buildOnboardPreflightDeps({
        sql: taggedSql,
        txSql: taggedSql,
        storage: {} as never,
        descriptor: {},
        gradeOneParcel: passGrader,
        loadRoads: makeRoadsLoader(),
        retrievalApiUrl: "https://retrieval.example.com",
        retrievalApiKey: "test-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      // loadDeterministicSample / loadCohortCount inside the geometry-parity
      // and cost-sample probes call loadRegistryDistrictCohortByRow, which
      // does its own AGOL fetch — override fetchImpl behavior per-URL so
      // both the reachability GETs and the cohort /query calls resolve.
      fetchImpl.mockImplementation(async (input: unknown) => {
        const url = String(input);
        if (url.includes("/query")) {
          return new Response(
            JSON.stringify({ features: [{ attributes: { prop_id: "1" } }] }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      // buildServePathHealthProbe needs its own 3 sequential OK responses per
      // call (health, search, atom-chain) on TOP of the AGOL stub above —
      // stub loadSample indirectly by keeping the AGOL /query response
      // non-empty (already done) so its internal sample load succeeds too.

      const { report } = await runOnboardPreflight("48021", deps);
      const bastropRow = report.rows.find((r) => r.rowId === "Bastrop")!;
      const byId = Object.fromEntries(bastropRow.checks.map((c) => [c.id, c]));
      expect(byId.railASourceReachable.outcome).toBe("PASS");
      expect(byId.zoningSourceReachableOrUnzoned.outcome).toBe("PASS");
      expect(byId.parcelLayerWired.outcome).toBe("PASS");
      expect(byId.supersededCohortMeasured.outcome).toBe("PASS");
      expect(byId.geometryParitySample.outcome).toBe("PASS");
      expect(byId.servePathHealth.outcome).toBe("PASS");
      expect(byId.costGate.outcome).toBe("PASS");
      expect(byId.mixedVintageResidueScan.outcome).toBe("PASS");
      expect(bastropRow.railPlan.declines).toHaveLength(0);
    },
    15_000, // runOnboardPreflight grades all 3 fips-48021 rows (Bastrop, county, Elgin)
    // x 8 checks, several re-running the 5-parcel sample grade — legitimately
    // slower than a pure-unit test; default 5s vitest timeout is too tight.
  );
});

/** Minimal shape for the `sql` tagged-template stub used above. */
type CertSql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;
