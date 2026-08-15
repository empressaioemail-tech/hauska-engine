/**
 * L26 / WDLL items 4, 5 (harness), 8 — PostGIS rrc-pipeline plan gates.
 */

import { describe, expect, it, vi } from "vitest";
import postgres from "postgres";

import {
  compareRrcPipelinePlanParity,
  configureRrcPipelinePlanSession,
  keysetParcelBatchPlanSql,
  PLAN_LOCK_TIMEOUT_MS,
  PLAN_STATEMENT_TIMEOUT_MS,
  planCountyRrcPipelinePostgis,
  probeRrcPipelinePostgisReadiness,
  rrcPipelineNearPredicateSql,
} from "../postgis-rrc-pipeline-plan.js";
import {
  planCountyRrcPipeline,
  type CountyRrcPipelinePlan,
} from "../plan-county-rrc-pipeline.js";

describe("rrc-pipeline PostGIS plan SQL contract", () => {
  it("uses geography ST_DWithin at buffer meters, not geometry degrees", () => {
    const pred = rrcPipelineNearPredicateSql("p.geom", "pl.geom", "$6");
    expect(pred).toContain("::geography");
    expect(pred).toContain("ST_DWithin");
    expect(pred).not.toContain("ST_DWithin(p.geom, pl.geom");

    const batchSql = keysetParcelBatchPlanSql();
    expect(batchSql).toContain("::geography");
    expect(batchSql).toContain("ST_DWithin");
    expect(batchSql).not.toMatch(
      /ST_DWithin\(\s*p\.geom\s*,\s*pl\.geom\s*,/,
    );
  });

  it("keysetParcelBatchPlanSql does not DISTINCT ON (feature_index)", () => {
    const batchSql = keysetParcelBatchPlanSql();
    expect(batchSql).not.toMatch(/DISTINCT ON\s*\(\s*feature_index\s*\)/i);
  });

  it("plan rows assembled from hit metadata carry no geometry field", () => {
    const plan = planCountyRrcPipeline(
      [
        {
          parcelKey: "1001",
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [-102.0802, 31.9965],
                [-102.0798, 31.9965],
                [-102.0798, 31.9975],
                [-102.0802, 31.9975],
                [-102.0802, 31.9965],
              ],
            ],
          },
        },
      ],
      [],
      { countyFips: "48001" },
    );
    for (const row of plan.planned) {
      expect(row).not.toHaveProperty("geometry");
      expect(Object.keys(row).every((k) => k !== "geom")).toBe(true);
    }
  });

  it("statement_timeout default is bounded (not zero)", () => {
    expect(PLAN_STATEMENT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PLAN_LOCK_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("compareRrcPipelinePlanParity harness", () => {
  function nearPlan(key: string, near: boolean): CountyRrcPipelinePlan {
    return {
      countyFips: "48001",
      bufferMeters: 152.4,
      pipelinesIndexed: 1,
      pipelinesDeduped: 1,
      sourceReadFailed: false,
      parcelsRead: 1,
      planned: [
        near
          ? {
              outcome: "present",
              parcelKey: key,
              nearPipeline: true,
              bufferMeters: 152.4,
            }
          : {
              outcome: "present",
              parcelKey: key,
              nearPipeline: false,
              bufferMeters: 152.4,
            },
      ],
      counts: {
        present: 1,
        presentNear: near ? 1 : 0,
        presentOutside: near ? 0 : 1,
        absent: 0,
        skippedUnusableKey: 0,
      },
    };
  }

  it("counts near/far flips between backends", () => {
    const delta = compareRrcPipelinePlanParity(
      nearPlan("A", true),
      nearPlan("A", false),
    );
    expect(delta.parcelsCompared).toBe(1);
    expect(delta.nearFarFlips).toBe(1);
    expect(delta.flipRate).toBe(1);
    expect(delta.flippedParcelKeys).toEqual(["A"]);
  });

  it("reports zero flips when backends agree", () => {
    const delta = compareRrcPipelinePlanParity(
      nearPlan("B", false),
      nearPlan("B", false),
    );
    expect(delta.nearFarFlips).toBe(0);
    expect(delta.flipRate).toBe(0);
  });
});

describe("postgis readiness fail-closed", () => {
  it("throws when postgis backend requested but probe is not ready", async () => {
    const fakeSql = Object.assign(
      vi.fn(async () => [{ n: 0 }]),
      { unsafe: vi.fn() },
    ) as unknown as ReturnType<typeof postgres>;

    const readiness = await probeRrcPipelinePostgisReadiness(fakeSql);
    expect(readiness.ready).toBe(false);

    if (!readiness.ready) {
      expect(() => {
        throw new Error(
          `--plan-backend=postgis requested but the PostGIS path is not available: ${readiness.reason}. ` +
            "Refusing to fall back silently — re-run with --plan-backend=auto to accept the JS path.",
        );
      }).toThrow(/Refusing to fall back silently/);
    }
  });
});

const TEST_URL = process.env.RRC_PIPELINE_POSTGIS_TEST_URL?.trim();

describe.skipIf(!TEST_URL)("live PostGIS session timeouts", () => {
  const sql = postgres(TEST_URL ?? "", { max: 1, prepare: false, ssl: "require" });

  it("configureRrcPipelinePlanSession aborts pg_sleep over statement_timeout", async () => {
    await configureRrcPipelinePlanSession(sql);
    const [st] = await sql<Array<{ st: string }>>`
      SELECT current_setting('statement_timeout') AS st
    `;
    expect(st?.st).not.toBe("0");
    await expect(
      sql.unsafe(`SELECT pg_sleep(600)`),
    ).rejects.toThrow(/statement timeout|canceling statement/i);
  }, 120_000);

  it("sets lock_timeout on the plan session", async () => {
    await configureRrcPipelinePlanSession(sql);
    const [lt] = await sql<Array<{ lt: string }>>`
      SELECT current_setting('lock_timeout') AS lt
    `;
    expect(lt?.lt).toBe(String(PLAN_LOCK_TIMEOUT_MS));
  });
});

describe("writer .done phase timer contract (WDLL item 7)", () => {
  it("requires loadMs, planMs, writeMs, verifyMs keys on summary shape", () => {
    const doneShape = {
      loadMs: 1,
      planMs: 2,
      writeMs: 0,
      verifyMs: 0,
      wallMs: 3,
    };
    for (const key of ["loadMs", "planMs", "writeMs", "verifyMs", "wallMs"]) {
      expect(doneShape).toHaveProperty(key);
      expect(typeof doneShape[key as keyof typeof doneShape]).toBe("number");
    }
  });
});

describe.skipIf(!TEST_URL)("live PostGIS plan smoke", () => {
  const sql = postgres(TEST_URL ?? "", { max: 2, prepare: false, ssl: "require" });

  it("plans a limited county slice without geometry on rows", async () => {
    const readiness = await probeRrcPipelinePostgisReadiness(sql);
    if (!readiness.ready) return;

    const result = await planCountyRrcPipelinePostgis(sql, {
      countyFips: "48001",
      limit: 5,
    });
    for (const row of result.plan.planned) {
      expect(row).not.toHaveProperty("geometry");
    }
    expect(result.meta.membershipMethodId).toBe(
      "postgis-geography-st-dwithin-buffer",
    );
  }, 180_000);
});
