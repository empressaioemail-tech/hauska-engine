/**
 * Tests for RRC PDQ normalization logic.
 *
 * Validates:
 * - Oil production anchors to rrc-lease (grain discriminator)
 * - Gas production anchors to well (grain discriminator)
 * - DIDs are stable and well-formed
 * - All required provenance fields are present
 */

import { describe, it, expect } from "vitest";
import { normalizeOilProduction, normalizeGasProduction } from "../normalize.js";
import { reevesOilSample } from "../__fixtures__/reeves-oil-sample.js";
import { reevesGasSample } from "../__fixtures__/reeves-gas-sample.js";

describe("RRC PDQ normalization", () => {
  const fetchedAt = "2024-03-15T10:00:00Z";

  describe("normalizeOilProduction", () => {
    it("should normalize oil records with rrc-lease anchor", () => {
      const atoms = normalizeOilProduction(reevesOilSample, fetchedAt);

      expect(atoms).toHaveLength(reevesOilSample.length);

      for (const atom of atoms) {
        // Grain discriminator: oil → rrc-lease
        expect(atom.anchorKind).toBe("rrc-lease");
        expect(atom.anchorDid).toMatch(/^rrclease_[0-9a-f]{16}$/);

        // Product and stream metadata
        expect(atom.product).toBe("oil");
        expect(atom.streamKind).toBe("reported");
        expect(atom.granularity).toBe("monthly");

        // Provenance fields
        expect(atom.sourceAdapter).toBe("rrc-pdq");
        expect(atom.sourceCitation).toContain("RRC PDQ");
        expect(atom.extractedAt).toBe(fetchedAt);
        expect(atom.accessPolicy).toBe("public-free");

        // DID format
        expect(atom.streamDid).toMatch(/^prodts_[0-9a-f]{16}$/);
        expect(atom.entityType).toBe("production-timeseries");
      }
    });

    it("should create stable DIDs for the same lease", () => {
      const atoms = normalizeOilProduction(reevesOilSample, fetchedAt);

      // Find all records for the same lease
      const lease1Records = reevesOilSample.filter((r) => r.leaseNumber === "12345");
      const lease1Atoms = atoms.filter((a, i) => reevesOilSample[i]?.leaseNumber === "12345");

      // All atoms for the same lease should have the same anchorDid
      const anchorDids = [...new Set(lease1Atoms.map((a) => a.anchorDid))];
      expect(anchorDids).toHaveLength(1);
    });

    it("should create distinct DIDs for different leases", () => {
      const atoms = normalizeOilProduction(reevesOilSample, fetchedAt);
      const anchorDids = [...new Set(atoms.map((a) => a.anchorDid))];

      // Should have 3 distinct anchor DIDs (3 leases in fixture)
      expect(anchorDids).toHaveLength(3);
    });
  });

  describe("normalizeGasProduction", () => {
    it("should normalize gas records with well anchor", () => {
      const atoms = normalizeGasProduction(reevesGasSample, fetchedAt);

      expect(atoms).toHaveLength(reevesGasSample.length);

      for (const atom of atoms) {
        // Grain discriminator: gas → well
        expect(atom.anchorKind).toBe("well");
        expect(atom.anchorDid).toMatch(/^well_[0-9a-f]{16}$/);

        // Product and stream metadata
        expect(atom.product).toBe("gas");
        expect(atom.streamKind).toBe("reported");
        expect(atom.granularity).toBe("monthly");

        // Provenance fields
        expect(atom.sourceAdapter).toBe("rrc-pdq");
        expect(atom.sourceCitation).toContain("RRC PDQ");
        expect(atom.extractedAt).toBe(fetchedAt);
        expect(atom.accessPolicy).toBe("public-free");

        // DID format
        expect(atom.streamDid).toMatch(/^prodts_[0-9a-f]{16}$/);
        expect(atom.entityType).toBe("production-timeseries");
      }
    });

    it("should create stable DIDs for the same well", () => {
      const atoms = normalizeGasProduction(reevesGasSample, fetchedAt);

      // Find all records for the same well
      const well1Records = reevesGasSample.filter((r) => r.apiNumber === "4238912345");
      const well1Atoms = atoms.filter((a, i) => reevesGasSample[i]?.apiNumber === "4238912345");

      // All atoms for the same well should have the same anchorDid
      const anchorDids = [...new Set(well1Atoms.map((a) => a.anchorDid))];
      expect(anchorDids).toHaveLength(1);
    });

    it("should create distinct DIDs for different wells", () => {
      const atoms = normalizeGasProduction(reevesGasSample, fetchedAt);
      const anchorDids = [...new Set(atoms.map((a) => a.anchorDid))];

      // Should have 3 distinct anchor DIDs (3 wells in fixture)
      expect(anchorDids).toHaveLength(3);
    });
  });

  describe("grain discriminator validation", () => {
    it("should never confuse oil and gas anchors", () => {
      const oilAtoms = normalizeOilProduction(reevesOilSample, fetchedAt);
      const gasAtoms = normalizeGasProduction(reevesGasSample, fetchedAt);

      // Oil atoms must all have rrc-lease anchor
      expect(oilAtoms.every((a) => a.anchorKind === "rrc-lease")).toBe(true);
      expect(oilAtoms.every((a) => a.anchorDid.startsWith("rrclease_"))).toBe(true);

      // Gas atoms must all have well anchor
      expect(gasAtoms.every((a) => a.anchorKind === "well")).toBe(true);
      expect(gasAtoms.every((a) => a.anchorDid.startsWith("well_"))).toBe(true);

      // No overlap in anchor DIDs
      const oilAnchorDids = new Set(oilAtoms.map((a) => a.anchorDid));
      const gasAnchorDids = new Set(gasAtoms.map((a) => a.anchorDid));
      const intersection = [...oilAnchorDids].filter((d) => gasAnchorDids.has(d));
      expect(intersection).toHaveLength(0);
    });
  });
});
