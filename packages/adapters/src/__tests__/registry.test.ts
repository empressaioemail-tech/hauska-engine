/**
 * Registry gating invariants.
 *
 * QA-22 SCOPE B closeout (2026-05-23) — `fcc:broadband` is gated off
 * by default because the upstream is Akamai-WAF-gated. See
 * `lib/adapters/src/registry.ts:isFccEnabled` docstring and
 * `doc_repo/_sessions/2026-05-23_qa22_fcc_recon_cc-agent-C.md`.
 *
 * The default-off behavior must hold for the deployed config (no
 * `FCC_ENABLED` env var set) so the failed-layer pill never surfaces
 * an FCC adapter that the runner isn't even trying to call.
 */

import { describe, expect, it } from "vitest";
import {
  FEDERAL_ADAPTERS,
  ALL_ADAPTERS,
  isFccEnabled,
  isTceqEdwardsEnabled,
} from "../registry";
import { fccBroadbandAdapter } from "../federal/fcc-broadband";

describe("registry — QA-22 SCOPE B FCC gating", () => {
  describe("isTceqEdwardsEnabled", () => {
    it("is off unless TCEQ_EDWARDS_ENABLED is the literal string true", () => {
      expect(isTceqEdwardsEnabled({})).toBe(false);
      expect(isTceqEdwardsEnabled({ TCEQ_EDWARDS_ENABLED: "1" })).toBe(false);
      expect(isTceqEdwardsEnabled({ TCEQ_EDWARDS_ENABLED: "true" })).toBe(
        true,
      );
    });
  });

  describe("isFccEnabled", () => {
    it("returns false when FCC_ENABLED is unset", () => {
      expect(isFccEnabled({})).toBe(false);
    });

    it("returns false when FCC_ENABLED is set to any value other than the literal string \"true\"", () => {
      // The dispatch's mechanic is intentionally strict — accidental
      // truthy strings like "1", "yes", "on" must NOT re-enable FCC
      // until the operator types the literal `true`. This protects
      // against config typos quietly bringing the WAF-gated adapter
      // back.
      expect(isFccEnabled({ FCC_ENABLED: "" })).toBe(false);
      expect(isFccEnabled({ FCC_ENABLED: "1" })).toBe(false);
      expect(isFccEnabled({ FCC_ENABLED: "yes" })).toBe(false);
      expect(isFccEnabled({ FCC_ENABLED: "on" })).toBe(false);
      expect(isFccEnabled({ FCC_ENABLED: "TRUE" })).toBe(false);
      expect(isFccEnabled({ FCC_ENABLED: "True" })).toBe(false);
    });

    it("returns true only when FCC_ENABLED is the literal string \"true\"", () => {
      expect(isFccEnabled({ FCC_ENABLED: "true" })).toBe(true);
    });
  });

  describe("FEDERAL_ADAPTERS (default-off invariant)", () => {
    it("excludes fcc:broadband by default (no FCC_ENABLED in the deployed env)", () => {
      // The Cloud Run revision does not set `FCC_ENABLED`, so the
      // imported `FEDERAL_ADAPTERS` must not contain the FCC adapter
      // and the runner produces zero outcomes for `fcc:broadband` —
      // the per-source pill in the Site Context tab renders nothing
      // (not even `no-coverage`).
      const keys = FEDERAL_ADAPTERS.map((a) => a.adapterKey);
      expect(keys).not.toContain(fccBroadbandAdapter.adapterKey);
      expect(keys).not.toContain("fcc:broadband");
    });

    it("still includes the FEMA + USGS + EPA federal trio in the default config", () => {
      // Guard against an accidental over-broad gate that would also
      // strip the federal adapters that DO work today.
      const keys = FEDERAL_ADAPTERS.map((a) => a.adapterKey);
      expect(keys).toContain("fema:nfhl-flood-zone");
      expect(keys).toContain("usgs:ned-elevation");
      expect(keys).toContain("epa:ejscreen");
    });

    it("ALL_ADAPTERS surfaces the same FCC default-off behavior", () => {
      // ALL_ADAPTERS is the spread of [FEDERAL, STATE, LOCAL] — a
      // regression that re-adds FCC to FEDERAL_ADAPTERS would also
      // re-add it here; pin both.
      const keys = ALL_ADAPTERS.map((a) => a.adapterKey);
      expect(keys).not.toContain("fcc:broadband");
    });
  });

  describe("fccBroadbandAdapter is still importable", () => {
    it("exports the adapter binding even when gated out of the registry", () => {
      // The binding must stay exported so unit tests can exercise
      // FCC-specific behavior directly via `runAdapters([fccBroadbandAdapter], ...)`
      // — only the registry membership is gated, not the adapter
      // itself. Operator can flip `FCC_ENABLED=true` to re-register
      // it without a code redeploy.
      expect(fccBroadbandAdapter.adapterKey).toBe("fcc:broadband");
      expect(fccBroadbandAdapter.tier).toBe("federal");
      expect(typeof fccBroadbandAdapter.run).toBe("function");
    });
  });
});
