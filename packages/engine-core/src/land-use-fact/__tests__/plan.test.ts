import { describe, expect, it } from "vitest";

import { planCountyLandUseFacts } from "../plan-county-land-use-facts.js";
import type { LandUseCadRowInput, LandUseParcelInput } from "../plan-county-land-use-facts.js";

describe("planCountyLandUseFacts", () => {
  it("plans a real present row with a non-blank land-use code for a non-hold county with a matching CAD row", () => {
    // 48021 (Travis) is not in LANDUSE_JOIN_HOLD_FIPS (only Hays/Williamson
    // are held), and the CAD row below carries a real, non-blank
    // property_use_code at the declared taxYear — this SHOULD reach present.
    const parcels: LandUseParcelInput[] = [{ parcelKey: "31362" }];
    const cadRows: LandUseCadRowInput[] = [
      {
        propId: "31362",
        taxYear: 2026,
        propertyUseCode: "A1",
        sourceVintage: "2026-tax-roll",
      },
    ];

    const plan = planCountyLandUseFacts(parcels, cadRows, {
      countyFips: "48021",
      taxYear: 2026,
    });

    expect(plan.hold).toBe(false);
    expect(plan.counts.present).toBe(1);
    expect(plan.counts.absent).toBe(0);
    const row = plan.planned[0];
    expect(row?.outcome).toBe("present");
    if (row?.outcome === "present") {
      expect(row.landUseCode).toBe("A1");
      expect(row.taxYear).toBe(2026);
      expect(row.sourceVintage).toBe("2026-tax-roll");
    }
  });

  it("plans join-hold absence (not present) for a LANDUSE_JOIN_HOLD county with the identical CAD row", () => {
    // Sanity contrast: same real parcel+CAD data, but for a held county
    // (48209, in LANDUSE_JOIN_HOLD_FIPS), must NOT reach present.
    const parcels: LandUseParcelInput[] = [{ parcelKey: "31362" }];
    const cadRows: LandUseCadRowInput[] = [
      { propId: "31362", taxYear: 2026, propertyUseCode: "A1" },
    ];

    const plan = planCountyLandUseFacts(parcels, cadRows, {
      countyFips: "48209",
      taxYear: 2026,
    });

    expect(plan.hold).toBe(true);
    expect(plan.counts.present).toBe(0);
    expect(plan.planned[0]?.outcome).toBe("absent");
    if (plan.planned[0]?.outcome === "absent") {
      expect(plan.planned[0].absenceKind).toBe("join-hold");
    }
  });
});
