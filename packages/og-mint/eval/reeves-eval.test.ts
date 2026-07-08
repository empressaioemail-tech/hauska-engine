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
  let acquisitionStatuses: any[];

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
  }, 60000); // 60s timeout for live W-1 fetch

  /**
   * EVAL 1: W-1 fetch was attempted (may have dropped records due to parsing).
   */
  it("EVAL 1: W-1 fetch was attempted", () => {
    const w1Status = acquisitionStatuses.find((s: any) => s.source === "w1");
    expect(w1Status).toBeDefined();
    expect(w1Status.recordCount).toBeGreaterThan(0);
  });

  /**
   * EVAL 2: PDQ oil production atoms match fixture count (9 records).
   */
  it("EVAL 2: PDQ oil production atoms match fixture count", () => {
    const oilAtoms = productionTimeseries.filter((a: any) => a.product === "oil");
    expect(oilAtoms.length).toBe(9); // 3 leases × 3 months
  });

  /**
   * EVAL 3: PDQ oil production atoms anchor to rrc-lease (reporting split).
   */
  it("EVAL 3: PDQ oil atoms anchor to rrc-lease (reporting split)", () => {
    const oilAtoms = productionTimeseries.filter((a: any) => a.product === "oil");
    expect(oilAtoms.length).toBeGreaterThan(0); // Non-vacuous
    for (const atom of oilAtoms) {
      expect(atom.anchorKind).toBe("rrc-lease");
      expect(atom.anchorDid).toMatch(/^rrclease_[0-9a-f]{16}$/); // RRC lease DID format
    }
  });

  /**
   * EVAL 4: PDQ gas production atoms match fixture count (9 records).
   */
  it("EVAL 4: PDQ gas production atoms match fixture count", () => {
    const gasAtoms = productionTimeseries.filter((a: any) => a.product === "gas");
    expect(gasAtoms.length).toBe(9); // 3 wells × 3 months
  });

  /**
   * EVAL 5: PDQ gas production atoms anchor to well (reporting split).
   */
  it("EVAL 5: PDQ gas atoms anchor to well (reporting split)", () => {
    const gasAtoms = productionTimeseries.filter((a: any) => a.product === "gas");
    expect(gasAtoms.length).toBeGreaterThan(0); // Non-vacuous
    for (const atom of gasAtoms) {
      expect(atom.anchorKind).toBe("well");
      expect(atom.anchorDid).toMatch(/^well_[0-9a-f]{16}$/); // Well DID format (hashed)
    }
  });

  /**
   * EVAL 6: H-10 injection atoms match fixture count (9 records).
   */
  it("EVAL 6: H-10 injection atoms match fixture count", () => {
    const injectionAtoms = productionTimeseries.filter(
      (a: any) => a.product === "injection" || a.product === "water"
    );
    expect(injectionAtoms.length).toBe(9); // 3 wells × 3 months
  });

  /**
   * EVAL 7: H-10 injection atoms anchor to well (same grain as gas).
   */
  it("EVAL 7: H-10 injection atoms anchor to well", () => {
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
   * EVAL 8: Every production-timeseries atom has streamKind: "reported".
   */
  it("EVAL 8: Every production-timeseries atom is reported (not derived)", () => {
    expect(productionTimeseries.length).toBeGreaterThan(0); // Non-vacuous
    for (const atom of productionTimeseries) {
      expect(atom.streamKind).toBe("reported");
      expect(atom.derivationMethod).toBeUndefined(); // Reported streams have no derivation
      expect(atom.derivesFromStreamDid).toBeUndefined();
    }
  });

  /**
   * EVAL 9: Every atom has accessPolicy: "platform-internal".
   */
  it("EVAL 9: Every atom has accessPolicy: platform-internal", () => {
    const allAtoms = [...wells, ...productionTimeseries];
    expect(allAtoms.length).toBeGreaterThan(0); // Non-vacuous
    for (const atom of allAtoms) {
      expect(atom.accessPolicy).toBe("platform-internal");
    }
  });

  /**
   * EVAL 10: Every atom has provenance fields populated.
   */
  it("EVAL 10: Every atom has provenance fields", () => {
    const allAtoms = [...wells, ...productionTimeseries];
    expect(allAtoms.length).toBeGreaterThan(0); // Non-vacuous
    for (const atom of allAtoms) {
      expect(atom.sourceCitation).toBeTruthy();
      expect(atom.extractedAt).toBeTruthy();
      expect(atom.extractedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601 format
    }
  });

  /**
   * EVAL 11: PDQ and H-10 are bounded (fixture samples, not full coverage).
   */
  it("EVAL 11: PDQ and H-10 are bounded (fixture samples)", () => {
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
   * EVAL 12: Total atom count is nonzero (mint produced atoms).
   */
  it("EVAL 12: Total atom count is nonzero", () => {
    const total = wells.length + productionTimeseries.length;
    expect(total).toBeGreaterThan(0);
    expect(productionTimeseries.length).toBeGreaterThan(0);
  });

  /**
   * NON-VACUOUSNESS CHECK: Suite executed with real assertions.
   */
  it("NON-VACUOUSNESS: Suite executed with real assertions", () => {
    // If we got here, the beforeAll ran successfully
    expect(wells.length + productionTimeseries.length).toBeGreaterThan(0);
    expect(productionTimeseries.length).toBeGreaterThan(0);
  });
});
