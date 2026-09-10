import { describe, expect, it } from "vitest";

import {
  planCountySpecialDistricts,
  attachComptrollerTaxRates,
} from "../plan-county-special-districts.js";
import type { SpecialDistrictFeature } from "../geo.js";

describe("planCountySpecialDistricts", () => {
  // A real square TCEQ MUD polygon covering roughly
  // lng [-97.5, -97.4] x lat [30.0, 30.1].
  const mud: SpecialDistrictFeature = {
    districtRowId: "row-1",
    districtId: "TCEQ-MUD-1",
    districtName: "Test Municipal Utility District 1",
    districtType: "MUD",
    countyFips: "48021",
    status: "active",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-97.5, 30.0],
          [-97.4, 30.0],
          [-97.4, 30.1],
          [-97.5, 30.1],
          [-97.5, 30.0],
        ],
      ],
    },
    westLng: -97.5,
    southLat: 30.0,
    eastLng: -97.4,
    northLat: 30.1,
  };

  it("plans a present membership when the parcel centroid lies inside a real district polygon", () => {
    const plan = planCountySpecialDistricts(
      [{ parcelKey: "1001", centroid: [-97.45, 30.05] }],
      [mud],
      { countyFips: "48021" },
    );

    // Non-vacuity: this must reach the real "present" branch with the
    // actual district identity, not merely "not throw" or "be defined".
    expect(plan.counts.presentMemberships).toBe(1);
    expect(plan.counts.parcelsInDistrict).toBe(1);
    expect(plan.emptyDistrictIndex).toBe(false);
    const row = plan.planned[0];
    expect(row?.outcome).toBe("present");
    if (row?.outcome === "present") {
      expect(row.districtId).toBe("TCEQ-MUD-1");
      expect(row.districtName).toBe("Test Municipal Utility District 1");
      expect(row.districtType).toBe("MUD");
      expect(row.countyFips).toBe("48021");
    }
  });

  it("enriches a present membership with a comptroller tax rate when the lookup hits", () => {
    const plan = planCountySpecialDistricts(
      [{ parcelKey: "1001", centroid: [-97.45, 30.05] }],
      [mud],
      {
        countyFips: "48021",
        taxLookup: (countyFips, districtType, districtName) => {
          if (
            countyFips === "48021" &&
            districtType === "MUD" &&
            districtName === "Test Municipal Utility District 1"
          ) {
            return {
              totalRatePc: 0.45,
              reportYear: 2025,
              registrySpdPublId: "SPD-1",
              source: "comptroller-spdpid",
            };
          }
          return undefined;
        },
      },
    );

    expect(plan.counts.rateEnrichedCount).toBe(1);
    const row = plan.planned[0];
    expect(row?.outcome).toBe("present");
    if (row?.outcome === "present") {
      expect(row.taxRate?.totalRatePc).toBe(0.45);
      expect(row.taxRate?.registrySpdPublId).toBe("SPD-1");
    }
  });

  it("attachComptrollerTaxRates enriches an already-planned present row post hoc", () => {
    const plan = planCountySpecialDistricts(
      [{ parcelKey: "1001", centroid: [-97.45, 30.05] }],
      [mud],
      { countyFips: "48021" },
    );
    expect(plan.counts.rateEnrichedCount).toBe(0);

    const enriched = attachComptrollerTaxRates(plan, () => ({
      totalRatePc: 0.9,
      reportYear: 2024,
      registrySpdPublId: "SPD-9",
      source: "comptroller-spdpid",
    }));

    expect(enriched.counts.rateEnrichedCount).toBe(1);
    const row = enriched.planned[0];
    expect(row?.outcome).toBe("present");
    if (row?.outcome === "present") {
      expect(row.taxRate?.totalRatePc).toBe(0.9);
    }
  });

  it("plans absent-outside when the centroid misses every district polygon", () => {
    const plan = planCountySpecialDistricts(
      [{ parcelKey: "2002", centroid: [-90.0, 25.0] }],
      [mud],
      { countyFips: "48021" },
    );
    expect(plan.counts.parcelsOutside).toBe(1);
    expect(plan.counts.absentOutside).toBe(1);
    expect(plan.planned[0]?.outcome).toBe("absent");
    if (plan.planned[0]?.outcome === "absent") {
      expect(plan.planned[0].absenceKind).toBe(
        "outside-tceq-source-boundaries",
      );
    }
  });

  it("positive zero-district determination when the county district index is empty", () => {
    const plan = planCountySpecialDistricts(
      [{ parcelKey: "3003", centroid: [-97.45, 30.05] }],
      [],
      { countyFips: "48113" },
    );
    expect(plan.emptyDistrictIndex).toBe(true);
    expect(plan.counts.absentOutside).toBe(1);
    expect(plan.counts.presentMemberships).toBe(0);
  });
});
