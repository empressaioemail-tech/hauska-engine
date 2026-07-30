/**
 * WDLL 2026-07-29 BDC STEP 3 + R13 (AMENDMENT 8) — bastrop setback routing.
 *
 * City BDC districts require layer-23 per-parcel record (no chart/descriptor fallback).
 * Repealed P-* honest-declines. County R-MD still uses bastrop-tx table.
 */

import { describe, expect, it } from "vitest";

import {
  getSetbackTable,
  getSetbackTableForZoning,
  getSetbackDistrict,
  isStaleBastropCitySetbackRule,
  BASTROP_AUTHORITATIVE_SETBACK_ADAPTER,
} from "../local/setbacks/index.js";

describe("bastrop-development-code setback router (WDLL STEP 3 + R13)", () => {
  it("SF-1 without layer-23 record returns null (R13 fail-closed)", () => {
    expect(getSetbackTableForZoning("bastrop-tx", "SF-1")).toBeNull();
    expect(getSetbackTableForZoning("bastrop-city-tx", "SF-1")).toBeNull();
  });

  it("SF-1 ordinance numbers remain on direct bastrop-development-code table (verification only)", () => {
    const table = getSetbackTable("bastrop-development-code");
    const d = table!.districts.find((row) =>
      row.district_name.toUpperCase().startsWith("SF-1"),
    );
    expect(d).toBeDefined();
    expect(d!.front_ft).toBe(30);
    expect(d!.side_ft).toBe(10);
    expect(d!.side_corner_ft).toBe(20);
    expect(d!.rear_ft).toBe(30);
  });

  it("SF-2 / SF-3 / RR without per-parcel record return null (R13)", () => {
    for (const code of ["SF-2", "SF-3", "RR"] as const) {
      expect(getSetbackTableForZoning("bastrop-tx", code)).toBeNull();
    }
  });

  it("MU / GC / PDD without layer 23 record return null", () => {
    expect(getSetbackTableForZoning("bastrop-tx", "MU")).toBeNull();
    expect(getSetbackTableForZoning("bastrop-tx", "GC")).toBeNull();
    expect(getSetbackTableForZoning("bastrop-tx", "PDD")).toBeNull();
    const bdc = getSetbackTable("bastrop-development-code")!;
    const mu = bdc.districts.find((d) => leading(d.district_name) === "MU");
    const gc = bdc.districts.find((d) => leading(d.district_name) === "GC");
    expect(mu).toBeUndefined();
    expect(gc).toBeUndefined();
  });

  it("repealed P-3 does NOT route to bastrop-city-tx as current (honest null)", () => {
    expect(getSetbackTableForZoning("bastrop-tx", "P-3")).toBeNull();
  });

  it("repealed P-5 / P-EC honest-decline (null); archival B3 by direct key only", () => {
    expect(getSetbackTableForZoning("bastrop-tx", "P-5")).toBeNull();
    expect(getSetbackTableForZoning("bastrop-tx", "P-EC")).toBeNull();
    expect(getSetbackTableForZoning("bastrop-city-tx", "P-3")).toBeNull();
    const archival = getSetbackTable("bastrop-city-tx");
    expect(archival!.jurisdictionKey).toBe("bastrop-city-tx");
    expect(
      archival!.districts.some((d) => d.district_name.startsWith("P-3")),
    ).toBe(true);
  });

  it("legacy county R-MD still uses bastrop-tx table (not BDC city path)", () => {
    const table = getSetbackTableForZoning("bastrop-tx", "R-MD");
    expect(table!.jurisdictionKey).toBe("bastrop-tx");
    const d = getSetbackDistrict("bastrop-tx", "R-MD Residential Medium Density");
    expect(d!.front_ft).toBe(25);
  });

  it("R13 stale detector flags descriptor-fixture and b3 atom_did", () => {
    expect(
      isStaleBastropCitySetbackRule({
        parcelNodeId: "48021:8723767",
        sourceAdapter: "descriptor-fixture",
        sourceCodeAtomDid: "bastrop_tx/b3-code-april-2025/6.5.003",
      }),
    ).toBe(true);
    expect(
      isStaleBastropCitySetbackRule({
        parcelNodeId: "48021:34073",
        sourceAdapter: BASTROP_AUTHORITATIVE_SETBACK_ADAPTER,
      }),
    ).toBe(false);
    expect(
      isStaleBastropCitySetbackRule({
        parcelNodeId: "48209:156346",
        sourceAdapter: "descriptor-fixture",
      }),
    ).toBe(false);
  });
});

function leading(name: string): string {
  return (name.trim().split(/\s+/)[0] ?? "").toUpperCase();
}
