import { describe, it, expect } from "vitest";

import { buildParcelAdjacencyIndex } from "../../boundary-primitive/index.js";
import type { ParcelIndexEntry } from "../../boundary-primitive/types.js";
import {
  PARCEL_34073_BCAD,
  PARCEL_34081_BCAD,
  PARCEL_105054_BCAD,
} from "../../boundary-primitive/fixtures/bastropDowntownDrill.js";
import { BASTROP_REGISTRY_ROW, BASTROP_COUNTY_UNINCORPORATED_REGISTRY_ROW } from "../../registry/jurisdiction-registry.js";
import { classifyNeighborConsistency, type ParcelZoningState } from "../neighbor-consistency.js";

const COUNTY_FIPS = "48021";
const FIXED_NOW = () => new Date("2026-08-04T00:00:00.000Z");

/** Three real, mutually-adjacent BDC downtown-drill parcels: 34073 (center), 34081 (south neighbor), 105054 (north neighbor). */
function buildThreeParcelIndex() {
  const entries: ParcelIndexEntry[] = [
    {
      countyFips: COUNTY_FIPS,
      propId: "34073",
      parcelNodeId: `${COUNTY_FIPS}:34073`,
      ring: PARCEL_34073_BCAD,
      westLng: -97.3169,
      southLat: 30.111,
      eastLng: -97.3163,
      northLat: 30.1114,
    },
    {
      countyFips: COUNTY_FIPS,
      propId: "34081",
      parcelNodeId: `${COUNTY_FIPS}:34081`,
      ring: PARCEL_34081_BCAD,
      westLng: -97.3168,
      southLat: 30.1109,
      eastLng: -97.3163,
      northLat: 30.1111,
    },
    {
      countyFips: COUNTY_FIPS,
      propId: "105054",
      parcelNodeId: `${COUNTY_FIPS}:105054`,
      ring: PARCEL_105054_BCAD,
      westLng: -97.3169,
      southLat: 30.1113,
      eastLng: -97.3163,
      northLat: 30.1116,
    },
  ];
  return buildParcelAdjacencyIndex(COUNTY_FIPS, entries);
}

function zoningMap(entries: ParcelZoningState[]): Map<string, ParcelZoningState> {
  return new Map(entries.map((e) => [e.parcelNodeId, e]));
}

describe("classifyNeighborConsistency", () => {
  it("legitimate boundary — different valid districts adjacent — never flags", () => {
    const index = buildThreeParcelIndex();
    const zoningByParcel = zoningMap([
      { parcelNodeId: `${COUNTY_FIPS}:34073`, propId: "34073", district: "SF-1" },
      { parcelNodeId: `${COUNTY_FIPS}:34081`, propId: "34081", district: "GC" },
      { parcelNodeId: `${COUNTY_FIPS}:105054`, propId: "105054", district: "MU" },
    ]);
    const findings = classifyNeighborConsistency({
      sweepId: "test-sweep",
      fips: COUNTY_FIPS,
      rowId: "Bastrop",
      row: BASTROP_REGISTRY_ROW,
      index,
      zoningByParcel,
      cohortParcelNodeIds: [`${COUNTY_FIPS}:34073`, `${COUNTY_FIPS}:34081`, `${COUNTY_FIPS}:105054`],
      now: FIXED_NOW,
    });
    expect(findings).toHaveLength(0);
  });

  it("repealed/renamed code — district not in current roster — flags MIXED-VINTAGE-NEIGHBOR", () => {
    const index = buildThreeParcelIndex();
    const zoningByParcel = zoningMap([
      { parcelNodeId: `${COUNTY_FIPS}:34073`, propId: "34073", district: "P-5" }, // not in BASTROP_REGISTRY_ROW roster
      { parcelNodeId: `${COUNTY_FIPS}:34081`, propId: "34081", district: "SF-1" },
      { parcelNodeId: `${COUNTY_FIPS}:105054`, propId: "105054", district: "SF-1" },
    ]);
    const findings = classifyNeighborConsistency({
      sweepId: "test-sweep",
      fips: COUNTY_FIPS,
      rowId: "Bastrop",
      row: BASTROP_REGISTRY_ROW,
      index,
      zoningByParcel,
      cohortParcelNodeIds: [`${COUNTY_FIPS}:34073`, `${COUNTY_FIPS}:34081`, `${COUNTY_FIPS}:105054`],
      now: FIXED_NOW,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.defectClass).toBe("MIXED-VINTAGE-NEIGHBOR");
    expect(findings[0]!.severity).toBe("flag");
    expect(findings[0]!.parcelNodeId).toBe(`${COUNTY_FIPS}:34073`);
    expect(findings[0]!.evidence.currentRoster).not.toContain("P-5");
  });

  it("patchy absence — an absent parcel whose neighbors are >= 75% districted — flags", () => {
    const index = buildThreeParcelIndex();
    const zoningByParcel = zoningMap([
      { parcelNodeId: `${COUNTY_FIPS}:34073`, propId: "34073", district: null }, // absent, but both neighbors districted (100%)
      { parcelNodeId: `${COUNTY_FIPS}:34081`, propId: "34081", district: "SF-1" },
      { parcelNodeId: `${COUNTY_FIPS}:105054`, propId: "105054", district: "SF-1" },
    ]);
    const findings = classifyNeighborConsistency({
      sweepId: "test-sweep",
      fips: COUNTY_FIPS,
      rowId: "Bastrop",
      row: BASTROP_REGISTRY_ROW,
      index,
      zoningByParcel,
      cohortParcelNodeIds: [`${COUNTY_FIPS}:34073`],
      now: FIXED_NOW,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.defectClass).toBe("MIXED-VINTAGE-NEIGHBOR");
    expect(findings[0]!.evidence.districtedFraction).toBe(1);
  });

  it("uniform absence in an unzoned county cohort — never flags (honest-absence is the expected pass state)", () => {
    const index = buildThreeParcelIndex();
    const zoningByParcel = zoningMap([
      { parcelNodeId: `${COUNTY_FIPS}:34073`, propId: "34073", district: null },
      { parcelNodeId: `${COUNTY_FIPS}:34081`, propId: "34081", district: null },
      { parcelNodeId: `${COUNTY_FIPS}:105054`, propId: "105054", district: null },
    ]);
    const findings = classifyNeighborConsistency({
      sweepId: "test-sweep",
      fips: COUNTY_FIPS,
      rowId: "Bastrop County (unincorporated)",
      row: BASTROP_COUNTY_UNINCORPORATED_REGISTRY_ROW,
      index,
      zoningByParcel,
      cohortParcelNodeIds: [`${COUNTY_FIPS}:34073`, `${COUNTY_FIPS}:34081`, `${COUNTY_FIPS}:105054`],
      now: FIXED_NOW,
    });
    expect(findings).toHaveLength(0);
  });

  it("patchy absence below threshold — does not flag", () => {
    const index = buildThreeParcelIndex();
    const zoningByParcel = zoningMap([
      { parcelNodeId: `${COUNTY_FIPS}:34073`, propId: "34073", district: null },
      { parcelNodeId: `${COUNTY_FIPS}:34081`, propId: "34081", district: "SF-1" },
      { parcelNodeId: `${COUNTY_FIPS}:105054`, propId: "105054", district: null },
    ]);
    const findings = classifyNeighborConsistency({
      sweepId: "test-sweep",
      fips: COUNTY_FIPS,
      rowId: "Bastrop",
      row: BASTROP_REGISTRY_ROW,
      index,
      zoningByParcel,
      cohortParcelNodeIds: [`${COUNTY_FIPS}:34073`],
      now: FIXED_NOW,
    });
    // Only 1 of 2 neighbors districted = 50%, below the default 75% threshold.
    expect(findings).toHaveLength(0);
  });

  it("calibration fix (dedup) — a parcel visited twice in cohortParcelNodeIds (e.g. duplicate ArcGIS pagination entry) produces exactly ONE finding, not one per visit", () => {
    const index = buildThreeParcelIndex();
    const zoningByParcel = zoningMap([
      { parcelNodeId: `${COUNTY_FIPS}:34073`, propId: "34073", district: "P-5" }, // roster drift
      { parcelNodeId: `${COUNTY_FIPS}:34081`, propId: "34081", district: "SF-1" },
      { parcelNodeId: `${COUNTY_FIPS}:105054`, propId: "105054", district: "SF-1" },
    ]);
    const findings = classifyNeighborConsistency({
      sweepId: "test-sweep",
      fips: COUNTY_FIPS,
      rowId: "Bastrop",
      row: BASTROP_REGISTRY_ROW,
      index,
      zoningByParcel,
      // The SAME parcel appears three times — reproduces a duplicate cohort
      // entry (e.g. an ArcGIS pagination-boundary repeat) that previously
      // produced one finding per repeat.
      cohortParcelNodeIds: [
        `${COUNTY_FIPS}:34073`,
        `${COUNTY_FIPS}:34073`,
        `${COUNTY_FIPS}:34081`,
        `${COUNTY_FIPS}:105054`,
        `${COUNTY_FIPS}:34073`,
      ],
      now: FIXED_NOW,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.parcelNodeId).toBe(`${COUNTY_FIPS}:34073`);
    expect(findings[0]!.defectClass).toBe("MIXED-VINTAGE-NEIGHBOR");
    // Every visit's neighbor observation is still present (unioned, not dropped).
    const neighborIds = (findings[0]!.evidence.neighbors as Array<{ parcelNodeId: string }>).map((n) => n.parcelNodeId);
    expect(neighborIds).toContain(`${COUNTY_FIPS}:34081`);
    expect(neighborIds).toContain(`${COUNTY_FIPS}:105054`);
    // No duplicate neighbor entries despite three visits.
    expect(new Set(neighborIds).size).toBe(neighborIds.length);
  });

  it("calibration fix (dedup) — two DISTINCT flagged parcels each still produce their own single finding (dedup is per-parcel, not global)", () => {
    const index = buildThreeParcelIndex();
    const zoningByParcel = zoningMap([
      { parcelNodeId: `${COUNTY_FIPS}:34073`, propId: "34073", district: "P-5" }, // roster drift #1
      { parcelNodeId: `${COUNTY_FIPS}:34081`, propId: "34081", district: "P-2" }, // roster drift #2
      { parcelNodeId: `${COUNTY_FIPS}:105054`, propId: "105054", district: "SF-1" },
    ]);
    const findings = classifyNeighborConsistency({
      sweepId: "test-sweep",
      fips: COUNTY_FIPS,
      rowId: "Bastrop",
      row: BASTROP_REGISTRY_ROW,
      index,
      zoningByParcel,
      cohortParcelNodeIds: [
        `${COUNTY_FIPS}:34073`,
        `${COUNTY_FIPS}:34081`,
        `${COUNTY_FIPS}:34073`,
        `${COUNTY_FIPS}:105054`,
      ],
      now: FIXED_NOW,
    });
    expect(findings).toHaveLength(2);
    const byParcel = new Map(findings.map((f) => [f.parcelNodeId, f]));
    expect(byParcel.has(`${COUNTY_FIPS}:34073`)).toBe(true);
    expect(byParcel.has(`${COUNTY_FIPS}:34081`)).toBe(true);
  });
});
