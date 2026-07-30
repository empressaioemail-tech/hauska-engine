/**
 * WDLL 2026-07-29 BDC STEP 3 items 1–2 — bastrop-development-code routing.
 *
 * SF-x must hit the BDC ordinance-text table; must NOT fall through to
 * legacy bastrop-tx.json. Repealed P-* honest-declines (null), never
 * silently serves bastrop-city-tx as current law.
 */

import { describe, expect, it } from "vitest";

import {
  getSetbackTable,
  getSetbackTableForZoning,
  getSetbackDistrict,
} from "../local/setbacks/index.js";

describe("bastrop-development-code setback router (WDLL STEP 3)", () => {
  it("SF-1 routes to bastrop-development-code (not bastrop-tx)", () => {
    const table = getSetbackTableForZoning("bastrop-tx", "SF-1");
    expect(table).not.toBeNull();
    expect(table!.jurisdictionKey).toBe("bastrop-development-code");
    expect(table!.jurisdictionKey).not.toBe("bastrop-tx");
    expect(table!.jurisdictionKey).not.toBe("bastrop-city-tx");
  });

  it("SF-1 does NOT fall through to bastrop-tx.json districts", () => {
    const routed = getSetbackTableForZoning("bastrop-tx", "SF-1");
    const legacy = getSetbackTable("bastrop-tx");
    expect(routed!.jurisdictionKey).toBe("bastrop-development-code");
    expect(legacy!.jurisdictionKey).toBe("bastrop-tx");
    const sf1InLegacy = legacy!.districts.some((d) =>
      d.district_name.toUpperCase().startsWith("SF-1"),
    );
    expect(sf1InLegacy).toBe(false);
  });

  it("SF-1 ordinance numbers match Sec. 14.02.003 (30/10/20/30, h35, i50)", () => {
    const table = getSetbackTableForZoning("bastrop-tx", "SF-1");
    const d = table!.districts.find((row) =>
      row.district_name.toUpperCase().startsWith("SF-1"),
    );
    expect(d).toBeDefined();
    expect(d!.front_ft).toBe(30);
    expect(d!.side_ft).toBe(10);
    expect(d!.side_corner_ft).toBe(20);
    expect(d!.rear_ft).toBe(30);
    expect(d!.max_height_ft).toBe(35);
    expect(d!.max_impervious_pct).toBe(50);
  });

  it("SF-2 / SF-3 / RR route to bastrop-development-code with ordinance numbers", () => {
    const cases = [
      { code: "SF-2", front: 25, side: 7.5, corner: 15, rear: 20 },
      { code: "SF-3", front: 15, side: 5, corner: 10, rear: 15 },
      { code: "RR", front: 50, side: 20, corner: 20, rear: 50 },
    ] as const;
    for (const c of cases) {
      const table = getSetbackTableForZoning("bastrop-tx", c.code);
      expect(table!.jurisdictionKey).toBe("bastrop-development-code");
      const d = table!.districts.find((row) =>
        row.district_name.toUpperCase().startsWith(c.code),
      );
      expect(d, c.code).toBeDefined();
      expect(d!.front_ft).toBe(c.front);
      expect(d!.side_ft).toBe(c.side);
      expect(d!.side_corner_ft).toBe(c.corner);
      expect(d!.rear_ft).toBe(c.rear);
      expect(d!.max_height_ft).toBe(35);
      expect(d!.max_impervious_pct).toBe(50);
    }
  });

  it("MU / GC chart has no fabricated rows; without layer 23 record router returns null", () => {
    expect(getSetbackTableForZoning("bastrop-tx", "MU")).toBeNull();
    expect(getSetbackTableForZoning("bastrop-tx", "GC")).toBeNull();
    const bdc = getSetbackTable("bastrop-development-code")!;
    const mu = bdc.districts.find((d) => leading(d.district_name) === "MU");
    const gc = bdc.districts.find((d) => leading(d.district_name) === "GC");
    expect(mu).toBeUndefined();
    expect(gc).toBeUndefined();
  });

  it("repealed P-3 does NOT route to bastrop-city-tx as current (honest null)", () => {
    const table = getSetbackTableForZoning("bastrop-tx", "P-3");
    expect(table).toBeNull();
  });

  it("repealed P-5 / P-EC honest-decline (null); PDD requires layer 23 (null without record)", () => {
    expect(getSetbackTableForZoning("bastrop-tx", "P-5")).toBeNull();
    expect(getSetbackTableForZoning("bastrop-tx", "P-EC")).toBeNull();
    expect(getSetbackTableForZoning("bastrop-city-tx", "P-3")).toBeNull();
    expect(getSetbackTableForZoning("bastrop-tx", "PDD")).toBeNull();
    // Archival B3 remains available by direct key only.
    const archival = getSetbackTable("bastrop-city-tx");
    expect(archival!.jurisdictionKey).toBe("bastrop-city-tx");
    expect(
      archival!.districts.some((d) => d.district_name.startsWith("P-3")),
    ).toBe(true);
  });

  it("bastrop-city-tx key with SF-1 still routes to BDC current table", () => {
    const table = getSetbackTableForZoning("bastrop-city-tx", "SF-1");
    expect(table!.jurisdictionKey).toBe("bastrop-development-code");
  });

  it("legacy county R-MD still uses bastrop-tx table (not BDC)", () => {
    const table = getSetbackTableForZoning("bastrop-tx", "R-MD");
    expect(table!.jurisdictionKey).toBe("bastrop-tx");
    const d = getSetbackDistrict("bastrop-tx", "R-MD Residential Medium Density");
    expect(d!.front_ft).toBe(25);
  });
});

function leading(name: string): string {
  return (name.trim().split(/\s+/)[0] ?? "").toUpperCase();
}
