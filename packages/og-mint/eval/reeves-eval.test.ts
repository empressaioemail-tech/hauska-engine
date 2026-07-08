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

import { describe, it, expect, beforeAll } from "vitest";
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
  let acquisitionStatuses: readonly any[];

  // Run the mint once before all tests
  beforeAll(async () => {
    const acquisition = await acquireAll();
    acquisitionStatuses = acquisition.statuses;

    wells = [];
    productionTimeseries = [];

    if (acquisition.w1) {
      const result = normalizeW1ToWells(acquisition.w1);
      wells = result.atoms as any[];
    }

    if (acquisition.pdqOil) {
      const result = normalizePdqOilToAtoms(acquisition.pdqOil);
      productionTimeseries.push(...(result.atoms as any[]));
    }

    if (acquisition.pdqGas) {
      const result = normalizePdqGasToAtoms(acquisition.pdqGas);
      productionTimeseries.push(...(result.atoms as any[]));
    }

    if (acquisition.h10) {
      const result = normalizeH10ToAtoms(acquisition.h10);
      productionTimeseries.push(...(result.atoms as any[]));
    }
  }, 180000); // 180s timeout for live W-1 fetch (4000+ permits with pagination)

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
    expect(w1Status.recordCount).toBeGreaterThanOrEqual(3000); // Hard floor per task
    expect(wells.length).toBeGreaterThanOrEqual(3000); // Validate >= 3000 wells
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
      expect(well.wellNumber).toBeTruthy(); // Must be non-empty after fix
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
   * EVAL 4: PDQ oil production atoms match fixture count (9 records).
   */
  it("EVAL 4: PDQ oil production atoms match fixture count", () => {
    const oilAtoms = productionTimeseries.filter((a: any) => a.product === "oil");
    expect(oilAtoms.length).toBe(9); // 3 leases × 3 months
  });

  /**
   * EVAL 5: PDQ oil production atoms anchor to rrc-lease (reporting split).
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
   * EVAL 6: PDQ gas production atoms match fixture count (9 records).
   */
  it("EVAL 6: PDQ gas production atoms match fixture count", () => {
    const gasAtoms = productionTimeseries.filter((a: any) => a.product === "gas");
    expect(gasAtoms.length).toBe(9); // 3 wells × 3 months
  });

  /**
   * EVAL 7: PDQ gas production atoms anchor to well (reporting split).
   */
  it("EVAL 7: PDQ gas atoms anchor to well (reporting split)", () => {
    const gasAtoms = productionTimeseries.filter((a: any) => a.product === "gas");
    expect(gasAtoms.length).toBeGreaterThan(0); // Non-vacuous
    for (const atom of gasAtoms) {
      expect(atom.anchorKind).toBe("well");
      expect(atom.anchorDid).toMatch(/^well_[0-9a-f]{16}$/); // Well DID format (hashed)
    }
  });

  /**
   * EVAL 8: H-10 injection atoms match fixture count (9 records).
   */
  it("EVAL 8: H-10 injection atoms match fixture count", () => {
    const injectionAtoms = productionTimeseries.filter(
      (a: any) => a.product === "injection" || a.product === "water"
    );
    expect(injectionAtoms.length).toBe(9); // 3 wells × 3 months
  });

  /**
   * EVAL 9: H-10 injection atoms anchor to well (same grain as gas).
   */
  it("EVAL 9: H-10 injection atoms anchor to well", () => {
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
   * EVAL 10: Every production-timeseries atom has streamKind: "reported".
   */
  it("EVAL 10: Every production-timeseries atom is reported (not derived)", () => {
    expect(productionTimeseries.length).toBeGreaterThan(0); // Non-vacuous
    for (const atom of productionTimeseries) {
      expect(atom.streamKind).toBe("reported");
      expect(atom.derivationMethod).toBeUndefined(); // Reported streams have no derivation
      expect(atom.derivesFromStreamDid).toBeUndefined();
    }
  });

  /**
   * EVAL 11: Every atom has accessPolicy: "platform-internal".
   */
  it("EVAL 11: Every atom has accessPolicy: platform-internal", () => {
    const allAtoms = [...wells, ...productionTimeseries];
    expect(allAtoms.length).toBeGreaterThan(0); // Non-vacuous
    for (const atom of allAtoms) {
      expect(atom.accessPolicy).toBe("platform-internal");
    }
  });

  /**
   * EVAL 12: Every atom has provenance fields populated.
   */
  it("EVAL 12: Every atom has provenance fields", () => {
    const allAtoms = [...wells, ...productionTimeseries];
    expect(allAtoms.length).toBeGreaterThan(0); // Non-vacuous
    for (const atom of allAtoms) {
      expect(atom.sourceCitation).toBeTruthy();
      expect(atom.extractedAt).toBeTruthy();
      expect(atom.extractedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601 format
    }
  });

  /**
   * EVAL 13: PDQ and H-10 are bounded (fixture samples, not full coverage).
   */
  it("EVAL 13: PDQ and H-10 are bounded (fixture samples)", () => {
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
   * EVAL 14: Total atom count is substantial (well atoms + production atoms).
   */
  it("EVAL 14: Total atom count is substantial", () => {
    const total = wells.length + productionTimeseries.length;
    expect(total).toBeGreaterThan(3000); // At least 3000 wells + 27 production atoms
    expect(wells.length).toBeGreaterThanOrEqual(3000);
    expect(productionTimeseries.length).toBeGreaterThan(0);
  });

  /**
   * NON-VACUOUSNESS CHECK: Ensure assertions were executed with real data.
   */
  it("NON-VACUOUSNESS: Suite executed with real assertions", () => {
    // If we got here, the beforeAll ran successfully
    expect(wells.length + productionTimeseries.length).toBeGreaterThan(3000);
    // Confirm we have substantial well atoms and production atoms
    expect(wells.length).toBeGreaterThanOrEqual(3000);
    expect(productionTimeseries.length).toBeGreaterThan(0);
  });
});
