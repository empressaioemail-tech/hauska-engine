import { describe, expect, it } from "vitest";

import {
  assertNamedAbsence,
  classifyCountyEasement,
  classifyParcelRail,
  COUNTY_EASEMENT_NOT_T3,
  EMPTY_RAIL,
  IN_CITY_NOT_APPLICABLE,
  L7_VOCAB_ON_PARCEL,
  nameParcelRails,
  T3_EASEMENT_EVALUATED_AT,
  unincorporatedOnly,
  VALUE_NOT_ABSENCE,
} from "../rail-absence.js";

const closeNone = {
  finding: "none-found" as const,
  evaluatedAt: "2026-08-05T19:30:00.000Z",
  sourceCatalog: "t3-four-point",
};

const closeUnprobed = {
  finding: "unprobed" as const,
  evaluatedAt: "2026-09-01T00:00:00.000Z",
  sourceCatalog: "none",
};

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "NO_THROW";
  } catch (e) {
    return (e as { code?: string }).code ?? "NO_CODE";
  }
}

describe("classifyParcelRail", () => {
  it("unincorporated setbacks/edges/envelope are not-applicable", () => {
    for (const rail of ["setbacks", "edges", "envelope"] as const) {
      const row = classifyParcelRail({
        rail,
        incorporation: "unincorporated",
        landedTable: false,
        collectClose: closeUnprobed,
        parcelNodeId: "48055:RURAL-1",
        containmentTotal: 357269,
      });
      expect(row.state).toBe("not-applicable");
      expect(row.incorporation).toBe("unincorporated");
      expect(unincorporatedOnly(row)).toBe("unincorporated");
      expect(JSON.stringify(row)).not.toContain("357269");
    }
  });

  it("in-city with no landed table is unmeasured, never not-applicable", () => {
    const row = classifyParcelRail({
      rail: "setbacks",
      incorporation: "in-city",
      landedTable: false,
      collectClose: closeUnprobed,
      parcelNodeId: "48021:INCITY-NOTABLE",
      containmentTotal: 357269,
    });
    expect(row.state).toBe("unmeasured");
    expect(row.incorporation).toBe("in-city");
    expect(row.landedTable).toBe(false);
    expect(JSON.stringify(row)).not.toContain("357269");
  });

  it("in-city emitOverride not-applicable is IN_CITY_NOT_APPLICABLE", () => {
    expect(
      codeOf(() =>
        classifyParcelRail({
          rail: "setbacks",
          incorporation: "in-city",
          landedTable: false,
          collectClose: closeUnprobed,
          parcelNodeId: "48021:INCITY-NOTABLE",
          emitOverride: "not-applicable",
        }),
      ),
    ).toBe(IN_CITY_NOT_APPLICABLE);
  });

  it("in-city landed table and none-found is absent-verified", () => {
    const row = classifyParcelRail({
      rail: "setbacks",
      incorporation: "in-city",
      landedTable: true,
      collectClose: closeNone,
      parcelNodeId: "48021:INCITY-PROBED",
    });
    expect(row.state).toBe("absent-verified");
    expect(row.probed).toBe(true);
  });

  it("source-present is VALUE_NOT_ABSENCE", () => {
    expect(
      codeOf(() =>
        classifyParcelRail({
          rail: "setbacks",
          incorporation: "in-city",
          landedTable: true,
          collectClose: { ...closeNone, finding: "source-present" },
          parcelNodeId: "48021:HAS-TABLE",
        }),
      ),
    ).toBe(VALUE_NOT_ABSENCE);
  });

  it("L7 satisfied-absent is refused", () => {
    expect(
      codeOf(() =>
        classifyParcelRail({
          rail: "setbacks",
          incorporation: "unincorporated",
          landedTable: false,
          collectClose: closeUnprobed,
          parcelNodeId: "48055:RURAL-1",
          emitOverride: "satisfied-absent" as "not-applicable",
        }),
      ),
    ).toBe(L7_VOCAB_ON_PARCEL);
  });
});

describe("classifyCountyEasement", () => {
  it("T3 four counties are absent-verified at the T3 asOf", () => {
    for (const fips of ["48021", "48055", "48209", "48491"] as const) {
      const row = classifyCountyEasement({ countyFips: fips, collectClose: closeNone });
      expect(row.state).toBe("absent-verified");
      expect(row.rail).toBe("utility-easement");
      expect(row.evaluatedAt).toBe(T3_EASEMENT_EVALUATED_AT);
    }
  });

  it("McLennan 48309 is COUNTY_EASEMENT_NOT_T3", () => {
    expect(codeOf(() => classifyCountyEasement({ countyFips: "48309", collectClose: closeNone }))).toBe(
      COUNTY_EASEMENT_NOT_T3,
    );
  });
});

describe("nameParcelRails / assertNamedAbsence", () => {
  it("Caldwell rural names county-absence and zoning not-applicable", () => {
    const parcelNodeId = "48055:RURAL-1";
    const rows = [
      classifyParcelRail({
        rail: "setbacks",
        incorporation: "unincorporated",
        landedTable: false,
        collectClose: closeUnprobed,
        parcelNodeId,
      }),
      classifyParcelRail({
        rail: "edges",
        incorporation: "unincorporated",
        landedTable: false,
        collectClose: closeUnprobed,
        parcelNodeId,
      }),
      classifyParcelRail({
        rail: "envelope",
        incorporation: "unincorporated",
        landedTable: false,
        collectClose: closeUnprobed,
        parcelNodeId,
      }),
      classifyCountyEasement({ countyFips: "48055", collectClose: closeNone }),
    ];
    const named = nameParcelRails(rows, parcelNodeId);
    expect(assertNamedAbsence(named, "setbacks").verdict).toBe("not-applicable");
    expect(assertNamedAbsence(named, "utility-easement").verdict).toBe("absent-verified");
    expect(assertNamedAbsence(named, "utility-easement").countyAbsence).toBe(true);
    expect(assertNamedAbsence(named, "utility-easement").basis).toContain(parcelNodeId);
  });

  it("missing easement rail is EMPTY_RAIL", () => {
    const parcelNodeId = "48055:RURAL-1";
    const named = nameParcelRails(
      [
        classifyParcelRail({
          rail: "setbacks",
          incorporation: "unincorporated",
          landedTable: false,
          collectClose: closeUnprobed,
          parcelNodeId,
        }),
      ],
      parcelNodeId,
    );
    expect(codeOf(() => assertNamedAbsence(named, "utility-easement"))).toBe(EMPTY_RAIL);
  });
});
