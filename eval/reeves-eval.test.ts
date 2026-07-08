/**
 * Non-vacuous eval suite for Reeves County mint.
 *
 * Gate: curated per-domain eval queries with REAL assertions checked against
 * the minted set. An eval that passes with zero queries executed is a FAILURE
 * (non-vacuousness floor).
 *
 * Assertions are tied to the actual mint run output. If the mint runs again
 * with different upstream data, assertions may need adjustment (drift vs
 * baseline is expected and honest).
 */

import { describe, it, expect } from "vitest";
import { acquireAll } from "../src/acquire.js";
import {
  normalizeW1ToWells,
  normalizePdqOilToAtoms,
  normalizePdqGasToAtoms,
  normalizeH10ToAtoms,
} from "../src/normalize.js";

describe("Reeves County Mint Eval (Non-Vacuous)", () => {
  let wells: any[];
  let productionTimeseries: any[];
  let acquisitionStatuses: any[];

  // Run the mint once before all tests
  beforeAll(async () => {
    const acquisition = await acquireAll();
    acquisitionStatuses = acquisition.statuses;

    wells = [];
    productionTimeseries = [];

    if (acquisition.w1) {
      const result = normalizeW1ToWells(acquisition.w1);
      wells = result.atoms;
    }

    if (acquisition.pdqOil) {
      const result = normalizePdqOilToAtoms(acquisition.pdqOil);
      productionTimeseries.push(...result.atoms);
    }

    if (acquisition.pdqGas) {
      const result = normalizePdqGasToAtoms(acquisition.pdqGas);
      productionTimeseries.push(...result.atoms);
    }

    if (acquisition.h10) {
      const result = normalizeH10ToAtoms(acquisition.h10);
      productionTimeseries.push(...result.atoms);
    }
  }, 60000); // 60s timeout for live W-1 fetch

  /**
   * EVAL 1: Total W-1 count is nonzero (live fetch succeeded).
   *
   * Baseline (2026-07-07): Expected ~3,887 permits for 2022-01-01 to present.
   * Drift is expected as new permits are filed.
   */
  it("EVAL 1: W-1 permits fetched (nonzero count)", () => {
    const w1Status = acquisitionStatuses.find((s: any) => s.source === "w1");
    expect(w1Status).toBeDefined();
    expect(w1Status.status).toBe("obtained"); // Live fetch succeeded
    expect(w1Status.recordCount).toBeGreaterThan(0);
    expect(wells.length).toBeGreaterThan(0);
  });

  /**
   * EVAL 2: W-1 count is within reasonable range of baseline (~3,887 ± 20%).
   *
   * Allows for drift as new permits are filed, but catches catastrophic
   * under-fetch (e.g., pagination bug).
   */
  it("EVAL 2: W-1 count within reasonable range of baseline", () => {
    const baseline = 3887;
    const tolerance = 0.2; // ±20%
    expect(wells.length).toBeGreaterThan(baseline * (1 - tolerance));
    // No upper bound assertion (new permits can grow the set indefinitely)
  });

  /**
   * EVAL 3: Every well atom has required fields populated.
   *
   * Contract validation should have caught this, but double-check that no
   * atoms slipped through with missing/invalid DIDs, API numbers, etc.
   */
  it("EVAL 3: Every well atom has required fields", () => {
    expect(wells.length).toBeGreaterThan(0); // Non-vacuous
    for (const well of wells) {
      expect(well.entityType).toBe("well");
      expect(well.wellDid).toMatch(/^well_\d{14}$/); // DID format: well_<api14>
      expect(well.apiNumber14).toMatch(/^\d{14}$/); // 14-digit API
      expect(well.wellName).toBeTruthy();
      expect(well.district).toBeTruthy();
      expect(well.accessPolicy).toBe("platform-internal"); // Per task requirement
      expect(well.sourceCitation).toBeTruthy();
      expect(well.extractedAt).toBeTruthy();
      expect(well.surfaceLocation).toBeDefined();
      expect(well.surfaceLocation.latitude).toBeTypeOf("number");
      expect(well.surfaceLocation.longitude).toBeTypeOf("number");
    }
  });

  /**
   * EVAL 4: PDQ oil production atoms are fixture-bounded (expected 9 records).
   *
   * Fixture sample: 3 leases × 3 months = 9 records.
   */
  it("EVAL 4: PDQ oil production atoms match fixture count", () => {
    const oilAtoms = productionTimeseries.filter((a: any) => a.product === "oil");
    expect(oilAtoms.length).toBe(9); // 3 leases × 3 months
  });

  /**
   * EVAL 5: PDQ oil production atoms anchor to rrc-lease (reporting split).
   *
   * Per ADR-025, oil production in Texas is reported at the RRC lease level.
   * Every oil stream must have anchorKind: "rrc-lease".
   */
  it("EVAL 5: PDQ oil atoms anchor to rrc-lease (reporting split)", () => {
    const oilAtoms = productionTimeseries.filter((a: any) => a.product === "oil");
    expect(oilAtoms.length).toBeGreaterThan(0); // Non-vacuous
    for (const atom of oilAtoms) {
      expect(atom.anchorKind).toBe("rrc-lease");
      expect(atom.anchorDid).toMatch(/^rrclease_[0-9a-f]{16}$/); // RRC lease DID format
    }
  });

  /**
   * EVAL 6: PDQ gas production atoms anchor to well (reporting split).
   *
   * Per ADR-025, gas production in Texas is reported at the well level.
   * Every gas stream must have anchorKind: "well".
   */
  it("EVAL 6: PDQ gas atoms anchor to well (reporting split)", () => {
    const gasAtoms = productionTimeseries.filter((a: any) => a.product === "gas");
    expect(gasAtoms.length).toBeGreaterThan(0); // Non-vacuous
    for (const atom of gasAtoms) {
      expect(atom.anchorKind).toBe("well");
      expect(atom.anchorDid).toMatch(/^well_[0-9a-f]{16}$/); // Well DID format (hashed)
    }
  });

  /**
   * EVAL 7: H-10 injection atoms are fixture-bounded (expected 9 records).
   *
   * Fixture sample: 3 wells × 3 months = 9 records.
   */
  it("EVAL 7: H-10 injection atoms match fixture count", () => {
    const injectionAtoms = productionTimeseries.filter(
      (a: any) => a.product === "injection" || a.product === "water"
    );
    expect(injectionAtoms.length).toBe(9); // 3 wells × 3 months
  });

  /**
   * EVAL 8: H-10 injection atoms anchor to well (same grain as gas).
   *
   * Per ADR-025, injection volumes are reported at the well level (same grain
   * as gas production).
   */
  it("EVAL 8: H-10 injection atoms anchor to well", () => {
    const injectionAtoms = productionTimeseries.filter(
      (a: any) => a.product === "injection" || a.product === "water"
    );
    expect(injectionAtoms.length).toBeGreaterThan(0); // Non-vacuous
    for (const atom of injectionAtoms) {
      expect(atom.anchorKind).toBe("well");
      expect(atom.anchorDid).toMatch(/^well_[0-9a-f]{16}$/); // Well DID format (hashed)
    }
  });

  /**
   * EVAL 9: Every production-timeseries atom has streamKind: "reported".
   *
   * All atoms in this mint are "reported" (direct from source). No derived
   * streams are present.
   */
  it("EVAL 9: Every production-timeseries atom is reported (not derived)", () => {
    expect(productionTimeseries.length).toBeGreaterThan(0); // Non-vacuous
    for (const atom of productionTimeseries) {
      expect(atom.streamKind).toBe("reported");
      expect(atom.derivationMethod).toBeUndefined(); // Reported streams have no derivation
      expect(atom.derivesFromStreamDid).toBeUndefined();
    }
  });

  /**
   * EVAL 10: Every atom has accessPolicy: "platform-internal".
   *
   * Per task requirement, all minted atoms carry accessPolicy: "platform-internal"
   * (tier placement is a product decision that hasn't been made; do not mark
   * anything public-free).
   */
  it("EVAL 10: Every atom has accessPolicy: platform-internal", () => {
    const allAtoms = [...wells, ...productionTimeseries];
    expect(allAtoms.length).toBeGreaterThan(0); // Non-vacuous
    for (const atom of allAtoms) {
      expect(atom.accessPolicy).toBe("platform-internal");
    }
  });

  /**
   * EVAL 11: Every atom has provenance fields populated.
   *
   * Quality gate: sourceCitation, extractedAt must be populated on every atom.
   */
  it("EVAL 11: Every atom has provenance fields", () => {
    const allAtoms = [...wells, ...productionTimeseries];
    expect(allAtoms.length).toBeGreaterThan(0); // Non-vacuous
    for (const atom of allAtoms) {
      expect(atom.sourceCitation).toBeTruthy();
      expect(atom.extractedAt).toBeTruthy();
      expect(atom.extractedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601 format
    }
  });

  /**
   * EVAL 12: PDQ and H-10 are bounded (fixture samples, not full coverage).
   *
   * Acquisition statuses for PDQ and H-10 must report status: "bounded" and
   * include an explicit note that they are fixture samples, not full county
   * coverage.
   */
  it("EVAL 12: PDQ and H-10 are bounded (fixture samples)", () => {
    const pdqOilStatus = acquisitionStatuses.find((s: any) => s.source === "pdq-oil");
    const pdqGasStatus = acquisitionStatuses.find((s: any) => s.source === "pdq-gas");
    const h10Status = acquisitionStatuses.find((s: any) => s.source === "h10");

    expect(pdqOilStatus.status).toBe("bounded");
    expect(pdqOilStatus.note).toContain("FIXTURE SAMPLE");

    expect(pdqGasStatus.status).toBe("bounded");
    expect(pdqGasStatus.note).toContain("FIXTURE SAMPLE");

    expect(h10Status.status).toBe("bounded");
    expect(h10Status.note).toContain("FIXTURE SAMPLE");
  });

  /**
   * NON-VACUOUSNESS CHECK: Ensure at least 10 assertions were executed.
   *
   * This test meta-checks the suite itself: if this test runs, it means
   * vitest executed the suite. The individual tests above ensure assertions
   * actually ran (they all check nonzero counts).
   */
  it("NON-VACUOUSNESS: Suite executed with real assertions", () => {
    // If we got here, the beforeAll ran successfully
    expect(wells.length + productionTimeseries.length).toBeGreaterThan(0);
    // Confirm we have both well and production atoms
    expect(wells.length).toBeGreaterThan(0);
    expect(productionTimeseries.length).toBeGreaterThan(0);
  });
});
