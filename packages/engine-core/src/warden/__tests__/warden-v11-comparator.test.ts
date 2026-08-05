import { describe, it, expect, vi } from "vitest";

import { runCrossStoreConsistencyCheck } from "../cross-store-consistency.js";
import { runCertFreshnessCheck } from "../cert-freshness.js";
import { runServePathTruthCheck } from "../serve-path-truth.js";
import { BASTROP_REGISTRY_ROW } from "../../registry/jurisdiction-registry.js";
import * as certGradeCore from "../../registry/cert-grade-core.js";
import { UNZONED_CASCADE_DECLINE_CODE } from "../../registry/cert-grade-core.js";
import { NO_DISTRICT_ON_RECORD_CODE } from "../../property-reasoning/cascade-unzoned-envelope-decline.js";
import type { JurisdictionRegistryRow } from "../../registry/jurisdiction-registry.js";

const FIXED_NOW = () => new Date("2026-08-04T00:00:00.000Z");
const FIPS = "48021";
const ROW_ID = "Bastrop";

const stubCtx = {
  sql: {} as never,
  txSql: {} as never,
  storage: {} as never,
  roads: [] as unknown[],
  descriptor: {} as unknown,
};

const UNZONED_COUNTY_ROW: JurisdictionRegistryRow = {
  ...BASTROP_REGISTRY_ROW,
  rowId: "Guadalupe County (unincorporated)",
  fips: "48187",
  zoningRegime: "unzoned",
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("runCrossStoreConsistencyCheck — Warden v1.1 decline-code awareness", () => {
  it("(a) city parcel with no-district-on-record decline => NO finding", async () => {
    vi.spyOn(certGradeCore, "gradeUnzonedParcel").mockResolvedValue({
      pass: false,
      gates: {},
      edges: [],
      reason: "cascade-missing",
    });
    const findings = await runCrossStoreConsistencyCheck({
      sweepId: "test-sweep",
      fips: "48187",
      rowId: UNZONED_COUNTY_ROW.rowId,
      now: FIXED_NOW,
      deps: {
        ctx: stubCtx,
        sample: ["48187:106109"],
        row: UNZONED_COUNTY_ROW,
        loadEnvelopeDeclineCode: async () => NO_DISTRICT_ON_RECORD_CODE,
      },
    });
    expect(findings.filter((f) => f.severity === "flag")).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it("(b) unincorporated parcel with unzoned code => NO finding when grader passes", async () => {
    vi.spyOn(certGradeCore, "gradeUnzonedParcel").mockResolvedValue({
      pass: true,
      gates: {},
      edges: [],
      honestDecline: true,
      declineReason: UNZONED_CASCADE_DECLINE_CODE,
    });
    const findings = await runCrossStoreConsistencyCheck({
      sweepId: "test-sweep",
      fips: "48187",
      rowId: UNZONED_COUNTY_ROW.rowId,
      now: FIXED_NOW,
      deps: {
        ctx: stubCtx,
        sample: ["48187:200001"],
        row: UNZONED_COUNTY_ROW,
        loadEnvelopeDeclineCode: async () => UNZONED_CASCADE_DECLINE_CODE,
      },
    });
    expect(findings.filter((f) => f.severity === "flag")).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it("(c) in-city parcel with no valid decline => CASCADE-STATE-MISMATCH finding", async () => {
    vi.spyOn(certGradeCore, "gradeOneParcelInQueryMode").mockResolvedValue({
      pass: false,
      gates: {},
      edges: [],
      reason: "cascade-missing",
    });
    const bastropRow = BASTROP_REGISTRY_ROW;
    const findings = await runCrossStoreConsistencyCheck({
      sweepId: "test-sweep",
      fips: FIPS,
      rowId: ROW_ID,
      now: FIXED_NOW,
      deps: {
        ctx: stubCtx,
        sample: [`${FIPS}:31131`],
        row: bastropRow,
        loadEnvelopeDeclineCode: async () => null,
      },
    });
    const flag = findings.find((f) => f.severity === "flag");
    expect(flag?.defectClass).toBe("CASCADE-STATE-MISMATCH");
    vi.restoreAllMocks();
  });

  it("a hard geometry fail still flags GEOMETRY-DIVERGE", async () => {
    vi.spyOn(certGradeCore, "gradeOneParcelInQueryMode").mockResolvedValue({
      pass: false,
      gates: {},
      edges: [],
      error: "no-promoted-envelope-geojson",
    });
    const findings = await runCrossStoreConsistencyCheck({
      sweepId: "test-sweep",
      fips: FIPS,
      rowId: ROW_ID,
      now: FIXED_NOW,
      deps: {
        ctx: stubCtx,
        sample: [`${FIPS}:34073`],
        row: BASTROP_REGISTRY_ROW,
        loadEnvelopeDeclineCode: async () => null,
      },
    });
    expect(findings.some((f) => f.severity === "flag" && f.defectClass === "GEOMETRY-DIVERGE")).toBe(true);
    vi.restoreAllMocks();
  });
});

describe("runServePathTruthCheck — absence-fact DB truth (Warden v1.1)", () => {
  it("(d) absence-fact parcel served with zoning section => NO servePathTruth finding", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/health/search")) return jsonResponse(200, {});
      if (url.includes("/search?")) return jsonResponse(200, {});
      if (url.includes("/atom-chain")) {
        return jsonResponse(200, {
          parcelNodeId: "48187:106109",
          zoningFact: { entityType: "zoning-fact", absence: { kind: "no-zoning-stamp" }, district: null },
          buildableEnvelope: { entityType: "buildable-envelope" },
          atoms: [
            { type: "zoning-fact", payload: { entityType: "zoning-fact", absence: { kind: "no-zoning-stamp" } } },
            { type: "buildable-envelope" },
          ],
        });
      }
      return jsonResponse(200, {});
    });
    const findings = await runServePathTruthCheck({
      sweepId: "test-sweep",
      fips: "48187",
      rowId: UNZONED_COUNTY_ROW.rowId,
      now: FIXED_NOW,
      deps: {
        baseUrl: "https://retrieval.example",
        apiKey: "test-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sample: ["48187:106109"],
        loadDbTruth: async () => ({
          hasZoningFact: true,
          district: null,
          hasBuildableEnvelope: true,
          setbackSourceStale: null,
          envelopeServeIndependentOfStaleSetback: true,
        }),
      },
    });
    expect(findings.filter((f) => f.severity === "flag")).toHaveLength(0);
  });
});

describe("runCertFreshnessCheck", () => {
  it("reads artifactTs from a cert JSON when field is when", async () => {
    vi.spyOn(certGradeCore, "gradeOneParcelInQueryMode").mockResolvedValue({ pass: true, gates: {}, edges: [] });
    const findings = await runCertFreshnessCheck({
      sweepId: "test-sweep",
      fips: FIPS,
      rowId: ROW_ID,
      now: FIXED_NOW,
      deps: {
        ctx: stubCtx,
        sample: [`${FIPS}:34073`],
        row: BASTROP_REGISTRY_ROW,
        priorVerdict: {
          passByParcel: { [`${FIPS}:34073`]: true },
          artifactPath: "fake.json",
          artifactTs: "2026-08-04T12:00:00.000Z",
        },
      },
    });
    expect(findings.some((f) => f.evidence.note?.toString().includes("no timestamp"))).toBe(false);
    vi.restoreAllMocks();
  });
});
