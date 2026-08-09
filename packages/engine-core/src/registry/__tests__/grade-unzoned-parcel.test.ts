import { describe, expect, it, vi, beforeEach } from "vitest";

// Mocked BEFORE importing cert-grade-core.ts, which imports fetchBcadParcelRings
// + exteriorRingFromGeoJson + BASTROP_BCAD_PARCELS_URL from this exact module path.
// BASTROP_BCAD_PARCELS_URL must be the REAL constant (not mocked) — it is a
// plain string re-exported by lot-line-scrub.ts, and cert-grade-core.ts's
// resolveCadastralQueryUrl (fix/unzoned-cert-cadastral-url-param) compares
// against it directly, so a mocked-away value would break that fallback.
vi.mock("../../boundary-primitive/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../boundary-primitive/index.js")>(
    "../../boundary-primitive/index.js",
  );
  return {
    ...actual,
    fetchBcadParcelRings: vi.fn(),
    ringCentroidLngLat: vi.fn(() => [0, 0]),
  };
});

import { fetchBcadParcelRings, BASTROP_BCAD_PARCELS_URL } from "../../boundary-primitive/index.js";
import { gradeUnzonedParcel, UNZONED_CASCADE_DECLINE_CODE } from "../cert-grade-core.js";

const mockedFetchBcadParcelRings = vi.mocked(fetchBcadParcelRings);

const PARCEL = "48021:UNZONED-TEST-1";
const TXGIO_RING = [[0, 0], [1, 0], [1, 1], [0, 0]] as Array<[number, number]>;
const TXGIO_GEOMETRY = {
  type: "Polygon",
  coordinates: [TXGIO_RING],
};

/** Minimal fake `postgres` Sql tagged-template — dispatches by matching a
 * marker substring in the query's raw strings against a caller-provided
 * response table, mirroring the SELECT-by-entity_type idiom cert-grade-core
 * already uses (SELECT ... FROM atoms WHERE entity_type = '...'). */
function makeFakeSql(responses: {
  zoningFact?: unknown[];
  setbackRule?: unknown[];
  buildableEnvelope?: unknown[];
}) {
  const fn = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("entity_type = 'zoning-fact'")) {
      return Promise.resolve(responses.zoningFact ?? []);
    }
    if (text.includes("entity_type = 'setback-rule'")) {
      return Promise.resolve(responses.setbackRule ?? []);
    }
    if (text.includes("entity_type = 'buildable-envelope'")) {
      return Promise.resolve(responses.buildableEnvelope ?? []);
    }
    throw new Error(`makeFakeSql: unrecognized query: ${text}`);
  };
  return fn as unknown as import("postgres").Sql;
}

function makeFakeTxSql(responses: { geometry?: unknown | null }) {
  const fn = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("FROM txgio_parcel")) {
      return Promise.resolve(responses.geometry != null ? [{ geometry: responses.geometry }] : []);
    }
    throw new Error(`makeFakeTxSql: unrecognized query: ${text}`);
  };
  return fn as unknown as import("postgres").Sql;
}

const absenceZoningFactRow = {
  body: {
    entityType: "zoning-fact",
    parcelNodeId: PARCEL,
    district: null,
    absence: { kind: "no-zoning-stamp", reason: "no zoning polygon" },
  },
};

const districtZoningFactRow = {
  body: {
    entityType: "zoning-fact",
    parcelNodeId: PARCEL,
    district: "SF-1",
  },
};

const cascadeEnvelopeRow = {
  body: {
    entityType: "buildable-envelope",
    parcelNodeId: PARCEL,
    outcome: { kind: "no-buildable-area", reason: "unzoned jurisdiction — no district basis for setbacks or envelope" },
    warmVerifyDecline: "unzoned jurisdiction — no district basis for setbacks or envelope",
    warmVerifyDeclineCode: UNZONED_CASCADE_DECLINE_CODE,
  },
};

const wrongCodeEnvelopeRow = {
  body: {
    entityType: "buildable-envelope",
    parcelNodeId: PARCEL,
    warmVerifyDeclineCode: "some-other-decline-code",
  },
};

describe("gradeUnzonedParcel (--grade-mode=unzoned)", () => {
  beforeEach(() => {
    mockedFetchBcadParcelRings.mockReset();
  });

  it("verdict: district-present fails expected-unzoned-but-district-present", async () => {
    const sql = makeFakeSql({ zoningFact: [districtZoningFactRow] });
    const txSql = makeFakeTxSql({ geometry: TXGIO_GEOMETRY });
    const result = await gradeUnzonedParcel(PARCEL, { sql, txSql });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("expected-unzoned-but-district-present");
  });

  it("verdict: no zoning-fact at all also fails expected-unzoned-but-district-present", async () => {
    const sql = makeFakeSql({ zoningFact: [] });
    const txSql = makeFakeTxSql({ geometry: TXGIO_GEOMETRY });
    const result = await gradeUnzonedParcel(PARCEL, { sql, txSql });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("expected-unzoned-but-district-present");
  });

  it("verdict: setback-rule present on an absence parcel fails unexpected-setback-rule", async () => {
    const sql = makeFakeSql({
      zoningFact: [absenceZoningFactRow],
      setbackRule: [{ exists: 1 }],
    });
    const txSql = makeFakeTxSql({ geometry: TXGIO_GEOMETRY });
    const result = await gradeUnzonedParcel(PARCEL, { sql, txSql });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("unexpected-setback-rule");
  });

  it("verdict: no cascade envelope decline fails cascade-missing", async () => {
    const sql = makeFakeSql({
      zoningFact: [absenceZoningFactRow],
      setbackRule: [],
      buildableEnvelope: [],
    });
    const txSql = makeFakeTxSql({ geometry: TXGIO_GEOMETRY });
    const result = await gradeUnzonedParcel(PARCEL, { sql, txSql });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("cascade-missing");
  });

  it("verdict: envelope present but wrong decline code fails cascade-missing", async () => {
    const sql = makeFakeSql({
      zoningFact: [absenceZoningFactRow],
      setbackRule: [],
      buildableEnvelope: [wrongCodeEnvelopeRow],
    });
    const txSql = makeFakeTxSql({ geometry: TXGIO_GEOMETRY });
    const result = await gradeUnzonedParcel(PARCEL, { sql, txSql });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("cascade-missing");
  });

  it("verdict: txgio ring does not resolve fails cadastral-ring-unresolved", async () => {
    const sql = makeFakeSql({
      zoningFact: [absenceZoningFactRow],
      setbackRule: [],
      buildableEnvelope: [cascadeEnvelopeRow],
    });
    const txSql = makeFakeTxSql({ geometry: null });
    const result = await gradeUnzonedParcel(PARCEL, { sql, txSql });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("cadastral-ring-unresolved");
  });

  it("verdict: genuine absence + cascade present + txgio ring resolves => pass", async () => {
    const sql = makeFakeSql({
      zoningFact: [absenceZoningFactRow],
      setbackRule: [],
      buildableEnvelope: [cascadeEnvelopeRow],
    });
    const txSql = makeFakeTxSql({ geometry: TXGIO_GEOMETRY });
    mockedFetchBcadParcelRings.mockResolvedValueOnce([
      { propId: "UNZONED-TEST-1", ring: TXGIO_RING },
    ]);
    const result = await gradeUnzonedParcel(PARCEL, { sql, txSql });
    expect(result.pass).toBe(true);
    expect(result.honestDecline).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  describe("cadastralQueryUrl threading (BCAD divergence instrument only)", () => {
    it("Bastrop (48021) parcel with no cadastralQueryUrl configured falls back to BASTROP_BCAD_PARCELS_URL for divergence check", async () => {
      const sql = makeFakeSql({
        zoningFact: [absenceZoningFactRow],
        setbackRule: [],
        buildableEnvelope: [cascadeEnvelopeRow],
      });
      const txSql = makeFakeTxSql({ geometry: TXGIO_GEOMETRY });
      mockedFetchBcadParcelRings.mockResolvedValueOnce([
        { propId: "UNZONED-TEST-1", ring: TXGIO_RING },
      ]);
      const result = await gradeUnzonedParcel(PARCEL, { sql, txSql, cadastralQueryUrl: undefined });
      expect(result.pass).toBe(true);
      expect(mockedFetchBcadParcelRings).toHaveBeenCalledWith(
        ["UNZONED-TEST-1"],
        fetch,
        BASTROP_BCAD_PARCELS_URL,
        "prop_id",
      );
    });

    it("a configured cadastralQueryUrl is threaded through to fetchBcadParcelRings for divergence reporting", async () => {
      const OTHER_COUNTY_PARCEL = "48453:UNZONED-TEST-2"; // Travis
      const otherCountyAbsenceRow = {
        body: { ...absenceZoningFactRow.body, parcelNodeId: OTHER_COUNTY_PARCEL },
      };
      const otherCountyEnvelopeRow = {
        body: { ...cascadeEnvelopeRow.body, parcelNodeId: OTHER_COUNTY_PARCEL },
      };
      const travisUrl =
        "https://example.traviscad.example/arcgis/rest/services/Parcels/FeatureServer/0";
      const sql = makeFakeSql({
        zoningFact: [otherCountyAbsenceRow],
        setbackRule: [],
        buildableEnvelope: [otherCountyEnvelopeRow],
      });
      const txSql = makeFakeTxSql({ geometry: TXGIO_GEOMETRY });
      mockedFetchBcadParcelRings.mockResolvedValueOnce([
        { propId: "UNZONED-TEST-2", ring: TXGIO_RING },
      ]);
      const result = await gradeUnzonedParcel(OTHER_COUNTY_PARCEL, {
        sql,
        txSql,
        cadastralQueryUrl: travisUrl,
      });
      expect(result.pass).toBe(true);
      expect(mockedFetchBcadParcelRings).toHaveBeenCalledWith(
        ["UNZONED-TEST-2"],
        fetch,
        travisUrl,
        "prop_id",
      );
    });

    it("a non-Bastrop row with NO configured cadastralQueryUrl still passes when txgio ring resolves (BCAD divergence skipped)", async () => {
      const OTHER_COUNTY_PARCEL = "48453:UNZONED-TEST-3"; // Travis, no row URL configured
      const otherCountyAbsenceRow = {
        body: { ...absenceZoningFactRow.body, parcelNodeId: OTHER_COUNTY_PARCEL },
      };
      const otherCountyEnvelopeRow = {
        body: { ...cascadeEnvelopeRow.body, parcelNodeId: OTHER_COUNTY_PARCEL },
      };
      const sql = makeFakeSql({
        zoningFact: [otherCountyAbsenceRow],
        setbackRule: [],
        buildableEnvelope: [otherCountyEnvelopeRow],
      });
      const txSql = makeFakeTxSql({ geometry: TXGIO_GEOMETRY });
      const result = await gradeUnzonedParcel(OTHER_COUNTY_PARCEL, {
        sql,
        txSql,
        cadastralQueryUrl: undefined,
      });
      expect(result.pass).toBe(true);
      expect(mockedFetchBcadParcelRings).not.toHaveBeenCalled();
    });
  });
});
