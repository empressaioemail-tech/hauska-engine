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

describe("onboard-preflight — Elgin now carries a wired railPerParcel row (2026-08-03 onboarding)", () => {
  it("Elgin (railPerParcel wired, ZONING_SOURCE_TODO removed) PASSes checks 1, 2, 3 with fully-configured probes", async () => {
    const { report, ledgerEvents } = await runOnboardPreflight("48021", ALL_PASS_DEPS);
    const elginRow = report.rows.find((r) => r.rowId === "Elgin")!;
    const byId = Object.fromEntries(elginRow.checks.map((c) => [c.id, c]));

    expect(byId.railASourceReachable.outcome).toBe("PASS");
    expect(byId.zoningSourceReachableOrUnzoned.outcome).toBe("PASS");
    expect(byId.parcelLayerWired.outcome).toBe("PASS");

    const elginEvents = ledgerEvents.filter((e) => e.rowId === "Elgin");
    expect(elginEvents.some((e) => e.defectClass === "ADAPTER-NEEDED")).toBe(false);
    expect(elginEvents.some((e) => e.defectClass === "PARCEL-LAYER-UNWIRED")).toBe(false);
  });

  it("Elgin with no probes configured (CI default) declines checks 1 and 2 as not-runnable, but check 3 (mechanical) still PASSes", async () => {
    const { report } = await runOnboardPreflight("48021", { now: FIXED_NOW });
    const elginRow = report.rows.find((r) => r.rowId === "Elgin")!;
    const byId = Object.fromEntries(elginRow.checks.map((c) => [c.id, c]));

    expect(byId.railASourceReachable.outcome).toBe("DECLINE");
    expect(byId.railASourceReachable.reason).toMatch(/^not runnable:/);
    expect(byId.zoningSourceReachableOrUnzoned.outcome).toBe("DECLINE");
    expect(byId.zoningSourceReachableOrUnzoned.reason).toMatch(/^not runnable:/);
    // check 3 is mechanical (no probe needed) — PASSes now that railPerParcel is wired.
    expect(byId.parcelLayerWired.outcome).toBe("PASS");
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

  // Addendum (2026-08-05): totalCount=0 on a pre-cascade county means the
  // superseded measure is not yet applicable — PASS with named pre-warm state,
  // not MEASURE-EMPTY-COHORT. MEASURE-EMPTY-COHORT is reserved for
  // measurementBroken cross-check hits.
  it("PASSes with pre-warm wording when totalCount is 0 (no envelope atoms yet)", async () => {
    const deps: PreflightDeps = {
      ...ALL_PASS_DEPS,
      probeSupersededCohort: async () => ({
        supersededCount: 0,
        totalCount: 0,
        preWarmNotApplicable: true,
      }),
    };
    const { report } = await runOnboardPreflight("48021", deps);
    const check = report.rows
      .find((r) => r.rowId === "Bastrop")!
      .checks.find((c) => c.id === "supersededCohortMeasured")!;
    expect(check.outcome).toBe("PASS");
    expect(check.reason).toMatch(/pre-warm county/);
    expect(check.reason).toMatch(/not yet applicable/);
  });

  it("DECLINEs with MEASURE-EMPTY-COHORT when measurementBroken is set", async () => {
    const deps: PreflightDeps = {
      ...ALL_PASS_DEPS,
      probeSupersededCohort: async () => ({
        supersededCount: 0,
        totalCount: 0,
        measurementBroken: true,
      }),
    };
    const { report } = await runOnboardPreflight("48021", deps);
    const check = report.rows
      .find((r) => r.rowId === "Bastrop")!
      .checks.find((c) => c.id === "supersededCohortMeasured")!;
    expect(check.outcome).toBe("DECLINE");
    expect(check.defectClass).toBe("MEASURE-EMPTY-COHORT");
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

  it("PASSes with pre-warm wording for Elgin when totalCount is 0 (pre-cascade envelope state)", async () => {
    const deps: PreflightDeps = {
      ...ALL_PASS_DEPS,
      probeSupersededCohort: async () => ({
        supersededCount: 0,
        totalCount: 0,
        preWarmNotApplicable: true,
      }),
    };
    const { report } = await runOnboardPreflight("48021", deps);
    const elginRow = report.rows.find((r) => r.rowId === "Elgin")!;
    const check = elginRow.checks.find((c) => c.id === "supersededCohortMeasured")!;
    expect(check.outcome).toBe("PASS");
    expect(check.reason).toMatch(/pre-warm county/);
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

  it("is empty for Elgin under fully-configured probes now that railPerParcel is wired (checks 1/2/3 all PASS)", async () => {
    const { report } = await runOnboardPreflight("48021", ALL_PASS_DEPS);
    const elginRow = report.rows.find((r) => r.rowId === "Elgin");
    const annotations = deriveScopeAnnotations(elginRow);
    expect(annotations).toEqual([]);
  });

  it("names rail, declineReason, and defectClass for Elgin's core-rail declines when no probes are configured (CI default)", async () => {
    const { report } = await runOnboardPreflight("48021", { now: FIXED_NOW });
    const elginRow = report.rows.find((r) => r.rowId === "Elgin");
    const annotations = deriveScopeAnnotations(elginRow);
    expect(annotations.length).toBeGreaterThan(0);
    for (const a of annotations) {
      expect(a.rail).toBeTruthy();
      expect(a.declineReason).toBeTruthy();
      expect(a.defectClass).toBeTruthy();
    }
    const rails = annotations.map((a) => a.rail);
    // Without configured probes, checks 1 and 2 decline "not runnable"
    // (ADAPTER-NEEDED); check 3 is mechanical and PASSes (no annotation).
    expect(rails).toContain("railASourceReachable");
    expect(rails).toContain("zoningSourceReachableOrUnzoned");
    expect(rails).not.toContain("parcelLayerWired");
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
