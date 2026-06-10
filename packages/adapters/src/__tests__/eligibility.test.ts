import { describe, expect, it } from "vitest";
import {
  filterApplicableAdapters,
  noApplicableAdaptersMessage,
} from "../eligibility";
import { ALL_ADAPTERS } from "../registry";
import type {
  Adapter,
  AdapterContext,
  AdapterResult,
} from "../types";

/** All Cotality national adapters registered for geocoded engagements. */
const COTALITY_ADAPTER_KEYS = [
  "cotality:parcels",
  "cotality:zoning",
  "cotality:property",
  "cotality:climate",
  "cotality:hazards",
  "cotality:replacementcost",
  "cotality:mineral",
  "cotality:utility",
] as const;

function ctxFor(
  stateKey: AdapterContext["jurisdiction"]["stateKey"],
  localKey: AdapterContext["jurisdiction"]["localKey"],
  opts: { partnerCity?: boolean } = {},
): AdapterContext {
  return {
    parcel: { latitude: 0, longitude: 0 },
    jurisdiction: { stateKey, localKey, partnerCity: opts.partnerCity },
  };
}

// QA-22 SCOPE B closeout (2026-05-23) — `fcc:broadband` is gated off
// by default; see `isFccEnabled` in
// `lib/adapters/src/registry.ts` and the registry-test invariants
// in `registry.test.ts`. The applicable-adapter lists below
// therefore exclude `fcc:broadband` even though FCC's `appliesTo`
// would still return true for a geocoded engagement — the gate
// removes it from `ALL_ADAPTERS` upstream of this filter.
describe("filterApplicableAdapters", () => {
  it("returns Bastrop TX's federal + Texas state + Bastrop local adapters", () => {
    const applicable = filterApplicableAdapters(ctxFor("texas", "bastrop-tx"));
    const keys = applicable.map((a) => a.adapterKey).sort();
    expect(keys).toEqual(
      [
        "fema:nfhl-flood-zone",
        "epa:ejscreen",
        "usgs:ned-elevation",
        // Cortex prop-intel SCOPE B (2026-05-23) — Regrid national baseline.
        "regrid:parcels",
        "regrid:zoning",
        // 2026-06-06 cotality full data-layer pack — all national Cotality adapters.
        ...COTALITY_ADAPTER_KEYS,
        "tceq:edwards-aquifer",
        "bastrop-tx:parcels",
        "bastrop-tx:zoning",
        "bastrop-tx:floodplain",
      ].sort(),
    );
  });

  it("returns Moab UT's federal + Utah state adapters (grand-county-ut gated off by default after SCOPE B)", () => {
    // Cortex prop-intel SCOPE B (2026-05-23) — grand-county-ut:* now
    // require `partnerCity: true` and Grand County is not currently a
    // partner. The default Moab context (no partnerCity) gets the
    // federal baseline (including Regrid) + UGRC state-tier, with
    // grand-county-ut adapters skipped via appliesTo === false.
    const applicable = filterApplicableAdapters(
      ctxFor("utah", "grand-county-ut"),
    );
    const keys = applicable.map((a) => a.adapterKey).sort();
    expect(keys).toEqual(
      [
        "fema:nfhl-flood-zone",
        "epa:ejscreen",
        "usgs:ned-elevation",
        "regrid:parcels",
        "regrid:zoning",
        // 2026-06-06 — Cotality full pack (Regrid fallback remains).
        ...COTALITY_ADAPTER_KEYS,
        "ugrc:dem",
        "ugrc:parcels",
        "ugrc:address-points",
      ].sort(),
    );
  });

  it("returns Moab UT + grand-county-ut local adapters when partnerCity=true", () => {
    // When the engagement carries `partnerCity: true` (Hauska
    // substrate partner status), the per-county adapters return as
    // opportunistic enrichment alongside the Regrid baseline.
    //
    // `fcc:broadband` is NOT in this list even though Grand County
    // is flagged partnerCity — the FCC gate
    // (QA-22 SCOPE B closeout, PR #102) is independent of the
    // partnerCity flag and stays off by default until the operator
    // flips `FCC_ENABLED=true` on the Cloud Run service env.
    const applicable = filterApplicableAdapters(
      ctxFor("utah", "grand-county-ut", { partnerCity: true }),
    );
    const keys = applicable.map((a) => a.adapterKey).sort();
    expect(keys).toEqual(
      [
        "fema:nfhl-flood-zone",
        "epa:ejscreen",
        "usgs:ned-elevation",
        "regrid:parcels",
        "regrid:zoning",
        // 2026-06-06 — Cotality full pack.
        ...COTALITY_ADAPTER_KEYS,
        "ugrc:dem",
        "ugrc:parcels",
        "ugrc:address-points",
        "grand-county-ut:parcels",
        "grand-county-ut:zoning",
        "grand-county-ut:roads",
      ].sort(),
    );
  });

  it("returns Salmon ID's federal + Idaho state + Lemhi County local adapters", () => {
    const applicable = filterApplicableAdapters(
      ctxFor("idaho", "lemhi-county-id"),
    );
    const keys = applicable.map((a) => a.adapterKey).sort();
    expect(keys).toEqual(
      [
        "fema:nfhl-flood-zone",
        "epa:ejscreen",
        "usgs:ned-elevation",
        // Cortex prop-intel SCOPE B (2026-05-23) — Regrid baseline.
        "regrid:parcels",
        "regrid:zoning",
        // 2026-06-06 — Cotality full pack (interim Regrid fallback).
        ...COTALITY_ADAPTER_KEYS,
        "inside-idaho:dem",
        "inside-idaho:parcels",
        "lemhi-county-id:parcels",
        "lemhi-county-id:zoning",
        "lemhi-county-id:roads",
      ].sort(),
    );
  });

  it("returns the federal set (FEMA + USGS + EPA + Regrid + Cotality full pack) for an out-of-pilot but geocoded context (PL-04 + SCOPE B + 2026-06-06 cotality)", () => {
    // Boulder CO style: stateKey null, but the parcel is geocoded
    // (lat/lng baked into ctxFor's defaults). Federal adapters apply
    // to any finite-coords engagement.
    //
    // The federal-tier set after the 2026-05-23 changes:
    //   - FEMA NFHL + USGS NED + EPA EJScreen — the original
    //     ungated federal trio.
    //   - `regrid:parcels` + `regrid:zoning` — Cortex prop-intel
    //     SCOPE B (PR #104) national baseline; tier-housed under
    //     federal for cache-predicate reuse.
    //   - `fcc:broadband` — gated off by default (QA-22 SCOPE B
    //     closeout, PR #102). Re-enables when `FCC_ENABLED=true`.
    const applicable = filterApplicableAdapters(ctxFor(null, null));
    const keys = applicable.map((a) => a.adapterKey).sort();
    expect(keys).toEqual(
      [
        "fema:nfhl-flood-zone",
        "epa:ejscreen",
        "usgs:ned-elevation",
        "regrid:parcels",
        "regrid:zoning",
        // 2026-06-06 cotality full pack — registered for every geocoded engagement.
        ...COTALITY_ADAPTER_KEYS,
      ].sort(),
    );
  });

  it("returns [] when the parcel has no geocode (NaN coordinates)", () => {
    const ctx: AdapterContext = {
      parcel: { latitude: NaN, longitude: NaN },
      jurisdiction: { stateKey: null, localKey: null },
    };
    expect(filterApplicableAdapters(ctx)).toEqual([]);
  });

  it("swallows an `appliesTo` throw and treats it as false", () => {
    const throwing: Adapter = {
      adapterKey: "test:throwing",
      tier: "state",
      sourceKind: "state-adapter",
      layerKind: "test-throwing",
      provider: "Test",
      jurisdictionGate: { state: "utah" },
      appliesTo: () => {
        throw new Error("boom — feature flag service unreachable");
      },
      run(): Promise<AdapterResult> {
        throw new Error("should never be called");
      },
    };
    const matching: Adapter = {
      ...throwing,
      adapterKey: "test:matching",
      appliesTo: () => true,
    };

    expect(
      filterApplicableAdapters(ctxFor("utah", "grand-county-ut"), [
        throwing,
        matching,
      ]),
    ).toEqual([matching]);
  });

  it("defaults to ALL_ADAPTERS when no second arg is supplied", () => {
    // Sanity check that the default-arg path matches the explicit-arg path
    // — the FE pre-flight gate calls the helper without a second arg.
    const explicit = filterApplicableAdapters(
      ctxFor("texas", "bastrop-tx"),
      ALL_ADAPTERS,
    );
    const defaulted = filterApplicableAdapters(ctxFor("texas", "bastrop-tx"));
    expect(defaulted.map((a) => a.adapterKey)).toEqual(
      explicit.map((a) => a.adapterKey),
    );
  });
});

describe("noApplicableAdaptersMessage", () => {
  it("asks for an address when the engagement has no geocode", () => {
    expect(
      noApplicableAdaptersMessage({
        jurisdiction: { stateKey: null, localKey: null },
        hasGeocode: false,
      }),
    ).toBe("Add an address to enable site context layers.");
  });

  it("falls back to a neutral message when geocoded but stateKey is unresolved (defensive)", () => {
    // PL-04: federal adapters apply to any geocoded engagement, so
    // reaching this branch means a non-US lat/lng or a future federal
    // adapter that gates more strictly. The message should not imply
    // the architect can fix it by editing the city/state.
    expect(
      noApplicableAdaptersMessage({
        jurisdiction: { stateKey: null, localKey: null },
        hasGeocode: true,
      }),
    ).toBe("No applicable adapters for this engagement's site context.");
  });

  it("names the resolved state when geocoded + stateKey resolved + localKey null", () => {
    expect(
      noApplicableAdaptersMessage({
        jurisdiction: { stateKey: "utah", localKey: null },
        hasGeocode: true,
      }),
    ).toBe(
      "Federal layers loaded. No local adapter for Utah yet — upload a QGIS overlay if you have one.",
    );
  });

  it("names Texas when the resolver lands on the Texas state slug", () => {
    expect(
      noApplicableAdaptersMessage({
        jurisdiction: { stateKey: "texas", localKey: null },
        hasGeocode: true,
      }),
    ).toBe(
      "Federal layers loaded. No local adapter for Texas yet — upload a QGIS overlay if you have one.",
    );
  });
});
