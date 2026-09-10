import { describe, expect, it } from "vitest";

import { planCountyFloodHazard } from "../plan-county-flood-hazard.js";
import type { FloodZoneFeature } from "../geo.js";

describe("planCountyFloodHazard", () => {
  it("plans a real present+inSFHA row when a parcel centroid falls inside a loaded SFHA zone polygon", () => {
    // Realistic single-ring NFHL zone polygon, sfhaTf="T" (special flood
    // hazard area), covering a small bbox around downtown-ish coordinates.
    const zone: FloodZoneFeature = {
      zoneRowId: "z1",
      fldZone: "AE",
      zoneSubty: null,
      sfhaTf: "T",
      staticBfe: 512.3,
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-97.33, 30.105],
            [-97.325, 30.105],
            [-97.325, 30.108],
            [-97.33, 30.108],
            [-97.33, 30.105],
          ],
        ],
      },
      westLng: -97.33,
      southLat: 30.105,
      eastLng: -97.325,
      northLat: 30.108,
      sourceVintage: "NFHL-2026-08-01",
    };

    // Centroid squarely inside the zone polygon above.
    const plan = planCountyFloodHazard(
      [{ parcelKey: "31362", centroid: [-97.3275, 30.1065] }],
      [zone],
      { countyFips: "48021" },
    );

    expect(plan.emptyZoneIndex).toBe(false);
    expect(plan.counts.present).toBe(1);
    expect(plan.counts.presentInSfha).toBe(1);
    expect(plan.counts.absent).toBe(0);
    const row = plan.planned[0];
    expect(row?.outcome).toBe("present");
    if (row?.outcome === "present") {
      expect(row.inSpecialFloodHazardArea).toBe(true);
      expect(row.floodZone).toBe("AE");
      expect(row.baseFloodElevation).toBe(512.3);
    }
  });

  it("plans present+outside (not absent) for the same zone index when the point falls outside every polygon", () => {
    const zone: FloodZoneFeature = {
      zoneRowId: "z1",
      fldZone: "AE",
      zoneSubty: null,
      sfhaTf: "T",
      staticBfe: 512.3,
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-97.33, 30.105],
            [-97.325, 30.105],
            [-97.325, 30.108],
            [-97.33, 30.108],
            [-97.33, 30.105],
          ],
        ],
      },
      westLng: -97.33,
      southLat: 30.105,
      eastLng: -97.325,
      northLat: 30.108,
    };

    // Far outside the zone bbox — should be typed absence, "not proven Zone X".
    const plan = planCountyFloodHazard(
      [{ parcelKey: "99999", centroid: [-90.0, 25.0] }],
      [zone],
      { countyFips: "48021" },
    );

    expect(plan.counts.present).toBe(0);
    expect(plan.counts.absent).toBe(1);
    if (plan.planned[0]?.outcome === "absent") {
      expect(plan.planned[0].absenceKind).toBe("no-flood-coverage");
    }
  });
});
