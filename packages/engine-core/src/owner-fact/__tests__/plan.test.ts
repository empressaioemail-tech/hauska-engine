import { describe, expect, it } from "vitest";

import { planCountyOwnerFacts } from "../plan-county-owner-facts.js";
import type { OwnerCadRowInput, OwnerParcelInput } from "../plan-county-owner-facts.js";

describe("planCountyOwnerFacts", () => {
  it("plans a real present row with a non-blank owner name for a non-hold county with a matching CAD row", () => {
    // 48021 (Travis) is not in the LANDUSE_JOIN_HOLD set, the CAD row has a
    // real owner_name and mailing address, and no withheldKeys list applies —
    // this SHOULD reach present, not just "doesn't throw".
    const parcels: OwnerParcelInput[] = [{ parcelKey: "31362" }];
    const cadRows: OwnerCadRowInput[] = [
      {
        propId: "31362",
        taxYear: 2026,
        ownerName: "JONES HIGGINS LLC",
        ownerMailingAddress: "PO BOX 1 AUSTIN TX 78701",
        exemptionCodes: ["HS"],
        sourceVintage: "2026-tax-roll",
      },
    ];

    const plan = planCountyOwnerFacts(parcels, cadRows, {
      countyFips: "48021",
      taxYear: 2026,
    });

    expect(plan.hold).toBe(false);
    expect(plan.counts.present).toBe(1);
    expect(plan.counts.absent).toBe(0);
    expect(plan.counts.withMailingAddress).toBe(1);
    const row = plan.planned[0];
    expect(row?.outcome).toBe("present");
    if (row?.outcome === "present") {
      expect(row.ownerName).toBe("JONES HIGGINS LLC");
      expect(row.ownerMailingAddress).toBe("PO BOX 1 AUSTIN TX 78701");
      expect(row.exemptionCodes).toEqual(["HS"]);
    }
  });

  it("promotes to owner-withheld (not present) when the identical parcel is on a published withheldKeys list", () => {
    // Sanity contrast: same real CAD row with a real owner name, but the
    // caller supplies a published confidentiality-election list containing
    // this parcel — must NOT leak the name as present.
    const parcels: OwnerParcelInput[] = [{ parcelKey: "31362" }];
    const cadRows: OwnerCadRowInput[] = [
      {
        propId: "31362",
        taxYear: 2026,
        ownerName: "JOHN Q OFFICER",
        ownerMailingAddress: null,
        exemptionCodes: null,
      },
    ];

    const plan = planCountyOwnerFacts(parcels, cadRows, {
      countyFips: "48021",
      taxYear: 2026,
      withheldKeys: new Set(["31362"]),
    });

    expect(plan.counts.present).toBe(0);
    expect(plan.planned[0]?.outcome).toBe("absent");
    if (plan.planned[0]?.outcome === "absent") {
      expect(plan.planned[0].absenceKind).toBe("owner-withheld");
    }
  });
});
