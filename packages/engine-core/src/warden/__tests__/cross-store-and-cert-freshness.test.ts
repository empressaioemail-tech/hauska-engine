import { describe, it, expect, vi } from "vitest";

import { runCrossStoreConsistencyCheck } from "../cross-store-consistency.js";
import { runCertFreshnessCheck } from "../cert-freshness.js";
import { BASTROP_REGISTRY_ROW } from "../../registry/jurisdiction-registry.js";
import * as certGradeCore from "../../registry/cert-grade-core.js";
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

describe("runCrossStoreConsistencyCheck", () => {
  it("no --cert-artifact supplied: emits a named info note and still grades the sample", async () => {
    vi.spyOn(certGradeCore, "gradeOneParcelInQueryMode").mockResolvedValue({
      pass: true,
      gates: {},
      edges: [],
    });
    const findings = await runCrossStoreConsistencyCheck({
      sweepId: "test-sweep",
      fips: FIPS,
      rowId: ROW_ID,
      now: FIXED_NOW,
      deps: { ctx: stubCtx, sample: [`${FIPS}:34073`], row: BASTROP_REGISTRY_ROW },
    });
    expect(findings.some((f) => f.severity === "info" && f.evidence.note)).toBe(true);
    expect(findings.some((f) => f.severity === "flag")).toBe(false);
    vi.restoreAllMocks();
  });

  it("a hard-fail grade flags GEOMETRY-DIVERGE", async () => {
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
      deps: { ctx: stubCtx, sample: [`${FIPS}:34073`], row: BASTROP_REGISTRY_ROW },
    });
    expect(findings.some((f) => f.severity === "flag" && f.defectClass === "GEOMETRY-DIVERGE")).toBe(true);
    vi.restoreAllMocks();
  });

  it("diverges from a supplied prior verdict — flags GEOMETRY-DIVERGE with both verdicts in evidence", async () => {
    vi.spyOn(certGradeCore, "gradeOneParcelInQueryMode").mockResolvedValue({
      pass: true,
      gates: {},
      edges: [],
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
        priorVerdict: { passByParcel: { [`${FIPS}:34073`]: false }, artifactPath: "fake.json" },
      },
    });
    const flag = findings.find((f) => f.severity === "flag");
    expect(flag?.defectClass).toBe("GEOMETRY-DIVERGE");
    expect(flag?.evidence.priorVerdict).toBe(false);
    expect(flag?.evidence.currentGrade).toBe(true);
    vi.restoreAllMocks();
  });

  it("threads the row's railC.cadastralQueryUrl into gradeOneParcel's ctx for a non-Bastrop row (fix/unzoned-cert-cadastral-url-param)", async () => {
    const spy = vi
      .spyOn(certGradeCore, "gradeOneParcelInQueryMode")
      .mockResolvedValue({ pass: true, gates: {}, edges: [] });
    const nonBastropRow: JurisdictionRegistryRow = {
      ...BASTROP_REGISTRY_ROW,
      rowId: "Travis-test",
      fips: "48453",
      railC: { ...BASTROP_REGISTRY_ROW.railC, cadastralQueryUrl: "https://traviscad.example/query" },
    };
    await runCrossStoreConsistencyCheck({
      sweepId: "test-sweep",
      fips: "48453",
      rowId: "Travis-test",
      now: FIXED_NOW,
      deps: { ctx: stubCtx, sample: ["48453:1"], row: nonBastropRow },
    });
    expect(spy).toHaveBeenCalledWith(
      "48453:1",
      expect.objectContaining({ cadastralQueryUrl: "https://traviscad.example/query" }),
    );
    vi.restoreAllMocks();
  });
});

describe("runCertFreshnessCheck", () => {
  it("no --cert-artifact supplied: declines with a named info note, no grading attempted", async () => {
    const spy = vi.spyOn(certGradeCore, "gradeOneParcelInQueryMode");
    const findings = await runCertFreshnessCheck({
      sweepId: "test-sweep",
      fips: FIPS,
      rowId: ROW_ID,
      now: FIXED_NOW,
      deps: { ctx: stubCtx, sample: [`${FIPS}:34073`], row: BASTROP_REGISTRY_ROW },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("info");
    expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("an un-datable cert artifact (no artifactTs) is flagged stale", async () => {
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
        priorVerdict: { passByParcel: {}, artifactPath: "fake.json", artifactTs: null },
      },
    });
    expect(findings.some((f) => f.severity === "flag" && f.evidence.note?.toString().includes("no timestamp"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("a fresh grade disagreeing with a dated artifact's verdict flags staleness", async () => {
    vi.spyOn(certGradeCore, "gradeOneParcelInQueryMode").mockResolvedValue({ pass: false, gates: {}, edges: [] });
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
          artifactTs: "2026-08-01T00:00:00.000Z",
        },
      },
    });
    expect(findings.some((f) => f.severity === "flag" && f.evidence.detail?.toString().includes("stale evidence"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("threads the row's railC.cadastralQueryUrl into gradeOneParcel's ctx for a non-Bastrop row (fix/unzoned-cert-cadastral-url-param)", async () => {
    const spy = vi
      .spyOn(certGradeCore, "gradeOneParcelInQueryMode")
      .mockResolvedValue({ pass: true, gates: {}, edges: [] });
    const nonBastropRow: JurisdictionRegistryRow = {
      ...BASTROP_REGISTRY_ROW,
      rowId: "Travis-test",
      fips: "48453",
      railC: { ...BASTROP_REGISTRY_ROW.railC, cadastralQueryUrl: "https://traviscad.example/query" },
    };
    await runCertFreshnessCheck({
      sweepId: "test-sweep",
      fips: "48453",
      rowId: "Travis-test",
      now: FIXED_NOW,
      deps: {
        ctx: stubCtx,
        sample: ["48453:1"],
        row: nonBastropRow,
        priorVerdict: { passByParcel: { "48453:1": true }, artifactPath: "fake.json", artifactTs: "2026-08-01T00:00:00.000Z" },
      },
    });
    expect(spy).toHaveBeenCalledWith(
      "48453:1",
      expect.objectContaining({ cadastralQueryUrl: "https://traviscad.example/query" }),
    );
    vi.restoreAllMocks();
  });
});
