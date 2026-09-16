import { describe, expect, it } from "vitest";

import {
  chooseDominantCounty,
  isDeclaredNonTexas,
  memoryCoverageCheckStore,
  normalizeCity,
  normalizeZip,
} from "../coverage-check.js";

describe("chooseDominantCounty (P-210)", () => {
  it("resolves a single-candidate match unambiguously", () => {
    expect(chooseDominantCounty([{ countyFips: "48029", n: 12300 }])).toEqual({
      kind: "resolved",
      countyFips: "48029",
    });
  });

  it("resolves a dominant-majority match despite a minority outlier -- the real, live-measured Bell/76541 shape (6897 vs 3, a single mis-keyed CAD row in a different county)", () => {
    const rows = [
      { countyFips: "48027", n: 6897 },
      { countyFips: "48319", n: 3 },
    ];
    expect(chooseDominantCounty(rows)).toEqual({ kind: "resolved", countyFips: "48027" });
  });

  it("refuses a genuinely split match: no county holds the dominance share", () => {
    const rows = [
      { countyFips: "48001", n: 55 },
      { countyFips: "48003", n: 45 },
    ];
    const result = chooseDominantCounty(rows);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates.map((c) => c.countyFips)).toEqual(["48001", "48003"]);
    }
  });

  it("reports not-found for zero rows", () => {
    expect(chooseDominantCounty([])).toEqual({ kind: "not-found" });
  });
});

describe("isDeclaredNonTexas", () => {
  it("is false for TX, texas, or no state at all", () => {
    expect(isDeclaredNonTexas("TX")).toBe(false);
    expect(isDeclaredNonTexas("texas")).toBe(false);
    expect(isDeclaredNonTexas(null)).toBe(false);
    expect(isDeclaredNonTexas("")).toBe(false);
  });
  it("is true for any other state", () => {
    expect(isDeclaredNonTexas("CA")).toBe(true);
    expect(isDeclaredNonTexas("California")).toBe(true);
  });
});

describe("normalizeZip / normalizeCity", () => {
  it("accepts a clean 5-digit zip, rejects anything else", () => {
    expect(normalizeZip("76541")).toBe("76541");
    expect(normalizeZip(" 76541 ")).toBe("76541");
    expect(normalizeZip("7654")).toBeNull();
    expect(normalizeZip("abcde")).toBeNull();
    expect(normalizeZip(null)).toBeNull();
  });
  it("trims a city, treats blank as absent", () => {
    expect(normalizeCity(" Killeen ")).toBe("Killeen");
    expect(normalizeCity("   ")).toBeNull();
    expect(normalizeCity(null)).toBeNull();
  });
});

describe("memoryCoverageCheckStore (fail-closed contract)", () => {
  const store = memoryCoverageCheckStore({
    zipRows: {
      "78209": [{ countyFips: "48029", n: 12300 }], // Bexar
      "76541": [
        { countyFips: "48027", n: 6897 },
        { countyFips: "48319", n: 3 },
      ], // Bell, dominant
      "78701": [{ countyFips: "48453", n: 6284 }], // Travis
      "99999": [
        { countyFips: "48001", n: 55 },
        { countyFips: "48003", n: 45 },
      ], // genuinely ambiguous
    },
    tier1Counties: new Set(["48029", "48027", "48453"]),
    countyNames: { "48001": "Anderson" },
  });

  it("returns covered for a county with tier1 presence", async () => {
    await expect(store.checkCoverage({ city: null, state: "TX", zip: "78209" })).resolves.toEqual({
      status: "covered",
    });
  });

  it("returns covered for Bell/76541 despite the minority mis-keyed row -- the empirically-traced serving path answer, not the pre-registered guess", async () => {
    await expect(store.checkCoverage({ city: "Killeen", state: "TX", zip: "76541" })).resolves.toEqual(
      { status: "covered" },
    );
  });

  it("returns not-covered with all three required fields for a resolved, uncovered county", async () => {
    await expect(
      store.checkCoverage({ city: null, state: "TX", zip: "99999-not-a-real-zip" }),
    ).resolves.toMatchObject({ status: "indeterminate" });
  });

  it("returns not-covered with countyFips/countyName/state when the county resolves but has no tier1 rows", async () => {
    const uncoveredStore = memoryCoverageCheckStore({
      zipRows: { "76537": [{ countyFips: "48001", n: 10 }] },
      tier1Counties: new Set(),
      countyNames: { "48001": "Anderson" },
    });
    await expect(uncoveredStore.checkCoverage({ city: null, state: "TX", zip: "76537" })).resolves.toEqual(
      { status: "not-covered", countyFips: "48001", countyName: "Anderson", state: "TX" },
    );
  });

  it("fails closed to indeterminate for a genuinely ambiguous locality, never guessing", async () => {
    await expect(store.checkCoverage({ city: null, state: "TX", zip: "99999" })).resolves.toMatchObject(
      { status: "indeterminate" },
    );
  });

  it("fails closed to indeterminate for a state outside Texas, without needing a match", async () => {
    await expect(store.checkCoverage({ city: null, state: "CA", zip: "90210" })).resolves.toMatchObject(
      { status: "indeterminate" },
    );
  });

  it("fails closed to indeterminate when no locality signal is present at all", async () => {
    await expect(store.checkCoverage({ city: null, state: null, zip: null })).resolves.toMatchObject({
      status: "indeterminate",
    });
  });

  it("fails closed to indeterminate on a simulated database failure -- never a guess, never a throw", async () => {
    const downStore = memoryCoverageCheckStore({ failReads: true });
    await expect(
      downStore.checkCoverage({ city: null, state: "TX", zip: "78209" }),
    ).resolves.toMatchObject({ status: "indeterminate" });
  });

  it("never returns not-covered without all three of countyFips/countyName/state", async () => {
    const nameless = memoryCoverageCheckStore({
      zipRows: { "76537": [{ countyFips: "48999", n: 10 }] },
      tier1Counties: new Set(),
      countyNames: {},
    });
    const verdict = await nameless.checkCoverage({ city: null, state: "TX", zip: "76537" });
    expect(verdict.status).not.toBe("not-covered");
    expect(verdict).toMatchObject({ status: "indeterminate" });
  });
});
