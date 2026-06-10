/**
 * Pilot-jurisdictions list (Task #188).
 *
 * The Site Context tab's empty-pilot banner reads
 * {@link PILOT_JURISDICTIONS} verbatim. The contract this test pins is:
 *
 *   - the visible list cannot drift from the server's `appliesTo` gate
 *     (the registry is the single source of truth);
 *   - every `localKey` present in `ALL_ADAPTERS.jurisdictionGate.local`
 *     has a friendly label here, so a half-wired adapter cannot ship
 *     without surfacing the gap;
 *   - the rendered short labels stay aligned with the city/county
 *     names architects know from the brief (Bastrop TX, Moab UT,
 *     Salmon ID).
 */

import { describe, expect, it } from "vitest";
import {
  FEDERAL_PILOT_LAYER_KINDS,
  PILOT_JURISDICTION_COVERAGE,
  PILOT_JURISDICTIONS,
  PILOT_LOCAL_KEYS,
  PILOT_STATE_KEYS,
} from "../pilotJurisdictions";
import { ALL_ADAPTERS } from "../registry";

describe("pilot jurisdictions", () => {
  it("derives PILOT_LOCAL_KEYS from the same registry the server gates on", () => {
    const fromRegistry = Array.from(
      new Set(
        ALL_ADAPTERS.map((a) => a.jurisdictionGate.local).filter(Boolean),
      ),
    ).sort();
    const fromExport = [...PILOT_LOCAL_KEYS].sort();
    expect(fromExport).toEqual(fromRegistry);
  });

  it("derives PILOT_STATE_KEYS from the registry too (state-tier + local-implied)", () => {
    const stateBearing = ALL_ADAPTERS.map(
      (a) => a.jurisdictionGate.state,
    ).filter((s): s is string => Boolean(s));
    for (const s of stateBearing) {
      expect(PILOT_STATE_KEYS).toContain(s);
    }
    // Implied: every local jurisdiction implies its parent state.
    expect(PILOT_STATE_KEYS).toContain("utah");
    expect(PILOT_STATE_KEYS).toContain("idaho");
    expect(PILOT_STATE_KEYS).toContain("texas");
  });

  it("provides a friendly label for every pilot localKey (no half-wired adapters)", () => {
    for (const key of PILOT_LOCAL_KEYS) {
      const entry = PILOT_JURISDICTIONS.find((j) => j.localKey === key);
      expect(entry, `missing pilot label for localKey "${key}"`).toBeDefined();
      expect(entry?.label).toBeTruthy();
      expect(entry?.shortLabel).toBeTruthy();
    }
    // And nothing extra: the visible list is exactly the registry set.
    expect(PILOT_JURISDICTIONS.map((j) => j.localKey).sort()).toEqual(
      [...PILOT_LOCAL_KEYS].sort(),
    );
  });

  it("renders the three DA-PI-4 pilot jurisdictions architects expect", () => {
    const shortLabels = PILOT_JURISDICTIONS.map((j) => j.shortLabel);
    expect(shortLabels).toEqual(
      expect.arrayContaining(["Bastrop, TX", "Moab, UT", "Salmon, ID"]),
    );
    // Stable display order (alphabetical by short label).
    expect(shortLabels).toEqual([...shortLabels].slice().sort());
  });

  it("pairs each local jurisdiction with the right state slug", () => {
    const stateByLocal = Object.fromEntries(
      PILOT_JURISDICTIONS.map((j) => [j.localKey, j.stateKey]),
    );
    expect(stateByLocal["bastrop-tx"]).toBe("texas");
    expect(stateByLocal["grand-county-ut"]).toBe("utah");
    expect(stateByLocal["lemhi-county-id"]).toBe("idaho");
  });

  /**
   * Task #253 — per-jurisdiction coverage. The Site Context tab's
   * supported-jurisdictions disclosure renders {@link
   * PILOT_JURISDICTION_COVERAGE} so an architect can see *what*
   * Generate Layers will fetch for each pilot jurisdiction inline,
   * without having to click through and read the per-adapter outcome
   * panel. The contract these assertions pin is:
   *
   *   - the coverage list is exhaustive on `PILOT_JURISDICTIONS` and
   *     stays in the same display order;
   *   - each row's `layers` set matches *exactly* the adapters whose
   *     `jurisdictionGate` selects that jurisdiction's local key (or
   *     the state implied by it) — so adding a new state/local
   *     adapter to `ALL_ADAPTERS` automatically extends the visible
   *     coverage with no FE change required;
   *   - federal-tier adapters are deliberately excluded from the
   *     per-jurisdiction list (they ungate and live in
   *     {@link FEDERAL_PILOT_LAYER_KINDS} as the always-on header).
   */
  describe("PILOT_JURISDICTION_COVERAGE", () => {
    it("covers every pilot jurisdiction in the same display order", () => {
      expect(PILOT_JURISDICTION_COVERAGE.map((c) => c.localKey)).toEqual(
        PILOT_JURISDICTIONS.map((j) => j.localKey),
      );
      for (const cov of PILOT_JURISDICTION_COVERAGE) {
        const j = PILOT_JURISDICTIONS.find((x) => x.localKey === cov.localKey)!;
        expect(cov.label).toBe(j.label);
        expect(cov.shortLabel).toBe(j.shortLabel);
        expect(cov.stateKey).toBe(j.stateKey);
      }
    });

    it("matches the adapters whose jurisdictionGate selects each jurisdiction", () => {
      for (const cov of PILOT_JURISDICTION_COVERAGE) {
        const expected = ALL_ADAPTERS.filter((a) => {
          if (a.tier === "state")
            return a.jurisdictionGate.state === cov.stateKey;
          if (a.tier === "local")
            return a.jurisdictionGate.local === cov.localKey;
          return false;
        }).map((a) => a.adapterKey);
        expect(cov.layers.map((l) => l.adapterKey)).toEqual(expected);
      }
    });

    it("ships at least one layer per pilot jurisdiction (no empty buckets)", () => {
      for (const cov of PILOT_JURISDICTION_COVERAGE) {
        expect(
          cov.layers.length,
          `pilot jurisdiction "${cov.localKey}" has no adapter coverage`,
        ).toBeGreaterThan(0);
      }
    });

    it("only enumerates state-tier and local-tier adapters (federal lives elsewhere)", () => {
      for (const cov of PILOT_JURISDICTION_COVERAGE) {
        for (const layer of cov.layers) {
          expect(["state", "local"]).toContain(layer.tier);
        }
      }
    });

    it("renders the DA-PI-4 layer kinds architects expect for each jurisdiction", () => {
      const byKey = Object.fromEntries(
        PILOT_JURISDICTION_COVERAGE.map((c) => [
          c.localKey,
          c.layers.map((l) => l.layerKind),
        ]),
      );
      // Bastrop, TX → Texas Edwards Aquifer (state) + Bastrop County
      // parcels / zoning / floodplain (local).
      expect(byKey["bastrop-tx"]).toEqual(
        expect.arrayContaining([
          "tceq-edwards-aquifer",
          "bastrop-tx-parcels",
          "bastrop-tx-zoning",
          "bastrop-tx-floodplain",
        ]),
      );
      // Moab, UT → UGRC DEM / parcels / address points (state) +
      // Grand County parcels / zoning / roads (local).
      expect(byKey["grand-county-ut"]).toEqual(
        expect.arrayContaining([
          "ugrc-dem",
          "ugrc-parcels",
          "ugrc-address-points",
          "grand-county-ut-parcels",
          "grand-county-ut-zoning",
          "grand-county-ut-roads",
        ]),
      );
      // Salmon, ID → INSIDE Idaho DEM + parcels (state) + Lemhi
      // County parcels / zoning / roads (local).
      expect(byKey["lemhi-county-id"]).toEqual(
        expect.arrayContaining([
          "inside-idaho-dem",
          "inside-idaho-parcels",
          "lemhi-county-id-parcels",
          "lemhi-county-id-zoning",
          "lemhi-county-id-roads",
        ]),
      );
    });
  });

  describe("FEDERAL_PILOT_LAYER_KINDS", () => {
    it("derives from every ungated federal-tier adapter", () => {
      const expected = ALL_ADAPTERS.filter(
        (a) =>
          a.tier === "federal" &&
          !a.jurisdictionGate.state &&
          !a.jurisdictionGate.local,
      ).map((a) => a.layerKind);
      expect([...FEDERAL_PILOT_LAYER_KINDS]).toEqual(expected);
    });

    it("includes the federal trio shipping in the default config (post-QA-22-SCOPE-B FCC drop)", () => {
      expect(FEDERAL_PILOT_LAYER_KINDS.length).toBeGreaterThan(0);
      // Sanity that the well-known federal layer kinds are surfaced
      // — a regression that drops one of these would break this
      // assertion instead of silently shrinking the disclosure.
      //
      // `fcc-broadband-availability` was the fourth DA-PI-2 federal
      // layer but is gated off by default as of QA-22 SCOPE B
      // closeout (2026-05-23) — see `isFccEnabled` in
      // `lib/adapters/src/registry.ts` and the gating invariants in
      // `registry.test.ts`. If the operator flips `FCC_ENABLED=true`,
      // `FEDERAL_PILOT_LAYER_KINDS` would self-extend to include
      // `fcc-broadband-availability` (it derives from `ALL_ADAPTERS`).
      expect(FEDERAL_PILOT_LAYER_KINDS).toEqual(
        expect.arrayContaining([
          "fema-nfhl-flood-zone",
          "usgs-ned-elevation",
          "epa-ejscreen-blockgroup",
        ]),
      );
      // And the gated-off layer is NOT in the default-config list.
      expect(FEDERAL_PILOT_LAYER_KINDS).not.toContain(
        "fcc-broadband-availability",
      );
    });
  });
});
