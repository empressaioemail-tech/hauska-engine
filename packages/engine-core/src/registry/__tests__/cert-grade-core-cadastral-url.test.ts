import { describe, expect, it, vi, beforeEach } from "vitest";

// Mocked BEFORE importing cert-grade-core.ts, which imports fetchBcadParcelRings
// + scrubLotLineRing + BASTROP_BCAD_PARCELS_URL from this exact module path.
// Mirrors the pattern in grade-unzoned-parcel.test.ts.
vi.mock("../../boundary-primitive/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../boundary-primitive/index.js")>(
    "../../boundary-primitive/index.js",
  );
  return {
    ...actual,
    fetchBcadParcelRings: vi.fn(),
    scrubLotLineRing: vi.fn((ring: unknown) => ring),
    ringCentroidLngLat: vi.fn(() => [0, 0]),
  };
});

import { fetchBcadParcelRings, BASTROP_BCAD_PARCELS_URL } from "../../boundary-primitive/index.js";
import {
  gradeOneParcelInQueryMode,
  gradeBlock13Parcel,
  resolveCadastralQueryUrl,
  CERT_GRADE_COUNTY_FIPS,
} from "../cert-grade-core.js";

const mockedFetchBcadParcelRings = vi.mocked(fetchBcadParcelRings);

describe("resolveCadastralQueryUrl (fix/unzoned-cert-cadastral-url-param)", () => {
  it("returns the explicit URL when one is supplied, regardless of fips", () => {
    const url = "https://example.county.example/arcgis/rest/services/Parcels/FeatureServer/0";
    expect(resolveCadastralQueryUrl("48021:1", url)).toBe(url);
    expect(resolveCadastralQueryUrl("48453:1", url)).toBe(url);
  });

  it("falls back to BASTROP_BCAD_PARCELS_URL for a 48021 (Bastrop) parcel with no explicit URL (legacy back-compat default)", () => {
    expect(resolveCadastralQueryUrl(`${CERT_GRADE_COUNTY_FIPS}:12345`, undefined)).toBe(
      BASTROP_BCAD_PARCELS_URL,
    );
    expect(resolveCadastralQueryUrl(`${CERT_GRADE_COUNTY_FIPS}:12345`, null)).toBe(
      BASTROP_BCAD_PARCELS_URL,
    );
  });

  it("throws a named error for a non-Bastrop parcel with no explicit URL — never silently defaults to Bastrop's endpoint", () => {
    expect(() => resolveCadastralQueryUrl("48453:99999", undefined)).toThrow(
      /cadastral query URL not configured for row/,
    );
    expect(() => resolveCadastralQueryUrl("48453:99999", undefined)).toThrow(/48453:99999/);
    expect(() => resolveCadastralQueryUrl("48453:99999", null)).toThrow(
      /cadastral query URL not configured/,
    );
  });
});

describe("gradeOneParcelInQueryMode cadastralQueryUrl threading", () => {
  beforeEach(() => {
    mockedFetchBcadParcelRings.mockReset();
  });

  it("a non-Bastrop parcel with no cadastralQueryUrl throws loud BEFORE any sql call (fail-closed, not a silent Bastrop default)", async () => {
    const sql = vi.fn(() => {
      throw new Error("sql should never be called — the URL check must short-circuit first");
    }) as unknown as import("postgres").Sql;

    await expect(
      gradeOneParcelInQueryMode("48453:99999", {
        sql,
        txSql: sql,
        storage: {} as never,
        roads: [],
        descriptor: {},
        districtPrefix: null,
      }),
    ).rejects.toThrow(/cadastral query URL not configured/);
  });

  it("a configured cadastralQueryUrl is threaded through to fetchBcadParcelRings for a non-Bastrop row", async () => {
    const OTHER_PARCEL = "48453:99999";
    const travisUrl = "https://example.traviscad.example/arcgis/rest/services/Parcels/FeatureServer/0";

    // Minimal fake sql: honest-decline at the earliest possible gate
    // (no-zoning-fact-on-substrate) so the test exercises only the ring
    // fetch call, not the full gradeAgainstKey pipeline.
    const sql = ((strings: TemplateStringsArray) => {
      const text = strings.join("?");
      if (text.includes("entity_type = 'buildable-envelope'")) return Promise.resolve([]);
      if (text.includes("entity_type = 'zoning-fact'")) return Promise.resolve([]);
      throw new Error(`unexpected query: ${text}`);
    }) as unknown as import("postgres").Sql;

    const result = await gradeOneParcelInQueryMode(OTHER_PARCEL, {
      sql,
      txSql: sql,
      storage: {} as never,
      roads: [],
      descriptor: {},
      districtPrefix: null,
      cadastralQueryUrl: travisUrl,
    });

    // Honest-decline path (no zoning-fact on substrate) returns before ever
    // reaching fetchBcadParcelRings — this test's purpose is to prove the
    // URL check does NOT throw when a URL is configured; the ring fetch
    // itself is exercised end-to-end by the gradeUnzonedParcel tests.
    expect(result.pass).toBe(true);
    expect(result.honestDecline).toBe(true);
    expect(mockedFetchBcadParcelRings).not.toHaveBeenCalled();
  });
});

describe("gradeBlock13Parcel cadastralQueryUrl threading (Bastrop default pin)", () => {
  beforeEach(() => {
    mockedFetchBcadParcelRings.mockReset();
  });

  it("a Block13-roster (48021) parcel with no explicit cadastralQueryUrl still resolves via the legacy Bastrop default — never throws", async () => {
    // resolveBlock13Key fails fast for an unknown parcel id, which is fine —
    // this test only proves the URL resolution step (which runs before the
    // key lookup) does not throw for a 48021 parcel with no explicit URL.
    const sql = {} as unknown as import("postgres").Sql;
    const result = await gradeBlock13Parcel("48021:not-in-answer-key", {
      sql,
      txSql: sql,
      storage: {} as never,
      roads: [],
      descriptor: {},
    });
    expect(result.error).toBe("not in BLOCK13 answer key");
  });
});
