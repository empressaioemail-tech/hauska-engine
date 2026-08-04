import { describe, it, expect } from "vitest";

import {
  BASTROP_REGISTRY_ROW,
  BASTROP_COUNTY_UNINCORPORATED_REGISTRY_ROW,
  ELGIN_REGISTRY_ROW,
} from "../jurisdiction-registry.js";
import { runOnboardPreflight, deriveScopeAnnotations } from "../onboard-preflight.js";
import type { PreflightDeps } from "../onboard-preflight.js";

const FIXED_NOW = () => new Date("2026-08-03T00:00:00.000Z");

/** A deps set where every probe passes cleanly — used to prove the PASS path end to end. */
const ALL_PASS_DEPS: PreflightDeps = {
  now: FIXED_NOW,
  probeRailASource: async () => ({ reachable: true }),
  probeZoningSource: async () => ({ reachable: true }),
  probeSupersededCohort: async () => ({ supersededCount: 1, totalCount: 100 }),
  probeGeometryParity: async () => ({ sampleSize: 5, diverged: false }),
  probeServePathHealth: async () => ({ reachable: true }),
  probeCostSample: async () => ({ estimatedUsd: 12.5 }),
  probeMixedVintageResidue: async () => ({ residueCount: 0, measured: true }),
};

describe("onboard-preflight — a fully passing row", () => {
  it("Bastrop (active row) passes all 8 checks with fully-configured probes", async () => {
    const { report, ledgerEvents } = await runOnboardPreflight("48021", ALL_PASS_DEPS);
    const bastropRow = report.rows.find((r) => r.rowId === "Bastrop");
    expect(bastropRow).toBeDefined();
    expect(bastropRow!.checks).toHaveLength(8);
    expect(bastropRow!.checks.every((c) => c.outcome === "PASS")).toBe(true);
    expect(bastropRow!.railPlan.declines).toHaveLength(0);
    expect(ledgerEvents.filter((e) => e.rowId === "Bastrop")).toHaveLength(0);
  });
});

describe("onboard-preflight — no probes configured (CI default, no live creds)", () => {
  it("declines every network/DB-dependent check as not-runnable, never fakes a PASS", async () => {
    const { report, ledgerEvents } = await runOnboardPreflight("48021", { now: FIXED_NOW });
    const bastropRow = report.rows.find((r) => r.rowId === "Bastrop")!;
    const byId = Object.fromEntries(bastropRow.checks.map((c) => [c.id, c]));

    // Check 3 (parcel layer wired) is mechanical — no probe needed — PASSes for Bastrop.
    expect(byId.parcelLayerWired.outcome).toBe("PASS");

    // Every probe-backed check declines "not runnable" without a configured probe.
    for (const id of [
      "railASourceReachable",
      "supersededCohortMeasured",
      "geometryParitySample",
      "servePathHealth",
      "costGate",
      "mixedVintageResidueScan",
    ] as const) {
      expect(byId[id].outcome).toBe("DECLINE");
      expect(byId[id].reason).toMatch(/^not runnable:/);
    }

    const bastropEvents = ledgerEvents.filter((e) => e.rowId === "Bastrop");
    expect(bastropEvents.length).toBeGreaterThan(0);
    expect(bastropEvents.every((e) => e.fips === "48021")).toBe(true);
    expect(bastropEvents.every((e) => e.ts === FIXED_NOW().toISOString())).toBe(true);
  });
});

describe("onboard-preflight — missing adapter produces ADAPTER-NEEDED decline", () => {
  it("Elgin (no railPerParcel, zoning source TODO) declines checks 1, 2, 3 with ADAPTER-NEEDED / PARCEL-LAYER-UNWIRED", async () => {
    const { report, ledgerEvents } = await runOnboardPreflight("48021", ALL_PASS_DEPS);
    const elginRow = report.rows.find((r) => r.rowId === "Elgin")!;
    const byId = Object.fromEntries(elginRow.checks.map((c) => [c.id, c]));

    expect(byId.railASourceReachable.outcome).toBe("DECLINE");
    expect(byId.railASourceReachable.defectClass).toBe("ADAPTER-NEEDED");
    expect(byId.railASourceReachable.reason).toMatch(/needs adapter/);

    expect(byId.zoningSourceReachableOrUnzoned.outcome).toBe("DECLINE");
    expect(byId.zoningSourceReachableOrUnzoned.defectClass).toBe("ADAPTER-NEEDED");
    expect(byId.zoningSourceReachableOrUnzoned.reason).toMatch(/ZONING_SOURCE_TODO/);

    expect(byId.parcelLayerWired.outcome).toBe("DECLINE");
    expect(byId.parcelLayerWired.defectClass).toBe("PARCEL-LAYER-UNWIRED");

    const elginEvents = ledgerEvents.filter((e) => e.rowId === "Elgin");
    expect(elginEvents.some((e) => e.defectClass === "ADAPTER-NEEDED")).toBe(true);
    expect(elginEvents.some((e) => e.defectClass === "PARCEL-LAYER-UNWIRED")).toBe(true);
  });
});

describe("onboard-preflight — unzoned row passes zoning check as honest-absence", () => {
  it("Bastrop County unincorporated (unzoned) PASSes check 2 with an honest-absence reason", async () => {
    const { report } = await runOnboardPreflight("48021", ALL_PASS_DEPS);
    const countyRow = report.rows.find((r) => r.rowId === "Bastrop County (unincorporated)")!;
    const zoningCheck = countyRow.checks.find((c) => c.id === "zoningSourceReachableOrUnzoned")!;
    expect(zoningCheck.outcome).toBe("PASS");
    expect(zoningCheck.reason).toMatch(/unzoned regime/);
    expect(zoningCheck.reason).toMatch(/expected pass state/);
  });

  it("Bastrop County unincorporated parcel layer is wired (reuses the Bastrop layer, no-filter variant)", async () => {
    const { report } = await runOnboardPreflight("48021", ALL_PASS_DEPS);
    const countyRow = report.rows.find((r) => r.rowId === "Bastrop County (unincorporated)")!;
    const parcelCheck = countyRow.checks.find((c) => c.id === "parcelLayerWired")!;
    expect(parcelCheck.outcome).toBe("PASS");
  });
});

describe("onboard-preflight — geometry parity caveat travels with both PASS and DECLINE", () => {
  it("carries the ratified caveat string on PASS", async () => {
    const { report } = await runOnboardPreflight("48021", ALL_PASS_DEPS);
    const bastropRow = report.rows.find((r) => r.rowId === "Bastrop")!;
    const parityCheck = bastropRow.checks.find((c) => c.id === "geometryParitySample")!;
    expect(parityCheck.outcome).toBe("PASS");
    expect(parityCheck.caveat).toMatch(/BOUNDS risk, it does not prove the cohort/);
  });

  it("carries the ratified caveat string on DECLINE too", async () => {
    const deps: PreflightDeps = {
      ...ALL_PASS_DEPS,
      probeGeometryParity: async () => ({ sampleSize: 5, diverged: true, detail: "2 of 5 parcels diverged" }),
    };
    const { report } = await runOnboardPreflight("48021", deps);
    const bastropRow = report.rows.find((r) => r.rowId === "Bastrop")!;
    const parityCheck = bastropRow.checks.find((c) => c.id === "geometryParitySample")!;
    expect(parityCheck.outcome).toBe("DECLINE");
    expect(parityCheck.defectClass).toBe("GEOMETRY-DIVERGE");
    expect(parityCheck.caveat).toMatch(/BOUNDS risk, it does not prove the cohort/);
    expect(parityCheck.reason).toMatch(/fix engine first/);
  });
});

describe("onboard-preflight — superseded cohort threshold", () => {
  it("PASSes at or below 3% superseded", async () => {
    const deps: PreflightDeps = {
      ...ALL_PASS_DEPS,
      probeSupersededCohort: async () => ({ supersededCount: 3, totalCount: 100 }),
    };
    const { report } = await runOnboardPreflight("48021", deps);
    const check = report.rows
      .find((r) => r.rowId === "Bastrop")!
      .checks.find((c) => c.id === "supersededCohortMeasured")!;
    expect(check.outcome).toBe("PASS");
  });

  it("DECLINEs above 3% superseded with SUPERSEDED-GT3PCT", async () => {
    const deps: PreflightDeps = {
      ...ALL_PASS_DEPS,
      probeSupersededCohort: async () => ({ supersededCount: 10, totalCount: 100 }),
    };
    const { report } = await runOnboardPreflight("48021", deps);
    const check = report.rows
      .find((r) => r.rowId === "Bastrop")!
      .checks.find((c) => c.id === "supersededCohortMeasured")!;
    expect(check.outcome).toBe("DECLINE");
    expect(check.defectClass).toBe("SUPERSEDED-GT3PCT");
  });

  // Addendum (caught live against prod fips 48021): a zero DENOMINATOR from
  // the probe means the measurement query matched no parcels — "could not
  // measure", not "measured zero". Faking a 0/0 PASS is a false-PASS shape
  // that violates honest-absence discipline.
  it("DECLINEs with MEASURE-EMPTY-COHORT when totalCount is 0 on a row with a wired parcel rail", async () => {
    const deps: PreflightDeps = {
      ...ALL_PASS_DEPS,
      probeSupersededCohort: async () => ({ supersededCount: 0, totalCount: 0 }),
    };
    const { report } = await runOnboardPreflight("48021", deps);
    // Bastrop (rowId "Bastrop") carries a wired railPerParcel in the fixture registry.
    const check = report.rows
      .find((r) => r.rowId === "Bastrop")!
      .checks.find((c) => c.id === "supersededCohortMeasured")!;
    expect(check.outcome).toBe("DECLINE");
    expect(check.defectClass).toBe("MEASURE-EMPTY-COHORT");
    expect(check.reason).toMatch(/empty cohort/);
    expect(check.reason).toMatch(/measurement path broken, not zero superseded/);
  });

  it("PASSes with the reported fraction when totalCount is nonzero", async () => {
    const deps: PreflightDeps = {
      ...ALL_PASS_DEPS,
      probeSupersededCohort: async () => ({ supersededCount: 1, totalCount: 500 }),
    };
    const { report } = await runOnboardPreflight("48021", deps);
    const check = report.rows
      .find((r) => r.rowId === "Bastrop")!
      .checks.find((c) => c.id === "supersededCohortMeasured")!;
    expect(check.outcome).toBe("PASS");
    expect(check.reason).toMatch(/1\/500/);
  });

  it("does NOT decline MEASURE-EMPTY-COHORT for a row with no wired parcel rail at all (Elgin — out of scope for this check, checks 1/3 already carry that decline)", async () => {
    const deps: PreflightDeps = {
      ...ALL_PASS_DEPS,
      probeSupersededCohort: async () => ({ supersededCount: 0, totalCount: 0 }),
    };
    const { report } = await runOnboardPreflight("48021", deps);
    const elginRow = report.rows.find((r) => r.rowId === "Elgin")!;
    const check = elginRow.checks.find((c) => c.id === "supersededCohortMeasured")!;
    expect(check.defectClass).not.toBe("MEASURE-EMPTY-COHORT");
    expect(check.outcome).toBe("PASS");
  });
});

describe("onboard-preflight — cost gate (commitment #3)", () => {
  it("PASSes under $200", async () => {
    const { report } = await runOnboardPreflight("48021", ALL_PASS_DEPS);
    const check = report.rows.find((r) => r.rowId === "Bastrop")!.checks.find((c) => c.id === "costGate")!;
    expect(check.outcome).toBe("PASS");
  });

  it("DECLINEs at or above $200 with COST-GATE", async () => {
    const deps: PreflightDeps = {
      ...ALL_PASS_DEPS,
      probeCostSample: async () => ({ estimatedUsd: 250 }),
    };
    const { report } = await runOnboardPreflight("48021", deps);
    const check = report.rows.find((r) => r.rowId === "Bastrop")!.checks.find((c) => c.id === "costGate")!;
    expect(check.outcome).toBe("DECLINE");
    expect(check.defectClass).toBe("COST-GATE");
  });
});

describe("onboard-preflight — mixed-vintage residue scan", () => {
  it("DECLINEs with MIXED-VINTAGE when residue is present", async () => {
    const deps: PreflightDeps = {
      ...ALL_PASS_DEPS,
      probeMixedVintageResidue: async () => ({ residueCount: 4, measured: true }),
    };
    const { report } = await runOnboardPreflight("48021", deps);
    const check = report.rows
      .find((r) => r.rowId === "Bastrop")!
      .checks.find((c) => c.id === "mixedVintageResidueScan")!;
    expect(check.outcome).toBe("DECLINE");
    expect(check.defectClass).toBe("MIXED-VINTAGE");
  });

  it("DECLINEs with MIXED-VINTAGE when the scan itself could not complete", async () => {
    const deps: PreflightDeps = {
      ...ALL_PASS_DEPS,
      probeMixedVintageResidue: async () => ({ residueCount: 0, measured: false }),
    };
    const { report } = await runOnboardPreflight("48021", deps);
    const check = report.rows
      .find((r) => r.rowId === "Bastrop")!
      .checks.find((c) => c.id === "mixedVintageResidueScan")!;
    expect(check.outcome).toBe("DECLINE");
    expect(check.reason).toMatch(/unmeasured/);
  });
});

describe("onboard-preflight — report shape covers all rows for a fips", () => {
  it("returns all three 48021 rows in one report", async () => {
    const { report } = await runOnboardPreflight("48021", ALL_PASS_DEPS);
    expect(report.fips).toBe("48021");
    expect(report.rows.map((r) => r.rowId).sort()).toEqual(
      [BASTROP_REGISTRY_ROW.rowId, BASTROP_COUNTY_UNINCORPORATED_REGISTRY_ROW.rowId, ELGIN_REGISTRY_ROW.rowId].sort(),
    );
  });

  it("returns an empty rows list for a fips with no registry row (honest-absence)", async () => {
    const { report, ledgerEvents } = await runOnboardPreflight("48129", ALL_PASS_DEPS);
    expect(report.rows).toHaveLength(0);
    expect(ledgerEvents).toHaveLength(0);
  });
});

// SCOPE 3 — cert-with-scope-annotation (operator-ruled 2026-08-03). A cert
// with zero annotations is a full cert; deriveScopeAnnotations is the pure
// function block13-cert-grade.mjs calls to populate its optional
// scopeAnnotations field. These tests assert the present/absent contract
// directly, since the .mjs script itself requires a live DATABASE_URL.
describe("deriveScopeAnnotations — cert scope annotation derivation", () => {
  it("is empty for a fully-passing row (Bastrop, full cert — array absent/empty)", async () => {
    const { report } = await runOnboardPreflight("48021", ALL_PASS_DEPS);
    const bastropRow = report.rows.find((r) => r.rowId === "Bastrop");
    const annotations = deriveScopeAnnotations(bastropRow);
    expect(annotations).toEqual([]);
  });

  it("is empty when the row report is undefined (no pre-flight row requested)", () => {
    expect(deriveScopeAnnotations(undefined)).toEqual([]);
  });

  it("names rail, declineReason, and defectClass for a declined core rail (Elgin — parcel layer + zoning source)", async () => {
    const { report } = await runOnboardPreflight("48021", ALL_PASS_DEPS);
    const elginRow = report.rows.find((r) => r.rowId === "Elgin");
    const annotations = deriveScopeAnnotations(elginRow);
    expect(annotations.length).toBeGreaterThan(0);
    for (const a of annotations) {
      expect(a.rail).toBeTruthy();
      expect(a.declineReason).toBeTruthy();
      expect(a.defectClass).toBeTruthy();
    }
    const rails = annotations.map((a) => a.rail);
    expect(rails).toContain("railASourceReachable");
    expect(rails).toContain("parcelLayerWired");
    expect(rails).toContain("zoningSourceReachableOrUnzoned");
    const parcelAnnotation = annotations.find((a) => a.rail === "parcelLayerWired")!;
    expect(parcelAnnotation.defectClass).toBe("PARCEL-LAYER-UNWIRED");
  });

  it("excludes non-core-rail declines (e.g. costGate, servePathHealth) even when they decline", async () => {
    const deps: PreflightDeps = {
      ...ALL_PASS_DEPS,
      probeCostSample: async () => ({ estimatedUsd: 999 }),
      probeServePathHealth: async () => ({ reachable: false, detail: "401" }),
    };
    const { report } = await runOnboardPreflight("48021", deps);
    const bastropRow = report.rows.find((r) => r.rowId === "Bastrop");
    const annotations = deriveScopeAnnotations(bastropRow);
    expect(annotations.some((a) => a.rail === "costGate")).toBe(false);
    expect(annotations.some((a) => a.rail === "servePathHealth")).toBe(false);
  });

  it("excludes an unzoned row's zoning check even though zoning is only a PASS, never a core-rail decline for that row", async () => {
    const { report } = await runOnboardPreflight("48021", ALL_PASS_DEPS);
    const countyRow = report.rows.find((r) => r.rowId === "Bastrop County (unincorporated)");
    const annotations = deriveScopeAnnotations(countyRow);
    expect(annotations.some((a) => a.rail === "zoningSourceReachableOrUnzoned")).toBe(false);
  });
});
