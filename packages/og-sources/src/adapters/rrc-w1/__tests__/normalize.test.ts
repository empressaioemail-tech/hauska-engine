/**
 * Tests: W-1 normalization → well atoms.
 *
 * Verifies that:
 * 1. Raw W-1 permits normalize into valid WellAtomInstance shapes
 * 2. DIDs are derived correctly (well_<api14> format)
 * 3. DIDs pass the contract's WELL_SCHEMA validation
 * 4. Invalid permits are skipped without crashing
 * 5. The residual (pooled+standalone) is never emitted as a resolved value
 */

import { describe, it, expect } from "vitest";
import { WELL_SCHEMA } from "@empressaio/atom-contract/og";
import { normalizeW1Permits } from "../normalize.js";
import {
  REEVES_SAMPLE_FETCH_RESULT,
  REEVES_SAMPLE_PERMITS,
} from "../__fixtures__/reeves-sample.js";
import type { RawW1Permit } from "../types.js";

describe("normalizeW1Permits", () => {
  it("should normalize all valid permits from fixture", () => {
    const wells = normalizeW1Permits(REEVES_SAMPLE_FETCH_RESULT);

    expect(wells.length).toBe(7); // All 7 permits should normalize
    expect(wells.every((w) => w.entityType === "well")).toBe(true);
  });

  it("should derive well DIDs in format well_<api14>", () => {
    const wells = normalizeW1Permits(REEVES_SAMPLE_FETCH_RESULT);

    // Check first permit (API: 42-389-12345-00-00 → 42389123450000)
    const well1 = wells.find((w) => w.apiNumber14 === "42389123450000");
    expect(well1).toBeDefined();
    expect(well1?.wellDid).toBe("well_42389123450000");

    // Check all DIDs match pattern
    wells.forEach((well) => {
      expect(well.wellDid).toMatch(/^well_\d{14}$/);
      expect(well.wellDid).toBe(`well_${well.apiNumber14}`);
    });
  });

  it("should pass WELL_SCHEMA validation for all normalized wells", () => {
    const wells = normalizeW1Permits(REEVES_SAMPLE_FETCH_RESULT);

    wells.forEach((well) => {
      // This will throw if validation fails
      const validated = WELL_SCHEMA.parse(well);
      expect(validated.wellDid).toBe(well.wellDid);
    });
  });

  it("should populate required provenance fields", () => {
    const wells = normalizeW1Permits(REEVES_SAMPLE_FETCH_RESULT);

    wells.forEach((well) => {
      expect(well.sourceCitation).toBeTruthy();
      expect(well.sourceCitation).toContain("RRC W-1 Drilling Permit");
      expect(well.extractedAt).toBe(
        REEVES_SAMPLE_FETCH_RESULT.fetchedAt,
      );
      expect(well.accessPolicy).toBe("public-free");
    });
  });

  it("should map well types correctly", () => {
    const wells = normalizeW1Permits(REEVES_SAMPLE_FETCH_RESULT);

    const oilWells = wells.filter((w) => w.wellType === "oil");
    const gasWells = wells.filter((w) => w.wellType === "gas");

    expect(oilWells.length).toBe(6); // 6 oil wells in fixture
    expect(gasWells.length).toBe(1); // 1 gas well in fixture
  });

  it("should skip permits with invalid API numbers", () => {
    const invalidPermit: RawW1Permit = {
      ...REEVES_SAMPLE_PERMITS[0]!,
      apiNumber: "INVALID", // Not 14 digits
    };

    const fetchResult = {
      ...REEVES_SAMPLE_FETCH_RESULT,
      permits: [invalidPermit],
    };

    const wells = normalizeW1Permits(fetchResult);
    expect(wells.length).toBe(0); // Invalid permit should be skipped
  });

  it("should handle permits with missing optional fields", () => {
    const minimalPermit: RawW1Permit = {
      permitNumber: "999999",
      apiNumber: "42-389-99999-00-00",
      wellName: "MINIMAL WELL #1",
      operatorName: "TEST OPERATOR",
      leaseName: "TEST LEASE",
      county: "REEVES",
      district: "08",
      wellType: "OIL",
      // All optional fields omitted
    };

    const fetchResult = {
      ...REEVES_SAMPLE_FETCH_RESULT,
      permits: [minimalPermit],
    };

    const wells = normalizeW1Permits(fetchResult);
    expect(wells.length).toBe(1);
    expect(wells[0]!.wellDid).toBe("well_42389999990000");
    expect(wells[0]!.fieldRef).toBeUndefined();
    expect(wells[0]!.spudDate).toBeUndefined();
  });

  it("should never emit pooled-vs-standalone as a resolved count (negative test)", () => {
    // The W-1 adapter does NOT have a "pooled" or "standalone" field; these
    // are derived attributes computed from county ingest data (per the task
    // spec). This negative test verifies that no such field is added.
    const wells = normalizeW1Permits(REEVES_SAMPLE_FETCH_RESULT);

    wells.forEach((well) => {
      const wellRecord = well as Record<string, unknown>;
      expect(wellRecord["pooled"]).toBeUndefined();
      expect(wellRecord["standalone"]).toBeUndefined();
      expect(wellRecord["pooledStandaloneStatus"]).toBeUndefined();
    });
  });

  it("should categorize completion types correctly (allocation, PSA, blank)", () => {
    const permits = REEVES_SAMPLE_PERMITS;

    const allocations = permits.filter(
      (p) => p.completionType === "ALLOCATION",
    );
    const psas = permits.filter((p) => p.completionType === "PSA");
    const blanks = permits.filter(
      (p) => !p.completionType || p.completionType === "",
    );

    expect(allocations.length).toBe(3);
    expect(psas.length).toBe(2);
    expect(blanks.length).toBe(2);

    // Verify these counts are used in the ratio report (the report generator
    // will use the same fixture to validate its output)
  });
});

describe("DID validation via WELL_SCHEMA", () => {
  it("should reject invalid DID formats", () => {
    const invalidWell = {
      entityType: "well" as const,
      wellDid: "banana", // Invalid format
      apiNumber14: "42389123450000",
      wellName: "TEST WELL",
      wellNumber: "1",
      wellType: "oil" as const,
      status: "permitted",
      surfaceLocation: {
        latitude: 31.5,
        longitude: -103.5,
        datum: "NAD27",
      },
      district: "08",
      sourceCitation: "test",
      extractedAt: "2026-07-07T00:00:00.000Z",
      accessPolicy: "public-free" as const,
    };

    expect(() => WELL_SCHEMA.parse(invalidWell)).toThrow();
  });

  it("should accept valid DID format well_<api14>", () => {
    const validWell = {
      entityType: "well" as const,
      wellDid: "well_42389123450000",
      apiNumber14: "42389123450000",
      wellName: "TEST WELL",
      wellNumber: "1",
      wellType: "oil" as const,
      status: "permitted",
      surfaceLocation: {
        latitude: 31.5,
        longitude: -103.5,
        datum: "NAD27",
      },
      district: "08",
      sourceCitation: "test",
      extractedAt: "2026-07-07T00:00:00.000Z",
      accessPolicy: "public-free" as const,
    };

    const validated = WELL_SCHEMA.parse(validWell);
    expect(validated.wellDid).toBe("well_42389123450000");
  });
});
