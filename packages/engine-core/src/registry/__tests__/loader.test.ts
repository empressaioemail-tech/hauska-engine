/**
 * A4 — registry-as-engine-input loader tests (Phase A foundation).
 */

import { describe, expect, it } from "vitest";

import {
  listRegistryFipsCodes,
  loadRegistryRowByFips,
  requireRegistryRowByFips,
  RegistryRowNotFoundError,
} from "../loader.js";

describe("registry loader (A4 Rail C row)", () => {
  it("returns Bastrop's frozen row correctly by FIPS lookup", () => {
    const row = loadRegistryRowByFips("48021");
    expect(row).not.toBeNull();
    expect(row!.fips).toBe("48021");
    expect(row!.countyName).toBe("Bastrop");
    expect(row!.inStratmap).toBe(true);
    expect(row!.geometrySource).toBe("stratmap_bulk_zip");
    expect(row!.joinKey).toBe("prop_id");
    expect(row!.ownerMatchRequired).toBe(false);
    expect(row!.vintageYyyymm).toBe("202503");
    expect(row!.flags).toContain("STALE");
  });

  it("returns null for a FIPS code not yet onboarded", () => {
    expect(loadRegistryRowByFips("48453")).toBeNull();
  });

  it("requireRegistryRowByFips throws RegistryRowNotFoundError when not onboarded", () => {
    expect(() => requireRegistryRowByFips("00000")).toThrow(
      RegistryRowNotFoundError,
    );
  });

  it("requireRegistryRowByFips returns the row when onboarded", () => {
    const row = requireRegistryRowByFips("48021");
    expect(row.fips).toBe("48021");
  });

  it("listRegistryFipsCodes includes Bastrop", () => {
    expect(listRegistryFipsCodes()).toContain("48021");
  });
});
