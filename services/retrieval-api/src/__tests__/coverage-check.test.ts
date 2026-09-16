import { describe, expect, it } from "vitest";
import type postgres from "postgres";

import {
  chooseDominantCounty,
  createCoverageCheckStore,
  decideAmbiguousLocality,
  isDeclaredNonTexas,
  memoryCoverageCheckStore,
  narrowByCity,
  normalizeCity,
  normalizeZip,
  splitCityMatch,
} from "../coverage-check.js";

/**
 * The one-scan ZIP+city statement's raw rows for `78654` / `MARBLE FALLS`, exactly as the
 * live GROUP BY returned them on 2026-09-16 (read-only, under a P-281 heavy-scan lease,
 * psql `\timing`: 67.8s cold). Kept verbatim because this fixture is the ONLY place the two
 * splits can be checked against a real statement's shape: `city_match` NULL is what a
 * `situs_city IS NULL` row produces, and those rows (48453's 1,839) are exactly why the
 * narrowing flips the answer.
 *
 *  48053|t|6873   48053|f|4511   48453|(null)|1839   48031|t|61   48319|t|45   48053|(null)|7
 *  48453|t|6      48453|f|5      48015|f|2             48501|f|2    48299|f|1    48319|f|1
 */
const MEASURED_78654_ROWS: Array<{ county_fips: string; city_match: boolean | null; n: number }> = [
  { county_fips: "48053", city_match: true, n: 6873 },
  { county_fips: "48053", city_match: false, n: 4511 },
  { county_fips: "48453", city_match: null, n: 1839 },
  { county_fips: "48031", city_match: true, n: 61 },
  { county_fips: "48319", city_match: true, n: 45 },
  { county_fips: "48053", city_match: null, n: 7 },
  { county_fips: "48453", city_match: true, n: 6 },
  { county_fips: "48453", city_match: false, n: 5 },
  { county_fips: "48015", city_match: false, n: 2 },
  { county_fips: "48501", city_match: false, n: 2 },
  { county_fips: "48299", city_match: false, n: 1 },
  { county_fips: "48319", city_match: false, n: 1 },
];

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

describe("splitCityMatch (P-205b) -- one scan, two splits", () => {
  it("folds the measured 78654 rows into the ZIP-only split and the ZIP-AND-city split", () => {
    const { zipRows, cityMatchedRows } = splitCityMatch(MEASURED_78654_ROWS);
    const byFips = (rows: readonly { countyFips: string; n: number }[]) =>
      Object.fromEntries(rows.map((r) => [r.countyFips, r.n]));

    // The ZIP-only fold must equal a separate ZIP-only GROUP BY over the same table.
    // Re-measured live, same session: 11391 / 1850 / 61 / 46 / 2 / 2 / 1.
    expect(byFips(zipRows)).toEqual({
      "48053": 11391,
      "48453": 1850,
      "48031": 61,
      "48319": 46,
      "48015": 2,
      "48501": 2,
      "48299": 1,
    });
    // The ZIP-AND-city fold: only city_match rows, and a NULL situs_city is NOT a match
    // (48453's 1,839 city-less rows are the reason the narrowed answer flips to Burnet).
    expect(byFips(cityMatchedRows)).toEqual({
      "48053": 6873,
      "48031": 61,
      "48319": 45,
      "48453": 6,
    });
  });

  it("tolerates the text spelling of a boolean, so a type-parser change cannot silently switch the narrowing off", () => {
    const { cityMatchedRows } = splitCityMatch([
      { county_fips: "48053", city_match: "t", n: 3 },
      { county_fips: "48053", city_match: "f", n: 9 },
      { county_fips: "48053", city_match: null, n: 5 },
    ]);
    expect(cityMatchedRows).toEqual([{ countyFips: "48053", n: 3 }]);
  });

  it("is not vacuous: the ZIP-only totals count every row, match or not", () => {
    const { zipRows } = splitCityMatch(MEASURED_78654_ROWS);
    expect(zipRows.reduce((sum, r) => sum + r.n, 0)).toBe(13353);
  });
});

describe("narrowByCity (P-205b rule 1)", () => {
  const zipOnly = chooseDominantCounty(splitCityMatch(MEASURED_78654_ROWS).zipRows);

  it("leaves a ZIP that resolves on its own completely alone, whatever the city would have said", () => {
    const resolved = { kind: "resolved", countyFips: "48027" } as const;
    expect(narrowByCity(resolved, [{ countyFips: "48319", n: 9999 }])).toEqual(resolved);
  });

  it("narrows an ambiguous ZIP to the county the given city holds -- the measured 78654 / Marble Falls case (85.3 percent alone, 98.4 percent narrowed)", () => {
    expect(zipOnly.kind).toBe("ambiguous");
    const narrowed = narrowByCity(zipOnly, splitCityMatch(MEASURED_78654_ROWS).cityMatchedRows);
    expect(narrowed).toEqual({ kind: "resolved", countyFips: "48053" });
  });

  it("keeps the ZIP-only ambiguity when the narrowing returned NO rows -- an empty result is not an absence (DEV-PROCESS 4.3)", () => {
    expect(narrowByCity(zipOnly, [])).toEqual(zipOnly);
  });

  it("reports continued ambiguity, from the narrowed split, when the narrowing returned rows that still fail 90 percent", () => {
    const narrowed = narrowByCity(zipOnly, [
      { countyFips: "48053", n: 55 },
      { countyFips: "48453", n: 45 },
    ]);
    expect(narrowed.kind).toBe("ambiguous");
    if (narrowed.kind === "ambiguous") {
      expect(narrowed.candidates.map((c) => c.countyFips)).toEqual(["48053", "48453"]);
    }
  });
});

describe("decideAmbiguousLocality (P-205b rule 2) -- a unanimous answer needs no winner", () => {
  it("answers covered when every candidate is served", () => {
    expect(
      decideAmbiguousLocality([
        { countyFips: "48453", n: 55, covered: true },
        { countyFips: "48053", n: 45, covered: true },
      ]).kind,
    ).toBe("covered");
  });

  it("answers not-covered naming the PLURALITY county when none is served", () => {
    const decision = decideAmbiguousLocality([
      { countyFips: "48453", n: 55, covered: false },
      { countyFips: "48053", n: 45, covered: false },
    ]);
    expect(decision.kind).toBe("not-covered");
    if (decision.kind === "not-covered") expect(decision.countyFips).toBe("48453");
  });

  it("answers mixed when the candidates disagree", () => {
    expect(
      decideAmbiguousLocality([
        { countyFips: "48453", n: 55, covered: true },
        { countyFips: "48053", n: 45, covered: false },
      ]).kind,
    ).toBe("mixed");
  });

  it("is not vacuous: the same candidate list decides all three ways", () => {
    const candidates = [
      { countyFips: "48453", n: 55, covered: true },
      { countyFips: "48053", n: 45, covered: true },
    ];
    expect(decideAmbiguousLocality(candidates).kind).toBe("covered");
    expect(decideAmbiguousLocality(candidates.map((c) => ({ ...c, covered: false }))).kind).toBe(
      "not-covered",
    );
    expect(
      decideAmbiguousLocality([{ ...candidates[0]! }, { ...candidates[1]!, covered: false }]).kind,
    ).toBe("mixed");
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

  it("UPDATED BY P-205b: an ambiguous locality whose candidates are ALL uncovered is no longer a bare refusal -- rule 2 answers not-covered naming the plurality, and carries the candidate list", async () => {
    // Same fixture as the P-210 test below, whose answer this ruling deliberately changes:
    // neither 48001 nor 48003 is served, so there is no split to refuse over.
    await expect(store.checkCoverage({ city: null, state: "TX", zip: "99999" })).resolves.toEqual({
      status: "not-covered",
      countyFips: "48001",
      countyName: "Anderson",
      state: "TX",
      candidates: [
        { countyFips: "48001", n: 55, covered: false },
        { countyFips: "48003", n: 45, covered: false },
      ],
    });
  });

  it("P-205b rule 2: an ambiguous locality whose candidates are ALL covered answers covered", async () => {
    const bothServed = memoryCoverageCheckStore({
      zipRows: {
        "70001": [
          { countyFips: "48453", n: 55 },
          { countyFips: "48027", n: 45 },
        ],
      },
      tier1Counties: new Set(["48453", "48027"]),
    });
    await expect(bothServed.checkCoverage({ city: null, state: "TX", zip: "70001" })).resolves.toEqual(
      { status: "covered" },
    );
  });

  it("P-205b rule 2: an ambiguous locality whose candidates DISAGREE stays indeterminate -- and now says which counties are served", async () => {
    const mixed = memoryCoverageCheckStore({
      zipRows: {
        "70002": [
          { countyFips: "48453", n: 55 },
          { countyFips: "48027", n: 45 },
        ],
      },
      tier1Counties: new Set(["48027"]),
      countyNames: { "48453": "Travis County", "48027": "Bell County" },
    });
    const verdict = await mixed.checkCoverage({ city: null, state: "TX", zip: "70002" });
    expect(verdict).toMatchObject({
      status: "indeterminate",
      candidates: [
        { countyFips: "48453", n: 55, covered: false },
        { countyFips: "48027", n: 45, covered: true },
      ],
    });
    // The disagreement is the finding; a bare "no dominant match" would hide it.
    if (verdict.status === "indeterminate") {
      expect(verdict.reason).toContain("48453 (55, not covered)");
      expect(verdict.reason).toContain("48027 (45, covered)");
    }
  });

  it("P-205b rule 2: a unanimous not-covered whose plurality county has no name is refused, never guessed at", async () => {
    const namelessPlurality = memoryCoverageCheckStore({
      zipRows: {
        "70003": [
          { countyFips: "48999", n: 55 },
          { countyFips: "48003", n: 45 },
        ],
      },
      tier1Counties: new Set(),
      countyNames: {},
    });
    const verdict = await namelessPlurality.checkCoverage({ city: null, state: "TX", zip: "70003" });
    expect(verdict.status).toBe("indeterminate");
    if (verdict.status === "indeterminate") {
      expect(verdict.candidates).toEqual([
        { countyFips: "48999", n: 55, covered: false },
        { countyFips: "48003", n: 45, covered: false },
      ]);
      expect(verdict.reason).toContain("no name on record");
    }
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
    await expect(downStore.checkCoverage({ city: null, state: "TX", zip: "78209" })).resolves.toMatchObject(
      { status: "indeterminate" },
    );
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

describe("memoryCoverageCheckStore -- P-205b falsifiers 1 and 3, on the MEASURED splits", () => {
  /** Tiers exactly as measured live 2026-09-16: 48453 served, 48053 NOT (Burnet is Phase 1). */
  const MARBLE_FALLS = {
    zipRows: {
      "78654": [
        { countyFips: "48053", n: 11391 },
        { countyFips: "48453", n: 1850 },
        { countyFips: "48031", n: 61 },
        { countyFips: "48319", n: 46 },
        { countyFips: "48015", n: 2 },
        { countyFips: "48501", n: 2 },
        { countyFips: "48299", n: 1 },
      ],
    },
    zipCityRows: {
      "78654|MARBLE FALLS": [
        { countyFips: "48053", n: 6873 },
        { countyFips: "48031", n: 61 },
        { countyFips: "48319", n: 45 },
        { countyFips: "48453", n: 6 },
      ],
    },
    tier1Counties: new Set(["48453"]),
    countyNames: { "48053": "Burnet County", "48453": "Travis County" },
  };

  it("F1: 78654 + Marble Falls resolves to 48053 (the narrowed split is 98.4 percent) and is therefore ANSWERED, not refused -- naming Burnet, which is not served yet", async () => {
    const store = memoryCoverageCheckStore(MARBLE_FALLS);
    await expect(
      store.checkCoverage({ city: "Marble Falls", state: "TX", zip: "78654" }),
    ).resolves.toEqual({
      status: "not-covered",
      countyFips: "48053",
      countyName: "Burnet County",
      state: "TX",
    });
  });

  it("F1 control: the SAME zip with NO city is still ambiguous -- the narrowing, not a widened share, is what fixed it", async () => {
    const store = memoryCoverageCheckStore(MARBLE_FALLS);
    const verdict = await store.checkCoverage({ city: null, state: "TX", zip: "78654" });
    expect(verdict.status).toBe("indeterminate");
    if (verdict.status === "indeterminate") {
      // All SEVEN measured candidates travel, in count order -- not the two the dispatch named.
      expect(verdict.candidates?.map((c) => c.countyFips)).toEqual([
        "48053",
        "48453",
        "48031",
        "48319",
        "48015",
        "48501",
        "48299",
      ]);
      expect(verdict.candidates?.[0]).toEqual({ countyFips: "48053", n: 11391, covered: false });
      expect(verdict.candidates?.[1]).toEqual({ countyFips: "48453", n: 1850, covered: true });
    }
  });

  it("F1 future state: the same call answers covered the day Burnet is onboarded, with no code change", async () => {
    const store = memoryCoverageCheckStore({
      ...MARBLE_FALLS,
      tier1Counties: new Set(["48453", "48053"]),
    });
    await expect(
      store.checkCoverage({ city: "Marble Falls", state: "TX", zip: "78654" }),
    ).resolves.toEqual({ status: "covered" });
  });

  it("F1: a city that matches nothing in that ZIP leaves the ZIP-only ambiguity standing (no false 'not found')", async () => {
    const store = memoryCoverageCheckStore({ ...MARBLE_FALLS, zipCityRows: {} });
    const verdict = await store.checkCoverage({ city: "Nowhere", state: "TX", zip: "78654" });
    expect(verdict.status).toBe("indeterminate");
    if (verdict.status === "indeterminate") expect(verdict.reason).not.toContain("not found");
  });

  it("F3: Bell 76541 (6897 in 48027 against 3 in 48319) still resolves to 48027 with no city given", async () => {
    const store = memoryCoverageCheckStore({
      zipRows: {
        "76541": [
          { countyFips: "48027", n: 6897 },
          { countyFips: "48319", n: 3 },
        ],
      },
      // Deliberately hostile: if the ZIP-only split were ever second-guessed by the city,
      // this is the fixture that would catch it.
      zipCityRows: { "76541|KILLEEN": [{ countyFips: "48319", n: 6985 }] },
      tier1Counties: new Set(["48027"]),
    });
    await expect(store.checkCoverage({ city: null, state: "TX", zip: "76541" })).resolves.toEqual({
      status: "covered",
    });
    await expect(store.checkCoverage({ city: "Killeen", state: "TX", zip: "76541" })).resolves.toEqual({
      status: "covered",
    });
  });
});

/**
 * A fake `postgres.Sql` that answers by inspecting the statement text, so the REAL store can
 * be driven with no connection at all. `statements` records the timeout bucket each statement
 * was issued under, which is how falsifier 5 counts scans rather than guessing at them.
 */
function fakeSqlFactory(plan: {
  txgioRows: Array<{ county_fips: string; city_match: boolean | null; n: number }>;
  tier1Counties: ReadonlySet<string>;
  names: Readonly<Record<string, string>>;
  statements: Array<{ timeoutMs: number; text: string }>;
}) {
  return async (_databaseUrl: string, timeoutMs: number): Promise<postgres.Sql> => {
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ""), "");
      plan.statements.push({ timeoutMs, text });
      if (text.includes("txgio_parcel")) return Promise.resolve(plan.txgioRows);
      if (text.includes("place_layer_snapshots")) {
        const placeKey = values.find((v) => typeof v === "string" && v.startsWith("node:"));
        const fips = String(placeKey ?? "").slice(5, 10);
        return Promise.resolve([{ exists: plan.tier1Counties.has(fips) }]);
      }
      if (text.includes("tx_county_boundary")) {
        const name = plan.names[String(values[0] ?? "")];
        return Promise.resolve(name ? [{ county_name: name }] : []);
      }
      return Promise.resolve([]);
    }) as unknown as postgres.Sql;
    (sql as unknown as { end: (opts?: unknown) => Promise<void> }).end = async () => {};
    return sql;
  };
}

describe("createCoverageCheckStore (P-205b) -- the real store, no connection", () => {
  it("F5: a zip+city lookup issues exactly ONE txgio_parcel statement, and it carries BOTH predicates", async () => {
    const statements: Array<{ timeoutMs: number; text: string }> = [];
    const store = createCoverageCheckStore({
      databaseUrl: "postgres://unused",
      openSql: fakeSqlFactory({
        txgioRows: MEASURED_78654_ROWS,
        tier1Counties: new Set(["48453"]),
        names: { "48053": "Burnet County" },
        statements,
      }),
    });

    await expect(
      store.checkCoverage({ city: "Marble Falls", state: "TX", zip: "78654" }),
    ).resolves.toEqual({
      status: "not-covered",
      countyFips: "48053",
      countyName: "Burnet County",
      state: "TX",
    });

    const scans = statements.filter((s) => s.text.includes("txgio_parcel"));
    expect(scans).toHaveLength(1); // one scan, never a second full scan per request
    expect(scans[0]!.text).toContain("situs_zip"); // both predicates in the one statement
    expect(scans[0]!.text).toContain("situs_city");
    // and it was the bounded geo-resolution bucket, not a fast lookup
    expect(scans[0]!.timeoutMs).toBe(150_000);
  });

  it("F5 control: a ZIP-only lookup also issues exactly one txgio_parcel statement, and it has no city predicate", async () => {
    const statements: Array<{ timeoutMs: number; text: string }> = [];
    const store = createCoverageCheckStore({
      databaseUrl: "postgres://unused",
      openSql: fakeSqlFactory({
        txgioRows: MEASURED_78654_ROWS,
        tier1Counties: new Set(["48453"]),
        names: { "48053": "Burnet County" },
        statements,
      }),
    });
    const verdict = await store.checkCoverage({ city: null, state: "TX", zip: "78654" });
    expect(verdict.status).toBe("indeterminate");
    const scans = statements.filter((s) => s.text.includes("txgio_parcel"));
    expect(scans).toHaveLength(1);
    expect(scans[0]!.text).not.toContain("situs_city");
  });

  it("F4: an out-of-state locality answers with NO database call at all", async () => {
    let opened = 0;
    const store = createCoverageCheckStore({
      databaseUrl: "postgres://unused",
      openSql: async () => {
        opened += 1;
        throw new Error("no connection may be opened for an out-of-state locality");
      },
    });
    const verdict = await store.checkCoverage({ city: "Portland", state: "OR", zip: "97201" });
    expect(opened).toBe(0);
    expect(verdict).toMatchObject({ status: "indeterminate" });
    if (verdict.status === "indeterminate") expect(verdict.reason).toContain("outside Texas");
  });

  it("rule 2 on the real store: every candidate read positively, they disagree -> indeterminate WITH the list", async () => {
    const statements: Array<{ timeoutMs: number; text: string }> = [];
    const store = createCoverageCheckStore({
      databaseUrl: "postgres://unused",
      openSql: fakeSqlFactory({
        txgioRows: [
          { county_fips: "48053", city_match: true, n: 55 },
          { county_fips: "48453", city_match: true, n: 45 },
        ],
        tier1Counties: new Set(["48453"]),
        names: {},
        statements,
      }),
    });
    const verdict = await store.checkCoverage({ city: "Somewhere", state: "TX", zip: "78654" });
    expect(verdict).toEqual({
      status: "indeterminate",
      reason:
        "locality resolves to multiple candidate counties with no dominant match, and the serving path does not hold all of them: 48053 (55, not covered), 48453 (45, covered)",
      candidates: [
        { countyFips: "48053", n: 55, covered: false },
        { countyFips: "48453", n: 45, covered: true },
      ],
    });
  });

  it("rule 2 on the real store: a candidate whose status cannot be READ refuses WITHOUT a candidate list -- never a `covered: false` standing for unknown", async () => {
    const store = createCoverageCheckStore({
      databaseUrl: "postgres://unused",
      openSql: async (_url: string, timeoutMs: number) => {
        const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
          const text = strings.join("");
          if (text.includes("txgio_parcel")) {
            return Promise.resolve([
              { county_fips: "48053", city_match: true, n: 55 },
              { county_fips: "48453", city_match: true, n: 45 },
            ]);
          }
          if (timeoutMs === 5_000) throw new Error("simulated store outage");
          void values;
          return Promise.resolve([]);
        }) as unknown as postgres.Sql;
        (sql as unknown as { end: (opts?: unknown) => Promise<void> }).end = async () => {};
        return sql;
      },
    });
    const verdict = await store.checkCoverage({ city: null, state: "TX", zip: "78654" });
    expect(verdict.status).toBe("indeterminate");
    if (verdict.status === "indeterminate") {
      expect(verdict.reason).toContain("simulated store outage");
      expect(verdict.candidates).toBeUndefined();
    }
  });
});
