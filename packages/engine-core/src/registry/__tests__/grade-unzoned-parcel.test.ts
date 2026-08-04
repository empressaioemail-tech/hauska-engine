import { describe, expect, it, vi, beforeEach } from "vitest";

// Mocked BEFORE importing cert-grade-core.ts, which imports fetchBcadParcelRings
// + scrubLotLineRing from this exact module path.
vi.mock("../../boundary-primitive/index.js", () => ({
  fetchBcadParcelRings: vi.fn(),
  scrubLotLineRing: vi.fn((ring: unknown) => ring),
  ringCentroidLngLat: vi.fn(() => [0, 0]),
}));

import { fetchBcadParcelRings } from "../../boundary-primitive/index.js";
import { gradeUnzonedParcel, UNZONED_CASCADE_DECLINE_CODE } from "../cert-grade-core.js";

const mockedFetchBcadParcelRings = vi.mocked(fetchBcadParcelRings);

const PARCEL = "48021:UNZONED-TEST-1";

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
    const result = await gradeUnzonedParcel(PARCEL, { sql });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("expected-unzoned-but-district-present");
  });

  it("verdict: no zoning-fact at all also fails expected-unzoned-but-district-present", async () => {
    const sql = makeFakeSql({ zoningFact: [] });
    const result = await gradeUnzonedParcel(PARCEL, { sql });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("expected-unzoned-but-district-present");
  });

  it("verdict: setback-rule present on an absence parcel fails unexpected-setback-rule", async () => {
    const sql = makeFakeSql({
      zoningFact: [absenceZoningFactRow],
      setbackRule: [{ exists: 1 }],
    });
    const result = await gradeUnzonedParcel(PARCEL, { sql });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("unexpected-setback-rule");
  });

  it("verdict: no cascade envelope decline fails cascade-missing", async () => {
    const sql = makeFakeSql({
      zoningFact: [absenceZoningFactRow],
      setbackRule: [],
      buildableEnvelope: [],
    });
    const result = await gradeUnzonedParcel(PARCEL, { sql });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("cascade-missing");
  });

  it("verdict: envelope present but wrong decline code fails cascade-missing", async () => {
    const sql = makeFakeSql({
      zoningFact: [absenceZoningFactRow],
      setbackRule: [],
      buildableEnvelope: [wrongCodeEnvelopeRow],
    });
    const result = await gradeUnzonedParcel(PARCEL, { sql });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("cascade-missing");
  });

  it("verdict: cadastral ring does not resolve fails cadastral-ring-unresolved", async () => {
    const sql = makeFakeSql({
      zoningFact: [absenceZoningFactRow],
      setbackRule: [],
      buildableEnvelope: [cascadeEnvelopeRow],
    });
    mockedFetchBcadParcelRings.mockResolvedValueOnce([]);
    const result = await gradeUnzonedParcel(PARCEL, { sql });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("cadastral-ring-unresolved");
  });

  it("verdict: genuine absence + cascade present + ring resolves => pass", async () => {
    const sql = makeFakeSql({
      zoningFact: [absenceZoningFactRow],
      setbackRule: [],
      buildableEnvelope: [cascadeEnvelopeRow],
    });
    mockedFetchBcadParcelRings.mockResolvedValueOnce([
      { propId: "UNZONED-TEST-1", ring: [[0, 0], [1, 0], [1, 1], [0, 0]] },
    ]);
    const result = await gradeUnzonedParcel(PARCEL, { sql });
    expect(result.pass).toBe(true);
    expect(result.honestDecline).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});
