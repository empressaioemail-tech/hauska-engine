/**
 * Tests for RRC H-10 normalization logic.
 *
 * Validates:
 * - Injection/disposal volumes anchor to well (grain discriminator)
 * - DIDs are stable and well-formed
 * - Product type mapping (SWD → water, EOR → injection)
 * - All required provenance fields are present
 */

import { describe, it, expect } from "vitest";
import { normalizeH10Injection } from "../normalize.js";
import { reevesInjectionSample } from "../__fixtures__/reeves-injection-sample.js";

describe("RRC H-10 normalization", () => {
  const fetchedAt = "2024-03-15T10:00:00Z";

  describe("normalizeH10Injection", () => {
    it("should normalize injection records with well anchor", () => {
      const atoms = normalizeH10Injection(reevesInjectionSample, fetchedAt);

      expect(atoms).toHaveLength(reevesInjectionSample.length);

      for (const atom of atoms) {
        // Grain discriminator: injection → well (same as gas)
        expect(atom.anchorKind).toBe("well");
        expect(atom.anchorDid).toMatch(/^well_[0-9a-f]{16}$/);

        // Product type (injection or water for SWD)
        expect(["injection", "water"]).toContain(atom.product);
        expect(atom.streamKind).toBe("reported");
        expect(atom.granularity).toBe("monthly");

        // Provenance fields
        expect(atom.sourceAdapter).toBe("rrc-h10");
        expect(atom.sourceCitation).toContain("RRC H-10");
        expect(atom.extractedAt).toBe(fetchedAt);
        expect(atom.accessPolicy).toBe("public-free");

        // DID format
        expect(atom.streamDid).toMatch(/^prodts_[0-9a-f]{16}$/);
        expect(atom.entityType).toBe("production-timeseries");
      }
    });

    it("should map SWD to water product type", () => {
      const atoms = normalizeH10Injection(reevesInjectionSample, fetchedAt);

      // Find SWD records
      const swdAtoms = atoms.filter((a, i) =>
        reevesInjectionSample[i]?.injectionType.includes("SWD")
      );

      expect(swdAtoms.length).toBeGreaterThan(0);
      expect(swdAtoms.every((a) => a.product === "water")).toBe(true);
    });

    it("should map EOR to injection product type", () => {
      const atoms = normalizeH10Injection(reevesInjectionSample, fetchedAt);

      // Find EOR records
      const eorAtoms = atoms.filter((a, i) =>
        reevesInjectionSample[i]?.injectionType.includes("EOR")
      );

      expect(eorAtoms.length).toBeGreaterThan(0);
      expect(eorAtoms.every((a) => a.product === "injection")).toBe(true);
    });

    it("should create stable DIDs for the same well", () => {
      const atoms = normalizeH10Injection(reevesInjectionSample, fetchedAt);

      // Find all records for the same well
      const well1Records = reevesInjectionSample.filter((r) => r.apiNumber === "4238945678");
      const well1Atoms = atoms.filter((a, i) => reevesInjectionSample[i]?.apiNumber === "4238945678");

      // All atoms for the same well should have the same anchorDid
      const anchorDids = [...new Set(well1Atoms.map((a) => a.anchorDid))];
      expect(anchorDids).toHaveLength(1);
    });

    it("should create distinct DIDs for different wells", () => {
      const atoms = normalizeH10Injection(reevesInjectionSample, fetchedAt);
      const anchorDids = [...new Set(atoms.map((a) => a.anchorDid))];

      // Should have 3 distinct anchor DIDs (3 wells in fixture)
      expect(anchorDids).toHaveLength(3);
    });
  });
});
