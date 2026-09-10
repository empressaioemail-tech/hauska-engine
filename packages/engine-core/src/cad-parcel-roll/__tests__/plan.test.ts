import { describe, expect, it } from "vitest";

import { planCountyCadParcelRoll } from "../plan-county-cad-parcel-roll.js";
import type { CadPropertyRowInput } from "../plan-county-cad-parcel-roll.js";

describe("planCountyCadParcelRoll", () => {
  it("plans a real present row with claim fields for a non-hold county", () => {
    // 48021 (Travis) is neither in CROSSWALK_HOLD_FIPS nor LANDUSE_JOIN_HOLD_FIPS,
    // and the row below carries real claim fields, so this SHOULD reach the
    // present branch, not just "doesn't throw".
    const row: CadPropertyRowInput = {
      countyFips: "48021",
      propId: "31362",
      taxYear: 2026,
      sourceFile: "travis_2026_cad_property.csv",
      sourceVintage: "2026-tax-roll",
      situsAddress: "123 Main St",
      situsCity: "Austin",
      situsZip: "78701",
      legalDescription: "LOT 1 BLK A JONES HIGGINS ADDN",
      landValue: 100000,
      improvementValue: 250000,
      marketValue: 350000,
      assessedValue: 340000,
      yearBuilt: 1998,
      livingAreaSqft: 2100,
      landAcres: "0.25",
      propertyUseCode: "A1",
    };

    const plan = planCountyCadParcelRoll([row], { countyFips: "48021" });

    expect(plan.hold).toBe(false);
    expect(plan.counts.present).toBe(1);
    const planned = plan.planned[0];
    expect(planned?.outcome).toBe("present");
    if (planned?.outcome === "present") {
      expect(planned.joinPassedOwnerMatchGate).toBe(true);
      expect(planned.parcelKey).toBe("31362");
      expect(planned.situsAddress).toBe("123 Main St");
      expect(planned.marketValue).toBe(350000);
    }
  });

  it("plans join-hold absence (not present) for a CROSSWALK_HOLD county with the same real claim fields", () => {
    // Sanity contrast: the identical realistic row, but for a hold county
    // (48453, in CROSSWALK_HOLD_FIPS), must NOT reach present — proving the
    // present branch above is gated on real logic, not always-on.
    const row: CadPropertyRowInput = {
      countyFips: "48453",
      propId: "31362",
      taxYear: 2026,
      sourceFile: "travis_2026_cad_property.csv",
      sourceVintage: "2026-tax-roll",
      situsAddress: "123 Main St",
      marketValue: 350000,
    };

    const plan = planCountyCadParcelRoll([row], { countyFips: "48453" });

    expect(plan.hold).toBe(true);
    expect(plan.counts.present).toBe(0);
    expect(plan.planned[0]?.outcome).toBe("absent");
    if (plan.planned[0]?.outcome === "absent") {
      expect(plan.planned[0].absenceKind).toBe("join-hold");
    }
  });
});
